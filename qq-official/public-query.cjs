"use strict";

// A typed, read-only view over the installed snapshots. Model output is data,
// never SQL, code, a path, or an instruction to the player-record executor.
const catalog = require("../ongeki-song-catalog.json");
const internal = require("../ongeki-music-internal.json");
const { loadCharacters, normalize: titleKey } = require("../chat-core/knowledge.cjs");
const path = require("node:path");
const songSearch = require("./song-search.cjs");
const { botChartId, catalogCoverage } = require("./song-id.cjs");
const { randomInt } = require("node:crypto");
const { Converter } = require("opencc-js");
const characters = loadCharacters(path.join(__dirname, "../chat-core"));
const textKey = value => String(value ?? "").normalize("NFKC").toLowerCase().trim();
// One key for 彩華/彩华, 美亜/美亚, 梨緒/梨绪, 咲姫/咲姬. OpenCC's jp→cn table
// leaves 姫 alone and turns 緒 into 緖, so those two are patched by hand.
const toSimplified = Converter({ from: "jp", to: "cn" });
const foldHan = value => toSimplified(String(value ?? "").normalize("NFKC").toLowerCase()).replace(/[緒緖]/g, "绪").replace(/姫/g, "姬");
const characterKey = value => foldHan(value).replace(/\s+/g, "");
const characterByName = new Map((characters?.characters || []).map(c => [c.name, c]));
const namesByAlias = new Map();
const addAlias = (alias, name) => {
  const key = characterKey(alias);
  if (!key) return;
  if (!namesByAlias.has(key)) namesByAlias.set(key, new Set());
  namesByAlias.get(key).add(name);
};
for (const c of characterByName.values()) for (const alias of [c.name, ...(c.aliases || [])]) addAlias(alias, c.name);
// Players call the cast by given name alone (セツナ, あかり), which the generated
// alias lists only partly cover. A given name another character owns stays out.
for (const c of characterByName.values()) {
  const given = c.cast ? c.name.split(/\s+/)[1] : "";
  if (characterKey(given).length >= 2 && !namesByAlias.has(characterKey(given))) addAlias(given, c.name);
}
const aliasKeysByName = new Map();
for (const [key, names] of namesByAlias) for (const name of names) {
  if (!aliasKeysByName.has(name)) aliasKeysByName.set(name, []);
  aliasKeysByName.get(name).push(key);
}
const isLatinKey = key => /^[a-z0-9]+$/.test(key);
const latinWords = value => foldHan(value).match(/[a-z0-9]+/g) || [];
const KATAKANA = /[\p{Script=Katakana}ー]/u, HIRAGANA = /\p{Script=Hiragana}/u, HAN = /\p{Script=Han}/u;
const sameKana = (a, b) => KATAKANA.test(a) && KATAKANA.test(b) || HIRAGANA.test(a) && HIRAGANA.test(b);
// Latin aliases match whole words only: "rio" is not inside "scenario" and
// "mia" is not inside "MiaBot". Both "takase rio" and "takaserio" match.
function latinKeysIn(value) {
  const words = latinWords(value), found = new Set();
  for (let i = 0; i < words.length; i++) {
    for (let j = i, joined = ""; j < words.length && joined.length < 40; j++) {
      joined += words[j];
      if (namesByAlias.has(joined)) found.add(joined);
    }
  }
  return found;
}
const cjkAliasKeys = [...namesByAlias.keys()].filter(key => !isLatinKey(key)).sort((a, b) => b.length - a.length);
// A leading "美亚，" only addresses the bot; it is not a character in the request.
function withoutVocative(text, self) {
  const folded = foldHan(text), match = folded.match(/^\s*([^，,、：:！!~～\s]+)[，,、：:！!~～\s]+(?=\S)/);
  return match && self && namesByAlias.get(characterKey(match[1]))?.has(self) ? folded.slice(match[0].length) : text;
}
// Characters the user's own words name, in order of appearance. Longest alias
// wins, so 高濑梨绪 is one mention; a kana alias must not continue a word in
// the same script (ラム in ドラム). One-character cast names (葵, 茜) count only
// as 「葵的」/「葵酱」, never inside another word such as 向日葵.
function characterMentions(text, { self } = {}) {
  const request = withoutVocative(String(text ?? ""), self);
  const compact = characterKey(request), taken = [], found = [];
  for (const key of cjkAliasKeys) {
    const names = [...namesByAlias.get(key)];
    if (key.length === 1 && !(HAN.test(key) && names.every(name => characterByName.get(name)?.cast))) continue;
    for (let at = compact.indexOf(key); at >= 0; at = compact.indexOf(key, at + 1)) {
      const end = at + key.length, before = compact[at - 1] || "", after = compact[end] || "";
      if (sameKana(key[0], before) || sameKana(key.at(-1), after) && !/^(?:の|ちゃん|さん|くん|さま|たち|と|が|は|も|を|に|や)/.test(compact.slice(end))) continue;
      if (key.length === 1 && (HAN.test(before) || !/^[的酱]$/.test(after))) continue;
      if (taken.some(([s, e]) => at < e && s < end)) continue;
      taken.push([at, end]);
      found.push({ at, alias: key, names });
    }
  }
  for (const key of latinKeysIn(request)) found.push({ at: Infinity, alias: key, names: [...namesByAlias.get(key)] });
  const seen = new Set();
  return found.sort((a, b) => a.at - b.at).filter(m => !seen.has(m.names.join()) && seen.add(m.names.join())).map(({ alias, names }) => ({ alias, names }));
}
// Looser than characterMentions: any alias of this character anywhere in the text.
function textNamesCharacter(text, name) {
  const compact = characterKey(text), latin = latinKeysIn(text);
  return (aliasKeysByName.get(name) || []).some(key => isLatinKey(key) ? latin.has(key) : compact.includes(key));
}
const DIFFICULTIES = ["BAS", "ADV", "EXP", "MAS", "LUN"];
const PAGE_SIZE = 8;
const fields = {
  title: { label: "歌名", type: "text", note: "prefix=开头，contains=包含，eq=完整歌名；search 才允许别名/ID/拼写候选" },
  artist: { label: "艺术家署名", type: "text" },
  genre: { label: "分类", type: "text" },
  version: { label: "收录版本", type: "text" },
  release: { label: "收录日期", type: "date", note: "YYYY-MM-DD；没有记录就未知" },
  bpm: { label: "BPM", type: "number" },
  deleted: { label: "已删除", type: "boolean" },
  botId: { label: "ID", type: "number", note: "分表和 Bot 指令使用的短 ID（最多四位的整数，比如 870）；用户问某首歌的 id 时返回此字段。用户拿一串数字问是哪首歌或问它的资料时用 title search：曲名本身也可能就是数字，比如《39》《2112410403927243233368》" },
  officialId: { label: "官方曲目ID", type: "text", note: "仅用户明确说“官方曲目 ID”时返回；用户输入 id870 查歌时用 title search" },
  difficulty: { label: "谱面难度", type: "enum", values: DIFFICULTIES },
  level: { label: "显示等级", type: "level", note: "13 与 13+ 不同；不可把等级自动改成定数" },
  constant: { label: "定数", type: "number", note: "仅使用已知定数；未知不能当 0" },
  notes: { label: "物量", type: "number" },
  bells: { label: "铃铛数", type: "number" },
  designer: { label: "谱师", type: "text" },
  opponent: { label: "对战相手", type: "character", note: "含同时为演唱者的角色；按实际谱面版本匹配" },
  singer: { label: "演唱角色", type: "character", note: "不等于对战相手；来自角色索引" },
  originalFor: { label: "原创曲归属角色", type: "character", note: "按本地策展口径，包含 solo 版，不等于对战相手" },
  personalFor: { label: "个人曲归属角色", type: "character", note: "仅限有记载的个人曲，不等于原创曲" },
  bossLevel: { label: "对战相手等级", type: "number" },
  attribute: { label: "对战属性", type: "enum", values: ["Fire", "Leaf", "Aqua"] },
};
const operations = {
  text: ["eq", "ne", "contains", "prefix", "suffix", "in"],
  number: ["eq", "ne", "gt", "gte", "lt", "lte", "in"],
  date: ["eq", "gt", "gte", "lt", "lte"],
  boolean: ["eq", "ne"], enum: ["eq", "ne", "in"],
  level: ["eq", "ne", "gt", "gte", "lt", "lte", "in"],
  character: ["eq", "ne", "in"],
};
const SCHEMA = {
  game: "ongeki", fields,
  operations: { ...operations, titleOnly: ["search"] },
  query: { filters: [{ field: "title", op: "prefix", value: "ai" }], entity: "songs或charts", select: ["title", "constant"], mode: "list或count", page: 1, sort: { field: "title", direction: "asc或desc" }, selection: { kind: "all或first或random", count: "first/random必填，1到50的整数；all省略", excludePrevious: false } },
  rules: "用户问歌曲的 id/ID 时选 botId（分表用短 ID），只有明确问官方曲目 ID 才选 officialId。filters 全部为 AND，in 的数组为 OR；每条谱面必须同时满足所有条件，不能拿红谱的等级配紫谱的定数。selection决定筛选后怎么选：随机/随便/任意选N项用random+count=N，前N项用first+count=N，列全部用all且不填count。换一批/排除刚才的用excludePrevious=true。排序后取前几项才是first；随机从完整候选池不放回抽取，不是第一分页。count模式统计全部候选，不与抽样混用。只支持上述字段，不支持的条件不能丢弃，应具体说明或追问。歌曲计数去重，谱面计数不去重。新查询page=1；翻页沿用完整条件和同一批抽样。空结果不放宽条件。",
};

class QueryError extends Error {
  constructor(message) { super(message); this.name = "QueryError"; }
}
const reject = message => { throw new QueryError(message); };
const known = value => value !== null && value !== undefined && value !== "";
const numeric = value => known(value) && Number.isFinite(Number(value)) ? Number(value) : null;
function scalar(field, value) {
  const spec = fields[field];
  if (spec.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) reject(`${spec.label}需要明确的数值`);
  } else if (spec.type === "boolean") {
    if (typeof value !== "boolean") reject(`${spec.label}需要 true 或 false`);
  } else {
    if (typeof value !== "string" || !value.trim() || value.length > 120) reject(`${spec.label}需要有效文字`);
    value = value.normalize("NFKC").trim();
    if (spec.type === "enum" && !spec.values.includes(value)) reject(`${spec.label}必须是 ${spec.values.join("/")}`);
    if (spec.type === "level" && !/^(?:[1-9]|1[0-5])\+?$/.test(value)) reject("显示等级用 13 或 13+ 这样的写法，不能混成定数");
    if (spec.type === "date" && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) reject("日期需要 YYYY-MM-DD");
    if (spec.type === "character") {
      const names = namesByAlias.get(characterKey(value));
      if (names?.size !== 1) reject("角色索引里没能唯一确认这个名字，需要更完整的角色称呼");
      value = [...names][0];
    }
  }
  return value;
}
function validateQuery(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) reject("查询必须是对象");
  for (const key of Object.keys(input)) if (!["filters", "entity", "select", "mode", "page", "sort", "selection"].includes(key)) reject("包含未支持的查询项，只允许 filters/entity/select/mode/page/sort/selection");
  if (!Array.isArray(input.filters) || input.filters.length > 12) reject("需要 filters 条件列表，最多 12 项");
  const filters = input.filters.map(f => {
    if (!f || Object.keys(f).some(k => !["field", "op", "value"].includes(k)) || !Object.hasOwn(fields, f.field)) reject("包含未支持的数据库字段");
    if (!(operations[fields[f.field].type].includes(f.op) || (f.field === "title" && f.op === "search"))) reject(`${fields[f.field].label}不支持这个比较方式`);
    if (f.op === "search" && /\s+--page\s+\d+$/i.test(String(f.value))) reject("翻页参数只能放在 query.page，不能混入曲名线索");
    const value = f.op === "in"
      ? (Array.isArray(f.value) && f.value.length && f.value.length <= 12 ? f.value.map(v => scalar(f.field, v)) : reject("in 需要非空数组，最多 12 项"))
      : scalar(f.field, f.value);
    return { field: f.field, op: f.op, value };
  });
  const entity = input.entity ?? "songs", mode = input.mode ?? "list", page = input.page ?? 1;
  if (!["songs", "charts"].includes(entity) || !["list", "count"].includes(mode)) reject("不支持这个查询输出类型");
  if (!Number.isSafeInteger(page) || page < 1 || page > 10000) reject("页码需要 1 到 10000 的整数");
  const select = input.select ?? ["title", "difficulty", "constant"];
  if (!Array.isArray(select) || !select.length || select.length > 8 || select.some(f => !Object.hasOwn(fields, f))) reject("返回字段不在本地资料范围内");
  const sort = input.sort ?? { field: "title", direction: "asc" };
  if (!sort || Object.keys(sort).some(k => !["field", "direction"].includes(k)) || !Object.hasOwn(fields, sort.field) || !["asc", "desc"].includes(sort.direction) || fields[sort.field].type === "character") reject("排序字段或顺序不受支持");
  if (entity === "songs" && ["difficulty", "level", "constant", "notes", "bells", "designer", "bossLevel", "attribute"].includes(sort.field)) reject("按谱面数据排序时请使用 charts，避免一首歌的多张谱面混算");
  const choice = input.selection ?? { kind: "all" };
  if (!choice || typeof choice !== "object" || Object.keys(choice).some(k => !["kind", "count", "excludePrevious"].includes(k)) || !["all", "first", "random"].includes(choice.kind)) reject("selection需要all/first/random选取方式");
  if (choice.excludePrevious !== undefined && typeof choice.excludePrevious !== "boolean") reject("excludePrevious需要布尔值");
  if (choice.kind === "all" && choice.excludePrevious) reject("排除上一批后选新一批，请使用first/random并指定count；不支持排除后的全量分页");
  if (choice.kind === "all" ? choice.count !== undefined : !Number.isInteger(choice.count) || choice.count < 1 || choice.count > 50) reject("first/random需要1到50的整数count；all不填count");
  if (mode === "count" && choice.kind !== "all") reject("统计总数不能同时抽取部分结果");
  const selection = { kind: choice.kind, ...(choice.kind !== "all" ? { count: choice.count } : {}), excludePrevious: choice.excludePrevious ?? false };
  return { filters, entity, select: [...new Set(["title", ...select, ...(entity === "charts" ? ["difficulty"] : [])])], mode, page, sort, selection };
}

const internalById = new Map(internal.map(item => [item.id, item]));
const { extraLunatics, attachedBase, uncataloged } = catalogCoverage(catalog.songs);
const SUPPLEMENT_LEVEL = /^(?:[1-9]|1[0-5])\+?$/;
const rolesByTitle = new Map();
for (const char of characters?.characters || []) {
  for (const song of char.songs) {
    const key = titleKey(song.title);
    if (!rolesByTitle.has(key)) rolesByTitle.set(key, { singer: [], originalFor: [], personalFor: [] });
    const entry = rolesByTitle.get(key);
    if (["singer", "both"].includes(song.role)) entry.singer.push(char.name);
    if (song.original) entry.originalFor.push(char.name);
    if (char.personal && titleKey(char.personal.title) === key) entry.personalFor.push(char.name);
  }
}
function songBase(songIndex, { title, artist, genre, version, release, bpm, deleted, officialId }) {
  const roles = rolesByTitle.get(titleKey(title)) || {};
  return {
    songIndex, songKey: `${textKey(title)}\0${textKey(artist)}`, title, artist, genre, version, release, bpm: numeric(bpm), deleted, officialId,
    singer: roles.singer || [], originalFor: roles.originalFor || [], personalFor: roles.personalFor || [],
  };
}
// Supplement only charts absent from the primary snapshot. An explicitly
// unknown constant in an existing chart stays unknown, not overwritten.
const internalChart = (v, i) => ({ level: v.level[i], const: v.const?.[i], const_status: numeric(v.const?.[i]) > 0 ? "known" : "unknown", notes_all: v.noteTotal?.[i], bell: v.bellTotal?.[i], notesdesigner: v.creator?.[i] });
// 一行一张谱面。对战相手取这张谱面实际对应的那条内部曲目：原来按曲名去配，同名不同曲的歌（《Hand in Hand》
// 《Singularity》）会把另一首的对手配上来，一首歌的几张白谱（《Perfect Shining!!》）也会互相串。
function chartRow(base, difficulty, chart, v, botId, supplemental) {
  return {
    ...base, supplemental, botId, difficulty, level: chart.level,
    // 白谱一张一条、ID 各不相同（见 song-id.cjs），同一首歌的几张白谱要算几张谱面，不能并成一张。
    chartKey: `${base.songKey}\0${difficulty}${difficulty === "LUN" ? `\0${botId}` : ""}`,
    // 0 级白谱的定数就是 0（游戏数据里 23 张全是）；《Perfect Shining!!》那张在曲库里记成未知，也按 0 算。
    constant: difficulty === "LUN" && String(chart.level) === "0" ? 0 : chart.const_status === "known" ? numeric(chart.const) : null,
    notes: numeric(chart.notes_all), bells: numeric(chart.bell), designer: chart.notesdesigner,
    opponent: v?.boss ? [v.boss] : [], bossLevel: numeric(v?.bossLevel), attribute: v?.attributeType ?? null,
  };
}
const rows = [
  ...catalog.songs.flatMap((song, songIndex) => {
    const meta = song.meta;
    const base = songBase(songIndex, { title: meta.name, artist: meta.artist, genre: meta.genre, version: meta.song_release_version,
      release: meta.song_release, bpm: meta.bpm, deleted: Boolean(meta.is_deleted), officialId: String(meta.official_id ?? "") });
    return DIFFICULTIES.flatMap((difficulty, i) => {
      const found = [];
      // 白谱单独编号：LUN 那一行给白谱自己的 ID 和对手；其余难度是本曲那条。曲库里只剩白谱的已删歌
      // （《回レ！雪月花》），本曲是 catalogCoverage 挂上来的那条，它的绿黄红紫谱当补充谱面列出来。
      const mapped = internalById.get(botChartId(song, difficulty)) ?? null;
      const own = difficulty === "LUN" ? mapped : attachedBase.get(song) ?? (mapped?.isLunatic ? null : mapped);
      const botId = own?.id ?? botChartId(song, difficulty);
      if (song[difficulty]?.has_chart) found.push(chartRow(base, difficulty, song[difficulty], own, botId, false));
      else if (difficulty !== "LUN" && own && SUPPLEMENT_LEVEL.test(String(own.level?.[i]))) found.push(chartRow(base, difficulty, internalChart(own, i), own, own.id, true));
      // 曲库漏收的白谱，挂在这首歌下面当补充谱面。
      if (difficulty === "LUN") for (const extra of extraLunatics.get(song) || []) found.push(chartRow(base, difficulty, internalChart(extra, i), extra, extra.id, true));
      return found;
    });
  }),
  // 连歌都不在曲库里的（ようこそジャパリパークへ、ユーフィリア的《Hand in Hand》、只有白谱的 No Remorse……）
  // 从游戏数据整首补上，本曲和白谱都是补充谱面。公开曲库的版本写成「オンゲキ SUMMER」，游戏数据只写「SUMMER」，
  // 照曲库的写法补上前缀，按版本筛才对得上。
  ...uncataloged.flatMap(({ base: baseSong, lunatics }, k) => {
    const head = baseSong ?? lunatics[0];
    const version = String(head.versionID || "");
    const base = songBase(catalog.songs.length + k, { title: head.name, artist: head.artistName, genre: head.genre ?? null,
      version: version && !version.startsWith("オンゲキ") ? `オンゲキ ${version}` : version || null,
      release: null, bpm: head.bpm, deleted: head.status !== "online", officialId: "" });
    return [
      ...(baseSong ? DIFFICULTIES.slice(0, 4).flatMap((difficulty, i) => SUPPLEMENT_LEVEL.test(String(baseSong.level?.[i]))
        ? [chartRow(base, difficulty, internalChart(baseSong, i), baseSong, baseSong.id, true)] : []) : []),
      ...lunatics.map(v => chartRow(base, "LUN", internalChart(v, 4), v, v.id, true)),
    ];
  }),
];
const knownBotIds = new Set(rows.map(row => row.botId));
const levelValue = v => Number(String(v).replace("+", "")) + (String(v).endsWith("+") ? 0.5 : 0);
function compare(value, filter) {
  if (!known(value) || (Array.isArray(value) && !value.length)) return false;
  if (filter.op === "in") return filter.value.some(v => compare(value, { ...filter, op: "eq", value: v }));
  if (Array.isArray(value)) return filter.op === "ne" ? value.every(v => compare(v, filter)) : value.some(v => compare(v, filter));
  const type = fields[filter.field].type;
  const key = v => type === "level" ? levelValue(v) : ["number", "boolean"].includes(type) ? v : textKey(v);
  const a = key(value), b = key(filter.value);
  switch (filter.op) {
    case "eq": return a === b; case "ne": return a !== b;
    case "gt": return a > b; case "gte": return a >= b; case "lt": return a < b; case "lte": return a <= b;
    case "prefix": return a.startsWith(b); case "suffix": return a.endsWith(b); case "contains": return a.includes(b);
    default: return false;
  }
}
function executeQuery(input, { preview = false, selectionKeys, excludeKeys = [], pickIndex = randomInt } = {}) {
  const query = validateQuery(input);
  // Search/alias expansion is allowed only when explicitly requested. Strict
  // contains/prefix/eq never inherit the legacy searcher's fuzzy suggestions.
  let fuzzy = false;
  const predicates = query.filters.map(f => {
    if (f.op !== "search") return row => compare(row[f.field], f);
    // 连歌都不在曲库里的白谱也要搜得到：它们在这张表里单独成行，官方曲目 ID 是空的。
    const first = songSearch.search(f.value, { uncataloged: true });
    fuzzy ||= Boolean(first.fuzzy);
    const found = [...(first.matches || [])];
    for (let page = 2; page <= first.pages; page++) found.push(...songSearch.search(`${f.value} --page ${page}`, { uncataloged: true }).matches);
    const keys = new Set(found.map(s => `${s.meta.official_id ?? ""}:${s.meta.name}`));
    return row => keys.has(`${row.officialId}:${row.title}`);
  });
  let matched = rows.filter(row => predicates.every(p => p(row)));
  const { field, direction } = query.sort;
  matched.sort((a, b) => {
    if (!known(a[field])) return known(b[field]) ? 1 : 0;
    if (!known(b[field])) return -1;
    const diff = fields[field].type === "number" ? a[field] - b[field] : fields[field].type === "level" ? levelValue(a[field]) - levelValue(b[field]) : String(a[field]).localeCompare(String(b[field]));
    return (direction === "desc" ? -diff : diff) || a.songIndex - b.songIndex || DIFFICULTIES.indexOf(a.difficulty) - DIFFICULTIES.indexOf(b.difficulty);
  });
  let entries;
  if (query.entity === "songs") {
    const groups = new Map();
    for (const row of matched) {
      if (!groups.has(row.songKey)) groups.set(row.songKey, { title: row.title, rows: [] });
      const entry = groups.get(row.songKey);
      if (!row.deleted && entry.rows.every(r => r.deleted)) entry.title = row.title;
      entry.rows.push(row);
    }
    entries = [...groups.values()];
  } else {
    const groups = new Map();
    for (const row of matched) {
      if (!groups.has(row.chartKey)) groups.set(row.chartKey, { title: row.title, rows: [] });
      groups.get(row.chartKey).rows.push(row);
    }
    entries = [...groups.values()];
  }
  const keyOf = entry => query.entity === "songs" ? entry.rows[0].songKey : entry.rows[0].chartKey;
  const total = entries.length;
  const excluded = new Set(query.selection.excludePrevious ? excludeKeys : []);
  let chosen = entries.filter(e => !excluded.has(keyOf(e)));
  const eligibleTotal = chosen.length;
  if (Array.isArray(selectionKeys) && query.selection.kind !== "all") {
    const byKey = new Map(entries.map(e => [keyOf(e), e]));
    chosen = [...new Set(selectionKeys)].map(k => byKey.get(k)).filter(Boolean);
  } else if (!preview && query.selection.kind === "random") {
    // Partial Fisher-Yates over the complete, deduplicated pool. One real draw
    // after semantic review; previews and subsequent pages never reroll it.
    const count = Math.min(query.selection.count, chosen.length);
    for (let i = 0; i < count; i++) {
      const offset = pickIndex(chosen.length - i);
      if (!Number.isInteger(offset) || offset < 0 || offset >= chosen.length - i) throw Error("Invalid random index");
      const j = i + offset;
      [chosen[i], chosen[j]] = [chosen[j], chosen[i]];
    }
    chosen = chosen.slice(0, count);
  } else if (query.selection.kind === "first") chosen = chosen.slice(0, query.selection.count);
  const selectedTotal = chosen.length, pages = Math.max(1, Math.ceil(selectedTotal / PAGE_SIZE));
  return { query, total, eligibleTotal, selectedTotal, pages, fuzzy,
    selectionKeys: !preview ? (query.selection.kind === "all" ? chosen.slice((query.page - 1) * PAGE_SIZE, query.page * PAGE_SIZE) : chosen).map(keyOf) : [],
    supplemental: chosen.some(e => e.rows.some(r => r.supplemental)),
    entries: query.mode === "count" ? [] : chosen.slice((query.page - 1) * PAGE_SIZE, query.page * PAGE_SIZE), source: "本地音击曲库快照", updatedAt: catalog.meta?.last_updated_at };
}
const opLabels = { eq: "＝", ne: "≠", gt: "＞", gte: "≥", lt: "＜", lte: "≤", contains: "包含", prefix: "开头是", suffix: "结尾是", search: "线索", in: "属于" };
const show = value => Array.isArray(value) ? value.join("、") || "未知" : !known(value) ? "未知" : typeof value === "boolean" ? value ? "是" : "否" : String(value);
function describeQuery(query) {
  return query.filters.length ? query.filters.map(f => `${fields[f.field].label}${opLabels[f.op]}${show(f.value)}`).join("；") : "全部曲目";
}
function formatResult(result) {
  const { query, total, pages } = result, unit = query.entity === "songs" ? "首" : "张谱面";
  const lines = [!total ? "唔，按这些条件暂时没找到匹配的记录。" : result.fuzzy ? "没找到完全匹配的，美亚翻到了这些近似曲名，看看是不是你要找的？" : "查到啦，给你整理在这里♪", `筛选：${describeQuery(query)}`, `${result.fuzzy ? "近似候选" : "符合条件"}：${total} ${unit}（${result.source}）`];
  if (query.selection.excludePrevious && query.selection.kind === "all") lines.push(`排除上一批后：${result.eligibleTotal} ${unit}。`);
  if (query.selection.kind !== "all") {
    lines[0] = result.selectedTotal ? query.selection.kind === "random" ? "喵哼哼，帮你抽好啦♪" : "按顺序帮你选出来啦♪" : "唔，按这些条件没有可选的新结果啦。";
    lines.push(`${query.selection.kind === "random" ? "随机抽取" : "按顺序取前"}：${result.selectedTotal} ${unit}${query.selection.excludePrevious ? "（排除上一批）" : ""}`);
    if (query.selection.kind === "first") lines.push(`排序：${fields[query.sort.field].label}，${query.sort.direction === "desc" ? "降序" : "升序"}。`);
    if (result.selectedTotal < query.selection.count) lines.push(`你要 ${query.selection.count} ${unit}，${query.selection.excludePrevious ? "排除上一批后" : "符合条件的"}只剩 ${result.selectedTotal} ${unit}，我都列在这里，不拿重复的凑数哦。`);
  }
  if (!total) lines.push("可以再确认一下名称或条件；这次没匹配到，不代表游戏里一定没有哦。");
  if (query.page > pages && total) lines.push(`这一页已经超出范围啦，一共 ${pages} 页。`);
  for (const entry of result.entries) {
    lines.push(`《${entry.title}》${entry.rows.every(r => r.deleted) ? "（已删除记录）" : entry.rows.some(r => r.deleted) ? "（含历史记录）" : ""}`);
    for (const field of query.select.filter(f => f !== "title" && f !== "difficulty")) {
      const chartField = ["constant", "level", "notes", "bells", "designer", "opponent", "bossLevel", "attribute"].includes(field);
      const values = [...new Set(entry.rows.map(r => `${chartField ? r.difficulty + " " : ""}${show(r[field])}`))];
      // 带白谱的歌有两个 ID（本曲 39、白谱 8015），光列「39 / 8015」分不清哪个是哪个，就注上各管哪几张谱面。
      const labelled = field === "botId" && values.length > 1
        ? values.map(id => `${id}（${[...new Set(entry.rows.filter(r => show(r.botId) === id).map(r => r.difficulty))].join("/")}）`)
        : values;
      lines.push(`${fields[field].label}：${labelled.join(" / ")}`);
    }
    if (query.select.includes("difficulty")) lines.push(`难度：${[...new Set(entry.rows.map(r => r.difficulty))].join(" / ")}`);
    if (entry.rows.some(r => r.supplemental)) lines.push(`补充谱面记录：${[...new Set(entry.rows.filter(r => r.supplemental).map(r => r.difficulty))].join(" / ")}（来自内部曲库快照）`);
  }
  if (result.supplemental) lines.push("结果含主曲库缺录的本地补充谱面，不代表当前机台仍可游玩。");
  if (query.mode !== "count" && result.selectedTotal && query.page <= pages && (query.selection.kind === "all" || pages > 1)) lines.push(`第 ${query.page}/${pages} 页${query.page < pages ? "，回复「下一页」继续看吧。" : "。"}`);
  return lines.join("\n");
}

// Words that name a relation. 「梨绪有哪些歌」 names none, and then the answer is
// her original songs: 个人曲 is a single song per character and must be asked for.
const RELATION_CUES = {
  personalFor: /个人曲|个人歌|个人单曲|角色曲|角色歌|キャラソン|キャラクターソング|character\s*song/g,
  originalFor: /原创|オリジナル|original/g,
  singer: /唱|歌手|vocal|ボーカル/g,
  opponent: /相手|对手|对战(?!属性|等级)|boss|ボス/g,
};
const RELATION_NAMES = { personalFor: "个人曲", originalFor: "原创曲", singer: "演唱", opponent: "对战相手" };
function relationCues(text) {
  const folded = foldHan(text), asked = new Set(), negated = new Set();
  for (const [field, pattern] of Object.entries(RELATION_CUES)) for (const match of folded.matchAll(pattern)) {
    const clause = folded.slice(0, match.index).split(/[，,。；;！!？?]|而是|改成|换成/).at(-1);
    const denied = /不是|不要|不用|不按|并非|别(?!的)|除了|除去/.test(clause) || /^[曲歌]?(?:以外|之外)/.test(folded.slice(match.index + match[0].length));
    (denied ? negated : asked).add(field);
  }
  return { asked, negated };
}
const ANAPHORA = /她|他|它|祂|这位|那位|这个人|那个人|此人|这个角色|那个角色|该角色|同一个?角色|上面那|刚才那|前面那/;
// The model maps names to characters with no roster in front of it, so a valid
// but wrong name (刹那 → 日向 千夏) used to pass. Each character field must name
// someone the user mentioned, unless the request points back with a pronoun.
function characterMismatch(query, text, self) {
  const used = query.filters.filter(f => fields[f.field].type === "character");
  if (!used.length) return "";
  const mentions = characterMentions(text, { self }), named = new Set(mentions.flatMap(m => m.names));
  if (named.size && !ANAPHORA.test(foldHan(text))) {
    for (const name of used.flatMap(f => [].concat(f.value))) {
      if (named.has(name) || name === self && /你|妳|您/.test(text) || textNamesCharacter(text, name)) continue;
      return `原话提到的角色是${mentions.map(m => `「${m.alias}」＝${m.names.join("或")}`).join("、")}，查询里的${name}原话没有提到；角色字段只能用原话里的角色，不能换成别人`;
    }
  }
  const { asked, negated } = relationCues(text), relations = new Set(used.map(f => f.field));
  if (relations.has("personalFor") && !asked.has("personalFor")) return "原话没有要「个人曲」：问某角色的歌/曲子按原创曲 originalFor 查（含 solo 版）；personalFor 只用于明确问个人曲，每个角色至多一首";
  if (asked.size === 1) {
    const [want] = asked;
    if (!relations.has(want) && !query.select.includes(want)) return `原话问的是${RELATION_NAMES[want]}，角色关系必须用 ${want}，不能换成其他关系`;
  }
  // 「除了个人曲还有哪些歌」 still means originals; 「原创曲以外的」 does not.
  if (!asked.size && !negated.has("originalFor")) {
    const hasOriginals = name => characterByName.get(name)?.cast && characterByName.get(name).songs.some(s => s.original);
    const other = used.find(f => f.field !== "originalFor" && [].concat(f.value).some(hasOriginals));
    if (other) return `原话没说是哪种关系：问某角色的歌/曲子默认按原创曲 originalFor 查（含 solo 版），不能改用${RELATION_NAMES[other.field]} ${other.field}；演唱、对战相手、个人曲都要原话明确提到才用`;
  }
  return "";
}

// Deterministic checks for high-impact semantic distinctions. Broader meaning
// is reviewed by the model against the original request before this executor.
function queryMismatch(query, text, { self } = {}) {
  const request = selectionIntent(text);
  if (request.kind && query.selection.kind !== request.kind) return `用户要求${request.kind === "random" ? "随机选取" : "只取前几项"}，必须保留 selection.kind=${request.kind}，不能退化为整页列表`;
  if (request.count && (query.selection.kind === "all" || query.selection.count !== request.count)) return `用户只要${request.count}项，selection.count必须保留这个数量`;
  if (request.entity && query.entity !== request.entity) return `用户指定选取单位，entity必须是${request.entity}`;
  if (request.excludePrevious && !query.selection.excludePrevious) return "用户要求换一批或不重复，必须excludePrevious=true";
  const asksSongs = /哪些歌|哪些歌曲|哪几首|多少首|几首歌|歌曲有哪些|歌都有哪些/.test(text);
  if (asksSongs && !/谱面数量|多少张|几张|每张谱面|按谱面/.test(text) && query.entity !== "songs") return "用户要歌曲列表或歌曲数量，应 entity=songs 去重，不能按谱面重复列同一首歌";
  // 模型见到一长串数字就当 ID 去筛。《2112410403927243233368》整条曲名就是数字，22 位连 JSON 数字都存不下
  // （解析出来是 2.1124104039272434e+21），按 ID 筛必然 0 首（真模型实测「2112410403927243233368的定数是多少」）。
  // 按 ID 等值筛选，值就得是真有的 Bot ID；对不上任何一首，就点名让它照原话里那串数字改成歌名 search。
  if (query.filters.some(f => f.field === "botId" && (f.op === "eq" || f.op === "in") && [].concat(f.value).some(v => !knownBotIds.has(v))))
    return "按 ID 筛选只能用真有的短 ID（最多四位，比如 870），这个值对不上任何一首。用户给的一串数字多半是曲名本身（曲名可以就是数字，比如《2112410403927243233368》），照原话里那串数字用 title search 查";
  const title = query.filters.filter(f => f.field === "title");
  let expected;
  for (const match of text.matchAll(/开头|開頭|前缀|前綴|结尾|結尾|后缀|後綴|包含|含有/g)) {
    const clause = text.slice(0, match.index).split(/[，,。；;！!？?]|而是|改成|换成/).at(-1);
    if (/(?:不是|不要|不用|不按|并非)/.test(clause)) continue;
    // With multiple named fields, leave the association to semantic review.
    if (/作者|艺术家|歌手|谱师|版本/.test(clause)) continue;
    expected = /开头|開頭|前/.test(match[0]) ? "prefix" : /结尾|結尾|后|後/.test(match[0]) ? "suffix" : "contains";
  }
  if (expected && title.length && !title.some(f => f.op === expected)) return `用户要求歌名 ${expected} 匹配，不能改成其他比较方式或模糊搜索`;
  if (/对战相手|對戰相手/.test(text) && !query.filters.some(f => f.field === "opponent") && !query.select.includes("opponent")) return "用户问对战相手，查询必须筛选或返回 opponent，不能只查演唱者";
  return characterMismatch(query, text, self);
}

function selectionIntent(raw) {
  const text = String(raw).normalize("NFKC");
  const cnNumber = token => {
    if (/^\d+$/.test(token)) return Number(token);
    const digit = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    if (token === "十") return 10;
    if (token.includes("十")) { const [a, b] = token.split("十"); return (a ? digit[a] : 1) * 10 + (b ? digit[b] : 0); }
    return digit[token];
  };
  const random = /随机|隨機|随便|隨便|任意|抽签|抽籤/.test(text) && !/(?:不要|不用|别|不是)\s*(?:随机|隨機|随便|隨便|任意)/.test(text);
  const countMatch = text.match(/(?:选|選|挑|抽|取|给我|给|来|來|推荐|推薦|前|随机|随便|任意)\s*(?:出|取|挑|选|選|我|一下|个|随机|随便|恰好|正好)*\s*([\d一二两三四五六七八九十]+)\s*(首|张|張|个|個|条)/);
  const count = countMatch ? cnNumber(countMatch[1]) : undefined;
  return { kind: random ? "random" : /前\s*[\d一二两三四五六七八九十]+\s*(?:首|张|張|个|条)/.test(text) ? "first" : undefined, count,
    entity: countMatch ? countMatch[2] === "首" ? "songs" : /张|張/.test(countMatch[2]) ? "charts" : undefined : undefined,
    excludePrevious: /换一批|換一批|换两|换二|换[\d]+|不要刚才|排除刚才|(?:上次|上一批|刚才).{0,6}(?:不重复|别重复)|(?:不|别).{0,4}(?:上次|上一批|刚才).{0,3}重复/.test(text) };
}
module.exports = { SCHEMA, QueryError, validateQuery, executeQuery, formatResult, describeQuery, queryMismatch, selectionIntent, characterMentions };
