"use strict";
// 美亚指令层的测试。**不起网关、不调模型、不花钱** —— 直接构造 createMiaCommands，
// 用假的 send / sendImage 收结果。
//
// 凭据库和出图核心都是真实现（要 spawn exe），所以这里按仓库既有做法从
// module.exports 上顶掉它们：mia-core 的 coreCall() 就是为此存在的
// （mia-core.cjs:780-782 那段注释）。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const core = require("../mia-core.cjs");
const { createMiaCommands, parseCommand, ALIASES } = require("./mia-commands.cjs");

const GROUP = "GROUP_OPENID_A";

test("搜索歌曲无需绑定，斜杠与模型工具共用真实曲库", async () => {
  await run({}, { getBinding: async () => { throw new Error("查歌不应读账号"); } }, async ({ commands, sent }) => {
    await commands.handleCommand(groupEvent(""), parseCommand("/搜索歌曲 サド"));
    await commands.runCapability(groupEvent(""), "songsearch", "サドマミホリツク", "模型虚构曲名");
    assert.match(sent[0].text, /サドマミホリック/);
    assert.match(sent[0].text, /13\.5/);
    assert.match(sent[1].text, /比较接近/);
    assert.ok(sent.every(s => !/绑定|模型虚构曲名/.test(s.text)));
    core.getAliasStore().add({ title: "サドマミホリック", game: "ongeki", alias: "搜索测试别名" });
    await commands.runCapability(groupEvent(""), "songsearch", "搜索测试别名");
    assert.match(sent.at(-1).text, /サドマミホリック/);
    await commands.runCapability(groupEvent(""), "songsearch", "id870");
    assert.match(sent.at(-1).text, /VIIIbit Explorer/);
  });
});

// ── 夹具 ────────────────────────────────────────────────────────────
// 每个用例一份独立的临时目录：别名库是 mia-core 的模块级单例，
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
  "getDataSource", "setDataSource", "getRinnetClient",
  "generateChart", "generateSongChart", "generateChartInfo", "generateCompletionChart", "generateLevelChart"];
function stub(overrides = {}) {
  const original = {};
  for (const name of PATCHED) original[name] = core[name];
  const defaults = {
    getBinding: async () => null,
    saveBinding: async () => {},
    vaultCall: async () => "0",
    verifyAccount: async () => "测试玩家",
    getDataSource: async () => "otogame",
    setDataSource: async () => {},
    getRinnetClient: () => { throw new Error("测试里不该创建真实 rinnet 客户端"); },
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
  // songJacket 是 createMiaCommands 的注入项，不是 core 的桩 —— 塞给 stub() 只会
  // 挂到 core 上吃灰，真实的 createSongJacket 照样被建出来、测试就变成真联网了。
  const { songJacket, ...coreOverrides } = overrides || {};
  const restore = stub(coreOverrides);
  try { await body(setup(configOverrides, songJacket ? { songJacket } : {})); } finally { restore(); }
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


test("查曲绘需要线索，成功时一条图文回复且曲名不加书名号", async () => {
  let lookups = 0;
  await run({}, {
    getBinding: async () => { throw new Error("查曲绘不应读账号"); },
    songJacket: { lookup: async (query) => {
      lookups++;
      assert.equal(query, "id870");
      return { ok: true, song: { name: "VIIIbit Explorer" },
        image: { buffer: Buffer.from("image"), name: "jacket.png", meta: {} } };
    } },
  }, async ({ commands, sent }) => {
    assert.equal(parseCommand("/查曲绘")?.name, "songjacket");
    assert.deepEqual(parseCommand("/查曲绘 id870"), { name: "songjacket", rest: "id870" });
    await commands.handleCommand(groupEvent("/查曲绘"), parseCommand("/查曲绘"));
    assert.equal(lookups, 0, "不带线索不能随机抽图");
    assert.match(sent[0].text, /查曲绘 id870/);
    sent.length = 0;
    await commands.handleCommand(groupEvent("/查曲绘 id870"), parseCommand("/查曲绘 id870"));
    assert.equal(lookups, 1);
    assert.equal(sent.length, 1, "图片和短文案应在同一条消息里");
    assert.equal(sent[0].kind, "image");
    assert.match(sent[0].caption, /VIIIbit Explorer/);
    assert.doesNotMatch(sent[0].caption, /[《》]/);
  });
});

test("查曲绘的重名结果给出可执行的选择指令", async () => {
  await run({}, {
    songJacket: { lookup: async () => ({
      ok: false, code: "AMBIGUOUS", candidates: [
        { name: "Redo", artist: "艺人甲", selector: "Redo --选 1" },
        { name: "Redo", artist: "艺人乙", selector: "Redo --选 2" },
      ],
    }) },
  }, async ({ commands, sent }) => {
    await commands.handleCommand(groupEvent("/查曲绘 Redo"), parseCommand("/查曲绘 Redo"));
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /\/查曲绘 Redo --选 2/);
    assert.doesNotMatch(sent[0].text, /[《》]/);
  });
});

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

// 梨绪（qq/ NapCat 版）是并列的另一条线，不随本仓库分发；缺失时这条守卫跳过。
const RIO_ENTRY = path.join(__dirname, "..", "qq", "qq-entry.cjs");

test("同一个说法在两个 bot 上必须是同一个意思（冲突守卫）", { skip: fs.existsSync(RIO_ENTRY) ? false : "qq/ 不在本仓库里" }, () => {
  // 早先这条写的是「美亚必须覆盖梨绪的全部说法」—— 那是按「两边完全一致」设的。
  // 2026-09-19 美亚砍掉了「别名候选 / 驳回候选」两条，覆盖式断言就站不住了。
  // 但**真正要防的不是「少了几条」，是「同一个词在两边指不同的东西」**：
  // 那才是用户在两个 bot 之间换着用时会被坑的地方。所以改成查冲突，允许美亚更少。
  const rio = require(RIO_ENTRY).ALIASES;
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
    assert.match(sent[0].text, /本地音击曲库/, "帮助里要说明自然语言曲库查询");
    assert.match(sent[0].text, /各难度已知定数/, "帮助说明搜歌返回各难度定数");
    assert.match(sent[0].text, /搜索歌曲/);
    assert.doesNotMatch(sent[0].text, /开头:|紫谱13|条件搜索/);
    assert.match(sent[0].text, /普通搜歌只查本地曲库/, "帮助里要写清普通搜歌的数据边界");
    assert.match(sent[0].text, /查曲绘缺图时会联网补图/, "帮助里要说明曲绘会联网补图");
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
    assert.ok(!/允许查询|禁止查询/.test(text), "权限开关已删除，帮助里不该再出现");
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

test("牌子版本清单不进绑定闸：未绑定也能问有哪些版本牌子", async () => {
  // 版本名（ID／日文名／中文名／版本号）是静态公共资料，跟 /定数表 一样不该要绑定。
  // 原先这段解析在绑定闸之后，问「总共有哪些牌子可以拿」的人只会收到「先去 /绑定」——
  // 他连有哪些版本都还不知道，那句提示解不了他的题。
  let bindingCalls = 0;
  await run({}, { getBinding: async () => { bindingCalls++; return null; } }, async ({ commands, sent }) => {
    // 命令路径：/牌子 不带参数
    await commands.handleCommand(groupEvent("/牌子"), parseCommand("/牌子"));
    assert.equal(sent.length, 1, "只该给清单，不该有占位、图片或绑定引导");
    assert.match(sent[0].text, /闪击|閃撃/, "清单里要有版本牌子名");
    assert.doesNotMatch(sent[0].text, /绑定|撤回/, "未绑定也要能看到清单，而不是被赶去绑定");
    for (const id of ["040100", "040145", "040150"]) assert.match(sent[0].text, new RegExp(id), "清单要列全 " + id);
    assert.equal(bindingCalls, 0, "只是列清单，不该去读凭据库");
    assert.equal(commands.state.queue.length, 0, "列清单不该入队出图");

    // 闲聊路径（模型挑 plate 且没给版本名）：程序直接兜住
    await commands.runCapability(groupEvent(""), "plate", "", "好，我来查一下♪");
    assert.match(sent.at(-1).text, /请选择版本牌子/, "闲聊问「有哪些牌子」也要能答");
    assert.match(sent.at(-1).text, /想击|想撃/);
    assert.equal(bindingCalls, 0, "闲聊这条也不该读凭据库");

    // 反过来：真的报了个版本名，才轮到绑定闸。认不出来的名字也只给清单，不误报绑定。
    await commands.handleCommand(groupEvent("/牌子 闪击"), parseCommand("/牌子 闪击"));
    assert.match(sent.at(-1).text, /撤回/, "报了版本名但仍未绑定：该给绑定引导");
    await commands.handleCommand(groupEvent("/牌子 不存在的版本"), parseCommand("/牌子 不存在的版本"));
    assert.match(sent.at(-1).text, /请选择版本牌子/, "认不出的版本名回清单，不要拿绑定挡在前面");
  });
});

test("牌子：认出具体版本才走绑定闸和出图", async () => {
  await run({}, {
    getBinding: async () => ({ playerName: "测试玩家", email: "a@b.c", password: "x" }),
  }, async ({ commands, sent }) => {
    await commands.handleCommand(groupEvent("/牌子 閃撃"), parseCommand("/牌子 閃撃"));
    const image = sent.find((s) => s.kind === "image");
    assert.ok(image, "绑定了就该出图");
    assert.match(image.caption, /閃撃/, "繁体写法也要认到");
    assert.match(image.caption, /闪击/);
    assert.match(image.caption, /bright MEMORY Act\.2/);
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

test("rinnet 查分失败写入接口与业务码，不记录响应凭据", async () => {
  const { RinnetError } = require("../rinnet-client.cjs");
  const error = new RinnetError("REJECTED", "rinnet 没有接受这次请求");
  error.diagnostic = { route: "api/game/ongeki/newRating", http: 200, business: 95001, response: "json" };
  error.rawResponse = "PRIVATE-TOKEN";
  const lines = [];
  const restore = stub({
    getBinding: async () => ({ dataSource: "rinnet", playerName: "玩家" }),
    generateChart: async () => { throw error; },
  });
  try {
    const { commands, sent } = setup({}, { log: line => lines.push(line) });
    await commands.handleCommand(groupEvent("/分表"), parseCommand("/分表"));
    assert.ok(lines.includes("[rinnet-query-v2] code=REJECTED route=api/game/ongeki/newRating http=200 business=95001 response=json"));
    assert.ok(!lines.join("\n").includes("PRIVATE-TOKEN"));
    assert.match(sent.at(-1).text, /分表生成失败/);
  } finally { restore(); }
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
    assert.deepEqual(deleted, ["delete-source"], "第二次只删当前来源");
    assert.match(sent[sent.length - 1].text, /当前数据源的绑定解开/);
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

// ── 数据源切换与 rinnet 绑定 ────────────────────────────────────────
test("/设置数据源：查当前、切换、无效说法，两边绑定分别提示", async () => {
  let source = "otogame";
  let bound = false;
  const sets = [];
  await run({}, {
    getDataSource: async () => source,
    setDataSource: async (cfg, uid, s) => { sets.push(s); source = s; },
    getBinding: async () => (bound ? { playerName: "玩家" } : null),
  }, async ({ commands, sent }) => {
    await commands.handleCommand(c2cEvent("/设置数据源"), parseCommand("/设置数据源"));
    assert.match(sent.at(-1).text, /现在翻的是「大饼」/);

    await commands.handleCommand(c2cEvent("/设置数据源 rinnet"), parseCommand("/设置数据源 rinnet"));
    assert.deepEqual(sets, ["rinnet"]);
    assert.match(sent.at(-1).text, /切到「rinnet」/);
    assert.match(sent.at(-1).text, /还没绑定/, "切过去但没绑定时要明说");

    bound = true;
    await commands.handleCommand(c2cEvent("/设置数据源 大餅"), parseCommand("/设置数据源 大餅"));
    assert.deepEqual(sets, ["rinnet", "otogame"], "繁体说法也要认");
    assert.match(sent.at(-1).text, /接下来查分就用这边/, "已绑定的那边不用再引导");

    await commands.handleCommand(c2cEvent("/设置数据源 火星服"), parseCommand("/设置数据源 火星服"));
    assert.deepEqual(sets, ["rinnet", "otogame"], "无效说法不能改来源");
    assert.match(sent.at(-1).text, /\/设置数据源 大饼 或 \/设置数据源 rinnet/);
  });
});

test("rinnet 绑定：邮箱→密码→验证码→卡号，全程凭据不外泄", async () => {
  const EMAIL = "rin@example.com", PW = "rinnet-绝密-☂", TOTP = "123456", CARDNO = "00000000000000004453";
  let saved = null;
  const calls = [];
  const fakeClient = {
    login: async (email, pw) => { calls.push(["login", email, pw]); return { totpToken: "tok-1" }; },
    totp: async (token, code) => { calls.push(["totp", token, code]); return { accessToken: "AT", refreshToken: "RT" }; },
    bind: async (account, email, cardNumber) => {
      calls.push(["bind", cardNumber]);
      if (!cardNumber) return { cards: [{ luid: CARDNO }, { luid: "00000000000000009901" }] };
      return { dataSource: "rinnet", email, account, cardNumber, aimeId: "44153",
        playerName: "リネット玩家", boundAt: "t", sessionId: "s-1" };
    },
  };
  await run({}, {
    getDataSource: async () => "rinnet",
    getRinnetClient: () => fakeClient,
    saveBinding: async (cfg, entry) => { saved = entry; },
  }, async ({ commands, sent }) => {
    await commands.handleCommand(c2cEvent("/绑定"), parseCommand("/绑定"));
    assert.match(sent.at(-1).text, /rinnet/);
    assert.match(sent.at(-1).text, /验证码/, "要预告可能需要两步验证");
    assert.match(sent.at(-1).text, /撤回/);
    assert.equal(commands.getSession("U2").state, "awaitingEmail");

    await commands.continueSession(c2cEvent(EMAIL), EMAIL);
    await commands.continueSession(c2cEvent(PW), PW);
    assert.match(sent.at(-1).text, /六位验证码/);
    await commands.continueSession(c2cEvent(TOTP), TOTP);
    assert.match(sent.at(-1).text, /卡号/, "多张卡时要请用户发 20 位卡号");
    await commands.continueSession(c2cEvent(CARDNO), CARDNO);

    assert.deepEqual(calls.map((c) => c[0]), ["login", "totp", "bind", "bind"]);
    assert.deepEqual(calls[0], ["login", EMAIL, PW], "登录用的是用户发的邮箱和密码");
    assert.equal(commands.getSession("U2"), null, "绑完会话要清掉");
    assert.equal(saved.dataSource, "rinnet");
    assert.equal(saved.aimeId, "44153");
    assert.equal(saved.userId, "U2");
    assert.match(sent.at(-1).text, /绑好 rinnet 啦/);
    const dump = JSON.stringify(sent);
    for (const secret of [EMAIL, PW, TOTP, CARDNO, "tok-1"]) {
      assert.ok(!dump.includes(secret), "凭据不能出现在任何一条回复里：" + secret);
    }
  });
});

test("rinnet 绑定：只有一张卡时自动选定，不问卡号", async () => {
  let saved = null;
  const fakeClient = {
    login: async () => ({ account: { accessToken: "AT", refreshToken: "RT" } }),
    bind: async (account, email, cardNumber) => {
      assert.equal(cardNumber, undefined, "单卡不该要求卡号");
      return { dataSource: "rinnet", email, account, cardNumber: "00000000000000004453",
        aimeId: "44153", playerName: "单卡玩家", boundAt: "t", sessionId: "s-1" };
    },
  };
  await run({}, {
    getDataSource: async () => "rinnet",
    getRinnetClient: () => fakeClient,
    saveBinding: async (cfg, entry) => { saved = entry; },
  }, async ({ commands, sent }) => {
    await commands.handleCommand(c2cEvent("/绑定"), parseCommand("/绑定"));
    await commands.continueSession(c2cEvent("rin@example.com"), "rin@example.com");
    await commands.continueSession(c2cEvent("pw"), "pw");
    assert.equal(saved?.playerName, "单卡玩家");
    assert.match(sent.at(-1).text, /绑好 rinnet 啦/);
    assert.ok(!sent.some((s) => /卡号要是|好几张/.test(s.text)), "单卡流程不出现选卡提示");
  });
});

test("rinnet 绑定：验证码格式连错三次就停下，凭据不进回复", async () => {
  const fakeClient = {
    login: async () => ({ totpToken: "tok-1" }),
    totp: async () => { throw new Error("不该被调到：格式不对不该发请求"); },
  };
  await run({}, {
    getDataSource: async () => "rinnet",
    getRinnetClient: () => fakeClient,
  }, async ({ commands, sent }) => {
    await commands.handleCommand(c2cEvent("/绑定"), parseCommand("/绑定"));
    await commands.continueSession(c2cEvent("rin@example.com"), "rin@example.com");
    await commands.continueSession(c2cEvent("pw"), "pw");
    for (const bad of ["abc", "12345", "不是验证码"]) {
      await commands.continueSession(c2cEvent(bad), bad);
    }
    assert.match(sent.at(-1).text, /连续三次/);
    assert.equal(commands.getSession("U2"), null, "三次错完会话要结束");
    assert.ok(!JSON.stringify(sent).includes("tok-1"), "totpToken 不能出现在回复里");
  });
});

// ── 别名 ────────────────────────────────────────────────────────────
test("删除别名的白名单：没有 / 是本人 / 是别人", async () => {
  const mk = (ids) => setup({ aliasDeleteOpenids: ids });
  const cmd = parseCommand("/删除别名 id870 八爪鱼");
  const argv = ["/删除别名 id870 八爪鱼"];

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

test("别名用空格分隔：ID 和带空格的曲名都能加", async () => {
  await run({}, {}, async ({ commands, sent }) => {
    await commands.handleCommand(c2cEvent("/添加别名 id870 八爪鱼"), parseCommand("/添加别名 id870 八爪鱼"));
    assert.match(sent.at(-1).text, /八爪鱼 → id870/);
    await commands.handleCommand(c2cEvent("/添加别名 VIIIbit Explorer 八比特"), parseCommand("/添加别名 VIIIbit Explorer 八比特"));
    assert.match(sent.at(-1).text, /八比特 → id870/);
    assert.deepEqual(core.getAliasStore().list("VIIIbit Explorer", "ongeki"), ["八爪鱼", "八比特"]);

    // 旧的竖线写法继续兼容，群里已有的肌肉记忆不会突然失效
    await commands.handleCommand(c2cEvent("/添加别名 id870 | 旧写法"), parseCommand("/添加别名 id870 | 旧写法"));
    assert.match(sent.at(-1).text, /旧写法 → id870/);
  });
});

test("别名缺第二个参数：给空格用法提示", async () => {
  await run({}, {}, async ({ commands, sent }) => {
    await commands.handleCommand(c2cEvent("/添加别名 id870"), parseCommand("/添加别名 id870"));
    assert.match(sent[sent.length - 1].text, /空格/);
  });
});

test("/是什么歌 支持部分曲名、焔/焰异体和原有别名，并列出多首候选", async () => {
  await run({}, {}, async ({ commands, sent }) => {
    const ask = async (query) => {
      const input = "/是什么歌 " + query;
      await commands.handleCommand(groupEvent(input), parseCommand(input));
      return sent.at(-1).text;
    };

    assert.match(await ask("冬花"), /id1076.*耐冬花麗/, "部分正式曲名应能反查");
    assert.match(await ask("光焰"), /id728.*光焔のラテラルアーク/, "简体异体写法应找到正式曲名");

    const multiple = await ask("光");
    assert.match(multiple, /id222.*光線チューニング/);
    assert.match(multiple, /id728.*光焔のラテラルアーク/, "多个曲名命中时应列出候选");

    const store = core.getAliasStore();
    store.add({ title: "VIIIbit Explorer", game: "ongeki", alias: "测试短名" });
    store.add({ title: "光焔のラテラルアーク", game: "ongeki", alias: "测试短名扩展" });
    const exactAlias = await ask("测试短名");
    assert.match(exactAlias, /id870.*VIIIbit Explorer/, "原有别名反查仍有效");
    assert.doesNotMatch(exactAlias, /id728/, "完整别名应优先于其他别名的部分命中");
    store.add({ title: "VIIIbit Explorer", game: "ongeki", alias: "共同叫法" });
    store.add({ title: "光焔のラテラルアーク", game: "ongeki", alias: "共同叫法" });
    const shared = await ask("共同叫法");
    assert.match(shared, /id870.*VIIIbit Explorer/);
    assert.match(shared, /id728.*光焔のラテラルアーク/, "一个别名指向多首时不可只选一首");
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

test("素材检索指令：返回带页面类型和关键词的可点击链接", async () => {
  await run({ assetBrowser: { enabled: true, publicBaseUrl: "http://192.168.1.20:47831/" } }, {}, async ({ commands, sent }) => {
    await commands.handleCommand(groupEvent("/查卡面 椿"), parseCommand("/查卡面 椿"));
    await commands.handleCommand(groupEvent("/查表情 星咲あかり"), parseCommand("/查表情 星咲あかり"));
    assert.match(sent[0].text, /卡面仓库给你翻开啦/);
    assert.match(sent[0].text, /http:\/\/192\.168\.1\.20:47831\/cards\?q=%E6%A4%BF/);
    assert.match(sent[1].text, /角色们的小表情都整理好啦/);
    assert.match(sent[1].text, /\/expressions\?q=%E6%98%9F%E5%92%B2%E3%81%82%E3%81%8B%E3%82%8A/);
  });
});

test("rinnet 登录途中取消：迟到的登录响应不能保存绑定", async () => {
  let resolveLogin;
  let saves = 0;
  const pending = new Promise(resolve => { resolveLogin = resolve; });
  await run({}, {
    getDataSource: async () => "rinnet",
    getRinnetClient: () => ({ login: () => pending, bind: async () => { throw new Error("取消后不应查卡"); } }),
    saveBinding: async () => { saves++; },
  }, async ({ commands }) => {
    await commands.handleCommand(c2cEvent("/绑定"), parseCommand("/绑定"));
    await commands.continueSession(c2cEvent("rin@example.com"), "rin@example.com");
    const work = commands.continueSession(c2cEvent("secret"), "secret");
    await commands.handleCommand(c2cEvent("/取消"), parseCommand("/取消"));
    resolveLogin({ account: { accessToken: "fake", refreshToken: "fake" } });
    await work;
    assert.equal(saves, 0);
    assert.equal(commands.getSession("U2"), null);
  });
});

test("已删除的查分开关及旧别名不能解析为功能", () => {
  for (const text of ["/允许查分", "/禁止查分", "/允许查询", "/禁止查询", "/allowquery", "/denyquery"]) assert.equal(parseCommand(text).name, null);
});
