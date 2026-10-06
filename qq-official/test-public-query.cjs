"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { executeQuery, validateQuery, formatResult, queryMismatch, characterMentions } = require("./public-query.cjs");
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

test("search 操作符不吞符号：整条是符号的曲名也一样查得到", () => {
  // search 走的是 song-search 那套归一化。它若把 \p{S} 一起抹掉，《∀》这条查询
  // 就变成空串，静默返回 0 条 —— 用户拿到的是「没这首歌」，而曲库里明明有。
  assert.equal(run([filter("title", "search", "∀")]).total, run([filter("title", "eq", "∀")]).total);
  assert.equal(run([filter("title", "search", "∀")]).total, 1);
  assert.ok(run([filter("title", "search", "☆")]).total > 1);
  // 少打符号的写法仍走兜底那一级，别因为这次的改动被削掉
  assert.equal(run([filter("title", "search", "ウキウキCandy")]).total, 1);
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

test("角色称呼：简繁日写法和单独的名字都认得，不从别的词里误认", () => {
  const names = text => characterMentions(text, { self: "柏木 美亜" }).flatMap(m => m.names);
  for (const [text, expected] of [
    ["刹那的曲子有哪些", ["皇城 セツナ"]], ["セツナちゃんの曲", ["皇城 セツナ"]],
    ["彩華学姐的曲子", ["早乙女 彩華"]], ["彩华学姐的曲子都有哪些", ["早乙女 彩華"]],
    ["高濑梨绪的个人曲", ["高瀬 梨緒"]], ["I like Takase Rio", ["高瀬 梨緒"]], ["あかりの曲", ["星咲 あかり"]],
    ["茜的个人曲", ["逢坂 茜"]], ["美亚的歌有哪些", ["柏木 美亜"]],
    // 开头喊一声「美亚，」只是在叫机器人，不是在问她
    ["美亚，梨绪有哪些歌", ["高瀬 梨緒"]],
    ["向日葵的歌", []], ["scenario", []], ["ドラムの曲", []], ["MiaBot 你好", []],
  ]) assert.deepEqual(names(text), expected, text);
  // 模型写日文汉字或单独的名字也能落到唯一角色，不必绕一圈追问
  for (const [value, name] of [["彩華", "早乙女 彩華"], ["セツナ", "皇城 セツナ"], ["美亜", "柏木 美亜"], ["咲姫", "柏木 咲姫"], ["梨緒", "高瀬 梨緒"]]) {
    assert.equal(validateQuery({ filters: [filter("originalFor", "eq", value)] }).filters[0].value, name, value);
  }
});

test("角色曲：没说关系按原创曲，个人曲要明说；查询里的角色必须是原话里的人", () => {
  const check = (text, ...filters) => queryMismatch(validateQuery({ filters, select: ["title"] }), text, { self: "柏木 美亜" });
  // 线上截图里的两次错误：刹那被换成日向千夏，「梨绪有哪些歌」被查成个人曲
  assert.match(check("刹那的曲子有哪些", filter("originalFor", "eq", "日向 千夏")), /刹那.*皇城 セツナ.*日向 千夏/);
  assert.match(check("梨绪有哪些歌", filter("personalFor", "eq", "梨绪")), /个人曲.*originalFor/);
  assert.match(check("梨绪有哪些歌", filter("singer", "eq", "梨绪")), /originalFor/);
  assert.match(check("梨绪的个人曲是哪首", filter("originalFor", "eq", "梨绪")), /personalFor/);
  assert.match(check("梨绪唱过哪些歌", filter("originalFor", "eq", "梨绪")), /singer/);
  assert.match(check("不是个人曲，是原创曲，梨绪的", filter("personalFor", "eq", "梨绪")), /personalFor/);
  for (const [text, ...filters] of [
    ["刹那的曲子有哪些", filter("originalFor", "eq", "刹那")],
    ["彩华学姐的曲子都有哪些", filter("originalFor", "eq", "早乙女 彩華")],
    ["梨绪的个人曲是哪首", filter("personalFor", "eq", "梨绪")],
    ["梨绪唱过哪些歌", filter("singer", "eq", "梨绪")],
    ["對戰相手是梨緒的歌", filter("opponent", "eq", "梨緒")],
    ["梨绪原创曲以外的歌", filter("singer", "eq", "梨绪")],
    ["你的歌有哪些", filter("originalFor", "eq", "美亚")],
    ["有哪些歌的对战相手是你自己？", filter("opponent", "eq", "美亚")],
    // 单字名不在严格识别里，但原话里确实写着，不能误判成换了人
    ["茜和梨绪合唱的歌", filter("singer", "eq", "茜"), filter("singer", "eq", "梨绪")],
    // 代词指回上文的角色；客串角色没有原创曲，不强行改成原创曲
    ["那她的个人曲呢", filter("personalFor", "eq", "梨绪")],
    ["初音未来有哪些歌", filter("opponent", "eq", "初音ミク")],
  ]) assert.equal(check(text, ...filters), "", text);
  const setsuna = characters.characters.find(c => c.name === "皇城 セツナ");
  const catalogTitles = new Set(catalog.songs.map(s => s.meta.name));
  const titles = new Set(all({ filters: [filter("originalFor", "eq", "刹那")] }).map(e => e.title));
  assert.deepEqual([...titles].sort(), setsuna.songs.filter(s => s.original && catalogTitles.has(s.title)).map(s => s.title).sort());
});

test("合唱曲只算曲绘上那位的原创曲，另一位仍查得到演唱", () => {
  // 线上截图：「蓝原椿的曲子里bpm最高的」答成了茜的《いつか花咲くその前に》，椿在那首里只是合唱
  const top = executeQuery({ filters: [filter("originalFor", "eq", "椿")], select: ["title", "bpm"], sort: { field: "bpm", direction: "desc" }, selection: { kind: "first", count: 1 } });
  assert.notEqual(top.entries[0].title, "いつか花咲くその前に");
  const has = (field, who) => all({ filters: [filter(field, "eq", who)] }).some(e => e.title === "いつか花咲くその前に");
  assert.ok(has("originalFor", "茜") && !has("originalFor", "椿") && has("singer", "椿"));
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

test("特殊 LUNATIC 0 的未定定数不等于0，也不满足不等于条件", () => {
  const song = catalog.songs.find(s => s.meta.name === "Perfect Shining!!" && s.LUN?.const_status === "unknown");
  const filters = [filter("title", "eq", song.meta.name), filter("difficulty", "eq", "LUN")];
  assert.equal(run([...filters, filter("constant", "gte", 0)]).total, 0);
  assert.equal(run([...filters, filter("constant", "ne", 0)]).total, 0);
  assert.match(formatResult(run(filters, { select: ["title", "constant"] })), /无定数/);
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

test("问歌曲 ID 返回分表短 ID，明确问官方曲目 ID 仍返回官方编号", () => {
  const song = "光焔のラテラルアーク";
  const short = run([filter("title", "eq", song)], { select: ["title", "botId"] });
  assert.equal(short.total, 1);
  assert.equal(short.entries[0].rows[0].botId, 728);
  assert.match(formatResult(short), /ID：728/);
  assert.doesNotMatch(formatResult(short), /601129/);
  const byShortId = run([filter("botId", "eq", 728)]);
  assert.deepEqual(byShortId.entries.map(entry => entry.title), [song]);
  const official = run([filter("title", "eq", song)], { select: ["title", "officialId"] });
  assert.match(formatResult(official), /官方曲目ID：601129/);
});
