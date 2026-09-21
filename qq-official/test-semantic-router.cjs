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
  assert.match(result.text, /帮助/);
});
