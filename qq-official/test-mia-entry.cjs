"use strict";
// 美亚 QQ 官方入口测试。全程走 mock-official + 假模型，不碰真接口、不花钱。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const core = require("../takase-core.cjs");
const { createMockOfficial } = require("./mock-official.cjs");
const { createMiaBot } = require("./mia-entry.cjs");

const GROUP = "GROUP_OPENID_A";
const OTHER_GROUP = "GROUP_OPENID_B";

// 假模型：永远回同一句，并把收到的消息记下来供断言。
// action 非空时会在 JSON 里带上工具调用，用来测聊天路径。
function fakeModel(reply = "喵哼哼，收到啦！", expressionIds = [], action = null) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body) });
    const payload = { text: reply, emotion: "happy", scene: "ordinary", expressionIds };
    if (action) payload.action = action;
    return {
      ok: true, status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
    };
  };
  return { fetchImpl, calls };
}

// 出图和凭据库都是真实现（要 spawn exe），这里从 module.exports 上顶掉。
// takase-core 的 coreCall() 正是为此存在的（takase-core.cjs:780-782）。
const STUBBED = ["getBinding", "saveBinding", "vaultCall", "verifyAccount",
  "generateChart", "generateSongChart", "generateChartInfo", "generateCompletionChart", "generateLevelChart"];
function stubCore(overrides = {}) {
  const original = {};
  for (const name of STUBBED) original[name] = core[name];
  Object.assign(core, {
    getBinding: async () => null,
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
  mock.push("GROUP_AT_MESSAGE_CREATE", groupEvent({ content: "@全体成员 开会啦" }));
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

// ── 聊天路径的工具调用 ──────────────────────────────────────────────
test("聊天里模型挑的工具真的被执行：先发引出语，结果由程序发", async () => {
  const restore = stubCore({ getBinding: async () => ({ playerName: "测试玩家", email: "a@b.c", password: "x" }) });
  try {
    const { mock, bot } = await setup({}, { reply: "喵哼哼，这就去翻你的成绩", action: { name: "chart" } });
    mock.push("GROUP_AT_MESSAGE_CREATE", groupEvent({ content: "帮我查一下分表" }));
    assert.ok(await mock.waitFor(() => mock.state.sent.some((s) => s.body?.msg_type === 7), 5000), "应当出图、上传并发送");
    const text = sentText(mock);
    assert.match(text, /这就去翻你的成绩/, "模型那句引出语要发出去");
    assert.ok(mock.state.sent.some((s) => s.body?.msg_type === 7), "结果以图片形式发出");
    await bot.stop(); await mock.stop();
  } finally { restore(); }
});

test("聊天里模型编的工具名不在清单里：直接丢弃，那句话照发", async () => {
  const restore = stubCore();
  try {
    const { mock, bot, model } = await setup({}, { reply: "美亚看看哦", action: { name: "rm-rf", query: "/" } });
    mock.push("GROUP_AT_MESSAGE_CREATE", groupEvent({ content: "美亚帮我干点活" }));
    assert.ok(await mock.waitFor(() => mock.state.sent.length > 0));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(model.calls.length, 1, "模型是调了的");
    assert.match(sentText(mock), /美亚看看哦/, "工具被丢弃后，模型那句话照常发出去");
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
