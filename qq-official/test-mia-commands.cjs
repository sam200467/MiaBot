"use strict";
// 美亚指令层的测试。**不起网关、不调模型、不花钱** —— 直接构造 createMiaCommands，
// 用假的 send / sendImage 收结果。
//
// 凭据库和出图核心都是真实现（要 spawn exe），所以这里按仓库既有做法从
// module.exports 上顶掉它们：takase-core 的 coreCall() 就是为此存在的
// （takase-core.cjs:780-782 那段注释）。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const core = require("../takase-core.cjs");
const { createMiaCommands, parseCommand, ALIASES } = require("./mia-commands.cjs");

const GROUP = "GROUP_OPENID_A";

// ── 夹具 ────────────────────────────────────────────────────────────
// 每个用例一份独立的临时目录：别名库是 takase-core 的模块级单例，
// 让它们各自指向自己的目录，用例之间就不会串。
function setup(configOverrides = {}, optionOverrides = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mia-cmd-"));
  const sent = [];
  const config = {
    vaultPath: path.join(tmp, "bindings.dat"),
    aliasDir: path.join(tmp, "aliases"),
    aliasScope: "mia-test",
    ...configOverrides,
  };
  const transport = {
    state: { connected: true }, healthy: () => true,
  };
  const commands = createMiaCommands({
    config,
    transport,
    send: async (event, text) => { sent.push({ type: event.type, text: String(text) }); return { id: "s" + sent.length }; },
    sendImage: async (event, image, caption) => { sent.push({ type: event.type, kind: "image", caption: String(caption || "") }); return { id: "s" + sent.length }; },
    log: () => {},
    ...optionOverrides,
  });
  commands.registerCore();
  return { commands, sent, transport, tmp, config };
}

// 事件形状与 official-transport 的 normalize() 输出一致
const groupEvent = (content, over = {}) => ({
  type: "group", eventName: "GROUP_AT_MESSAGE_CREATE", openid: GROUP, userId: "U1",
  content, msgId: "m-" + Math.random().toString(36).slice(2, 8),
  mentioned: true, mentionedOpenids: [], refId: null, ...over,
});
const c2cEvent = (content, over = {}) => ({
  type: "c2c", eventName: "C2C_MESSAGE_CREATE", openid: "U2", userId: "U2",
  content, msgId: "c-" + Math.random().toString(36).slice(2, 8),
  mentioned: true, mentionedOpenids: [], refId: null, ...over,
});

// 每次用例前后把被动过手脚的 core 函数恢复回去
const PATCHED = ["getBinding", "saveBinding", "vaultCall", "verifyAccount",
  "generateChart", "generateSongChart", "generateChartInfo", "generateCompletionChart", "generateLevelChart"];
function stub(overrides = {}) {
  const original = {};
  for (const name of PATCHED) original[name] = core[name];
  const defaults = {
    getBinding: async () => null,
    saveBinding: async () => {},
    vaultCall: async () => "0",
    verifyAccount: async () => "测试玩家",
    generateChart: async () => ({ name: "chart.png", buffer: Buffer.from("png"), meta: {} }),
    generateSongChart: async () => ({ name: "song.png", buffer: Buffer.from("png"), meta: {} }),
    generateChartInfo: async () => ({ name: "ci.png", buffer: Buffer.from("png"), meta: {} }),
    generateCompletionChart: async () => ({ name: "plate.png", buffer: Buffer.from("png"), meta: {} }),
    generateLevelChart: async () => ({ name: "level.png", buffer: Buffer.from("png"), meta: {} }),
  };
  Object.assign(core, defaults, overrides);
  return () => { Object.assign(core, original); };
}
const run = async (configOverrides, overrides, body) => {
  const restore = stub(overrides);
  try { await body(setup(configOverrides)); } finally { restore(); }
};

// 队列那类用例没法靠 await 排序（dispatch 会一直等到图出完），
// 所以轮询等状态到位，比数 setImmediate 次数稳。
async function waitUntil(predicate, timeoutMs = 2000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return false;
}

// ── 解析 ────────────────────────────────────────────────────────────
test("前缀矩阵：斜杠、半角井号、全角井号都认", () => {
  for (const prefix of ["/", "#", "＃"]) {
    assert.equal(parseCommand(prefix + "help")?.name, "help", prefix + "help");
    assert.equal(parseCommand(prefix + "帮助")?.name, "help", prefix + "帮助");
  }
  assert.equal(parseCommand("帮助"), null, "没前缀就不是指令");
  assert.deepEqual(parseCommand("/不存在"), { name: null, rest: "" }, "前缀对但词不认识");
  assert.deepEqual(parseCommand("/单曲 id870"), { name: "song", rest: "id870" });
  assert.deepEqual(parseCommand("/  单曲   id870  "), { name: "song", rest: "id870" });
});

test("/b110 是分表的别名", () => {
  assert.equal(parseCommand("/b110")?.name, "chart");
  assert.equal(parseCommand("/B110")?.name, "chart", "大小写不敏感");
  assert.equal(parseCommand("/b50")?.name, "chart");
});

test("同一个说法在两个 bot 上必须是同一个意思（冲突守卫）", () => {
  // 早先这条写的是「美亚必须覆盖梨绪的全部说法」—— 那是按「两边完全一致」设的。
  // 2026-09-19 美亚砍掉了「别名候选 / 驳回候选」两条，覆盖式断言就站不住了。
  // 但**真正要防的不是「少了几条」，是「同一个词在两边指不同的东西」**：
  // 那才是用户在两个 bot 之间换着用时会被坑的地方。所以改成查冲突，允许美亚更少。
  const rio = require("../qq/qq-entry.cjs").ALIASES;
  const lookup = (table) => {
    const map = new Map();
    for (const [name, words] of Object.entries(table)) {
      for (const word of words) map.set(word.toLowerCase(), name);
    }
    return map;
  };
  const mine = lookup(ALIASES);
  const theirs = lookup(rio);
  const conflicts = [];
  for (const [word, name] of mine) {
    const other = theirs.get(word);
    if (other && other !== name) conflicts.push(word + "：美亚=" + name + "，梨绪=" + other);
  }
  assert.deepEqual(conflicts, [], "同一个说法在两边指的不是同一条指令");
});

test("候选/驳回那两条确实没有了（美亚不做复核流程）", () => {
  // 用户要求简化：添加别名就加上了、删除别名删了就删了，中间不夹一层人工复核。
  // 这条防止哪天有人「顺手」把它们加回来。
  for (const word of ["别名候选", "驳回别名候选", "aliascandidates", "aliasreject", "驳回候选"]) {
    const parsed = parseCommand("/" + word);
    assert.equal(parsed?.name, null, word + " 不该再是一条指令（prefix 命中但词不认识才对）");
  }
});

test("工具清单里每个能力都有可达的关键字", () => {
  const reachable = new Set(Object.values(ALIASES).flat());
  for (const spec of core.CAPABILITY_SPECS) {
    assert.ok(
      Object.entries(ALIASES).some(([name, words]) => words.includes(spec.name) || (name === spec.name && words.length)),
      "能力 " + spec.name + " 没有关键字入口（可达集大小 " + reachable.size + "）");
  }
});

// ── 指令路径 ────────────────────────────────────────────────────────
test("/帮助 不碰模型也不碰凭据库", async () => {
  let bindingCalls = 0;
  await run({}, { getBinding: async () => { bindingCalls++; return null; } }, async ({ commands, sent }) => {
    await commands.handleCommand(groupEvent("/帮助"), parseCommand("/帮助"));
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /美亚的小道具/);
    assert.match(sent[0].text, /\/b110/, "帮助里要写明 b110 也认");
    assert.equal(bindingCalls, 0, "帮助不该去读凭据库");
  });
});

test("闲聊触发帮助：开场、清单、安全提醒分段，且不重复群绑定说明", async () => {
  await run({}, {}, async ({ commands, sent }) => {
    await commands.runCapability(groupEvent("帮我看看功能"), "help", "", "喵哼哼，这就把清单翻给你看～");
    const text = sent[0].text;
    assert.ok(text.startsWith("喵哼哼，这就把清单翻给你看～\n\n美亚的小道具"), "开场与清单之间要空一行");
    assert.match(text, /\/取消[^\n]*\n\n等等，这里要认真听/, "清单与安全提醒之间要空一行");
    assert.ok(!text.includes("群里绑定："), "不要把 /绑定 的说明重复写两遍");
    assert.match(text, /别人能不能查你的成绩/, "权限开关说的是用户自己的成绩，不是美亚的成绩");
  });
});

test("未知指令：回在原地，措辞是美亚的", async () => {
  await run({}, {}, async ({ commands, sent }) => {
    await commands.handleCommand(groupEvent("/瞎写的"), parseCommand("/瞎写的"));
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /美亚不认识/);
    assert.match(sent[0].text, /\/帮助/);
  });
});

test("未绑定：给绑定引导，而且不入队出图", async () => {
  await run({}, { getBinding: async () => null }, async ({ commands, sent }) => {
    await commands.handleCommand(groupEvent("/分表"), parseCommand("/分表"));
    assert.equal(sent.length, 1, "只该有一条引导，不该有占位和图片");
    assert.match(sent[0].text, /撤回/, "引导必须提醒用户自行撤回凭据");
    assert.equal(commands.state.queue.length, 0, "不该入队");
  });
});

test("群里发 /绑定 直接启动群会话，并提醒用户手动撤回", async () => {
  await run({}, {}, async ({ commands, sent }) => {
    const e = groupEvent("/绑定", { msgId: "bind-probe" });
    await commands.handleCommand(e, parseCommand("/绑定"));
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, "group", "只能回在群里");
    assert.match(sent[0].text, /群绑定已开启/);
    assert.match(sent[0].text, /长按.*撤回/s);
    assert.equal(commands.getSession("U1")?.state, "awaitingEmail");
  });
});

test("出图失败用 core 给的 failText，不是从 label 推导", async () => {
  await run({}, {
    getBinding: async () => ({ playerName: "测试玩家", email: "a@b.c", password: "x" }),
    generateChart: async () => { throw new Error("核心炸了"); },
  }, async ({ commands, sent }) => {
    await commands.handleCommand(groupEvent("/分表"), parseCommand("/分表"));
    const all = sent.map((s) => s.text).join("\n");
    assert.match(all, /分表生成失败：/, "要用 plan.failText");
    assert.match(all, /核心炸了/, "带上真实原因");
    // 梨绪那边是 label.replace(/^正在生成/,"") 推出来的，会变成「测试玩家的分表生成失败：」
    assert.ok(!/测试玩家的分表生成失败/.test(all), "不该出现 label 推导出来的那句");
  });
});

test("出图成功：先占位再发图，caption 来自 core", async () => {
  await run({}, {
    getBinding: async () => ({ playerName: "测试玩家", email: "a@b.c", password: "x" }),
  }, async ({ commands, sent }) => {
    await commands.handleCommand(groupEvent("/分表"), parseCommand("/分表"));
    assert.equal(sent.length, 2, "占位 + 图片");
    assert.match(sent[0].text, /美亚这就去弄|交给美亚/, "占位是美亚的口气");
    assert.equal(sent[1].kind, "image");
    assert.match(sent[1].caption, /测试玩家/, "caption 里要有玩家名");
  });
});

test("冷却：同一类图 2 秒内只放一次", async () => {
  await run({}, {
    getBinding: async () => ({ playerName: "测试玩家", email: "a@b.c", password: "x" }),
  }, async ({ commands, sent }) => {
    await commands.handleCommand(groupEvent("/分表"), parseCommand("/分表"));
    const after1 = sent.length;
    await commands.handleCommand(groupEvent("/分表"), parseCommand("/分表"));
    const added = sent.slice(after1).map((s) => s.text).join("\n");
    assert.match(added, /再等 \d+ 秒/, "要带上还剩多少秒，否则用户不知道该等多久");
  });
});

test("队列满时被挡回来的那次不烧冷却，也不留下占位", async () => {
  // 出图卡住不返回，队列就会积起来（MAX_QUEUE = 3）。
  // 被队列挡回来的那一次，**冷却不该被记上** —— 梨绪那边是先记冷却再入队，
  // 于是被挡的用户要白等 60 秒才能重试，而他那张图压根没开始做。
  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = async () => { await gate; return { name: "x.png", buffer: Buffer.from("png"), meta: {} }; };
  await run({}, {
    getBinding: async () => ({ playerName: "测试玩家", email: "a@b.c", password: "x" }),
    generateChart: slow, generateSongChart: slow, generateLevelChart: slow, generateCompletionChart: slow,
  }, async ({ commands, sent }) => {
    try {
      // 四个不同的 kind 同时发起：第一个立刻开跑，后三个排进队列 → queue.length = 3
      const inflight = ["/分表", "/单曲 id870", "/等级 14", "/牌子 闪击"]
        .map((cmd) => commands.handleCommand(groupEvent(cmd), parseCommand(cmd)));
      await waitUntil(() => commands.state.queue.length === 3);
      assert.equal(commands.state.queue.length, 3, "前提：队列应当刚好满了");

      // 第五个（谱面分析，又一个不同的 kind）应当被队列挡回来
      const before = sent.length;
      await commands.handleCommand(groupEvent("/谱面分析 id870 master"), parseCommand("/谱面分析 id870 master"));
      const added = sent.slice(before).map((s) => s.text).join("\n");
      assert.match(added, /活儿太多/, "队列满要明确拒绝，不能默默排进去");
      assert.ok(!commands.state.queuedUsers.has("chartinfo:U1"), "被挡回来的那次要把占位清掉，否则用户永远等不到");

      // 放行之后再做一次谱面分析：**不该**被冷却拦下（说明那次没记冷却）
      release();
      await Promise.all(inflight);
      const before2 = sent.length;
      await commands.handleCommand(groupEvent("/谱面分析 id870 master"), parseCommand("/谱面分析 id870 master"));
      const added2 = sent.slice(before2).map((s) => s.text).join("\n");
      assert.ok(!/等 \d+ 秒再叫美亚/.test(added2), "被队列挡回来的那次不该烧掉冷却");
      assert.match(added2, /美亚这就去弄|交给美亚/, "应当正常开始生成");
    } finally { release(); }
  });
});

test("Rating 计算：四样没给全就拒绝，并把正确格式给回去", async () => {
  // 核心那边缺参数会静默按「铃铛无 / 连击无」算出一个具体的数。用户问的是半句话、
  // 拿到的却是一个确定的 Rating —— 跟「参数不全就拒绝并给出格式」相反。
  // 实测还抓到过模型自己把铃铛补成 fb、连击补成 fc，所以这条闸在程序侧兜底。
  await run({}, {}, async ({ commands, sent }) => {
    for (const partial of ["/计算 14.2 1000737", "/计算 14.2 1000737 fb", "/计算 14.2"]) {
      sent.length = 0;
      await commands.handleCommand(groupEvent(partial), parseCommand(partial));
      const text = sent.map((s) => s.text).join("\n");
      assert.ok(!/基础分/.test(text), partial + " 不该算出一个 Rating（实际：" + text.slice(0, 60) + "）");
      assert.match(text, /四样|定数/, partial + " 要说明缺什么");
    }
    // 给全了就该真算
    sent.length = 0;
    await commands.handleCommand(groupEvent("/计算 14.2 1000737 fb none"), parseCommand("/计算 14.2 1000737 fb none"));
    assert.match(sent.map((s) => s.text).join("\n"), /基础分/, "四样齐了就该算");
  });
});

test("Rating 计算：闲聊路径同样不放行半套参数", async () => {
  await run({}, {}, async ({ commands, sent }) => {
    // 模型实测给过这几种形状，都要被拦下
    for (const query of ["14.2 | 1000737", "14.2,1000737", "定数 14.2，技术分 1000737"]) {
      sent.length = 0;
      await commands.runCapability(c2cEvent("x"), "calculate", query);
      assert.ok(!/基础分/.test(sent.map((s) => s.text).join("\n")),
        JSON.stringify(query) + " 不该算出 Rating");
    }
    // 四样齐（空格或竖线分隔）都要放行。
    // ⚠ 不用逗号做分隔：核心的预处理会把「2,1」当千分位合并成「14.21000737」，
    // 核自己也拒绝那种写法，闸门跟它保持一致就行。
    for (const query of ["14.2 1000737 fb none", "14.2|1000737|fb|fc", "14.2 1000737 ab-plus none"]) {
      sent.length = 0;
      await commands.runCapability(c2cEvent("x"), "calculate", query);
      assert.match(sent.map((s) => s.text).join("\n"), /基础分/,
        JSON.stringify(query) + " 四样齐了就该算");
    }
  });
});

test("模型编的铃铛/连击要能识别出来", async () => {
  // 实测抓到过：用户只说「算一下 14.2 打 1000737」，模型自己补成 fb / fc 就去算了，
  // 回复里还写成「铃铛 fb、连击 fc」，像是用户说过一样。这条是那道闸的判据。
  const { commands } = setup();
  const invented = (q, src) => commands.hasInventedEnum(q, src).length > 0;

  // 用户没说 → 判为编的（这就是要拦的情况）
  assert.equal(invented("14.2 1000737 fb fc", "算一下 14.2 打 1000737 能有多少 rating"), true);
  assert.equal(invented("14.2 1000737 fb", "算一下 14.2 打 1000737"), true);

  // 用户说了 → 放行。⚠ 判据不能是逐字相等：模型会把话**规范化**
  // （「没有」→none、「ab+」→ab-plus、「全连」→fc），逐字比会把这些正常翻译误拦成编的。
  assert.equal(invented("14.2 1000737 fb fc", "14.2 打 1000737，铃铛 fb，连击 fc"), false);
  assert.equal(invented("14.2 1000737 ab-plus none", "14.2 打 1000737，连击 ab+，铃铛没有"), false);
  assert.equal(invented("14.2 1000737 none none", "14.2 打 1000737，铃铛和连击都没有"), false);
  assert.equal(invented("14.2 1000737 fc none", "14.2 打 1000737，全连，铃铛没开"), false);

  // 一个都没给：核心会把两个都当 none。那等于替用户假设了「没开铃铛、没连击」，
  // 所以照样判为「要追问」—— 跟 hasFullCalculateArgs 那道闸结论一致。
  assert.equal(invented("14.2 1000737", "算一下 14.2 打 1000737"), true);

  // 模型多塞的无害值不该算它编的：实测用户说「铃铛 fb，连击 fc」时模型传的是
  // `14.2 1000737 none fb fc`，那个多出来的 none 核心会忽略，判成「编的」会误拦正常请求。
  assert.equal(invented("14.2 1000737 none fb fc", "算一下 14.2 打 1000737，铃铛 fb，连击 fc"), false);
});

// ── 幂等闸 ──────────────────────────────────────────────────────────
test("幂等闸：同一条消息认一次，不同消息各认一次", () => {
  const { commands } = setup();
  const e = groupEvent("x", { msgId: "same-id" });
  assert.equal(commands.claimEvent(e), true, "第一次认领");
  assert.equal(commands.claimEvent(e), false, "同一条再来一次要被挡");
  assert.equal(commands.claimEvent(groupEvent("x", { msgId: "other-id" })), true, "不同的消息要放行");
  // 取键函数单独可换 —— probe 出真实 payload 形状后改这里一处
  assert.equal(commands.messageKey(e), "same-id");
  assert.equal(commands.claimEvent(groupEvent("x", { msgId: "" })), true, "没有 id 就没法判重，放行比吞掉好");
});

// ── 绑定会话 ────────────────────────────────────────────────────────
test("绑定：邮箱连错 3 次就放弃", async () => {
  await run({}, {}, async ({ commands, sent }) => {
    await commands.handleCommand(c2cEvent("/绑定"), parseCommand("/绑定"));
    for (const bad of ["不是邮箱", "还不是", "依然不是"]) {
      await commands.continueSession(c2cEvent(bad), bad);
    }
    assert.match(sent[sent.length - 1].text, /放弃/);
    assert.equal(commands.getSession("U2"), null, "放弃后会话要清掉");
  });
});

test("绑定：邮箱对了才要密码，密码不进 session、不进任何一条发送", async () => {
  const SECRET = "hunter2-绝密-☂";
  await run({}, {}, async ({ commands, sent, config }) => {
    await commands.handleCommand(c2cEvent("/绑定"), parseCommand("/绑定"));
    await commands.continueSession(c2cEvent("me@example.com"), "me@example.com");
    assert.equal(commands.getSession("U2").state, "awaitingPassword");

    await commands.continueSession(c2cEvent(SECRET), SECRET);
    await new Promise((r) => setTimeout(r, 50));

    const dump = JSON.stringify(sent);
    assert.ok(!dump.includes(SECRET), "密码不能出现在任何一条发出去的消息里");
    assert.ok(!JSON.stringify([...commands.state.sessions.values()]).includes(SECRET), "密码不能存在 session 里");
    // 会话跑完要清掉，邮箱也一并擦掉
    assert.equal(commands.getSession("U2"), null, "验证完会话要结束");
    assert.match(sent[sent.length - 1].text, /绑好啦/, "成功文案是美亚的口气");
    assert.ok(config.vaultPath, "保存走的是注入的 vaultPath");
  });
});

test("群绑定：邮箱和密码不进发送或 session，并提示用户手动撤回", async () => {
  const SECRET = "group-secret-绝密";
  let verified = 0;
  await run({}, { verifyAccount: async () => { verified += 1; return "群玩家"; } }, async ({ commands, sent }) => {
    await commands.handleCommand(groupEvent("/绑定", { msgId: "start" }), parseCommand("/绑定"));
    assert.equal(commands.getSession("U1")?.openid, GROUP, "会话要锁定发起群，不能跨群吞消息");

    await commands.continueSession(groupEvent("me@example.com", { msgId: "email" }), "me@example.com");
    await commands.continueSession(groupEvent(SECRET, { msgId: "password" }), SECRET);
    assert.ok(await waitUntil(() => commands.getSession("U1") === null), "验证应当完成");

    assert.equal(verified, 1);
    assert.ok(!JSON.stringify(sent).includes(SECRET), "密码不能出现在回复里");
    assert.match(sent.map((x) => x.text).join("\n"), /密码消息.*撤回/s, "要明确提醒手动撤回密码");
  });
});

test("群绑定不会调用官方撤回接口", async () => {
  await run({}, {}, async ({ commands, transport }) => {
    let recallCalls = 0;
    transport.recallGroupMessage = async () => { recallCalls += 1; throw new Error("官方撤回故障"); };
    await commands.handleCommand(groupEvent("/绑定", { msgId: "start" }), parseCommand("/绑定"));
    await commands.continueSession(groupEvent("me@example.com", { msgId: "email" }), "me@example.com");
    await commands.continueSession(groupEvent("password", { msgId: "password" }), "password");
    assert.equal(recallCalls, 0, "任何一步都不应调用自动撤回");
  });
});

test("群绑定会话不能跨群接管消息", async () => {
  await run({}, {}, async ({ commands }) => {
    await commands.handleCommand(groupEvent("/绑定", { msgId: "start" }), parseCommand("/绑定"));
    const handled = await commands.continueSession(groupEvent("me@example.com", { openid: "OTHER_GROUP", msgId: "other" }), "me@example.com");
    assert.equal(handled, false);
    assert.equal(commands.getSession("U1")?.state, "awaitingEmail", "别群消息不能推进会话");
  });
});

test("绑定：验证期间再发文字只回等待提示，不再入队", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  await run({}, { verifyAccount: async () => { await gate; return "玩家"; } }, async ({ commands, sent }) => {
    await commands.handleCommand(c2cEvent("/绑定"), parseCommand("/绑定"));
    await commands.continueSession(c2cEvent("me@example.com"), "me@example.com");
    await commands.continueSession(c2cEvent("pw"), "pw");
    await commands.continueSession(c2cEvent("又来一句"), "又来一句");
    assert.match(sent[sent.length - 1].text, /还在验/, "重复输入只提示等待");
    release();
    await new Promise((r) => setTimeout(r, 50));
  });
});

test("绑定：结果发送期间会话已结束，不会再误回等待提示", async () => {
  const restore = stub();
  let releaseSuccess;
  let successStarted;
  const successGate = new Promise((resolve) => { releaseSuccess = resolve; });
  const successSeen = new Promise((resolve) => { successStarted = resolve; });
  const externalSent = [];
  const fixture = setup({}, {
    send: async (event, text) => {
      externalSent.push(String(text));
      if (String(text).includes("绑好啦")) {
        successStarted();
        await successGate;
      }
      return { id: "external-" + externalSent.length };
    },
  });
  try {
    await fixture.commands.handleCommand(c2cEvent("/绑定"), parseCommand("/绑定"));
    await fixture.commands.continueSession(c2cEvent("me@example.com"), "me@example.com");
    await fixture.commands.continueSession(c2cEvent("pw"), "pw");
    await successSeen;
    assert.equal(fixture.commands.getSession("U2"), null, "最终消息还在发送时，会话也必须已经清掉");
    const handled = await fixture.commands.continueSession(c2cEvent("聊天有人设就行"), "聊天有人设就行");
    assert.equal(handled, false, "成功后的普通聊天不能再落进 verifying 会话");
    assert.ok(!externalSent.some((text) => text.includes("还在验")), "不能误发等待提示");
  } finally {
    releaseSuccess();
    restore();
  }
});

test("解绑：要两次确认，确认时才真的删", async () => {
  const deleted = [];
  await run({}, {
    getBinding: async () => ({ playerName: "玩家", email: "a@b.c", password: "x" }),
    vaultCall: async (cfg, cmd, args) => { deleted.push(cmd); return "0"; },
  }, async ({ commands, sent }) => {
    await commands.handleCommand(c2cEvent("/解绑"), parseCommand("/解绑"));
    assert.match(sent[sent.length - 1].text, /再发一次/, "第一次只给确认提示");
    assert.deepEqual(deleted, [], "第一次不能真删");

    await commands.handleCommand(c2cEvent("/解绑"), parseCommand("/解绑"));
    assert.deepEqual(deleted, ["delete"], "第二次才删");
    assert.match(sent[sent.length - 1].text, /已经删掉/);
  });
});

test("解绑确认期间：continueSession 必须拒绝接管", async () => {
  // 这条契约是入口那边依赖的：handleEvent 要先判 confirmUnbind、自己发提醒，
  // 才能把「解绑」的确认走完。如果 continueSession 把 confirmUnbind 也接了，
  // 用户发来的「解绑」会掉进绑定流程的兜底，收到一句「正在验证，请稍候……」——
  // 线上真出过这个问题（qq/qq-entry.cjs:782-784 的注释）。
  await run({}, {
    getBinding: async () => ({ playerName: "玩家", email: "a@b.c", password: "x" }),
  }, async ({ commands, sent }) => {
    await commands.handleCommand(c2cEvent("/解绑"), parseCommand("/解绑"));
    const before = sent.length;
    const handled = await commands.continueSession(c2cEvent("随便说点什么"), "随便说点什么");
    assert.equal(handled, false, "confirmUnbind 状态下不该接管");
    assert.equal(sent.length, before, "更不该自己发一条出去");
    assert.equal(commands.getSession("U2")?.state, "confirmUnbind", "会话要保持原样等确认");
  });
});

test("取消：有会话就中断，没有就照实说", async () => {
  await run({}, {}, async ({ commands, sent }) => {
    await commands.handleCommand(c2cEvent("/取消"), parseCommand("/取消"));
    assert.match(sent[sent.length - 1].text, /没有在办的事/);

    await commands.handleCommand(c2cEvent("/绑定"), parseCommand("/绑定"));
    await commands.handleCommand(c2cEvent("/取消"), parseCommand("/取消"));
    assert.equal(commands.getSession("U2"), null, "取消要清掉会话");
    assert.match(sent[sent.length - 1].text, /那就不弄啦/);
  });
});

// ── 别名 ────────────────────────────────────────────────────────────
test("删除别名的白名单：没有 / 是本人 / 是别人", async () => {
  const mk = (ids) => setup({ aliasDeleteOpenids: ids });
  const cmd = parseCommand("/删除别名 id870 | 八爪鱼");
  const argv = ["/删除别名 id870 | 八爪鱼"];

  // 名单为空 → 谁都不能删
  {
    const { commands, sent } = mk([]);
    await commands.handleCommand(c2cEvent(argv[0], { userId: "U2" }), cmd);
    assert.match(sent[sent.length - 1].text, /只认指定的人/);
  }
  // 名单里有别人，没有我 → 还是不能删
  {
    const { commands, sent } = mk(["SOMEONE_ELSE"]);
    await commands.handleCommand(c2cEvent(argv[0], { userId: "U2" }), cmd);
    assert.match(sent[sent.length - 1].text, /只认指定的人/);
  }
  // 名单里有我 → 走到真正的删除逻辑（这里曲名找不到，所以是「没有找到曲目」之类，
  // 关键是**不再**是权限拒绝）
  {
    const { commands, sent } = mk(["U2"]);
    await commands.handleCommand(c2cEvent(argv[0], { userId: "U2" }), cmd);
    assert.ok(!/只认指定的人/.test(sent[sent.length - 1].text), "名单里的人不该被拒");
  }
});

test("别名缺竖线：给用法提示", async () => {
  await run({}, {}, async ({ commands, sent }) => {
    await commands.handleCommand(c2cEvent("/添加别名 id870"), parseCommand("/添加别名 id870"));
    assert.match(sent[sent.length - 1].text, /竖线/);
  });
});

// ── 隐私开关 ────────────────────────────────────────────────────────
test("允许/禁止查询：没绑定时给绑定引导，绑定了才改", async () => {
  const saved = [];
  await run({}, {
    getBinding: async () => null,
    saveBinding: async (cfg, entry) => { saved.push(entry); },
  }, async ({ commands, sent }) => {
    await commands.handleCommand(c2cEvent("/允许查询"), parseCommand("/允许查询"));
    assert.match(sent[sent.length - 1].text, /\/绑定/, "先引导去绑定");
    assert.deepEqual(saved, [], "没绑定就不该写");
  });

  const saved2 = [];
  await run({}, {
    getBinding: async () => ({ userId: "U2", playerName: "玩家", email: "a@b.c", password: "x" }),
    saveBinding: async (cfg, entry) => { saved2.push(entry); },
  }, async ({ commands }) => {
    await commands.handleCommand(c2cEvent("/允许查询"), parseCommand("/允许查询"));
    assert.equal(saved2.length, 1);
    assert.equal(saved2[0].allowOthers, true, "开关只改调用者自己");
    await commands.handleCommand(c2cEvent("/禁止查询"), parseCommand("/禁止查询"));
    assert.equal(saved2[1].allowOthers, false);
  });
});

// ── 状态 ────────────────────────────────────────────────────────────
test("状态：读传输层的连接状态，措辞是美亚的", async () => {
  await run({}, {}, async ({ commands, sent }) => {
    await commands.handleCommand(c2cEvent("/状态"), parseCommand("/状态"));
    const text = sent[sent.length - 1].text;
    assert.match(text, /美亚在的/);
    assert.match(text, /已连接/);
    assert.match(text, /排队：0 项/);
  });
});
