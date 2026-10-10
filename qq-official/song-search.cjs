"use strict";

// Public metadata only: never consult player bindings or send a model-written result.
const { songs: catalogSongs } = require("../ongeki-song-catalog.json");
const core = require("../mia-core.cjs");
const { botSongId, botChartId, catalogCoverage, currentCatalogSongs } = require("./song-id.cjs");
// 换了新条目重新上架的歌，公开曲库里那条「已删除」的旧条目不再单独列出（见 song-id.cjs）。
const songs = currentCatalogSongs(catalogSongs);
// 两级归一化。**符号不能在唯一那一级里抹掉**：曲名里真的有符号，而 `∀` 这种
// 整条曲名就是一个符号的，抹完是空串 —— 空串 includes 一切，查询词抹成空串又会被
// 下面判成「没给线索」，于是这首歌谁也搜不到。所以第一级保留符号。
const normalize = value => core.normalizeSongQuery(value)
  .replace(/[ぁ-ゖ]/g, ch => String.fromCharCode(ch.charCodeAt(0) + 0x60))
  .replace(/[\s\p{P}]/gu, "");
// 第二级再去掉符号，也就是原来的行为：用户通常不会照着打「!」「☆」，
// 「ウキウキCandy」要能搜到《ウキウキ☆Candy!》。**只在前一级没结果时兜底**，
// 两级同时用会把这个宽松度换成另一批噪声。
const squash = value => normalize(value).replace(/\p{S}/gu, "");

// 游戏数据里的每一条都要搜得到（见 song-id.cjs 的 catalogCoverage）。一条搜索结果是玩家眼里的一首歌：
// 标题行是本曲的 ID，主行是本曲的谱面；白谱一张一行，各写各的 ID（《Gate of Doom》本曲 39、白谱 8015）。
// 曲库漏收的白谱、曲库只剩白谱时的本曲，都挂到曲库那条下面；连歌都不在曲库里的已删歌，从游戏数据整首补上。
const { extraLunatics, attachedBase, uncataloged } = catalogCoverage(songs);
const BASE_DIFFICULTIES = ["BAS", "ADV", "EXP", "MAS"];
const hasLevel = level => level != null && String(level) !== "-";
const internalChart = (entry, index) => ({ level: entry.level[index], value: entry.const[index], known: Number(entry.const[index]) >= 0 });
const internalBase = entry => BASE_DIFFICULTIES.flatMap((difficulty, i) => hasLevel(entry.level[i]) ? [{ difficulty, ...internalChart(entry, i) }] : []);

function makeEntry(song, id, main, lunatics) {
  lunatics.sort((a, b) => (a.id ?? Infinity) - (b.id ?? Infinity));
  // 白谱的 ID 也算这首歌的 ID：「id8015」要搜得到《Gate of Doom》，「id8091」要搜得到《Perfect Shining!!》。
  return { song, title: normalize(song.meta.name), squashed: squash(song.meta.name), id, main, lunatics, ids: [id, ...lunatics.map(l => l.id)] };
}

function catalogEntry(song) {
  const base = attachedBase.get(song);
  const id = base ? base.id : botSongId(song);
  const lunId = song.LUN?.has_chart ? botChartId(song, "LUN") : id;
  const catalogChart = d => ({ difficulty: d, level: song[d].level, value: song[d].const, known: song[d].const_status === "known" });
  // 曲库里只剩白谱的已删歌（《回レ！雪月花》），主行是挂上来的本曲；白谱 ID 跟本曲不同时，白谱单列一行。
  const main = base ? internalBase(base)
    : [...BASE_DIFFICULTIES, "LUN"].filter(d => song[d]?.has_chart && !(d === "LUN" && lunId !== id)).map(catalogChart);
  const lunatics = [
    ...(song.LUN?.has_chart && lunId !== id ? [{ id: lunId, ...catalogChart("LUN"), deleted: false }] : []),
    ...(extraLunatics.get(song) || []).map(other => ({ id: other.id, ...internalChart(other, 4), deleted: other.status !== "online" && !song.meta.is_deleted })),
  ];
  return makeEntry(song, id, main, lunatics);
}

// 曲库里连这首歌都没有的，照曲库的格式造一条，检索不用分两套。本曲领头；没有本曲的，第一张白谱领头，LUN 写在主行。
function uncatalogedEntry({ base, lunatics }) {
  const head = base ?? lunatics[0];
  const song = { meta: { official_id: null, name: head.name, artist: head.artistName, is_deleted: head.status !== "online" } };
  const main = base ? internalBase(base) : [{ difficulty: "LUN", ...internalChart(head, 4) }];
  const rest = (base ? lunatics : lunatics.slice(1))
    .map(other => ({ id: other.id, ...internalChart(other, 4), deleted: other.status !== "online" && !song.meta.is_deleted }));
  return makeEntry(song, head.id, main, rest);
}

const catalogIndex = songs.map(catalogEntry);
// 单独成条的只进 /搜索歌曲 的回复（和美亚查曲库）。查曲绘拿 search() 的结果去对公开曲库，这种条目塞进去，
// 它就不走「曲库没有就按游戏数据找、用本地曲绘缓存」那条路了。
const fullIndex = [...catalogIndex, ...uncataloged.map(uncatalogedEntry)];
const entryBySong = new Map(fullIndex.map(entry => [entry.song, entry]));
const SEARCH_SPEC = { name: "songsearch", label: "搜索本地音击歌曲资料（不是个人成绩）", argHint: "只填曲名线索、别名或 id；可加 --page 2 翻页；不支持前缀或等级条件语法；无需绑定", needsBinding: false };

function distance(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + (a[i - 1] !== b[j - 1]));
    row = next;
  }
  return row[b.length];
}

function search(raw, { uncataloged = false } = {}) {
  let query = String(raw || "").normalize("NFKC").trim();
  const pageMatch = query.match(/\s+--page\s+(\d+)$/i);
  const page = pageMatch ? Math.max(1, Number(pageMatch[1])) : 1;
  if (pageMatch) query = query.slice(0, pageMatch.index).trim();
  const repeatQuery = query;
  query = query.replace(/^[「『“"']|[」』”"']$/g, "");
  const needle = normalize(query);
  if (!needle || needle.length > 100) return { usage: true };
  // 去符号的那一级可能是**空串**（查询词整个都是符号，比如「☆」）。空串 includes 一切，
  // 直接拿去匹配会把整库倒出来，所以那一支必须判非空 —— 这正是原代码要拦的东西。
  const squashedNeedle = squash(query);
  const pool = uncataloged ? fullIndex : catalogIndex;
  // 数字跟 mia-core 的 searchSongs 同一套规矩：「id870」只认 ID；光是一串数字先当 ID，跟它完全相同的
  // 曲名（《39》《2112410403927243233368》）一起列出；两样都不是，就当曲名片段往下找。
  const idMatch = query.match(/^(id\s*)?(\d+)$/i);
  const byId = idMatch ? pool.filter(({ ids }) => ids.includes(Number(idMatch[2]))) : [];
  const sameTitle = idMatch && !idMatch[1] ? pool.filter(item => item.title === needle && !byId.includes(item)) : [];
  const asNumber = Boolean(idMatch && (idMatch[1] || byId.length || sameTitle.length));
  const aliasTitles = asNumber ? null : new Set(core.searchSongs(query).map(s => normalize(s.name)));
  let matches = asNumber ? [...byId, ...sameTitle]
    : pool.filter(({ title, squashed }) =>
      title.includes(needle) || (squashedNeedle && squashed.includes(squashedNeedle)) || aliasTitles.has(title));
  let fuzzy = false;
  if (!matches.length && !asNumber && needle.length >= 3) {
    const limit = needle.length < 5 ? 1 : Math.min(3, Math.floor(needle.length * 0.25));
    matches = pool.map(item => ({ ...item, distance: Math.abs(item.title.length - needle.length) <= limit ? distance(needle, item.title) : Infinity }))
      .filter(item => item.distance <= limit).sort((a, b) => a.distance - b.distance || a.title.localeCompare(b.title));
    fuzzy = matches.length > 0;
  }
  // 最后一级：查询词里含着一首歌的完整曲名，而且曲名占了查询词的一半以上。照着封面抄曲名时会把作者
  // 一起抄进来 ——《2112410403927243233368》的封面上紧跟着作者 253215，群里问的就是这一整串。
  // 「占一半以上」是挡短曲名的：长查询里碰巧含着《39》《Ring》这种，不算。结果按候选给，不当精确命中。
  if (!matches.length && !asNumber && squashedNeedle.length >= 3) {
    matches = pool.filter(({ squashed }) => squashed.length >= 3 && squashed.length * 2 >= squashedNeedle.length && squashedNeedle.includes(squashed))
      .sort((a, b) => b.squashed.length - a.squashed.length || a.title.localeCompare(b.title));
    fuzzy = matches.length > 0;
  }
  if (!fuzzy) matches.sort((a, b) => Number(b.title === needle) - Number(a.title === needle) || a.title.localeCompare(b.title));
  const total = matches.length;
  const pages = Math.max(1, Math.ceil(total / 8));
  return { matches: matches.slice((page - 1) * 8, page * 8).map(x => x.song), total, pages, page, fuzzy, repeatQuery };
}

function reply(query) {
  const r = search(query, { uncataloged: true });
  if (r.usage) return "给我一点曲名线索吧♪\n/搜索歌曲 サド\n也能用别名或 id；结果多时加 --page 2 翻页。";
  if (!r.total) return "本地音击曲库里没有找到匹配这个关键词的歌。换一小段曲名试试？";
  if (r.page > r.pages) return `这一页没有结果，一共只有 ${r.pages} 页。`;
  const showId = id => id == null ? "ID待核实" : `id${id}`;
  // 0 级白谱的定数就是 0。先判它：《Perfect Shining!!》那张在曲库里记的是「定数未知」，不能显示成漏填。
  const showConstant = (difficulty, { level, value, known }) => difficulty === "LUN" && String(level) === "0" ? 0
    : known && value != null ? value : "定数未知";
  // 白谱在游戏里是单独一条曲目（见 song-id.cjs）。ID 跟本曲不同的，跟在绿黄红紫后面、一张一对括号写上它自己的 ID：
  // 「MAS 11.5（id8003：LUN 0）（id8091：LUN 13.8）」。不写的话，用户会拿本曲的 ID 去查白谱，照着打「/谱面分析 id39 白」。
  const entries = r.matches.map(song => {
    const { id, main, lunatics } = entryBySong.get(song);
    const title = `${showId(id)}   ${song.meta.name}${song.meta.is_deleted ? "（已删除）" : ""}`;
    const chartLine = main.map(chart => `${chart.difficulty} ${showConstant(chart.difficulty, chart)}`).join(" / ") +
      lunatics.map(l => `（${showId(l.id)}：LUN ${showConstant("LUN", l)}${l.deleted ? "，已删除" : ""}）`).join("");
    return chartLine ? `${title}\n${chartLine}` : title;
  });
  const sections = [`查到 ${r.total} 首：`, entries.join("\n\n")];
  if (r.fuzzy) sections.push("以上是曲名比较接近的候选。");
  if (r.pages > 1) sections.push(`第 ${r.page}/${r.pages} 页；${r.page < r.pages ? `下一页：/搜索歌曲 ${r.repeatQuery} --page ${r.page + 1}` : "已到最后一页"}`);
  return sections.join("\n\n");
}

module.exports = { search, reply, SEARCH_SPEC };
