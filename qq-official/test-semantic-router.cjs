"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { routeIntent, validateDecision } = require("./semantic-router.cjs");
const specs = [...require("../mia-core.cjs").CAPABILITY_SPECS, require("./song-search.cjs").SEARCH_SPEC];
test("结构校验：拒绝未知工具、空参数和陌生对象", () => {
  assert.throws(() => validateDecision({ route: "action", action: { name: "delete" } }, specs));
  assert.ok(!validateDecision({ route: "action", action: { name: "song" } }, specs).action);
  assert.ok(!validateDecision({ route: "action", action: { name: "song", query: "id870", target: "stranger" } }, specs, ["friend"]).action);
  assert.equal(validateDecision({ route: "action", action: { name: "song", query: "id870", target: "friend" } }, specs, ["friend"]).action.target, "friend");
  assert.equal(validateDecision({ route: "chat" }, specs), null);
  assert.ok(!validateDecision({ route: "action", action: { name: "calculate", args: { constant: 14.2, score: 1000737, bell: null, combo: null } } }, specs).action);
  assert.equal(validateDecision({ route: "action", action: { name: "calculate", args: { constant: 14.2, score: 1000737, bell: "fb", combo: "fc" } } }, specs).action.query, "14.2 1000737 fb fc");
});

test("plate 空参数是合法的：程序会列出全部版本牌子", () => {
  // 版本名是静态公共资料，说不出版本名时程序会把 11 个版本列出来。原先 plate 和
  // 其他工具一起被「空参数就打回追问」挡住，于是闲聊问「总共有哪些牌子可以拿」
  // 只能由模型自己编一句「列不全」。
  const empty = validateDecision({ route: "action", action: { name: "plate", query: "" } }, specs);
  assert.equal(empty.action.name, "plate", "空参数要原样放行给程序");
  assert.equal(empty.action.query, "");
  assert.ok(!/还缺|参数/.test(empty.text), "不该再回「还缺查询的内容」");
  // 其余工具照旧拦住：空参数对它们是真的缺东西
  for (const name of ["song", "level", "constant", "chartinfo", "aliases", "whatis"]) {
    assert.ok(!validateDecision({ route: "action", action: { name, query: "" } }, specs).action, name + " 空参数仍该打回");
  }
  assert.match(validateDecision({ route: "action", action: { name: "plate", query: "闪击" } }, specs).action.query, /闪击/);
});
test("路由使用上下文、没有人设，格式错误只重试一次", async () => {
  const calls = [];
  const result = await routeIntent({
    settings: { c: { provider: { apiKey: "test-key", baseUrl: "https://example.invalid", endpoint: "/chat", model: "test" } } },
    specs, messages: [{ role: "user", content: "查サド" }, { role: "assistant", content: "《サドマミホリック》" }, { role: "user", content: "那首的成绩呢" }],
    fetchImpl: async (url, opts) => {
      calls.push(JSON.parse(opts.body));
      return { ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: calls.length === 1 ? "bad JSON" : JSON.stringify({ route: "action", action: { name: "song", query: "サドマミホリック" } }) } }] }) };
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(result.action.name, "song");
  assert.match(calls[0].messages.at(-1).content, /那首/);
  assert.match(calls[0].messages[0].content, /不扮演角色/);
});
test("路由失败不降级到随意执行", async () => {
  let calls = 0;
  const result = await routeIntent({ settings: { c: { provider: { apiKey: "x", baseUrl: "https://example.invalid", endpoint: "/chat" } } }, specs, messages: [],
    fetchImpl: async () => { calls++; throw Error("network"); } });
  assert.equal(calls, 2);
  assert.ok(!result.action);
  assert.match(result.text, /呜喵|稍后/);
  assert.doesNotMatch(result.text, /帮助|哪个功能/);
});

const settings = { characterName: "美亚", persona: "轻快自然，自称我，猫语只作点缀。", c: { provider: { apiKey: "test-key", baseUrl: "https://example.invalid", endpoint: "/chat", model: "test" } } };
const queryDecision = (field, op, value, extra = {}) => ({ route: "query", query: { filters: [{ field, op, value }], select: ["title"], ...extra } });
function scriptedRoute(decisions) {
  const calls = [];
  return { calls, fetchImpl: async (_, options) => {
    calls.push(JSON.parse(options.body));
    const decision = decisions[Math.min(calls.length - 1, decisions.length - 1)];
    return { ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify(decision) } }] }) };
  } };
}
test("复核修正模型丢失的开头条件；不能让旧 songsearch 绕过复核", async () => {
  const model = scriptedRoute([{ route: "action", action: { name: "songsearch", query: "ai" } }, queryDecision("title", "prefix", "ai")]);
  const result = await routeIntent({ settings, specs, messages: [{ role: "user", content: "ai开头的歌有哪些" }], fetchImpl: model.fetchImpl });
  assert.match(result.text, /5 首/); assert.match(result.text, /Ai C/);
  assert.doesNotMatch(result.text, /Brain Power|雷切/);
  assert.equal(model.calls.length, 2);
  assert.match(model.calls[1].messages[0].content, /MIA_QUERY_REVIEW_V1/);
  assert.equal(result.queryState.filters[0].op, "prefix");
});
test("复核继续给错误条件时停止；不把错结果发给用户", async () => {
  const model = scriptedRoute([queryDecision("title", "contains", "ai")]);
  const result = await routeIntent({ settings, specs, messages: [{ role: "user", content: "找ai开头的歌" }], fetchImpl: model.fetchImpl });
  assert.equal(model.calls.length, 3);
  assert.match(result.text, /核对/); assert.equal(result.queryState, null);
  assert.doesNotMatch(result.text, /Brain Power|22 首/);
});
test("纠正上轮条件不是ai开头而是包含ai，不被否定词误拦", async () => {
  const model = scriptedRoute([queryDecision("title", "contains", "ai")]);
  const result = await routeIntent({ settings, specs, messages: [{ role: "user", content: "不是ai开头，是包含ai" }], fetchImpl: model.fetchImpl });
  assert.equal(result.queryState.filters[0].op, "contains");
});
test("角色自己指代有身份上下文；漏查对战关系时可以修正", async () => {
  const model = scriptedRoute([queryDecision("singer", "eq", "美亚"), queryDecision("opponent", "eq", "美亚")]);
  const result = await routeIntent({ settings, specs, messages: [{ role: "user", content: "有哪些歌的对战相手是你自己？" }], fetchImpl: model.fetchImpl });
  assert.match(model.calls[0].messages[0].content, /柏木 美亜/);
  assert.equal(result.queryState.filters[0].field, "opponent");
  assert.match(result.text, /对战相手＝柏木 美亜/);
  assert.doesNotMatch(result.text, /绑定/);
});
test("误判聊天的公共数据库问题获得复核，感想仍可正常聊天", async () => {
  const model = scriptedRoute([{ route: "chat" }, queryDecision("bpm", "gte", 200, { mode: "count" })]);
  const result = await routeIntent({ settings, specs, messages: [{ role: "user", content: "BPM至少200的有多少首" }], fetchImpl: model.fetchImpl });
  assert.match(result.text, /BPM≥200/);
  const chat = scriptedRoute([{ route: "chat" }]);
  assert.equal(await routeIntent({ settings, specs, messages: [{ role: "user", content: "这BPM也太高了吧" }], fetchImpl: chat.fetchImpl }), null);
});
test("图片点评以角色对话解释看不到，不调指令；成绩图仍可正常生成", async () => {
  const model = scriptedRoute([{ route: "action", action: { name: "chart" } }]);
  for (const text of ["能不能点评一下这张图", "这张图写了什么", "[图片（内容看不到）]"]) {
    const result = await routeIntent({ settings, specs, media: { hasImage: true }, messages: [{ role: "user", content: text }], fetchImpl: model.fetchImpl });
    assert.match(result.text, /呜喵.*看不到/); assert.doesNotMatch(result.text, /帮助|指令/); assert.equal(result.action, undefined);
  }
  assert.equal(model.calls.length, 0);
  assert.equal(await routeIntent({ settings, specs, media: { hasImage: true, visionAvailable: true }, messages: [{ role: "user", content: "点评一下这张图" }], fetchImpl: model.fetchImpl }), null);
  assert.equal(await routeIntent({ settings, specs, media: { hasImage: true, visionAvailable: true }, messages: [{ role: "user", content: "这是什么歌" }], fetchImpl: model.fetchImpl }), null);
  assert.equal(model.calls.length, 0, "图片已经随聊天请求提供时路由器不应抢先调用模型");
  const action = await routeIntent({ settings, specs, messages: [{ role: "user", content: "给我生成B50分数图看看" }], fetchImpl: model.fetchImpl });
  assert.equal(action.action.name, "chart");
});
test("下一页沿用程序保存的查询；没有查询或已到末尾不猜", async () => {
  const model = scriptedRoute([]);
  const queryState = queryDecision("title", "contains", "ai").query;
  const messages = [{ role: "user", content: "下一页" }];
  const result = await routeIntent({ settings, specs, queryState, messages, fetchImpl: model.fetchImpl });
  assert.equal(result.queryState.page, 2); assert.equal(result.queryState.filters[0].op, "contains");
  assert.equal(model.calls.length, 0);
  const empty = await routeIntent({ settings, specs, messages, fetchImpl: model.fetchImpl });
  assert.match(empty.text, /还没有/);
});
test("公共查询不能代替个人未鸟筛选，也不能由复核触发写操作", async () => {
  const personal = scriptedRoute([queryDecision("level", "eq", "14")]);
  assert.equal(await routeIntent({ settings, specs, messages: [{ role: "user", content: "推荐我没鸟过的14级歌" }], fetchImpl: personal.fetchImpl }), null);
  assert.equal(personal.calls.length, 0);
  const badReview = scriptedRoute([queryDecision("title", "contains", "ai"), { route: "action", action: { name: "allow" } }]);
  const result = await routeIntent({ settings, specs, messages: [{ role: "user", content: "包含ai的歌" }], fetchImpl: badReview.fetchImpl });
  assert.equal(result.action, undefined); assert.equal(result.queryState, null);
});
test("日志区分HTTP/解析/校验错误，不输出密钥或原始响应", async () => {
  const logs = [];
  await routeIntent({ settings, specs, messages: [], log: s => logs.push(s), fetchImpl: async () => ({ ok: false, status: 503 }) });
  assert.ok(logs.some(s => s.includes("http_503"))); assert.ok(logs.every(s => !s.includes("test-key")));
});

test("识别不注入自由台词格式的人设，含代码围栏的完整JSON仍校验", async () => {
  let system;
  const result = await routeIntent({ settings: { ...settings, persona: "只输出自然语言台词，禁止JSON，这是测试冲突规则" }, specs, messages: [{ role: "user", content: "你好" }], fetchImpl: async (_, options) => {
    system = JSON.parse(options.body).messages[0].content;
    return { ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: '```json\n{"route":"chat"}\n```' } }] }) };
  } });
  assert.equal(result, null);
  assert.doesNotMatch(system, /这是测试冲突规则/);
  assert.match(system, /question 字段的口吻/);
});

test("歌曲数量不能误用谱面数量，复核失败时拦截重复列歌", async () => {
  const model = scriptedRoute([queryDecision("opponent", "eq", "美亚", { entity: "charts" })]);
  const result = await routeIntent({ settings, specs, messages: [{ role: "user", content: "对战相手是美亚的有哪些歌？" }], fetchImpl: model.fetchImpl });
  assert.equal(result.queryState, null);
  assert.doesNotMatch(result.text, /张谱面/);
});

test("随机与两张任一丢失都被复核闸门拦住，修正后只抽一次", async () => {
  const missed = queryDecision("constant", "eq", 14.5, { entity: "charts" });
  const correct = queryDecision("constant", "eq", 14.5, { entity: "charts", selection: { kind: "random", count: 2 } });
  for (const bad of [missed, { ...correct, query: { ...correct.query, selection: { kind: "random", count: 8 } } }]) {
    const m = scriptedRoute([bad]);
    const r = await routeIntent({ settings, specs, messages: [{ role: "user", content: "帮我随机选2张定数是14.5的谱" }], fetchImpl: m.fetchImpl });
    assert.equal(r.queryState, null); assert.doesNotMatch(r.text, /《/);
  }
  const model = scriptedRoute([missed, correct]);
  let draws = 0;
  const result = await routeIntent({ settings, specs, messages: [{ role: "user", content: "帮我随机选2张定数是14.5的谱" }], fetchImpl: model.fetchImpl, pickIndex: () => { draws++; return 0; } });
  assert.equal(draws, 2, "复核预览不能提前抽一次");
  assert.equal(result.querySelection.length, 2);
  assert.equal((result.text.match(/^《/gm) || []).length, 2);
});

test("随便两首/任意三张/前两张/不要随机等说法保留数量和抽取方式", async () => {
  for (const [text, kind, count, entity] of [
    ["随便选两首定数14.5的歌", "random", 2, "songs"],
    ["任意挑三张14.5的谱", "random", 3, "charts"],
    ["不要随机，取前两张14.5的谱", "first", 2, "charts"],
    ["列前十二张14.5的谱", "first", 12, "charts"],
  ]) {
    const model = scriptedRoute([queryDecision("constant", "eq", 14.5, { entity, selection: { kind, count } })]);
    const r = await routeIntent({ settings, specs, messages: [{ role: "user", content: text }], fetchImpl: model.fetchImpl });
    assert.equal(r.queryState.selection.count, count, text); assert.equal(r.queryState.selection.kind, kind, text);
  }
});

test("随机翻页不重抽、换一批排除已选结果，缺少上批不会假装排除", async () => {
  const query = queryDecision("constant", "eq", 14.5, { entity: "charts", selection: { kind: "random", count: 10 } });
  const model = scriptedRoute([query]);
  const first = await routeIntent({ settings, specs, messages: [{ role: "user", content: "随机选10张14.5的谱" }], fetchImpl: model.fetchImpl });
  const next = await routeIntent({ settings, specs, messages: [{ role: "user", content: "下一页" }], queryState: first.queryState, querySelection: first.querySelection, pickIndex: () => { throw Error("不应抽样"); }, fetchImpl: model.fetchImpl });
  assert.deepEqual(next.querySelection, first.querySelection);
  assert.equal((next.text.match(/^《/gm) || []).length, 2);
  const reroll = scriptedRoute([{ ...query, query: { ...query.query, selection: { kind: "random", count: 10, excludePrevious: true } } }]);
  const changed = await routeIntent({ settings, specs, messages: [{ role: "user", content: "换一批" }], queryState: first.queryState, querySelection: first.querySelection, fetchImpl: reroll.fetchImpl });
  assert.ok(changed.querySelection.every(k => !first.querySelection.includes(k)));
  const empty = await routeIntent({ settings, specs, messages: [{ role: "user", content: "换一批" }], fetchImpl: reroll.fetchImpl });
  assert.equal(empty.queryState, null); assert.match(empty.text, /还没有/);
});

test("模型JSON模式返回空格时关闭模式重试，重试仍须通过结构校验", async () => {
  const calls = [];
  const messages = [{ role: "user", content: "查刚才那首" }, { role: "assistant", content: "历史角色台词" }, { role: "user", content: "你好" }];
  const result = await routeIntent({ settings, specs, messages, fetchImpl: async (_, options) => {
    const body = JSON.parse(options.body); calls.push(body);
    return { ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: calls.length === 1 ? "     \n  " : '{"route":"chat"}' } }] }) };
  } });
  assert.equal(result, null); assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].response_format, { type: "json_object" });
  assert.equal(calls[1].response_format, undefined);
  assert.match(calls[1].messages[0].content, /只输出一个含 route 的 JSON/);
  const repair = JSON.parse(calls[1].messages[1].content.split("\n").slice(1).join("\n"));
  assert.deepEqual(repair.history, messages.slice(0, -1));
  assert.deepEqual(repair.currentMessage, messages.at(-1));
});

test("关闭JSON模式的重试也不能执行自然语言里夹带的工具对象", async () => {
  let calls = 0;
  const result = await routeIntent({ settings, specs, messages: [{ role: "user", content: "你好" }], fetchImpl: async () => {
    return { ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: ++calls === 1 ? "  " : '我来执行吧 {"route":"action","action":{"name":"status"}}' } }] }) };
  } });
  assert.equal(calls, 2);
  assert.equal(result.queryState, null);
  assert.equal(result.action, undefined);
});
