"use strict";
// 指令面板测试。全程走假 transport，**不发任何真实请求**。
const test = require("node:test");
const assert = require("node:assert/strict");

const { COMMANDS, ALIASES } = require("./mia-commands.cjs");
const panel = require("./mia-command-panel.cjs");

// 假的传输层：只记下 rest 调用，按需返回预设结果。
function fakeTransport(handler) {
  const calls = [];
  return {
    calls,
    rest: async (method, path, body) => {
      calls.push({ method, path, body });
      return handler ? handler(method, path, body) : {};
    },
    stop() {},
  };
}

// ── 防漂移：这张表是「代码里有命令、面板里忘了更新」的唯一防线 ────────
test("命令表和面板描述必须一一对应", () => {
  const commands = Object.keys(COMMANDS);
  const described = Object.keys(panel.DESCRIPTIONS);

  const missing = commands.filter((name) => !described.includes(name));
  assert.deepEqual(missing, [],
    "这些命令没有面板描述，加命令时忘了更新 DESCRIPTIONS：" + missing.join(", "));

  const stale = described.filter((name) => !commands.includes(name));
  assert.deepEqual(stale, [],
    "这些描述对应的命令已经不存在了，从 DESCRIPTIONS 里删掉：" + stale.join(", "));
});

test("面板元素数量不超过平台上限", () => {
  const items = panel.panelItems();
  assert.ok(items.length <= panel.PANEL_ITEM_MAX,
    "面板元素 " + items.length + " 个，超过上限 " + panel.PANEL_ITEM_MAX +
    "（命令多了要显式 exclude 几条，别指望平台收）");
  assert.equal(items.length, Object.keys(COMMANDS).length - 2, "默认省略 /取消 和 /状态，给搜索留面板位置");
  assert.ok(!items.some((item) => item.name === "/取消"));
});

test("每个元素都合乎平台的长度限制", () => {
  for (const item of panel.panelItems()) {
    assert.ok([...item.name].length <= panel.NAME_MAX, "名字超长：" + item.name);
    assert.ok([...item.desc].length <= panel.DESC_MAX, "描述超长：" + item.desc);
    assert.equal(item.type, "command", "面板只做发现入口，元素一律是 command");
  }
});

// ── 派生规则 ────────────────────────────────────────────────────────
test("元素名就是能直接用的命令写法", () => {
  // 点击 command 元素只是把 name 填进输入框，所以它必须和手打的一致：
  // 斜杠 + ALIASES 里的第一个说法（中文那个）。
  assert.equal(panel.commandText("help"), "/帮助");
  assert.equal(panel.commandText("chart"), "/分表");
  for (const name of Object.keys(COMMANDS)) {
    const text = panel.commandText(name);
    assert.ok(text.startsWith("/"), name + " 的命令写法应当以斜杠开头");
    assert.ok(ALIASES[name].includes(text.slice(1)), name + " 的写法应当来自 ALIASES");
  }
});

test("exclude 能挑掉指定的命令", () => {
  // 2026-09-19：候选/驳回那两条命令已经从美亚去掉了，这里换成还存在的三条
  const items = panel.panelItems({ exclude: ["aliasdelete", "unbind", "cancel"] });
  const names = items.map((i) => i.name);
  assert.ok(!names.includes("/删除别名"));
  assert.ok(!names.includes("/解绑"), "exclude 里的都该被挑掉");
  assert.ok(!names.includes("/取消"));
  assert.equal(items.length, Object.keys(COMMANDS).length - 3);
});

// ── 校验 ────────────────────────────────────────────────────────────
test("超限的元素在本地就被拦下，不发给平台", () => {
  assert.throws(() => panel.validatePanel({
    items: [{ type: "command", name: "/" + "很长".repeat(8), desc: "x" }],
  }), /元素名超长/);

  assert.throws(() => panel.validatePanel({
    items: [{ type: "command", name: "/x", desc: "很长的描述".repeat(10) }],
  }), /描述超长/);

  assert.throws(() => panel.validatePanel({ items: [] }), /一个元素都没有/);

  const tooMany = Array.from({ length: panel.PANEL_ITEM_MAX + 1 }, (_, i) => ({
    type: "command", name: "/n" + i, desc: "d",
  }));
  assert.throws(() => panel.validatePanel({ items: tooMany }), /超过平台上限/);
});

test("version 由内容决定：内容不变就不该重复提交", () => {
  const a = panel.buildPanel();
  const b = panel.buildPanel();
  assert.equal(a.version, b.version, "同样的内容要得到同样的版本号");
  const c = panel.buildPanel({ exclude: ["cancel", "status", "unbind"] });
  assert.notEqual(a.version, c.version, "内容变了版本号也要变");
});

// ── 注册流程 ────────────────────────────────────────────────────────
test("还没建过：调 POST /v2/panels，且只挂指定群", async () => {
  const transport = fakeTransport((method, path) => {
    if (method === "GET") return { records: [], is_end: true };
    return { panel_id: "p_test_1" };
  });
  const result = await panel.registerGroupPanel({
    transport, groups: ["GROUP_A", "GROUP_B"], log: () => {},
  });

  const create = transport.calls.find((c) => c.method === "POST");
  assert.ok(create, "应当发过 POST");
  assert.equal(create.path, "/v2/panels");
  assert.equal(create.body.scope, "group");
  assert.equal(create.body.target_type, "specific", "默认必须只挂指定群，不能全局推");
  assert.deepEqual(create.body.group_openids, ["GROUP_A", "GROUP_B"]);
  assert.equal(create.body.panel.items.length, Object.keys(COMMANDS).length - 2);
  assert.equal(result.created, true);
});

test("已经建过且内容没变：一次写请求都不发", async () => {
  const existing = panel.buildPanel();
  const transport = fakeTransport((method) => {
    if (method === "GET") {
      return { records: [{ panel_id: "p_old", scope: "group", target_type: "specific", panel: existing }] };
    }
    return {};
  });
  const result = await panel.registerGroupPanel({ transport, groups: ["GROUP_A"], log: () => {} });
  assert.equal(result.unchanged, true);
  assert.equal(result.panelId, "p_old");
  assert.ok(!transport.calls.some((c) => c.method !== "GET"), "内容没变不该发写请求");
});

test("已经建过但内容变了：用 PUT 改内容（不动已关联的群）", async () => {
  // ⚠ 夹具要让**内容**真的不同。早先这里是改 version 制造的差异 ——
  // 现在比的是面板元素（平台的 version 是它自己维护的、列表接口还不返回），
  // 靠改 version 会判成「内容一致」，那就测不到 PUT 这条路了。
  const ours = panel.buildPanel();
  const stale = { ...ours, items: [...ours.items, { type: "command", name: "/旧的", desc: "早就删掉的命令" }] };
  const transport = fakeTransport((method) => {
    if (method === "GET") {
      return { records: [{ panel_id: "p_old", scope: "group", target_type: "specific", panel: stale }] };
    }
    return {};
  });
  const result = await panel.registerGroupPanel({ transport, groups: ["GROUP_A"], log: () => {} });
  assert.equal(result.updated, true);
  const put = transport.calls.find((c) => c.method === "PUT");
  assert.ok(put, "应当发过 PUT");
  assert.equal(put.path, "/v2/panels/p_old");
  assert.ok(!transport.calls.some((c) => c.method === "POST"), "不该再建一个新的（面板名额只有 20 个）");
  assert.equal(put.body.panel.items.length, Object.keys(COMMANDS).length - 2);
});

test("比对前要归一化：平台会去掉开头的斜杠、键序也不一样", () => {
  // 实测：发 "/帮助" 上去，读回来是 "帮助"；返回的键序是 {name,desc,type}。
  // 不归一化的话 JSON.stringify 永远不相等 —— 每次 --register 都白发一个 PUT。
  const mine = [{ type: "command", name: "/帮助", desc: "看看" }];
  const theirs = [{ name: "帮助", desc: "看看", type: "command" }];
  assert.deepEqual(panel.normalizeItems(mine), panel.normalizeItems(theirs));
  assert.equal(JSON.stringify(panel.normalizeItems(mine)), JSON.stringify(panel.normalizeItems(theirs)),
    "归一化之后 stringify 必须相等，判等就是拿它比的");
  // 内容真的不同时还是要能区分出来
  assert.notEqual(
    JSON.stringify(panel.normalizeItems(mine)),
    JSON.stringify(panel.normalizeItems([{ name: "绑定", desc: "看看", type: "command" }])));
});

test("不指定群又不肯全局：拒绝，不偷偷推给所有群", async () => {
  const transport = fakeTransport(() => ({}));
  await assert.rejects(
    () => panel.registerGroupPanel({ transport, groups: [], log: () => {} }),
    /没有指定群 openid/);
  assert.equal(transport.calls.length, 0, "拒绝时不该发任何请求");
});

test("--all-groups 时才用 target_type=all", async () => {
  const transport = fakeTransport((method) => (method === "GET" ? { records: [] } : { panel_id: "p" }));
  await panel.registerGroupPanel({ transport, groups: [], allGroups: true, log: () => {} });
  const create = transport.calls.find((c) => c.method === "POST");
  assert.equal(create.body.target_type, "all");
  assert.equal(create.body.group_openids, undefined, "全局面板不该带群列表");
});

test("dry-run 一个请求都不发", async () => {
  const transport = fakeTransport(() => ({}));
  const result = await panel.registerGroupPanel({
    transport, groups: ["GROUP_A"], dryRun: true, log: () => {},
  });
  assert.equal(result.dryRun, true);
  assert.equal(transport.calls.length, 0, "dry-run 只打印，不发请求");
  assert.equal(result.body.target_type, "specific");
});

test("认领面板靠 remark，不靠位置", () => {
  const ours = panel.buildPanel();
  const payload = {
    records: [
      { panel_id: "other_1", panel: { remark: "别人的面板" } },
      { panel_id: "ours_1", panel: ours },
      { panel_id: "other_2", panel: {} },
    ],
  };
  assert.equal(panel.findOurs(payload)?.panel_id, "ours_1");
  assert.equal(panel.findOurs({ records: [] }), null);
  assert.equal(panel.findOurs({}), null, "形状不对也不能崩");
});
