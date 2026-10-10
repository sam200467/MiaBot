"use strict";
// 美亚 QQ 官方入口测试。全程走 mock-official + 假模型，不碰真接口、不花钱。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const core = require("../mia-core.cjs");
const { createMockOfficial } = require("./mock-official.cjs");
const { createMiaBot, formatReply } = require("./mia-entry.cjs");

const GROUP = "GROUP_OPENID_A";
const OTHER_GROUP = "GROUP_OPENID_B";

test("截图查歌请求经语义路由查本地，未绑定不查账号或状态", async () => {
  const restore = stubCore({ getBinding: async () => { throw new Error("不应查绑定"); } });
  const { mock, bot, model } = await setup({}, { action: { name: "songsearch", query: "サド" } });
  bot.settings.c.limits.userCooldownSeconds = 0;
  try {
    for (const content of ["有没有哪首歌开头是サド的，如果有多个符合条件的歌，全部列出来", "你能查到这首歌吗：サドマミホリック", "/搜索歌曲 サド"]) {
      const before = mock.state.sent.length;
      await bot.handleEvent("GROUP_AT_MESSAGE_CREATE", groupEvent({ content }));
      assert.ok(await mock.waitFor(() => mock.state.sent.length > before));
      const text = mock.state.sent.at(-1).body.content;
      assert.match(text, /サドマミホリック/);
      assert.match(text, /13\.5/);
      assert.doesNotMatch(text, /绑定|网关|排队/);
    }
    assert.equal(model.calls.length, 0);
    assert.equal(model.routeCalls.length, 4, "自然语言查询各做一次识别和复核");
    assert.ok(model.routeCalls[2].messages.some(m => m.role === "assistant" && m.content.includes("サドマミホリック")), "实际检索结果进入后续语义上下文");
  } finally { await bot.stop(); await mock.stop(); restore(); }
});

// 假模型：永远回同一句，并把收到的消息记下来供断言。
// action 非空时会在 JSON 里带上工具调用，用来测聊天路径。
function fakeModel(reply = "喵哼哼，收到啦！", expressionIds = [], action = null) {
  const calls = [], routeCalls = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    if (body.messages[0].content.includes("MIA_SEMANTIC_ROUTER_V1")) {
      routeCalls.push(body);
      const routedAction = action?.name === "calculate" ? { ...action, args: "args" in action ? action.args : { constant: 14.2, score: 1000737, bell: "fb", combo: "fc" } } : action;
      const decision = action?.name === "songsearch"
        ? { route: "query", query: { filters: [{ field: "title", op: /开头/.test(body.messages.at(-1).content) ? "prefix" : "search", value: action.query }], select: ["title", "constant"] } }
        : action ? { route: "action", action: routedAction } : { route: "chat" };
      return { ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify(decision) } }] }) };
    }
    calls.push({ url: String(url), body });
    const payload = { text: reply, emotion: "happy", scene: "ordinary", expressionIds };
    if (action) payload.action = action;
    return {
      ok: true, status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
    };
  };
  return { fetchImpl, calls, routeCalls };
}

// 出图和凭据库都是真实现（要 spawn exe），这里从 module.exports 上顶掉。
// mia-core 的 coreCall() 正是为此存在的（mia-core.cjs:780-782）。
const STUBBED = ["getBinding", "saveBinding", "vaultCall", "verifyAccount", "getDataSource", "getRinnetClient",
  "generateChart", "generateSongChart", "generateChartInfo", "generateCompletionChart", "generateLevelChart"];
function stubCore(overrides = {}) {
  const original = {};
  for (const name of STUBBED) original[name] = core[name];
  Object.assign(core, {
    getBinding: async () => null,
    getDataSource: async () => "otogame",
    saveBinding: async () => {},
    vaultCall: async () => "0",
    verifyAccount: async () => "测试玩家",
    generateChart: async () => ({ name: "chart.png", buffer: Buffer.from("png"), meta: {} }),
    generateSongChart: async () => ({ name: "song.png", buffer: Buffer.from("png"), meta: {} }),
    generateChartInfo: async () => ({ name: "ci.png", buffer: Buffer.from("png"), meta: {} }),
    generateCompletionChart: async () => ({ name: "plate.png", buffer: Buffer.from("png"), meta: {} }),
    generateLevelChart: async () => ({ name: "level.png", buffer: Buffer.from("png"), meta: {} }),
  }, overrides);
  return () => { Object.assign(core, original); };
}

// 起了命令层的 bot 配置：corePath / vaultPath / vaultHelperPath 必须齐，
// 否则 createMiaBot 会（有意地）退化成纯聊天，指令相关的断言就全测不到了。
function commandConfig(tmp) {
  return {
    workDir: tmp, outputDir: path.join(tmp, "out"),
    corePath: "C:/fake/ongeki-core.exe", vaultHelperPath: "C:/fake/vault.exe",
    vaultPath: path.join(tmp, "bindings.dat"), aliasDir: path.join(tmp, "aliases"),
  };
}

// ⚠ 走这个夹具就一定会注入假模型。**新用例别绕开它直接 createMiaBot** ——
// loadSettings 读的是真的 mia-chat/config.local.json，里面是真 DeepSeek key，
// 忘了传 fetchImpl 就会真的计费。
async function setup(configOverrides = {}, deps = {}) {
  const mock = createMockOfficial({ heartbeatIntervalMs: 200 });
  await mock.start();
  const model = fakeModel(deps.reply, deps.expressionIds, deps.action);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mia-entry-"));
  const config = {
    appId: "1", clientSecret: "s", sandbox: true,
    tokenUrl: mock.tokenUrl, apiBase: mock.apiBase, sandboxApiBase: mock.apiBase,
    allowedGroupIds: [GROUP], allowPrivateChat: true,
    minSendIntervalMs: 0, jitterMs: 0, perTargetIntervalMs: 0, duplicateWindowMs: 0, dailyCap: 9999,
    ...commandConfig(tmp),
    ...configOverrides,
  };
  const bot = createMiaBot(config, {
    log: () => {},
    fetchImpl: model.fetchImpl,
    createTransport: (host) => require("./official-transport.cjs").createOfficial(host),
    ...deps.botDeps,
  });
  await bot.start();
  assert.ok(await mock.waitFor(() => bot.transport.state.connected), "应当连上 mock 网关");
  return { mock, bot, model };
}

const groupEvent = (over = {}) => ({
  id: "m-" + Math.random().toString(36).slice(2, 8),
  group_openid: GROUP, content: "你好呀",
  timestamp: new Date().toISOString(), author: { member_openid: "U1" }, ...over,
});
const c2cEvent = (over = {}) => ({
  id: "c-" + Math.random().toString(36).slice(2, 8),
  content: "在吗",
  timestamp: new Date().toISOString(), author: { user_openid: "U2" }, ...over,
});

test("结构化查询状态按用户隔离，闲聊后仍可翻页，重置后清除", async () => {
  const calls = [];
  const fetchImpl = async (_, options) => {
    const body = JSON.parse(options.body); calls.push(body);
    const question = body.messages.at(-1).content;
    const decision = body.messages[0].content.includes("MIA_SEMANTIC_ROUTER_V1")
      ? question.includes("ai") ? { route: "query", query: { filters: [{ field: "title", op: "contains", value: "ai" }], select: ["title"] } } : { route: "chat" }
      : { text: "喵哼哼，不客气啦！", scene: "ordinary", expressionIds: [] };
    return { ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify(decision) } }] }) };
  };
  const { mock, bot } = await setup({}, { botDeps: { fetchImpl } });
  bot.settings.c.limits.userCooldownSeconds = 0;
  try {
    await bot.handleEvent("GROUP_AT_MESSAGE_CREATE", groupEvent({ content: "歌名包含ai的有哪些" }));
    assert.match(mock.state.sent.at(-1).body.content, /第 1\//);
    await bot.handleEvent("GROUP_AT_MESSAGE_CREATE", groupEvent({ content: "下一页", author: { member_openid: "ANOTHER_USER" } }));
    assert.match(mock.state.sent.at(-1).body.content, /还没有/);
    await bot.handleEvent("GROUP_AT_MESSAGE_CREATE", groupEvent({ content: "谢谢你" }));
    assert.match(mock.state.sent.at(-1).body.content, /喵哼哼/);
    await bot.handleEvent("GROUP_AT_MESSAGE_CREATE", groupEvent({ content: "下一页" }));
    assert.match(mock.state.sent.at(-1).body.content, /第 2\//);
    assert.match(mock.state.sent.at(-1).body.content, /歌名包含ai/);
    await bot.handleEvent("GROUP_AT_MESSAGE_CREATE", groupEvent({ content: "清空对话" }));
    await bot.handleEvent("GROUP_AT_MESSAGE_CREATE", groupEvent({ content: "下一页" }));
    assert.match(mock.state.sent.at(-1).body.content, /还没有/);
  } finally { await bot.stop(); await mock.stop(); }
});

test("当前图片附件进入 DeepSeek 多模态请求；只有引用ID时仍说明不可读", async () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  const fetched = [];
  const { mock, bot, model } = await setup({}, {
    reply: "图里有一个测试像素哦。",
    botDeps: { mediaFetchImpl: async (url) => {
      fetched.push(String(url));
      return new Response(png, { status: 200, headers: { "content-type": "image/png", "content-length": String(png.length) } });
    } },
  });
  bot.settings.c.limits.userCooldownSeconds = 0;
  try {
    await bot.handleEvent("GROUP_AT_MESSAGE_CREATE", groupEvent({ content: "点评一下这张图", attachments: [{ content_type: "image/png", url: "https://example.invalid/picture.png" }] }));
    assert.equal(fetched.length, 1);
    assert.match(mock.state.sent.at(-1).body.content, /测试像素/);
    assert.equal(model.routeCalls.length, 0);
    assert.equal(model.calls.length, 1);
    const imageMessage = model.calls[0].body.messages.find(m => Array.isArray(m.content));
    assert.ok(imageMessage, "模型请求应包含多模态 user message");
    assert.equal(imageMessage.role, "user");
    assert.equal(imageMessage.content[0].type, "text");
    assert.equal(imageMessage.content[1].type, "image_url");
    assert.match(imageMessage.content[1].image_url.url, /^data:image\/png;base64,/);

    await bot.handleEvent("GROUP_AT_MESSAGE_CREATE", groupEvent({ content: "点评一下这张图", message_reference: { message_id: "unavailable" } }));
    assert.match(mock.state.sent.at(-1).body.content, /呜喵.*看不到/);
    await bot.handleEvent("GROUP_AT_MESSAGE_CREATE", groupEvent({ content: "看看这张图", attachments: [{ content_type: "image/png", url: "http://example.invalid/not-accepted.png" }] }));
    assert.match(mock.state.sent.at(-1).body.content, /呜喵.*看不到/);
    assert.equal(fetched.length, 1, "非 HTTPS 图片不能下载或转发");
    assert.equal(mock.state.uploads.length, 0);
    assert.equal(model.calls.length, 1, "拿不到引用原图时不能让模型猜图");
  } finally { await bot.stop(); await mock.stop(); }
});

test("随机抽样经QQ入口保存，同批翻页不重抽，用户间不能共用抽样", async () => {
  const fetchImpl = async (_, options) => {
    const body = JSON.parse(options.body), current = body.messages.at(-1).content;
    const decision = { route: "query", query: { filters: [{ field: "constant", op: "eq", value: 14.5 }], entity: "charts", select: ["title", "constant"], selection: { kind: "random", count: 10, excludePrevious: current.includes("换一批") } } };
    return { ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify(decision) } }] }) };
  };
  const { mock, bot } = await setup({}, { botDeps: { fetchImpl } });
  bot.settings.c.limits.userCooldownSeconds = 0;
  const titles = text => [...text.matchAll(/^《(.+)》/gm)].map(m => m[1]);
  try {
    await bot.handleEvent("GROUP_AT_MESSAGE_CREATE", groupEvent({ content: "随机选10张14.5的谱" }));
    const first = titles(mock.state.sent.at(-1).body.content);
    assert.equal(first.length, 8);
    await bot.handleEvent("GROUP_AT_MESSAGE_CREATE", groupEvent({ content: "下一页" }));
    const second = titles(mock.state.sent.at(-1).body.content);
    assert.equal(second.length, 2); assert.ok(second.every(t => !first.includes(t)));
    await bot.handleEvent("GROUP_AT_MESSAGE_CREATE", groupEvent({ content: "换一批" }));
    assert.ok(titles(mock.state.sent.at(-1).body.content).every(t => ![...first, ...second].includes(t)));
    await bot.handleEvent("GROUP_AT_MESSAGE_CREATE", groupEvent({ content: "换一批", author: { member_openid: "ANOTHER_USER" } }));
    assert.match(mock.state.sent.at(-1).body.content, /还没有/);
    await bot.handleEvent("GROUP_AT_MESSAGE_CREATE", groupEvent({ content: "清空对话" }));
    await bot.handleEvent("GROUP_AT_MESSAGE_CREATE", groupEvent({ content: "换一批" }));
    assert.match(mock.state.sent.at(-1).body.content, /还没有/);
  } finally { await bot.stop(); await mock.stop(); }
});

test("群 @ 消息：走模型并把回复发回同一个群", async () => {
  const { mock, bot, model } = await setup();
  mock.push("GROUP_AT_MESSAGE_CREATE", groupEvent());
  assert.ok(await mock.waitFor(() => mock.state.sent.length > 0), "应当发出回复");
  assert.equal(model.calls.length, 1, "应当调用了一次模型");
  assert.equal(mock.state.sent[0].path, "/v2/groups/" + GROUP + "/messages");
  assert.match(mock.state.sent[0].body.content, /喵哼哼/);
  assert.ok(mock.state.sent[0].body.msg_id, "要带被动回复凭据");
  await bot.stop(); await mock.stop();
});

test("私聊消息：回给同一用户，走 /v2/users/", async () => {
  const { mock, bot } = await setup();
  mock.push("C2C_MESSAGE_CREATE", c2cEvent());
  assert.ok(await mock.waitFor(() => mock.state.sent.length > 0));
  assert.equal(mock.state.sent[0].path, "/v2/users/U2/messages");
  await bot.stop(); await mock.stop();
});

test("白名单外的群：整条忽略，不调模型也不回复", async () => {
  const { mock, bot, model } = await setup();
  mock.push("GROUP_AT_MESSAGE_CREATE", groupEvent({ group_openid: OTHER_GROUP }));
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(model.calls.length, 0, "不该调用模型");
  assert.equal(mock.state.sent.length, 0, "不该回复");
  await bot.stop(); await mock.stop();
});

test("@全体成员：整条忽略，不回复、不调模型、也不写入上下文", async () => {
  const { mock, bot, model } = await setup();
  const event = groupEvent({ content: "@全体成员 开会啦" });
  const normalized = bot.transport.normalize("GROUP_AT_MESSAGE_CREATE", event);
  assert.equal(bot.mentionsSelf(normalized), false, "@全体成员 不能被公共判定当成单独 @ 美亚");
  mock.push("GROUP_AT_MESSAGE_CREATE", event);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(model.calls.length, 0, "@全体成员 不是在叫美亚");
  assert.equal(mock.state.sent.length, 0, "不该回复");
  assert.equal(bot.readContext(GROUP, false).length, 0, "明确忽略的消息也不写进上下文");
  await bot.stop(); await mock.stop();
});

test("关掉私聊后，私聊消息被忽略", async () => {
  const { mock, bot, model } = await setup({ allowPrivateChat: false });
  mock.push("C2C_MESSAGE_CREATE", c2cEvent());
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(model.calls.length, 0);
  assert.equal(mock.state.sent.length, 0);
  await bot.stop(); await mock.stop();
});

test("全量群消息：只进上下文，不触发回复", async () => {
  const { mock, bot, model } = await setup();
  mock.push("GROUP_MESSAGE_CREATE", { ...groupEvent(), content: "群友在闲聊" });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(model.calls.length, 0, "普通群消息不该触发回复");
  assert.equal(mock.state.sent.length, 0);
  // 但它应当进了上下文缓冲
  const ctx = bot.readContext(GROUP, false);
  assert.ok(ctx.some((line) => line.includes("群友在闲聊")), "普通群消息应当被记进上下文");
  await bot.stop(); await mock.stop();
});

test("上下文只喂过往消息，不含当前这条", async () => {
  const { mock, bot, model } = await setup();
  mock.push("GROUP_MESSAGE_CREATE", { ...groupEvent(), content: "上一句闲聊" });
  await mock.waitFor(() => bot.readContext(GROUP, false).length > 0);
  mock.push("GROUP_AT_MESSAGE_CREATE", groupEvent({ content: "这一句是问我的" }));
  assert.ok(await mock.waitFor(() => mock.state.sent.length > 0));

  // 断言要看**模型实际收到的东西**，不能看回复落地之后的缓冲区：
  // 适配器是在回复发出**之前**取上下文的，那之后机器人自己的回复也会进缓冲区，
  // 再读一次 skipLast 去掉的就不是当前这句了。
  const payload = JSON.stringify(model.calls[0].body);
  assert.ok(payload.includes("上一句闲聊"), "应当带上之前的群消息");
  const hit = payload.split("这一句是问我的").length - 1;
  assert.equal(hit, 1, "当前这句只该以「用户消息」出现一次，不能再作为上下文重复喂（实际出现 " + hit + " 次）");
  await bot.stop(); await mock.stop();
});

test("模型返回空白/坏 JSON 时不崩，且不会发出空消息", async () => {
  const mock = createMockOfficial({ heartbeatIntervalMs: 200 });
  await mock.start();
  let n = 0;
  const bot = createMiaBot({
    appId: "1", clientSecret: "s", tokenUrl: mock.tokenUrl, apiBase: mock.apiBase, sandboxApiBase: mock.apiBase,
    allowedGroupIds: [GROUP], allowPrivateChat: true,
    minSendIntervalMs: 0, jitterMs: 0, perTargetIntervalMs: 0, duplicateWindowMs: 0,
  }, {
    log: () => {},
    fetchImpl: async () => {
      n += 1;
      // 第一次给坏 JSON，第二次给空字符串
      return { ok: true, status: 200, text: async () => (n === 1 ? "not json at all" : " ") };
    },
  });
  await bot.start();
  await mock.waitFor(() => bot.transport.state.connected);
  mock.push("GROUP_AT_MESSAGE_CREATE", groupEvent());
  await new Promise((r) => setTimeout(r, 800));
  for (const s of mock.state.sent) {
    assert.ok(String(s.body.content || "").trim().length > 0, "不该发出空白消息");
  }
  await bot.stop(); await mock.stop();
});

test("配图时正文一个字都不能少（回归：曾被截到 100 字）", async () => {
  // 线上实测：所有带图的回复都恰好 100 字符、半句话结尾，因为发图那条路径上
  // 写着 slice(0,100)。这条测试专门盯住它。
  const long = "喵哼哼，" + "美亚最擅长的就是这件事了。".repeat(12) + "就是这样喵。";
  assert.ok(long.length > 100, "夹具前提：正文要超过 100 字（实际 " + long.length + "）");
  const { mock, bot } = await setup({}, { reply: long, expressionIds: ["gentle_smile"] });
  mock.push("GROUP_AT_MESSAGE_CREATE", groupEvent());
  assert.ok(await mock.waitFor(() => mock.state.sent.length > 0));
  const body = mock.state.sent[0].body;
  assert.ok(body.msg_type === 7, "这条应当走富媒体（带图）");
  assert.equal(body.content, long, "带图时正文必须原样发出，不能被截断");
  await bot.stop(); await mock.stop();
});

test("同一个事件重复推送只回一次", async () => {
  const { mock, bot, model } = await setup();
  const e = groupEvent();
  mock.push("GROUP_AT_MESSAGE_CREATE", e);
  mock.push("GROUP_AT_MESSAGE_CREATE", e);
  await mock.waitFor(() => mock.state.sent.length > 0);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(model.calls.length, 1, "去重应当在传输层就挡掉");
  await bot.stop(); await mock.stop();
});

// ════════════════════════════════════════════════════════════════════
// 指令层接上之后的入口行为
// ════════════════════════════════════════════════════════════════════

const sentText = (mock) => mock.state.sent.map((s) => String(s.body?.content || "")).join("\n");
const privateSends = (mock) => mock.state.sent.filter((s) => s.path.startsWith("/v2/users/"));

test("核心要求：群里 /help 完全不碰模型", async () => {
  const { mock, bot, model } = await setup();
  mock.push("GROUP_AT_MESSAGE_CREATE", groupEvent({ content: "/help" }));
  assert.ok(await mock.waitFor(() => mock.state.sent.length > 0), "应当有回复");
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(model.calls.length, 0, "指令是硬路由，一次模型调用都不该有");
  assert.match(sentText(mock), /美亚的小道具/, "回的应当是美亚腔的清单");
  await bot.stop(); await mock.stop();
});

test("普通聊天照常走模型", async () => {
  const { mock, bot, model } = await setup();
  mock.push("GROUP_AT_MESSAGE_CREATE", groupEvent({ content: "美亚你好呀" }));
  assert.ok(await mock.waitFor(() => mock.state.sent.length > 0));
  assert.equal(model.calls.length, 1, "不带指令前缀的还是要交给模型");
  await bot.stop(); await mock.stop();
});

test("私聊里直接发 /help 会执行", async () => {
  const { mock, bot, model } = await setup();
  mock.push("C2C_MESSAGE_CREATE", c2cEvent({ content: "/help" }));
  assert.ok(await mock.waitFor(() => mock.state.sent.length > 0));
  assert.equal(model.calls.length, 0, "私聊也不需要模型");
  assert.match(sentText(mock), /美亚的小道具/);
  await bot.stop(); await mock.stop();
});

test("未知指令回在原地，不偷偷私信", async () => {
  const { mock, bot } = await setup();
  mock.push("GROUP_AT_MESSAGE_CREATE", groupEvent({ content: "/不存在的指令" }));
  assert.ok(await mock.waitFor(() => mock.state.sent.length > 0));
  assert.match(sentText(mock), /美亚不认识/);
  assert.equal(mock.state.sent[0].path, "/v2/groups/" + GROUP + "/messages", "要回在群里");
  assert.equal(privateSends(mock).length, 0, "不能变成「群里打了个词，机器人偷偷私信你一句」");
  await bot.stop(); await mock.stop();
});

test("群里没 @ 美亚时，光有 / 前缀不执行指令", async () => {
  // 全量群消息模式下，群里别的 bot 打的 /help 也会送到这儿来。
  const { mock, bot, model } = await setup();
  mock.push("GROUP_MESSAGE_CREATE", groupEvent({ content: "/help" }));
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(mock.state.sent.length, 0, "不该抢答");
  assert.equal(model.calls.length, 0, "全量群消息也不进模型");
  assert.ok(bot.readContext(GROUP, false).some((l) => l.includes("/help")), "但要记进上下文");
  await bot.stop(); await mock.stop();
});

test("配了 botOpenid 且消息真的 @ 了它，全量消息里的指令才执行", async () => {
  const { mock, bot } = await setup({ botOpenid: "BOT_OPENID" });
  mock.push("GROUP_MESSAGE_CREATE", groupEvent({ content: "/help", mentions: [{ id: "BOT_OPENID" }] }));
  assert.ok(await mock.waitFor(() => mock.state.sent.length > 0), "认得出自己就该执行");
  assert.match(sentText(mock), /美亚的小道具/);
  await bot.stop(); await mock.stop();
});

test("逃生阀：acceptBareGroupCommands 打开后，群里不带 @ 也执行", async () => {
  const { mock, bot } = await setup({ acceptBareGroupCommands: true });
  mock.push("GROUP_MESSAGE_CREATE", groupEvent({ content: "/help" }));
  assert.ok(await mock.waitFor(() => mock.state.sent.length > 0));
  assert.match(sentText(mock), /美亚的小道具/);
  await bot.stop(); await mock.stop();
});

// ── 全量群消息模式（2026-09-19 实测形状）─────────────────────────────
// 开了「获取群内全部消息」之后，平台**不再推 GROUP_AT_MESSAGE_CREATE**，
// @ 消息只以 GROUP_MESSAGE_CREATE 到达，判据是 mentions[].is_you。
// 下面这几条就是照着实测 payload 写的 —— 少了它们，改错一个字就是
// 「美亚在那个群里完全不吭声」，而那是最难查的症状。
const SELF_OPENID = "5FE5240E4627033E7488D3516E0DE79E";
const selfMention = () => ({
  bot: true, id: SELF_OPENID, is_you: true, member_openid: SELF_OPENID,
  member_role: "member", scope: "single", username: "MiaBot",
});
// 实测收到过另一只 bot 被 @ 的 /login，那条的 is_you 是 false
const otherBotMention = () => ({
  bot: true, id: "C19063DA84624E5365A72039ECD27520", is_you: false,
  member_openid: "C19063DA84624E5365A72039ECD27520", member_role: "member", scope: "single", username: "OtherBot",
});

test("全量模式下 @ 美亚发指令：必须执行", async () => {
  const { mock, bot, model } = await setup();
  mock.push("GROUP_MESSAGE_CREATE", groupEvent({
    content: "<@" + SELF_OPENID + "> /help", mentions: [selfMention()],
  }));
  assert.ok(await mock.waitFor(() => mock.state.sent.length > 0), "全量模式下的 @ 指令必须执行");
  assert.equal(model.calls.length, 0, "指令不走模型");
  assert.match(sentText(mock), /美亚的小道具/);
  await bot.stop(); await mock.stop();
});

test("全量模式下 @ 美亚说话：要走模型回复", async () => {
  // 这条是「美亚在那个群里完全不吭声」的直接回归：原来按事件名判，
  // 而全量模式下根本没有 AT 事件，于是任何 @ 都进不了聊天。
  const { mock, bot, model } = await setup();
  mock.push("GROUP_MESSAGE_CREATE", groupEvent({
    content: "<@" + SELF_OPENID + "> 美亚你好呀", mentions: [selfMention()],
  }));
  assert.ok(await mock.waitFor(() => mock.state.sent.length > 0), "全量模式下的 @ 聊天必须回复");
  assert.equal(model.calls.length, 1, "该走模型");
  await bot.stop(); await mock.stop();
});

test("全量模式下 @自己 发指令：查的是**自己**，不是「别人」", async () => {
  // 回归（线上实测踩到）：正文里的 @ 标记会被解析成 mentions，而那里面装的是**美亚自己**。
  // 如果自己没被排除，「@美亚 /牌子 耀击」就会被当成「查美亚自己」，
  // 于是去查一个不存在的绑定，回一句「TA 还没把账号交给美亚过」——用户已经绑过了却查不了。
  const asked = [];
  const restore = stubCore({
    getBinding: async (cfg, id) => { asked.push(String(id)); return { playerName: "测试玩家", email: "a@b.c", password: "x" }; },
  });
  try {
    const { mock, bot } = await setup();
    mock.push("GROUP_MESSAGE_CREATE", groupEvent({
      content: "<@" + SELF_OPENID + "> /牌子 耀击",
      mentions: [selfMention()],
      author: { member_openid: "U1" },
    }));
    assert.ok(await mock.waitFor(() => mock.state.sent.length > 0), "应该出图");
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(asked.length > 0, "应当查过绑定");
    assert.ok(asked.every((id) => id === "U1"),
      "只能查调用者自己（U1），实际查了：" + asked.join(","));
    assert.ok(!asked.includes(SELF_OPENID), "绝不能把美亚自己的 openid 当查询对象");
    await bot.stop(); await mock.stop();
  } finally { restore(); }
});

test("全量模式下别的 bot 被 @ 的 /login：绝不抢答", async () => {
  const { mock, bot, model } = await setup();
  mock.push("GROUP_MESSAGE_CREATE", groupEvent({
    content: "<@C19063DA84624E5365A72039ECD27520> /login", mentions: [otherBotMention()],
  }));
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(mock.state.sent.length, 0, "别人被 @ 的指令不能抢答（实测真的会收到这种消息）");
  assert.equal(model.calls.length, 0, "也不该进模型");
  assert.ok(bot.readContext(GROUP, false).length > 0, "但要记进上下文");
  await bot.stop(); await mock.stop();
});

test("全量模式下普通消息：不回复，但进上下文", async () => {
  const { mock, bot, model } = await setup();
  mock.push("GROUP_MESSAGE_CREATE", groupEvent({ content: "444" }));
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(mock.state.sent.length, 0);
  assert.equal(model.calls.length, 0);
  assert.ok(bot.readContext(GROUP, false).some((l) => l.includes("444")), "普通消息要进上下文");
  await bot.stop(); await mock.stop();
});

test("双投递同一条消息：只处理一次，上下文也只记一条", async () => {
  // 平台可能对同一条消息同时推两种事件，而传输层的去重键带事件名，互相挡不住。
  const { mock, bot } = await setup();
  const e = {
    id: "dup-" + Math.random().toString(36).slice(2, 8), content: "/帮助",
    timestamp: new Date().toISOString(), author: { member_openid: "U1" }, group_openid: GROUP,
  };
  mock.push("GROUP_AT_MESSAGE_CREATE", e);
  mock.push("GROUP_MESSAGE_CREATE", e);
  assert.ok(await mock.waitFor(() => mock.state.sent.length > 0));
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(mock.state.sent.length, 1, "副作用只能发生一次");
  const ctx = bot.readContext(GROUP, false).filter((l) => l.includes("/帮助"));
  assert.equal(ctx.length, 1, "上下文也只能记一条，否则模型看到同一句话两遍");
  await bot.stop(); await mock.stop();
});

test("群里的未绑定提示原地发送，并提醒用户自行撤回", async () => {
  const restore = stubCore();
  try {
    const { mock, bot } = await setup();
    mock.push("GROUP_AT_MESSAGE_CREATE", groupEvent({ content: "/分表" }));
    assert.ok(await mock.waitFor(() => mock.state.sent.length > 0));
    assert.equal(privateSends(mock).length, 0, "一次 /v2/users/ 调用都不该有");
    assert.match(sentText(mock), /撤回/, "要提醒用户自行撤回凭据");
    await bot.stop(); await mock.stop();
  } finally { restore(); }
});

test("提示文案会换着说，不是每次都同一句", async () => {
  const restore = stubCore();
  try {
    const { mock, bot } = await setup();
    const seen = new Set();
    for (let i = 0; i < 12; i++) {
      const before = mock.state.sent.length;
      mock.push("GROUP_AT_MESSAGE_CREATE", groupEvent({ content: "/分表" }));
      await mock.waitFor(() => mock.state.sent.length > before);
      seen.add(String(mock.state.sent[mock.state.sent.length - 1].body.content));
    }
    assert.ok(seen.size >= 2, "未绑定提示应当有多个说法（实际 " + seen.size + " 种）");
    await bot.stop(); await mock.stop();
  } finally { restore(); }
});

test("两条不同的消息、回复文案一样，两条都要发得出去", async () => {
  // 回归：抑制键原先只用 target + 正文，同一分钟里第二个人问同一件事会被吞掉。
  const { mock, bot } = await setup({ duplicateWindowMs: 60000 });
  mock.push("GROUP_AT_MESSAGE_CREATE", groupEvent({ content: "/帮助", id: "h1" }));
  assert.ok(await mock.waitFor(() => mock.state.sent.length > 0));
  mock.push("GROUP_AT_MESSAGE_CREATE", groupEvent({ content: "/帮助", id: "h2" }));
  assert.ok(await mock.waitFor(() => mock.state.sent.length > 1, 3000), "第二条也该发出去");
  assert.equal(mock.state.sent.length, 2);
  await bot.stop(); await mock.stop();
});

test("/帮助 清单跟着这台的开关走：联网、读引用、私聊，关着的那行不出现", async () => {
  const { loadSettings } = require("../chat-core/chat.cjs");
  const { gateSettings } = require("../chat-core/search-gate.cjs");
  const base = loadSettings(path.resolve(__dirname, "../mia-chat"));
  const helpFrom = async (configOverrides, searchGate) => {
    const { mock, bot } = await setup(configOverrides, { botDeps: { settings: { ...base, searchGate: gateSettings(searchGate) } } });
    try {
      mock.push("GROUP_AT_MESSAGE_CREATE", groupEvent({ content: "/帮助" }));
      assert.ok(await mock.waitFor(() => mock.state.sent.length > 0));
      return String(mock.state.sent[0].body.content);
    } finally { await bot.stop(); await mock.stop(); }
  };
  const defaults = await helpFrom({}, { mode: "off" });
  assert.match(defaults, /私聊美亚不用 @/);
  assert.doesNotMatch(defaults, /搜一下|被回复的那条/, "联网和读引用关着，清单里就不该写");
  // 联网只要不是 off 就算开：「搜一下 …」这种明说，explicit 档也会去查
  const flipped = await helpFrom({ quotedMessage: "read", allowPrivateChat: false }, { mode: "explicit" });
  assert.match(flipped, /搜一下/);
  assert.match(flipped, /被回复的那条/);
  assert.doesNotMatch(flipped, /私聊美亚/, "私聊关了就别让人去私聊");
});

// ── 聊天路径的工具调用 ──────────────────────────────────────────────
test("聊天里模型挑的工具真的被执行：先发引出语，结果由程序发", async () => {
  const restore = stubCore({ getBinding: async () => ({ playerName: "测试玩家", email: "a@b.c", password: "x" }) });
  try {
    const { mock, bot } = await setup({}, { reply: "喵哼哼，这就去翻你的成绩", action: { name: "chart" } });
    mock.push("GROUP_AT_MESSAGE_CREATE", groupEvent({ content: "帮我查一下分表" }));
    assert.ok(await mock.waitFor(() => mock.state.sent.some((s) => s.body?.msg_type === 7), 5000), "应当出图、上传并发送");
    const text = sentText(mock);
    assert.match(text, /好，我来查一下/, "程序引出语要发出去");
    assert.ok(mock.state.sent.some((s) => s.body?.msg_type === 7), "结果以图片形式发出");
    await bot.stop(); await mock.stop();
  } finally { restore(); }
});

test("聊天里未知工具名：重试一次后提示重试，不执行", async () => {
  const restore = stubCore();
  try {
    const { mock, bot, model } = await setup({}, { reply: "美亚看看哦", action: { name: "rm-rf", query: "/" } });
    mock.push("GROUP_AT_MESSAGE_CREATE", groupEvent({ content: "美亚帮我干点活" }));
    assert.ok(await mock.waitFor(() => mock.state.sent.length > 0));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(model.routeCalls.length, 2);
    assert.equal(model.calls.length, 0);
    assert.match(sentText(mock), /呜喵.*没接稳/);
    assert.equal(mock.state.uploads.length, 0, "不该有任何出图");
    await bot.stop(); await mock.stop();
  } finally { restore(); }
});

test("聊天里模型挑 bind：只走绑定引导，那句引出语绝不发出去", async () => {
  // 绑定是要收邮箱密码的多轮流程。让它经模型的手，明文密码就会作为 action 参数
  // 进到 DeepSeek 的请求体和本地会话历史里。
  const restore = stubCore();
  try {
    const { mock, bot } = await setup({}, { reply: "带你去绑定哦～", action: { name: "bind" } });
    mock.push("GROUP_AT_MESSAGE_CREATE", groupEvent({ content: "我想绑定账号" }));
    assert.ok(await mock.waitFor(() => mock.state.sent.length > 0));
    await new Promise((r) => setTimeout(r, 200));
    const text = sentText(mock);
    assert.match(text, /群绑定已开启/, "要进入程序控制的群绑定流程");
    assert.ok(!text.includes("带你去绑定哦～"), "模型那句引出语不能发");
    await bot.stop(); await mock.stop();
  } finally { restore(); }
});

test("群绑定凭据：不自动撤回，但不进群上下文、日志回复或模型", async () => {
  const SECRET = "entry-group-secret-绝密";
  const restore = stubCore();
  try {
    const { mock, bot, model } = await setup();
    mock.push("GROUP_AT_MESSAGE_CREATE", groupEvent({ id: "bind-start", content: "/绑定" }));
    assert.ok(await mock.waitFor(() => mock.state.sent.length >= 1));

    mock.push("GROUP_MESSAGE_CREATE", groupEvent({ id: "bind-email", content: "me@example.com", mentions: undefined }));
    assert.ok(await mock.waitFor(() => sentText(mock).includes("邮箱收到")));
    mock.push("GROUP_MESSAGE_CREATE", groupEvent({ id: "bind-password", content: SECRET, mentions: undefined }));
    assert.ok(await mock.waitFor(() => sentText(mock).includes("绑好啦")));
    assert.equal(model.calls.length, 0, "整个绑定状态机都不能调用模型");
    assert.ok(!JSON.stringify(mock.state.sent).includes(SECRET), "任何机器人回复都不能含密码");
    assert.match(sentText(mock), /密码消息.*撤回/s, "机器人要提醒用户手动撤回密码");
    await bot.stop(); await mock.stop();
  } finally { restore(); }
});

test("聊天里模型自己补的铃铛/连击：拦下，绝不拿它去算", async () => {
  // 实测抓到过：用户只说「算一下 14.2 打 1000737」，模型自己补成 fb / fc 就去算了，
  // 回复里还写成「铃铛 fb、连击 fc」，像是用户说过一样 —— 算出来的 Rating 会被当成事实。
  // 提示词里写了「缺参数只能问」，但那是模型判断、不稳（三次里跑出来两次），
  // 所以这里在程序侧再兜一道。
  const restore = stubCore();
  try {
    const { mock, bot } = await setup({}, {
      reply: "14.2 打 1000737，铃铛 fb、连击 fc——好嘞，这就给你算",
      action: { name: "calculate", query: "14.2 1000737 fb fc" },
    });
    mock.push("GROUP_AT_MESSAGE_CREATE", groupEvent({ content: "算一下 14.2 打 1000737 能有多少 rating" }));
    assert.ok(await mock.waitFor(() => mock.state.sent.length > 0));
    await new Promise((r) => setTimeout(r, 300));
    const text = sentText(mock);
    assert.ok(!/基础分/.test(text), "绝不能算出 Rating（实际：" + text.slice(0, 80) + "）");
    assert.match(text, /铃铛和连击/, "要回去问缺的那两样");
    await bot.stop(); await mock.stop();
  } finally { restore(); }
});

test("聊天里说「理论值」：两盏灯是推出来的，直接算出唯一结果", async () => {
  // 群里实测：「我打了14.2的理论值，以及full bell，单曲rating是多少」被回成
  // 「算 Rating 还需要定数、技术分、铃铛和连击」。理论值 1010000 ⇔ AB+，且必然 FB，
  // 这句话已经够算了。模型的两种输出形状都要能算：照提示词把没说的 combo 留成 null 的 args，
  // 以及线上 deepseek-flash 实际给的 query 字符串（它根本不写 args）。
  for (const action of [
    { name: "calculate", args: { constant: 14.2, score: 1010000, bell: "fb", combo: null } },
    { name: "calculate", query: "14.2 1010000 fb ab-plus", args: undefined },
  ]) {
    const restore = stubCore();
    try {
      const { mock, bot } = await setup({}, { reply: "好嘞", action });
      mock.push("GROUP_AT_MESSAGE_CREATE", groupEvent({ content: "我打了14.2的理论值，以及full bell，单曲rating是多少" }));
      assert.ok(await mock.waitFor(() => /基础分/.test(sentText(mock))), "应当算出来（实际：" + sentText(mock).slice(0, 80) + "）");
      assert.match(sentText(mock), /成绩加成 0\.3（SSS\+）\+ 铃铛 0\.05（FB）\+ 连击 0\.35（AB\+）= 16\.90/);
      await bot.stop(); await mock.stop();
    } finally { restore(); }
  }
});

test("聊天里给了打不出来的组合：说清哪里不可能，不硬算", async () => {
  const restore = stubCore();
  try {
    const { mock, bot } = await setup({}, {
      reply: "好嘞",
      action: { name: "calculate", args: { constant: 14.2, score: 1000000, bell: "fb", combo: "ab-plus" } },
    });
    mock.push("GROUP_AT_MESSAGE_CREATE", groupEvent({ content: "14.2 打了 1000000，fb，ab+，算下单曲 rating" }));
    assert.ok(await mock.waitFor(() => mock.state.sent.length > 0));
    await new Promise((r) => setTimeout(r, 300));
    const text = sentText(mock);
    assert.ok(!/基础分/.test(text), "AB+ 配 1000000 不能算出 Rating（实际：" + text.slice(0, 80) + "）");
    assert.match(text, /AB\+ 只在技术分正好 1010000/);
    await bot.stop(); await mock.stop();
  } finally { restore(); }
});

test("聊天里模型替用户估了分数：问分数，不拿编的数去算也不拿它报矛盾", async () => {
  // 实测（2026-10-08，deepseek-flash）：「14.2打了个鸟加，fb」→ 模型给了 "14.2 1008999 fb ab-plus"。
  // /计算 的结果不显示分数，真算出来用户看不出是估的；先报矛盾又会冒出两样用户没说过的东西。
  const restore = stubCore();
  try {
    const { mock, bot } = await setup({}, {
      reply: "好嘞",
      action: { name: "calculate", query: "14.2 1008999 fb ab-plus", args: undefined },
    });
    mock.push("GROUP_AT_MESSAGE_CREATE", groupEvent({ content: "14.2打了个鸟加，fb，帮我算下rating" }));
    assert.ok(await mock.waitFor(() => mock.state.sent.length > 0));
    await new Promise((r) => setTimeout(r, 300));
    const text = sentText(mock);
    assert.ok(!/基础分/.test(text), "不能拿编的分数算（实际：" + text.slice(0, 80) + "）");
    assert.match(text, /技术分要你报具体数字/);
    assert.doesNotMatch(text, /1008999/);
    await bot.stop(); await mock.stop();
  } finally { restore(); }
});

test("聊天里模型给的查询对象只认本条消息真的 @ 过的人", async () => {
  // 隐私边界：模型挑 target 时必须过 @ 名单校验，编出来的编号一律作废。
  const asked = [];
  const restore = stubCore({
    getBinding: async (cfg, id) => { asked.push(String(id)); return null; },
  });
  try {
    const { mock, bot } = await setup({}, {
      reply: "美亚去看看", action: { name: "song", query: "id870", target: "SOMEONE_ELSE" },
    });
    mock.push("GROUP_AT_MESSAGE_CREATE", groupEvent({ content: "帮我查一下他的单曲", mentions: [] }));
    assert.ok(await mock.waitFor(() => mock.state.sent.length > 0));
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(!asked.includes("SOMEONE_ELSE"), "模型编的编号不能拿去查别人（实际查了：" + asked.join(",") + "）");
    await bot.stop(); await mock.stop();
  } finally { restore(); }
});

test("rinnet 群绑定：附带凭据、斜杠密码、TOTP 和卡号不进模型、上下文或日志", async () => {
  const secrets = ["rin@example.com", "/secret-password", "123456", "00000000000000000001"];
  const logs = [];
  const saved = [];
  const restore = stubCore({
    getDataSource: async () => "rinnet",
    getRinnetClient: () => ({
      login: async (email, password) => { assert.equal(password, secrets[1]); return { totpToken: "challenge-secret" }; },
      totp: async () => ({ accessToken: "access-secret", refreshToken: "refresh-secret" }),
      bind: async (account, email, cardNumber) => cardNumber ? { account, email, cardNumber, aimeId: "7", sessionId: "s", playerName: "测试玩家", dataSource: "rinnet" } : { cards: [{}, {}] },
    }),
    saveBinding: async (config, entry) => saved.push(entry),
  });
  const { mock, bot, model } = await setup({}, { botDeps: { log: line => logs.push(line) } });
  try {
    await bot.handleEvent("GROUP_AT_MESSAGE_CREATE", groupEvent({ content: "/绑定 " + secrets.join(" ") }));
    for (const content of secrets) await bot.handleEvent("GROUP_AT_MESSAGE_CREATE", groupEvent({ content }));
    assert.equal(saved.length, 1);
    assert.equal(saved[0].aimeId, "7");
    const exposed = JSON.stringify([logs, bot.readContext(GROUP, false), model.calls, model.routeCalls, mock.state.sent]);
    for (const secret of [...secrets, "challenge-secret", "access-secret", "refresh-secret"]) assert.ok(!exposed.includes(secret));
    assert.equal(model.calls.length + model.routeCalls.length, 0);
  } finally { await bot.stop(); await mock.stop(); restore(); }
});

// ── 聊天记录（chatLog）────────────────────────────────────────────────
// 记录模块本身和引擎钩子在 test-chat-log.cjs 里测，这里只测接进入口之后的整条链路。
const readChatLog = (dir) => !fs.existsSync(dir) ? [] : fs.readdirSync(dir).filter((name) => name.endsWith(".jsonl")).sort()
  .flatMap((name) => fs.readFileSync(path.join(dir, name), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)));

test("聊天记录：开着时记下她回复的群聊，连同她当时看到的群上下文；私聊不记", async () => {
  const logs = [];
  const { mock, bot, model } = await setup({ chatLog: { mode: "replies" } }, { botDeps: { log: (line) => logs.push(line) } });
  bot.settings.c.limits.userCooldownSeconds = 0;
  try {
    assert.ok(logs.some((line) => /聊天记录：开｜只记美亚回复的群聊｜保留 14 天/.test(line)), logs.join("\n"));
    mock.push("GROUP_MESSAGE_CREATE", { ...groupEvent({ author: { member_openid: "U9" } }), content: "今天谁出勤" });
    assert.ok(await mock.waitFor(() => bot.readContext(GROUP, false).length > 0));
    await bot.handleEvent("GROUP_AT_MESSAGE_CREATE", groupEvent({ id: "at-1", content: "刚才他们说啥了" }));
    await bot.handleEvent("C2C_MESSAGE_CREATE", c2cEvent({ content: "私聊一句" }));
    assert.equal(model.calls.length, 2, "两句都回了");
    const records = readChatLog(bot.chatLog.dir);
    assert.equal(records.length, 1, "私聊不记");
    const [r] = records;
    assert.equal(r.group, GROUP);
    assert.equal(r.user, "U1");
    assert.equal(r.msgId, "at-1");
    assert.equal(r.text, "刚才他们说啥了");
    assert.deepEqual(r.context, ["群友：今天谁出勤"], "没 @ 她的那句作为上下文出现，当前这句不重复");
    assert.equal(r.reply, "喵哼哼，收到啦！");
    assert.match(r.time, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  } finally { await bot.stop(); await mock.stop(); }
});

test("聊天记录：默认关，不建目录、不挂钩子", async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-entry-nolog-"));
  const { mock, bot } = await setup({ workDir });
  try {
    await bot.handleEvent("GROUP_AT_MESSAGE_CREATE", groupEvent({ content: "在吗" }));
    assert.ok(mock.state.sent.length > 0);
    assert.equal(bot.chatLog, null);
    assert.ok(!fs.existsSync(path.join(workDir, "chatlog")));
  } finally { await bot.stop(); await mock.stop(); }
});

test("聊天记录：配置写错按关闭处理，启动日志里说清楚", async () => {
  const logs = [];
  const { mock, bot } = await setup({ chatLog: { mode: "all" } }, { botDeps: { log: (line) => logs.push(line) } });
  try {
    assert.equal(bot.chatLog, null);
    assert.ok(logs.some((line) => /chatLog\.mode 只能是 off \/ replies，聊天记录先按关闭处理/.test(line)), logs.join("\n"));
  } finally { await bot.stop(); await mock.stop(); }
});

test("聊天记录：绑定流程的邮箱和密码进不了记录", async () => {
  const SECRET = "chatlog-bind-secret-绝密";
  const restore = stubCore();
  const { mock, bot } = await setup({ chatLog: { mode: "replies" } });
  bot.settings.c.limits.userCooldownSeconds = 0;
  try {
    mock.push("GROUP_AT_MESSAGE_CREATE", groupEvent({ id: "bind-start", content: "/绑定" }));
    assert.ok(await mock.waitFor(() => mock.state.sent.length >= 1));
    mock.push("GROUP_MESSAGE_CREATE", groupEvent({ id: "bind-email", content: "me@example.com", mentions: undefined }));
    assert.ok(await mock.waitFor(() => sentText(mock).includes("邮箱收到")));
    mock.push("GROUP_MESSAGE_CREATE", groupEvent({ id: "bind-password", content: SECRET, mentions: undefined }));
    assert.ok(await mock.waitFor(() => sentText(mock).includes("绑好啦")));
    await bot.handleEvent("GROUP_AT_MESSAGE_CREATE", groupEvent({ content: "绑好了吗" }));
    const records = readChatLog(bot.chatLog.dir);
    assert.deepEqual(records.map((r) => r.text), ["绑好了吗"], "只有绑完之后那句闲聊");
    const raw = fs.readdirSync(bot.chatLog.dir).map((name) => fs.readFileSync(path.join(bot.chatLog.dir, name), "utf8")).join("");
    for (const secret of [SECRET, "me@example.com"]) assert.ok(!raw.includes(secret), "记录里不能有 " + secret);
  } finally { await bot.stop(); await mock.stop(); restore(); }
});

// ── 回复排版 ──────────────────────────────────────────────────────────

test("排版：正文的空行照旧折叠，来源脚注前面留一个空行", () => {
  assert.deepEqual(formatReply("第一段。\n\n\n第二段。\n"), { body: "第一段。\n第二段。", text: "第一段。\n第二段。" }, "没有脚注时和原来一样");
  const footer = "参考资料：\nCHUNITHM\nhttps://zh.wikipedia.org/wiki/CHUNITHM";
  assert.deepEqual(formatReply("日本版是 X-VERSE-X。\n\n国际版慢半年♪\n\n" + footer),
    { body: "日本版是 X-VERSE-X。\n国际版慢半年♪", text: "日本版是 X-VERSE-X。\n国际版慢半年♪\n\n" + footer });
  for (const title of ["资料出处（本地条目自带的来源优先）：", "搜索结果（供核对）："]) {
    assert.equal(formatReply("正文。\n\n" + title + "\n来源一").text, "正文。\n\n" + title + "\n来源一", title);
  }
  assert.equal(formatReply("\n\n" + footer).text, footer, "只有脚注时前面不留空行");
  assert.equal(formatReply("参考资料：这一句只是正文。\n\n下一段").text, "参考资料：这一句只是正文。\n下一段", "正文里提到这几个字不算脚注");
});

test("带来源的回复：发到 QQ 的那条里「参考资料」前面空一行，也不再误报「疑似未写完」", async () => {
  const { loadSettings } = require("../chat-core/chat.cjs");
  const { gateSettings, GATE_MARKER } = require("../chat-core/search-gate.cjs");
  const base = loadSettings(path.resolve(__dirname, "../mia-chat"));
  const respond = (content) => ({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }) });
  const fetchImpl = async (_, options) => {
    const body = JSON.parse(options.body), system = String(body.messages[0].content);
    if (system.includes("MIA_SEMANTIC_ROUTER_V1")) return respond({ route: "chat" });
    if (system.startsWith(GATE_MARKER)) return respond({ act: "ask", about: "world", target: "CHUNITHM 最新版本", fresh: true, confident: true, unknownTerms: [] });
    return respond({ text: "日本版最新是 X-VERSE-X。\n\n国际版慢半年♪", emotion: "happy", scene: "explanation", expressionIds: [], sourceIds: ["S1"] });
  };
  const webFetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ search_results: [
    { title: "CHUNITHM", url: "https://zh.wikipedia.org/wiki/CHUNITHM", chunks: [{ text: "CHUNITHM 最新版本是 X-VERSE-X。" }], snippet: "CHUNITHM 最新版本" }] }) });
  const settings = { ...base, searchGate: gateSettings({ mode: "auto" }), search: { apiKey: "kimi-fixture", cache: new Map() },
    c: { ...base.c, limits: { ...base.c.limits, userCooldownSeconds: 0 } } };
  const logs = [];
  const { mock, bot } = await setup({}, { botDeps: { settings, fetchImpl, webFetchImpl, log: (line) => logs.push(line) } });
  try {
    await bot.handleEvent("GROUP_AT_MESSAGE_CREATE", groupEvent({ content: "CHUNITHM 最新版本是什么" }));
    assert.equal(mock.state.sent.at(-1).body.content,
      "日本版最新是 X-VERSE-X。\n国际版慢半年♪\n\n参考资料：\nCHUNITHM\nhttps://zh.wikipedia.org/wiki/CHUNITHM");
    assert.ok(!logs.some((line) => /疑似未写完/.test(line)), logs.join("\n"));
  } finally { await bot.stop(); await mock.stop(); }
});

// ── 读引用（quotedMessage，默认关）──────────────────────────────────
// 「回复」一张图再 @ 美亚：被引用的那条在事件的 msg_elements 里（官方 2026-09-16 版文档的形状）。
// 2026-10-09 群里实测：读引用之前，这种问法被路由判成「问图但没图」，回一句「这边暂时看不到图片里的内容」。
const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const CAKE_URL = "https://multimedia.nt.qq.com.cn/download?appid=1&fileid=CAKE&rkey=RKEY&spec=0";
const quotedImageEvent = (over = {}) => groupEvent({
  content: "猫猫这个是定做的你的蛋糕，你觉得像吗", message_type: 103,
  message_scene: { source: "default", ext: ["msg_idx=REFIDX_self==", "ref_msg_idx=REFIDX_cake=="] },
  msg_elements: [{ msg_idx: "REFIDX_cake==", message_type: 0, content: "",
    author: { id: "U1", member_openid: "U1", bot: false },
    attachments: [{ content_type: "image/jpeg", filename: "cake.jpg", url: CAKE_URL, width: 1080, height: 1440, size: 300000 }] }],
  ...over,
});
function imageFetcher(fetched, ok = true) {
  return async (url) => {
    fetched.push(String(url));
    return ok ? new Response(PNG_1PX, { status: 200, headers: { "content-type": "image/png", "content-length": String(PNG_1PX.length) } })
      : new Response("gone", { status: 404 });
  };
}
const systemText = (body) => body.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");

test("读引用：默认关时跟改造前一模一样——不下载引用里的图，送给模型的请求跟没引用时逐字相同", async () => {
  const runs = [];
  for (const event of [quotedImageEvent(), groupEvent({ content: "猫猫这个是定做的你的蛋糕，你觉得像吗" })]) {
    const fetched = [], logs = [];
    const { mock, bot, model } = await setup({}, { botDeps: { mediaFetchImpl: imageFetcher(fetched), log: (line) => logs.push(line) } });
    try {
      assert.equal(bot.readQuoted, false);
      await bot.handleEvent("GROUP_AT_MESSAGE_CREATE", event);
      assert.ok(await mock.waitFor(() => mock.state.sent.length > 0));
      runs.push({ fetched, logs, model });
    } finally { await bot.stop(); await mock.stop(); }
  }
  const [withQuote, plain] = runs;
  assert.deepEqual(withQuote.fetched, [], "关着时不该去下引用里的图");
  assert.equal(withQuote.model.calls.length, 1);
  assert.equal(withQuote.model.routeCalls.length, 1);
  assert.deepEqual(withQuote.model.routeCalls.map((body) => body.messages), plain.model.routeCalls.map((body) => body.messages));
  assert.deepEqual(withQuote.model.calls[0].body.messages, plain.model.calls[0].body.messages);
  assert.match(systemText(withQuote.model.calls[0].body), /没有附带原图数据的引用图片仍然看不到，不能猜测。/);
  assert.ok(!withQuote.logs.some((line) => /引用消息结构|读引用/.test(line)), withQuote.logs.join("\n"));
});

test("读引用开着：回复一张图再 @ 美亚，那张图和本条的话一起交给模型，不再回「看不到」", async () => {
  const fetched = [], logs = [];
  const { mock, bot, model } = await setup({ quotedMessage: "read" }, {
    reply: "像！连耳朵都做出来了喵～", botDeps: { mediaFetchImpl: imageFetcher(fetched), log: (line) => logs.push(line) },
  });
  try {
    assert.ok(logs.some((line) => /^读引用：开/.test(line)), logs.join("\n"));
    await bot.handleEvent("GROUP_AT_MESSAGE_CREATE", quotedImageEvent());
    assert.ok(await mock.waitFor(() => mock.state.sent.length > 0));
    assert.deepEqual(fetched, [CAKE_URL]);
    assert.equal(model.routeCalls.length, 0, "看得到图就不走路由，跟直接发图一样");
    assert.equal(model.calls.length, 1);
    const body = model.calls[0].body;
    const user = body.messages.filter((m) => m.role === "user").at(-1);
    assert.equal(user.content[0].text, "猫猫这个是定做的你的蛋糕，你觉得像吗");
    assert.equal(user.content[1].type, "image_url");
    assert.match(user.content[1].image_url.url, /^data:image\/png;base64,/);
    const system = systemText(body);
    assert.match(system, /本条消息引用（回复）了下面这条消息[^\n]*\n群友：\[图片 1 张（原图已随本条消息一起给你）\]/);
    assert.match(system, /用户回复（引用）的那条消息里的图片，程序取到原图时也会一起提供给你/);
    assert.doesNotMatch(system, /没有附带原图数据的引用图片仍然看不到/);
    assert.match(mock.state.sent.at(-1).body.content, /连耳朵都做出来了/);
    assert.equal(logs.find((line) => line.startsWith("引用消息结构")),
      "引用消息结构（已取到被引用那条）：type=103｜ref_msg_idx 有｜msg_elements 1 条：#0 msg_idx 对上 type=0 正文 0 字 附件 image/jpeg×1 字段 attachments,author,content,message_type,msg_idx");
    assert.ok(!logs.some((line) => /CAKE|RKEY/.test(line)), "日志里不该有图片地址：\n" + logs.join("\n"));
  } finally { await bot.stop(); await mock.stop(); }
});

test("读引用开着：本条自己也带图时，自己的图排前面，提示词里说清引用的图排在后面", async () => {
  const fetched = [];
  const { mock, bot, model } = await setup({ quotedMessage: "read" }, { botDeps: { mediaFetchImpl: imageFetcher(fetched) } });
  try {
    await bot.handleEvent("GROUP_AT_MESSAGE_CREATE", quotedImageEvent({
      content: "左边是成品，你看哪个更像", attachments: [{ content_type: "image/png", url: "https://example.invalid/mine.png" }] }));
    assert.ok(await mock.waitFor(() => mock.state.sent.length > 0));
    assert.deepEqual(fetched, ["https://example.invalid/mine.png", CAKE_URL]);
    const user = model.calls[0].body.messages.filter((m) => m.role === "user").at(-1);
    assert.equal(user.content.filter((part) => part.type === "image_url").length, 2);
    assert.match(systemText(model.calls[0].body), /\n群友：\[图片 1 张（原图已随本条消息一起给你，排在本条自己那 1 张后面）\]/);
  } finally { await bot.stop(); await mock.stop(); }
});

test("读引用开着：引用里的图取不到时写明看不到；只 @ 不说话的那种直接回看不到，不让模型猜", async () => {
  const fetched = [];
  const { mock, bot, model } = await setup({ quotedMessage: "read" }, { botDeps: { mediaFetchImpl: imageFetcher(fetched, false) } });
  bot.settings.c.limits.userCooldownSeconds = 0;
  try {
    await bot.handleEvent("GROUP_AT_MESSAGE_CREATE", quotedImageEvent());
    assert.ok(await mock.waitFor(() => mock.state.sent.length > 0));
    assert.equal(fetched.length, 1);
    assert.equal(model.calls.length, 1);
    const body = model.calls[0].body;
    assert.ok(!body.messages.some((m) => Array.isArray(m.content)), "取不到原图就不能带图");
    assert.match(systemText(body), /\n群友：\[图片（内容看不到）\]/);
    const routeSystem = model.routeCalls[0].messages[0].content;
    assert.ok(routeSystem.includes('图片接入状态：{"hasImage":true,"hasReference":true,"visionAvailable":false,"images":[],"quotedImages":1}'), routeSystem.slice(-400));
    // 只 @ 了一下、没说话：本条正文是「[图片]」，路由按「问图但没图」直接回看不到
    const before = mock.state.sent.length;
    await bot.handleEvent("GROUP_AT_MESSAGE_CREATE", quotedImageEvent({ content: " " }));
    assert.ok(await mock.waitFor(() => mock.state.sent.length > before));
    assert.match(mock.state.sent.at(-1).body.content, /呜喵.*看不到/);
    assert.equal(model.calls.length, 1, "这一句没进聊天模型");
  } finally { await bot.stop(); await mock.stop(); }
});

test("读引用开着：引用的是美亚自己的话，署名写明是她自己；语音之类只标一句、不下载", async () => {
  const fetched = [];
  const { mock, bot, model } = await setup({ quotedMessage: "read" }, { botDeps: { mediaFetchImpl: imageFetcher(fetched) } });
  try {
    await bot.handleEvent("GROUP_MESSAGE_CREATE", groupEvent({
      content: "<@MIA_OPENID> 这首是哪个难度", message_type: 103,
      mentions: [{ bot: true, id: "MIA_OPENID", is_you: true, member_openid: "MIA_OPENID" }],
      message_scene: { source: "default", ext: ["ref_msg_idx=REFIDX_mine=="] },
      msg_elements: [{ msg_idx: "REFIDX_mine==", content: "推荐你打\n\nμ3 喵", author: { id: "MIA_OPENID", member_openid: "MIA_OPENID", bot: true },
        attachments: [{ content_type: "voice", url: "https://example.invalid/a.silk" }] }],
    }));
    assert.ok(await mock.waitFor(() => mock.state.sent.length > 0));
    assert.deepEqual(fetched, []);
    assert.match(systemText(model.calls[0].body), /\n美亚（你自己）：推荐你打 μ3 喵 \[语音\]$/m);
    assert.ok(model.routeCalls[0].messages.some((m) => String(m.content).includes("美亚（你自己）：推荐你打 μ3 喵")), "路由也看得到被引用的那句");
  } finally { await bot.stop(); await mock.stop(); }
});

test("读引用：配置写错按关闭处理，启动日志里说清楚", async () => {
  const logs = [];
  const { mock, bot } = await setup({ quotedMessage: "on" }, { botDeps: { log: (line) => logs.push(line) } });
  try {
    assert.equal(bot.readQuoted, false);
    assert.ok(logs.includes("⚠ quotedMessage 只能是 off / read，读引用先按关闭处理"), logs.join("\n"));
    assert.ok(!logs.some((line) => /^读引用：开/.test(line)));
  } finally { await bot.stop(); await mock.stop(); }
});

test("读引用开着：聊天记录里记下她看到的那条引用，不记图片地址和图本身", async () => {
  const fetched = [];
  const { mock, bot } = await setup({ quotedMessage: "read", chatLog: { mode: "replies" } }, { botDeps: { mediaFetchImpl: imageFetcher(fetched) } });
  try {
    await bot.handleEvent("GROUP_AT_MESSAGE_CREATE", quotedImageEvent());
    assert.ok(await mock.waitFor(() => readChatLog(bot.chatLog.dir).length > 0));
    const [r] = readChatLog(bot.chatLog.dir);
    assert.equal(r.text, "猫猫这个是定做的你的蛋糕，你觉得像吗");
    assert.equal(r.image, true);
    assert.equal(r.quote, true);
    assert.equal(r.quoted, "群友：[图片 1 张（原图已随本条消息一起给你）]");
    assert.doesNotMatch(JSON.stringify(r), /CAKE|RKEY|base64/);
  } finally { await bot.stop(); await mock.stop(); }
});

// ── 回复里的字面 \n ──────────────────────────────────────────────────
// 线上出现过：读引用那条蛋糕图，美亚的回复中间露出了「\n\n」。模型把换行在 JSON 里多转义了一层，
// 解出来是反斜杠加 n 两个字符，formatReply 折叠空行时认不出来，就原样发了出去。
const ESCAPED_REPLY = "呜喵！？这、这是美亚的蛋糕吗！\\n\\n话说回来，这真的是能吃的吗？\\(^o^)/";

test("回复里多转义的换行：发出去的是真换行（照常折成单个换行），会话历史里存的也是真换行", async () => {
  const fetched = [];
  const { mock, bot, model } = await setup({ quotedMessage: "read" }, { reply: ESCAPED_REPLY, botDeps: { mediaFetchImpl: imageFetcher(fetched) } });
  bot.settings.c.limits.userCooldownSeconds = 0;
  try {
    await bot.handleEvent("GROUP_AT_MESSAGE_CREATE", quotedImageEvent());
    assert.ok(await mock.waitFor(() => mock.state.sent.length > 0));
    assert.equal(mock.state.sent.at(-1).body.content, "呜喵！？这、这是美亚的蛋糕吗！\n话说回来，这真的是能吃的吗？\\(^o^)/",
      "颜文字里的反斜杠不是换行，原样留着");
    // 下一轮她会看到自己上一句：那里留着字面的 \n 的话，她会照着学
    await bot.handleEvent("GROUP_AT_MESSAGE_CREATE", groupEvent({ content: "那你要先拍照吗" }));
    assert.equal(model.calls.length, 2);
    const mine = model.calls[1].body.messages.filter((m) => m.role === "assistant" && String(m.content).includes("蛋糕吗"));
    assert.deepEqual(mine.map((m) => m.content), ["呜喵！？这、这是美亚的蛋糕吗！\n\n话说回来，这真的是能吃的吗？\\(^o^)/"]);
  } finally { await bot.stop(); await mock.stop(); }
});

test("纯文本降级那条路：模型直接写了字面的 \\n，同样还原成换行再发", async () => {
  const respond = (content) => ({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content } }] }) });
  const fetchImpl = async (_, options) => {
    const body = JSON.parse(options.body);
    if (String(body.messages[0].content).includes("MIA_SEMANTIC_ROUTER_V1")) return respond(JSON.stringify({ route: "chat" }));
    // JSON 模式两次都只给空白，逼它走纯文本降级（见 chat.cjs 的 parseReply 上方）
    if (body.response_format) return respond(" ");
    return respond("喵哼哼，收到啦！\\n\\n下次再来找美亚玩～");
  };
  const { mock, bot } = await setup({}, { botDeps: { fetchImpl } });
  try {
    await bot.handleEvent("GROUP_AT_MESSAGE_CREATE", groupEvent({ content: "美亚晚上好" }));
    assert.ok(await mock.waitFor(() => mock.state.sent.length > 0));
    assert.equal(mock.state.sent.at(-1).body.content, "喵哼哼，收到啦！\n下次再来找美亚玩～");
  } finally { await bot.stop(); await mock.stop(); }
});

// ── 表情：点名要图、提示词里的样例 ────────────────────────────────────
// 2026-10-10 群里「发个睡觉表情」：41 号标成「眯眼犯困」、图其实是爱心眼，她照着标注说「眯眼犯困，送你」。
// 标注在 expressions.json 里改好了；这里盯住程序侧的两件事。
const sentExpressions = (logs) => logs.filter((line) => line.startsWith("发送表情 ")).map((line) => line.slice(5).replace(/（.*$/, ""));

test("点名要表情：没点名字就发她排第一的那张，不再在候选里随机换；她说没有就不发；点了名字就发那张", async () => {
  const { pickImage, chooseImage } = require("../chat-core/chat.cjs");
  const logs = [];
  const { mock, bot } = await setup({}, {
    reply: "睡觉的没有哦，拿捧杯取暖那张顶一下～", expressionIds: ["warm_cup", "cat_hiss"], botDeps: { log: (line) => logs.push(line) },
  });
  bot.settings.c.limits.userCooldownSeconds = 0;
  try {
    // 她排第一的是捧杯；按概率配图时候选按清单顺序排，随机数 0 抽到的是排在前面的 21 号猫猫炸毛
    const result = { scene: "ordinary", emotion: "happy", expressionIds: ["warm_cup", "cat_hiss"] };
    const first = () => 0;
    assert.equal(chooseImage(result, bot.settings, false, first).id, "cat_hiss", "夹具前提：按概率配图会换成别的那张");
    assert.equal(pickImage(result, bot.settings, "发个睡觉表情", first).id, "warm_cup");
    assert.equal(pickImage(result, bot.settings, "帮我看看这张图", first).id, "cat_hiss", "没提「表情」的照旧按概率配");
    assert.equal(pickImage({ ...result, expressionIds: ["warm_cup"] }, bot.settings, "发个猫猫炸毛的表情", first).id, "cat_hiss", "点了名字就发那张");
    assert.equal(pickImage({ ...result, expressionIds: ["sleepy_yawn", "warm_cup"] }, bot.settings, "发个睡觉表情", first).id, "warm_cup", "编出来的 ID 跳过");
    assert.equal(pickImage({ ...result, scene: "distress" }, bot.settings, "发个睡觉表情", first), null);
    // 走 QQ 入口：连发几次，每次都是她排第一的那张
    for (let i = 0; i < 4; i++) {
      const before = mock.state.sent.length;
      await bot.handleEvent("GROUP_AT_MESSAGE_CREATE", groupEvent({ content: "发个睡觉表情" }));
      assert.ok(await mock.waitFor(() => mock.state.sent.length > before));
    }
    assert.deepEqual(sentExpressions(logs), Array(4).fill("42_捧杯取暖.gif"), logs.join("\n"));
  } finally { await bot.stop(); await mock.stop(); }

  const quiet = [];
  const none = await setup({}, { reply: "美亚没有睡觉的表情啦。", expressionIds: [], botDeps: { log: (line) => quiet.push(line) } });
  try {
    await none.bot.handleEvent("GROUP_AT_MESSAGE_CREATE", groupEvent({ content: "发个睡觉表情" }));
    assert.ok(await none.mock.waitFor(() => none.mock.state.sent.length > 0));
    assert.deepEqual(sentExpressions(quiet), [], "她说没有、也没给候选，就只发文字");
    assert.equal(none.mock.state.uploads.length, 0);
  } finally { await none.bot.stop(); await none.mock.stop(); }
});

test("提示词里的表情样例只用美亚清单里真有的 ID（原来那套是梨绪的，一个都对不上），而且不是空的", async () => {
  const { mock, bot, model } = await setup();
  try {
    await bot.handleEvent("GROUP_AT_MESSAGE_CREATE", groupEvent({ content: "今天打歌好累啊" }));
    assert.ok(await mock.waitFor(() => model.calls.length > 0));
    const known = new Set(bot.settings.manifest.entries.map((e) => e.id));
    const samples = model.calls[0].body.messages.filter((m) => m.role === "assistant" && m.content !== "{").map((m) => JSON.parse(m.content));
    assert.ok(samples.length > 0, "应当至少有一条样例");
    for (const sample of samples.filter((s) => s.scene !== "distress")) {
      assert.ok(sample.expressionIds.length > 0, "样例要带表情候选，不然模型学会永远给空数组");
      assert.deepEqual(sample.expressionIds.filter((id) => !known.has(id)), [], "样例里的表情 ID 必须是清单里真有的");
    }
    assert.ok(samples.some((s) => s.expressionIds.join() === "sparkle_wink,bashful_glance"), "被夸那条用 examples.json 里自带的表情");
  } finally { await bot.stop(); await mock.stop(); }
});

test("点名要表情不过语义路由：路由把它判成「在问图片」时，也是聊天这边回话配图，不会图对话不对", async () => {
  // 2026-10-10 线上：「发个猫猫炸毛的表情」被路由判成 media，回了一句「这边暂时看不到图片里的内容」，
  // 程序又按名字贴上了 21 号；「发个睡觉表情」只剩那句话。真模型 4 次里 2 次这么判，路由规则里写了也没用。
  const respond = (content) => ({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }) });
  let routes = 0;
  const logs = [];
  const fetchImpl = async (_, options) => {
    const body = JSON.parse(options.body);
    if (String(body.messages[0].content).includes("MIA_SEMANTIC_ROUTER_V1")) { routes++; return respond({ route: "media" }); }
    return respond({ text: "哼，炸毛就炸毛！喏，这张给你。", emotion: "angry", scene: "banter", expressionIds: ["warm_cup", "cat_hiss"] });
  };
  const { mock, bot } = await setup({}, { botDeps: { fetchImpl, log: (line) => logs.push(line) } });
  bot.settings.c.limits.userCooldownSeconds = 0;
  try {
    for (const content of ["发个猫猫炸毛的表情", "发个睡觉表情"]) {
      const before = mock.state.sent.length;
      await bot.handleEvent("GROUP_AT_MESSAGE_CREATE", groupEvent({ content }));
      assert.ok(await mock.waitFor(() => mock.state.sent.length > before));
      assert.equal(mock.state.sent.at(-1).body.content, "哼，炸毛就炸毛！喏，这张给你。", content + " 应当是聊天这边的回话");
    }
    assert.equal(routes, 0, "点名要表情不该去问语义路由");
    assert.deepEqual(sentExpressions(logs), ["21_猫猫炸毛.jpg", "42_捧杯取暖.gif"], logs.join("\n"));
    // 真在问图片内容的照旧走路由；路由那句「看不到」不配表情图
    const before = mock.state.sent.length;
    await bot.handleEvent("GROUP_AT_MESSAGE_CREATE", groupEvent({ content: "这张图片写了什么" }));
    assert.ok(await mock.waitFor(() => mock.state.sent.length > before));
    assert.match(mock.state.sent.at(-1).body.content, /看不到图片里的内容/);
    assert.equal(sentExpressions(logs).length, 2, "路由那句话不配表情图");
  } finally { await bot.stop(); await mock.stop(); }
});
