"use strict";
// 联网判断层（search-gate.cjs）的测试。全程假模型 + 假搜索，不碰真接口、不花钱。
// 真模型的判断准不准由 search-gate-smoke.cjs 量，这里只钉住程序侧的规矩：
// 规则只能否决不能放行、模型只有识别权、各档位的行为、提议的状态机。
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const gate = require("./search-gate.cjs");
const { loadSettings, requestReply, createChat } = require("./chat.cjs");

// ── 纯函数 ────────────────────────────────────────────────────────────

test("明说要搜才算放行：联网对战、查成绩这类说法不算", () => {
  assert.deepEqual(gate.explicitRequest("帮我搜一下 CHUNITHM 最新版本吧"), { rest: "CHUNITHM 最新版本" });
  assert.deepEqual(gate.explicitRequest("联网查一下疯狂星期四的出处"), { rest: "疯狂星期四的出处" });
  assert.deepEqual(gate.explicitRequest("去年那次活动帮我搜一下"), { rest: "去年那次活动" }, "不能把「去年」删成「年」");
  assert.deepEqual(gate.explicitRequest("帮我搜搜这个"), { rest: "" }, "只剩代词：对象在上文里");
  assert.equal(gate.explicitRequest("音击能联网对战吗"), null);
  assert.equal(gate.explicitRequest("查一下 id870"), null, "查成绩/查曲库的说法不能被当成联网");
  assert.equal(gate.explicitRequest("不用搜了直接说"), null);
});

test("美亚自己的说法也算明说：「翻翻」「翻…情报」；翻译、翻唱、翻车不算", () => {
  // 线上：美亚提议「要美亚去翻翻情报吗」，用户照着回「你翻翻claude的情报」，没被认成明说，她又提议了一遍。
  assert.deepEqual(gate.explicitRequest("你翻翻claude的情报"), { rest: "claude", soft: true });
  assert.deepEqual(gate.explicitRequest("查查 nora2r 的情报"), { rest: "nora2r", soft: true });
  assert.deepEqual(gate.explicitRequest("去翻情报"), { rest: "", soft: true }, "「情报」和它前面的动词都是话术，不是要搜的东西");
  for (const text of ["帮我翻一下这句日语", "翻译一下", "这首歌翻唱了吗", "我翻车了", "美亚的情报本里有吗"])
    assert.equal(gate.explicitRequest(text), null, text);
});

test("否决规则只挡纯反应和寒暄，像问句的玩梗留给判断调用", () => {
  for (const text of ["哈哈哈哈", "草", "[图片]", "6666", "在吗？", "早安！", "不要联网，直接答"]) assert.ok(gate.vetoReason(text), text);
  for (const text of ["这日子怎么过啊", "美亚你是不是又摸鱼了", "CHUNITHM 最新版本是什么"]) assert.equal(gate.vetoReason(text), "", text);
});

test("只有整句短答应才算答应提议", () => {
  for (const text of ["要", "好呀！", "去吧~", "嗯嗯", "查吧", "翻吧", "去翻翻", "好的，去吧", "要！快去翻"]) assert.ok(gate.affirmative(text), text);
  for (const text of ["好，但是我想问别的", "要不你先说说", "不要", "要不要", "可以吗", "翻译一下"]) assert.equal(gate.affirmative(text), false, text);
});

test("检索词要有出处：修饰词可以加，对象不能编", () => {
  const hay = "中二是不是快出新版本了\n美亚你知道吗";
  assert.equal(gate.targetProblem("CHUNITHM 新版本", hay), "", "中二和 CHUNITHM 互为出处");
  assert.equal(gate.targetProblem("疯狂星期四 梗 出处", "疯狂星期四是什么梗"), "");
  assert.match(gate.targetProblem("原神 4.0 更新", hay), /用户没提过/);
  assert.match(gate.targetProblem("最新版本", hay), /没有具体对象/);
  assert.equal(gate.targetProblem("Lanota 开发商 后续作品", "Lanota 的开发商后来还做了什么游戏"), "", "近义改写（后来→后续）不算编");
  assert.match(gate.targetProblem("Phigros 更新", "那个音游最近更新了吗"), /名字或数字（phigros）/, "名字编不得");
  assert.match(gate.targetProblem("最新 瓜 新闻", "最新的瓜是什么"), /太泛/);
  assert.match(gate.targetProblem("", hay), /没有检索词/);
});

test("复读次数按正文比，不看谁发的", () => {
  assert.equal(gate.repeatCount("疯狂星期四v我50", ["群友：疯狂星期四 v我50", "群友：今天没出勤", "群友：疯狂星期四v我50！"]), 2);
  assert.equal(gate.repeatCount("嗯", ["群友：嗯"]), 0, "太短的不算复读");
});

test("配置写错按 off 处理，不让机器人起不来", () => {
  assert.deepEqual(gate.gateSettings(undefined), { mode: "off" });
  assert.equal(gate.gateSettings({ mode: "auto" }).mode, "auto");
  for (const bad of [{ mode: "yes" }, { mode: "auto", timeoutMs: 5 }, "auto", { mode: "auto", model: "a b" }]) {
    const s = gate.gateSettings(bad);
    assert.equal(s.mode, "off");
    assert.match(s.error, /已按 off 处理/);
  }
});

test("回答里的提议与没把握能认出来", () => {
  assert.ok(gate.offerPresent("这个美亚也不太确定喵……要不要美亚去查查情报？"));
  assert.ok(gate.offerPresent("需要我帮你搜一下吗？"));
  assert.ok(gate.offerPresent("不敢乱说。要不我去帮你翻一翻？这种消息美亚还是有兴趣的。"), "实测漏认过的说法");
  assert.equal(gate.offerPresent("美亚去翻了一圈，情报网带回来的东西有点怪。"), false, "陈述句不是提议");
  assert.equal(gate.offerPresent("喵哼哼，交给美亚吧！"), false);
  assert.ok(gate.unsure("唔，这个美亚不太清楚呢"));
  assert.equal(gate.unsure("是 2015 年上线的哦"), false);
});

const T0 = 1_000_000;
const obs = (over = {}) => ({ act: "ask", about: "world", target: "", fresh: false, confident: true, unknownTerms: [], ...over });
test("决策表：说了不要联网 > 答应提议 > 明说要搜 > 按档位", () => {
  const d = args => gate.decide({ mode: "auto", text: "", explicit: null, pending: null, lastTarget: null, obs: null, veto: "", haystack: "", now: T0, ...args });
  const pending = { target: "CHUNITHM 最新版本", expiresAt: T0 + 1000 };
  assert.equal(d({ text: "不要联网", pending }).action, "none");
  assert.deepEqual([d({ text: "要", pending }).action, d({ text: "要", pending }).target], ["search", "CHUNITHM 最新版本"]);
  assert.equal(d({ text: "要", pending: { ...pending, expiresAt: T0 - 1 } }).action, "none", "过期的提议不算数");
  // 明说要搜
  const explicit = { rest: "" };
  assert.equal(d({ explicit, obs: obs({ about: "bot" }) }).refuse, "bot", "问自己的事：明说也不搜");
  assert.ok(d({ explicit }).clarify, "没说搜什么就问");
  assert.equal(d({ explicit, lastTarget: { target: "中二 新版本", expiresAt: T0 + 1 } }).target, "中二 新版本", "只说「搜一下」就搜上一轮的对象");
  assert.equal(d({ explicit: { rest: "疯狂星期四" }, obs: obs({ target: "原神 更新" }), haystack: "搜一下疯狂星期四" }).target, "疯狂星期四", "模型编的对象不用");
  // 软说法（翻翻、翻…情报）：判断调用说是玩笑就不算明说，按档位走；硬说法照旧放行
  const joking = obs({ act: "play", about: "bot" });
  assert.deepEqual([d({ explicit: { rest: "书", soft: true }, obs: joking }).action, d({ explicit: { rest: "书", soft: true }, obs: joking }).reason], ["none", "在玩梗或开玩笑"],
    "「你去翻翻书吧，别老问我」不该让她解释「这个没法上网查」");
  assert.equal(d({ explicit: { rest: "claude", soft: true }, obs: obs({ act: "command", target: "Claude" }), haystack: "你翻翻claude的情报" }).target, "Claude");
  assert.equal(d({ explicit: { rest: "疯狂星期四" }, obs: obs({ act: "play", target: "疯狂星期四" }), haystack: "搜一下疯狂星期四" }).action, "search", "「搜一下」是硬说法，玩笑也照搜");
  // 档位
  const asking = obs({ target: "CHUNITHM 最新版本", fresh: true, confident: false });
  const hay = "CHUNITHM 最新版本是什么";
  assert.equal(d({ mode: "explicit", obs: asking, haystack: hay }).action, "none");
  const shadow = d({ mode: "shadow", obs: asking, haystack: hay });
  assert.deepEqual([shadow.action, shadow.would.action], ["none", "search"]);
  assert.equal(d({ obs: asking, haystack: hay }).action, "search");
  assert.equal(d({ obs: obs({ act: "play", target: "x" }) }).action, "none");
  assert.equal(d({ obs: obs({ about: "group" }) }).action, "none");
  assert.equal(d({ obs: obs({ about: "local" }) }).action, "none");
  assert.equal(d({ obs: obs({ target: "原神 更新", fresh: true }), haystack: hay }).action, "none", "编出来的对象不搜");
  assert.equal(d({ obs: obs({ target: "CHUNITHM 版本" }), haystack: hay }).action, "offer", "有把握又不会变：先凭知识答");
  assert.equal(d({ obs: obs({ act: "unclear", target: "CHUNITHM 版本" }), haystack: hay }).action, "offer");
  assert.equal(d({ obs: obs({ target: "CHUNITHM 版本", confident: false }), haystack: hay }).action, "offer", "光是自报没把握不自动搜");
  assert.equal(d({ obs: obs({ target: "CHUNITHM 版本", unknownTerms: ["CHUNITHM"] }), haystack: hay }).action, "search", "点得出名字的生词才搜");
  assert.equal(d({ veto: "纯反应或寒暄", obs: asking, haystack: hay }).action, "none");
  assert.equal(d({}).action, "none", "判断调用失败按不搜");
});

test("「今年」能给检索词里的年份当出处，模型自己编的年份不行", () => {
  const now = new Date(2026, 9, 9, 12).getTime();
  assert.equal(gate.targetProblem("2026 网络热梗", "今年最火的网络梗有哪些" + gate.yearWords("今年最火的网络梗有哪些", now)), "");
  assert.match(gate.targetProblem("2025 网络热梗", "今年最火的网络梗有哪些" + gate.yearWords("今年最火的网络梗有哪些", now)), /用户没提过/);
  assert.equal(gate.yearWords("去年那次活动", now).trim(), "2025");
  assert.equal(gate.yearWords("疯狂星期四是什么梗", now), "");
  assert.equal(gate.gateInput({ name: "美亚", current: "x", now })["今天的日期"], "2026-10-09");
});

test("曲库里有的歌、问的又是曲库字段：自动档不搜，交给本地曲库", () => {
  const knowledge = { titles: [{ game: "ongeki", title: "Opfer", normalized: "opfer" }] };
  const d = (target, text) => gate.decide({ mode: "auto", text, obs: obs({ target, fresh: true }), veto: "", haystack: text + "\n群友：我今天打了 Opfer", now: T0, knowledge });
  assert.match(d("Opfer 作曲", "这首歌是谁写的").reason, /本地曲库答得了（Opfer）/);
  assert.equal(d("Opfer 攻略", "这首歌有什么攻略吗").action, "search", "攻略不在曲库里，照常判");
  assert.equal(d("Dengeki Tube 作曲", "Dengeki Tube 是谁写的").action, "search", "库里没有的歌本地答不了");
});

// ── 整条回复链路 ──────────────────────────────────────────────────────

const ROLE = path.resolve(__dirname, "../mia-chat");
const base = loadSettings(ROLE);
function settingsWith(searchGate, { search = true } = {}) {
  return { ...base, c: { ...base.c, limits: { ...base.c.limits, userCooldownSeconds: 0 } },
    searchGate: gate.gateSettings(searchGate), search: search ? { apiKey: "kimi-fixture", cache: new Map() } : null };
}
const respond = content => ({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content } }] }) });
// 假模型：判断调用（系统提示词以 GATE_MARKER 开头）和回复调用分开记。
function fakeModel({ observe = obs(), reply = "喵哼哼，收到啦！", gateStatus = 200 } = {}) {
  const calls = { gate: [], reply: [] };
  const fetchImpl = async (_, options) => {
    const body = JSON.parse(options.body);
    if (String(body.messages[0]?.content || "").startsWith(gate.GATE_MARKER)) {
      calls.gate.push(body);
      if (gateStatus !== 200) return { ok: false, status: gateStatus, text: async () => "gateway error" };
      return respond(JSON.stringify(typeof observe === "function" ? observe(body) : observe));
    }
    calls.reply.push(body);
    const payload = typeof reply === "function" ? reply(body) : reply;
    return respond(JSON.stringify(typeof payload === "string" ? { text: payload, emotion: "happy", scene: "ordinary", expressionIds: [] } : payload));
  };
  return { fetchImpl, calls };
}
// 假 Kimi：按 search_pro 的返回形状给结果，并记下发出去的检索词。
function fakeWeb(results = [{ title: "CHUNITHM 最新版本一览", url: "https://example.com/chunithm", chunks: [{ text: "CHUNITHM 的最新版本是 X-VERSE。" }], snippet: "CHUNITHM 最新版本" }]) {
  const calls = [];
  const webFetchImpl = async (url, options) => { calls.push({ url: String(url), body: JSON.parse(options.body) }); return { ok: true, status: 200, json: async () => ({ search_results: results }) }; };
  return { webFetchImpl, calls };
}
const say = text => [{ role: "user", content: text }];
const systemOf = body => String(body.messages[0].content);
const promptOf = body => body.messages.map(m => typeof m.content === "string" ? m.content : "").join("\n");

test("off：不调判断、提示词和改造前一样（还带着意图标注）", async () => {
  const model = fakeModel(), web = fakeWeb();
  const result = await requestReply(settingsWith(undefined), say("CHUNITHM 最新版本是什么"), { fetchImpl: model.fetchImpl, webFetchImpl: web.webFetchImpl });
  assert.equal(model.calls.gate.length, 0);
  assert.equal(web.calls.length, 0);
  assert.match(systemOf(model.calls.reply[0]), /意图标注/);
  assert.equal(result.searchGate, undefined);
  assert.equal(result.searchState, undefined);
});

test("explicit：闲聊零额外调用，回复模型也不再被要求抽 factQuery", async () => {
  const model = fakeModel(), web = fakeWeb();
  const result = await requestReply(settingsWith({ mode: "explicit" }), say("今天好累啊"), { fetchImpl: model.fetchImpl, webFetchImpl: web.webFetchImpl });
  assert.equal(model.calls.gate.length, 0);
  assert.equal(web.calls.length, 0);
  const system = systemOf(model.calls.reply[0]);
  assert.doesNotMatch(system, /意图标注|factQuery":"这一句/);
  assert.match(system, /联网：由程序决定/);
  assert.equal(result.searchGate.decision.action, "none");
});

test("explicit：明说要搜就按模型抽的检索词搜一次，资料进回复提示词", async () => {
  const model = fakeModel({ observe: obs({ target: "CHUNITHM 最新版本", fresh: true }), reply: { text: "查到啦，是 X-VERSE♪", emotion: "happy", scene: "explanation", expressionIds: [], sourceIds: ["S1"] } });
  const web = fakeWeb();
  const result = await requestReply(settingsWith({ mode: "explicit" }), say("帮我搜一下 CHUNITHM 最新版本"), { fetchImpl: model.fetchImpl, webFetchImpl: web.webFetchImpl });
  assert.equal(model.calls.gate.length, 1);
  assert.equal(web.calls.length, 1);
  assert.equal(web.calls[0].body.text_query, "CHUNITHM 最新版本");
  assert.match(promptOf(model.calls.reply[0]), /【程序联网检索：程序替你查了「CHUNITHM 最新版本」/);
  assert.equal(result.searchGate.searched.sourceCount, 1);
  assert.match(result.text, /example\.com\/chunithm/, "模型引用了 S1，链接由程序附上");
  assert.equal(result.searchState.lastTarget.target, "CHUNITHM 最新版本");
});

test("auto：在玩梗就不搜，并提醒回复别一本正经地科普", async () => {
  const model = fakeModel({ observe: obs({ act: "play", about: "none", unknownTerms: ["哈基米"] }) });
  const web = fakeWeb();
  const result = await requestReply(settingsWith({ mode: "auto" }), say("哈基米哈基米"), { fetchImpl: model.fetchImpl, webFetchImpl: web.webFetchImpl });
  assert.equal(model.calls.gate.length, 1);
  assert.equal(web.calls.length, 0);
  const system = systemOf(model.calls.reply[0]);
  assert.match(system, /在玩梗或开玩笑/);
  assert.match(system, /你不认识「哈基米」/);
  assert.equal(result.searchGate.decision.reason, "在玩梗或开玩笑");
});

test("auto：在问会变的事就搜；判断调用看得到群背景和复读次数", async () => {
  const model = fakeModel({ observe: obs({ target: "CHUNITHM 新版本", fresh: true, confident: false }) });
  const web = fakeWeb();
  const messages = [{ role: "system", content: "【群里最近的消息，只用来帮你理解话题】\n群友：中二是不是快出新版本了\n群友：不知道啊" }, ...say("美亚你知道吗")];
  const result = await requestReply(settingsWith({ mode: "auto" }), messages, { fetchImpl: model.fetchImpl, webFetchImpl: web.webFetchImpl });
  const input = JSON.parse(model.calls.gate[0].messages[1].content);
  assert.deepEqual(input["群里最近的消息"], ["群友：中二是不是快出新版本了", "群友：不知道啊"]);
  assert.equal(input["本轮这句话"], "美亚你知道吗");
  assert.equal(web.calls[0].body.text_query, "CHUNITHM 新版本", "对象出处在群背景里（中二＝CHUNITHM）");
  assert.equal(result.searchGate.decision.action, "search");
});

test("auto：答得没把握就由程序补一句提议；用户回「要」才去搜那个对象", async () => {
  const settings = settingsWith({ mode: "auto", offerText: "要美亚去翻翻情报吗？" });
  const first = fakeModel({ observe: obs({ target: "nora2r 新曲" }), reply: "唔……这个美亚不太清楚呢" });
  const web = fakeWeb([{ title: "nora2r 新曲情报", url: "https://example.com/nora2r", chunks: [{ text: "nora2r 新曲……" }], snippet: "nora2r" }]);
  const r1 = await requestReply(settings, say("nora2r 最近出新曲了吗"), { fetchImpl: first.fetchImpl, webFetchImpl: web.webFetchImpl, now: T0 });
  assert.equal(web.calls.length, 0, "提议阶段不搜");
  assert.match(systemOf(first.calls.reply[0]), /没把握就照实说不太确定，然后在结尾用一句话问用户要不要你去查查/);
  assert.match(r1.text, /不太清楚呢。要美亚去翻翻情报吗？$/);
  assert.equal(r1.searchState.pending.target, "nora2r 新曲");
  assert.equal(r1.searchState.lastOfferAt, T0);
  // 下一轮：用户只回了一句「要」
  const second = fakeModel({ reply: "翻到了！" });
  const r2 = await requestReply(settings, [...say("nora2r 最近出新曲了吗"), { role: "assistant", content: r1.text }, ...say("要")],
    { fetchImpl: second.fetchImpl, webFetchImpl: web.webFetchImpl, now: T0 + 60000, searchState: r1.searchState });
  assert.equal(second.calls.gate.length, 0, "答应提议不需要再判断");
  assert.equal(web.calls.length, 1);
  assert.equal(web.calls[0].body.text_query, "nora2r 新曲");
  assert.equal(r2.searchState.pending, null, "提议用掉了");
  // 冷却期内同一个人不再被提议
  const third = fakeModel({ observe: obs({ target: "nora2r 新曲" }), reply: "唔……这个美亚不太清楚呢" });
  const r3 = await requestReply(settings, say("nora2r 是谁"), { fetchImpl: third.fetchImpl, webFetchImpl: web.webFetchImpl, now: T0 + 120000, searchState: { lastOfferAt: T0 } });
  assert.equal(r3.text, "唔……这个美亚不太清楚呢");
  assert.equal(r3.searchState.pending, null);
});

test("auto：答得有把握就不提议", async () => {
  const model = fakeModel({ observe: obs({ target: "疯狂星期四 梗" }), reply: "疯狂星期四是肯德基的周四促销梗啦♪" });
  const result = await requestReply(settingsWith({ mode: "auto" }), say("疯狂星期四是什么梗"), { fetchImpl: model.fetchImpl, webFetchImpl: fakeWeb().webFetchImpl, now: T0 });
  assert.equal(result.searchState.pending, null);
  assert.doesNotMatch(result.text, /要我去网上查查吗/);
});

test("shadow：判断照跑只记录，不搜也不改回复的提示词", async () => {
  const model = fakeModel({ observe: obs({ target: "CHUNITHM 最新版本", fresh: true, confident: false }) });
  const web = fakeWeb();
  const result = await requestReply(settingsWith({ mode: "shadow" }), say("CHUNITHM 最新版本是什么"), { fetchImpl: model.fetchImpl, webFetchImpl: web.webFetchImpl });
  assert.equal(model.calls.gate.length, 1);
  assert.equal(web.calls.length, 0);
  assert.equal(result.searchGate.decision.would.action, "search");
  assert.doesNotMatch(systemOf(model.calls.reply[0]), /替你联网查了|在玩梗或开玩笑|要不要你去查查/);
  assert.match(gate.describeGate(result.searchGate), /自动档会search/);
});

test("判断调用挂了就当不搜，回复照常发", async () => {
  const model = fakeModel({ gateStatus: 500 });
  const web = fakeWeb();
  const result = await requestReply(settingsWith({ mode: "auto" }), say("CHUNITHM 最新版本是什么"), { fetchImpl: model.fetchImpl, webFetchImpl: web.webFetchImpl });
  assert.equal(model.calls.gate.length, 2, "重试一次");
  assert.equal(web.calls.length, 0);
  assert.equal(result.text, "喵哼哼，收到啦！");
  assert.match(result.searchGate.error, /HTTP 500/);
});

test("明说要搜但问的是美亚自己：不搜，让她用自己的口吻说明", async () => {
  const model = fakeModel({ observe: obs({ about: "bot", target: "美亚 设定" }) });
  const web = fakeWeb();
  await requestReply(settingsWith({ mode: "explicit" }), say("帮我搜一下你自己的设定"), { fetchImpl: model.fetchImpl, webFetchImpl: web.webFetchImpl });
  assert.equal(web.calls.length, 0);
  assert.match(systemOf(model.calls.reply[0]), /问的是你自己的事，网上查不到/);
});

test("没配搜索 Key：照实说查不了，不吐给管理员看的话", async () => {
  const model = fakeModel({ observe: obs({ target: "CHUNITHM 最新版本" }), reply: "呜喵，美亚这次没能查到……" });
  const web = fakeWeb();
  const result = await requestReply(settingsWith({ mode: "explicit" }, { search: false }), say("帮我搜一下 CHUNITHM 最新版本"), { fetchImpl: model.fetchImpl, webFetchImpl: web.webFetchImpl });
  assert.equal(web.calls.length, 0);
  assert.match(promptOf(model.calls.reply[0]), /联网搜索还没配置好/);
  assert.equal(result.text, "呜喵，美亚这次没能查到……");
  assert.doesNotMatch(result.text, /管理员|Kimi/);
});

test("判断层开着时，回复模型给的 factQuery 不再绕一轮", async () => {
  const model = fakeModel({ reply: { text: "这个嘛……", factQuery: "CHUNITHM 最新版本", emotion: "neutral", scene: "ordinary", expressionIds: [] } });
  const result = await requestReply(settingsWith({ mode: "explicit" }), say("CHUNITHM 最新版本是什么"), { fetchImpl: model.fetchImpl, webFetchImpl: fakeWeb().webFetchImpl });
  assert.equal(model.calls.reply.length, 1);
  assert.equal(result.text, "这个嘛……");
});

test("搜回来的结果和对象一个词都不沾，就不算资料", async () => {
  const model = fakeModel({ observe: obs({ target: "CHUNITHM 最新版本" }) });
  const web = fakeWeb([{ title: "宝宝黄疸 16.5 怎么办", url: "https://example.com/baby", chunks: [{ text: "黄疸……" }], snippet: "黄疸" }]);
  const result = await requestReply(settingsWith({ mode: "explicit" }), say("帮我搜一下 CHUNITHM 最新版本"), { fetchImpl: model.fetchImpl, webFetchImpl: web.webFetchImpl });
  assert.equal(result.searchGate.searched.sourceCount, 0);
  assert.equal(result.sourceStats.retrieved, 1);
  assert.match(promptOf(model.calls.reply[0]), /对不上，不能当资料用/);
});

test("会话里：答应提议的那句「要」不走语义路由，直接去搜", async () => {
  let time = T0, routeCalls = 0;
  const sent = [], logs = [];
  const model = fakeModel({ observe: obs({ target: "nora2r 新曲" }), reply: "唔……这个美亚不太清楚呢" });
  const web = fakeWeb([{ title: "nora2r 新曲", url: "https://example.com/n", chunks: [{ text: "nora2r 新曲……" }], snippet: "nora2r" }]);
  const chat = createChat(settingsWith({ mode: "auto" }), { guildId: "g", channelIds: ["c"] }, {
    fetchImpl: model.fetchImpl, webFetchImpl: web.webFetchImpl, now: () => time, log: line => logs.push(line),
    adapter: { accepts: () => true, extractText: m => m.content, typing: async () => {},
      send: async (_, text) => { sent.push(text); }, routeIntent: async () => { routeCalls++; return null; } },
  });
  const message = (id, content) => ({ id, guildId: "g", channelId: "c", author: { id: "u1" }, content });
  try {
    await chat.handle(message("m1", "nora2r 最近出新曲了吗"));
    assert.match(sent.at(-1), /要我去网上查查吗？/);
    time += 30000;
    await chat.handle(message("m2", "要"));
    assert.equal(routeCalls, 1, "第二句没进路由");
    assert.equal(web.calls.length, 1);
    assert.equal(web.calls[0].body.text_query, "nora2r 新曲");
    assert.ok(logs.some(line => /联网判断（auto｜.*search：用户答应了之前的提议/.test(line)), logs.join("\n"));
  } finally { chat.close(); }
});

// 群聊里的两个人。判断调用按「本轮这句话」给观察：问 claude 的是在认真问，别的都是闲聊。
function groupChat() {
  let time = T0;
  const sent = [], logs = [];
  const model = fakeModel({
    observe: body => /claude/i.test(JSON.parse(body.messages[1].content)["本轮这句话"]) ? obs({ target: "Claude" }) : obs({ act: "chat", about: "none" }),
    reply: "唔……这个美亚不太清楚呢" });
  const web = fakeWeb([{ title: "Claude 是什么", url: "https://example.com/claude", chunks: [{ text: "Claude 是 Anthropic 做的 AI 助手。" }], snippet: "Claude" }]);
  const chat = createChat(settingsWith({ mode: "auto" }), { guildId: "g", channelIds: ["c"] }, {
    fetchImpl: model.fetchImpl, webFetchImpl: web.webFetchImpl, now: () => time, log: line => logs.push(line),
    adapter: { accepts: () => true, extractText: m => m.content, typing: async () => {}, send: async (_, text) => { sent.push(text); } },
  });
  let n = 0;
  const say = async (user, content, after = 10000) => { time += after; await chat.handle({ id: "m" + ++n, guildId: "g", channelId: "c", author: { id: user }, content }); };
  return { chat, web, sent, logs, say };
}

test("群里别的人回「要」也算答应：搜提问那个人的对象，他那边的提议跟着用掉", async () => {
  // 线上：A 问「你认识 claude 吗」，美亚提议去翻情报；B 回了句「要」，提议挂在 A 的会话上，
  // B 这句成了没头没脑的一个字，她反问「是要美亚继续说 Claude 的事吗」。
  const g = groupChat();
  try {
    await g.say("A", "你认识claude吗");
    assert.match(g.sent.at(-1), /要我去网上查查吗？/);
    await g.say("B", "要");
    assert.equal(g.web.calls.length, 1, "B 的「要」答应的是美亚给 A 的提议");
    assert.equal(g.web.calls[0].body.text_query, "Claude");
    assert.ok(g.logs.some(line => /search：群友答应了美亚对别人的提议「Claude」/.test(line)), g.logs.join("\n"));
    await g.say("A", "要");
    assert.equal(g.web.calls.length, 1, "同一件事不再搜第二遍");
  } finally { g.chat.close(); }
});

test("自己在提议之后跟美亚说过话，再回「要」就不借别人的提议", async () => {
  // 这时他的「要」更可能是在接自己那段对话，替他去搜别人问的东西就是误搜。
  const g = groupChat();
  try {
    await g.say("A", "你认识claude吗");
    await g.say("B", "今天打了好几把音击");
    await g.say("B", "要");
    assert.equal(g.web.calls.length, 0);
  } finally { g.chat.close(); }
});

test("「你翻翻 claude 的情报」是明说要搜：直接搜，不再提议一遍", async () => {
  const g = groupChat();
  try {
    await g.say("B", "你翻翻claude的情报");
    assert.equal(g.web.calls.length, 1);
    assert.equal(g.web.calls[0].body.text_query, "Claude");
    assert.doesNotMatch(g.sent.at(-1), /要我去网上查查吗？/);
    assert.ok(g.logs.some(line => /search：用户明说要搜「Claude」/.test(line)), g.logs.join("\n"));
  } finally { g.chat.close(); }
});

test("同一篇文章的两个地址只列一次，第二个位置留给别的来源", async () => {
  // 2026-10-09 群里实测：维基百科的 /zh-hk/ 和 /wiki/ 两个地址占满了两条来源。
  const model = fakeModel({ observe: obs({ target: "CHUNITHM 最新版本", fresh: true }),
    reply: { text: "日本版最新是《Mate》。", emotion: "happy", scene: "explanation", expressionIds: [], sourceIds: ["S1", "S2", "S3"] } });
  const web = fakeWeb([
    { title: "CHUNITHM", url: "https://zh.wikipedia.org/zh-hk/CHUNITHM", chunks: [{ text: "CHUNITHM 最新版本……" }], snippet: "CHUNITHM 最新版本" },
    { title: "CHUNITHM - 維基百科，自由的百科全書", url: "https://zh.wikipedia.org/wiki/CHUNITHM", chunks: [{ text: "CHUNITHM 最新版本……" }], snippet: "CHUNITHM 最新版本" },
    { title: "CHUNITHM 官网", url: "https://chunithm.sega.jp/", chunks: [{ text: "CHUNITHM 最新版本……" }], snippet: "CHUNITHM 最新版本" },
  ]);
  const result = await requestReply(settingsWith({ mode: "auto" }), say("CHUNITHM 最新版本是什么"), { fetchImpl: model.fetchImpl, webFetchImpl: web.webFetchImpl });
  assert.equal(result.text, "日本版最新是《Mate》。\n\n参考资料：\nCHUNITHM\nhttps://zh.wikipedia.org/zh-hk/CHUNITHM\nCHUNITHM 官网\nhttps://chunithm.sega.jp/");
  assert.equal(result.sourceStats.cited, 2);
  assert.equal(result.sourceStats.displayed, 2);
});
