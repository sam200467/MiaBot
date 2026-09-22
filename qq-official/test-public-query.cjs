"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { executeQuery, validateQuery, formatResult } = require("./public-query.cjs");
const catalog = require("../ongeki-song-catalog.json");
const characters = require("../chat-core/knowledge/ongeki-characters.json");
const filter = (field, op, value) => ({ field, op, value });
const run = (filters, extra = {}) => executeQuery({ filters, select: ["title"], ...extra });
const all = query => {
  const first = executeQuery(query), entries = [...first.entries];
  for (let page = 2; page <= first.pages; page++) entries.push(...executeQuery({ ...query, page }).entries);
  return entries;
};

test("开头/包含/完整名互不退化；严格搜索不引入别名与纠错", () => {
  const prefix = run([filter("title", "prefix", "ＡＩ")]);
  assert.deepEqual(prefix.entries.map(e => e.title).sort(), ["Ai C", "Ai Drew", "Ai Me", "Ai Nov", "Air"].sort());
  const includes = all({ filters: [filter("title", "contains", "ai")] });
  assert.ok(includes.some(e => e.title === "Brain Power"));
  assert.ok(!prefix.entries.some(e => e.title === "Brain Power" || e.title === "雷切-RAIKIRI-"));
  assert.equal(run([filter("title", "eq", "ai")]).total, 0);
  assert.equal(run([filter("title", "prefix", "サドマミホリツク")]).total, 0);
  assert.ok(run([filter("title", "search", "サドマミホリツク")]).fuzzy);
  assert.equal(run([filter("title", "search", "id999999999")]).total, 0);
});

test("美亚对战曲包含 both，排除纯歌手；支持中文名与短名消歧", () => {
  const mia = characters.characters.find(c => c.aliases.includes("美亚"));
  const entries = all({ filters: [filter("opponent", "eq", "美亚")] });
  const titles = new Set(entries.map(e => e.title));
  const catalogTitles = new Set(catalog.songs.map(s => s.meta.name));
  for (const song of mia.songs.filter(s => catalogTitles.has(s.title))) {
    assert.equal(titles.has(song.title), ["boss", "both"].includes(song.role), song.title);
  }
  assert.ok(mia.songs.some(s => s.role === "both" && titles.has(s.title)));
  assert.throws(() => run([filter("opponent", "eq", "柏木")]), /完整|角色/);
  assert.ok(run([filter("opponent", "eq", "葵")]).total);
});

test("组合筛选针对同一张谱面；等级与定数分别比较", () => {
  const entries = all({ filters: [filter("difficulty", "eq", "MAS"), filter("level", "eq", "14"), filter("constant", "gte", 14.4), filter("constant", "lt", 14.7)] });
  assert.ok(entries.length > 0);
  for (const entry of entries) for (const row of entry.rows) {
    assert.equal(row.difficulty, "MAS"); assert.equal(row.level, "14");
    assert.ok(row.constant >= 14.4 && row.constant < 14.7);
  }
  assert.equal(run([filter("title", "eq", "Ai C"), filter("difficulty", "eq", "BAS"), filter("constant", "gt", 14)]).total, 0);
  assert.throws(() => run([filter("level", "eq", "14.4")]), /等级/);
});

test("未知定数不等于0也不满足不等于条件，返回时标注未知", () => {
  const song = catalog.songs.find(s => s.ADV?.has_chart && s.ADV.const_status === "unknown");
  const filters = [filter("title", "eq", song.meta.name), filter("difficulty", "eq", "ADV")];
  assert.equal(run([...filters, filter("constant", "gte", 0)]).total, 0);
  assert.equal(run([...filters, filter("constant", "ne", 0)]).total, 0);
  assert.match(formatResult(run(filters, { select: ["title", "constant"] })), /未知/);
});

test("BPM/谱师/物量等数据库字段可组合，按谱面排序和计数不重复", () => {
  const entries = all({ entity: "charts", filters: [filter("bpm", "gte", 180), filter("notes", "gte", 1000), filter("designer", "contains", "ペンギン")], sort: { field: "notes", direction: "desc" } });
  assert.ok(entries.length);
  const counts = new Set();
  let previous = Infinity;
  for (const entry of entries) {
    const row = entry.rows[0];
    assert.ok(row.notes <= previous); previous = row.notes;
    assert.ok(row.bpm >= 180 && row.notes >= 1000 && row.designer.includes("ペンギン"));
    assert.ok(!counts.has(row.chartKey)); counts.add(row.chartKey);
  }
  const total = run([], { entity: "charts", mode: "count" });
  assert.equal(total.entries.length, 0);
  assert.equal(total.total, all({ filters: [], entity: "charts" }).length);
  const umapi = run([filter("title", "eq", "うまぴょい伝説"), filter("opponent", "eq", "美亚")], { select: ["title", "difficulty", "opponent"] });
  assert.deepEqual(umapi.entries[0].rows.map(r => r.difficulty), ["LUN"]);
  assert.match(formatResult(umapi), /补充谱面/);
});

test("严格拒绝未支持的字段/操作/类型，不能静默丢失条件", () => {
  for (const query of [
    { filters: [filter("score", "gt", 1000000)] },
    { filters: [filter("title", "regex", ".*")] },
    { filters: [filter("constant", "gte", "14")] },
    { filters: [filter("difficulty", "eq", "PURPLE")] },
    { filters: [filter("title", "in", [])] },
    { filters: [filter("release", "eq", "2026-02-30")] },
    { filters: [], sql: "select * from bindings" },
    { filters: [], select: ["password"] },
    { filters: [], page: 1.2 },
    { filters: [], sort: { field: "constant", direction: "desc" } },
  ]) assert.throws(() => validateQuery(query));
});

test("翻页不漏不重，零结果/页码越界/计数都保留条件与来源", () => {
  const query = { filters: [filter("title", "contains", "ai")], select: ["title"], entity: "songs" };
  const first = executeQuery(query), entries = all(query);
  assert.equal(entries.length, first.total);
  assert.equal(new Set(entries.map(e => e.rows[0].songKey)).size, first.total);
  assert.match(formatResult(executeQuery({ ...query, page: 999 })), /超出范围/);
  const empty = formatResult(run([filter("bpm", "gt", 99999)]));
  assert.match(empty, /BPM＞99999/); assert.match(empty, /0 首/); assert.match(empty, /没匹配到/);
  assert.match(formatResult(run([], { mode: "count" })), /本地音击曲库快照/);
});

test("同曲同作者的全半角历史记录合并计数，并标明历史收录", () => {
  const r = run([filter("title", "eq", "TiamaT:F minor")]);
  assert.equal(r.total, 1);
  assert.match(formatResult(r), /历史记录/);
  const deleted = run([filter("title", "eq", "TiamaT:F minor"), filter("deleted", "eq", true)]);
  assert.equal(deleted.total, 1);
  assert.match(formatResult(deleted), /已删除记录/);
});

const pickQuery = (selection, extra = {}) => ({ filters: [filter("constant", "eq", 14.5)], entity: "charts", select: ["title", "constant"], selection, ...extra });
test("截图请求：从全部14.5谱面不放回抽两张，不是第一页前两张", () => {
  const pool = all(pickQuery({ kind: "all" }));
  const result = executeQuery(pickQuery({ kind: "random", count: 2 }), { pickIndex: n => n - 1 });
  assert.equal(result.total, pool.length);
  assert.equal(result.selectedTotal, 2); assert.equal(result.entries.length, 2);
  assert.equal(new Set(result.selectionKeys).size, 2);
  assert.equal(result.selectionKeys[0], pool.at(-1).rows[0].chartKey, "完整池最后一项必须有机会抽到");
  assert.ok(result.entries.every(e => e.rows.every(r => r.constant === 14.5)));
  const text = formatResult(result);
  assert.equal((text.match(/^《/gm) || []).length, 2);
  assert.match(text, /随机抽取：2 张谱面/); assert.doesNotMatch(text, /下一页/);
});

test("筛选后按数值排序取前N项，数量不变成分页大小", () => {
  const result = executeQuery(pickQuery({ kind: "first", count: 3 }, { sort: { field: "notes", direction: "desc" } }));
  const ranked = all(pickQuery({ kind: "all" }, { sort: { field: "notes", direction: "desc" } }));
  assert.equal(result.entries.length, 3);
  assert.deepEqual(result.selectionKeys, ranked.slice(0, 3).map(e => e.rows[0].chartKey));
  assert.match(formatResult(result), /按顺序取前：3 张谱面/);
});

test("复核预览不抽签；随机抽样跨页使用同一批结果", () => {
  const query = pickQuery({ kind: "random", count: 10 });
  const preview = executeQuery(query, { preview: true, pickIndex: () => { throw Error("预览不应抽签"); } });
  assert.equal(preview.selectionKeys.length, 0);
  const first = executeQuery(query, { pickIndex: n => n - 1 });
  const second = executeQuery({ ...query, page: 2 }, { selectionKeys: first.selectionKeys, pickIndex: () => { throw Error("翻页不应重抽"); } });
  assert.equal(first.entries.length, 8); assert.equal(second.entries.length, 2);
  assert.deepEqual(second.selectionKeys, first.selectionKeys);
  assert.equal(new Set([...first.entries, ...second.entries].map(e => e.rows[0].chartKey)).size, 10);
  assert.equal(second.pages, 2);
});

test("换一批排除上次结果；不足和耗尽如实说明，不靠重复补足", () => {
  const query = { filters: [filter("title", "prefix", "ai")], selection: { kind: "random", count: 3 } };
  const first = executeQuery(query, { pickIndex: () => 0 });
  const next = executeQuery({ ...query, selection: { kind: "random", count: 3, excludePrevious: true } }, { excludeKeys: first.selectionKeys, pickIndex: () => 0 });
  assert.equal(next.entries.length, 2);
  assert.ok(next.selectionKeys.every(k => !first.selectionKeys.includes(k)));
  assert.match(formatResult(next), /只剩 2 首/);
  const exhausted = executeQuery({ ...query, selection: { kind: "random", count: 3, excludePrevious: true } }, { excludeKeys: [...first.selectionKeys, ...next.selectionKeys] });
  assert.equal(exhausted.entries.length, 0); assert.match(formatResult(exhausted), /没有可选/);
});

test("抽样数量/计数冲突/模型伪造结果键都拒绝，不静默截断", () => {
  for (const choice of [{ kind: "random" }, { kind: "random", count: 0 }, { kind: "first", count: 1.5 }, { kind: "random", count: 51 }, { kind: "all", count: 2 }, { kind: "random", count: 2, keys: ["fake"] }]) {
    assert.throws(() => validateQuery(pickQuery(choice)));
  }
  assert.throws(() => validateQuery(pickQuery({ kind: "random", count: 2 }, { mode: "count" })));
});
