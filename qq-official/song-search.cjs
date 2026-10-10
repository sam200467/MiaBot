"use strict";

// Public metadata only: never consult player bindings or send a model-written result.
const { songs: catalogSongs } = require("../ongeki-song-catalog.json");
const core = require("../mia-core.cjs");
const { pagerKeyboard } = require("./pager-buttons.cjs");
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

// 回复按行给出，每行是若干段：字符串原样显示；{ text, command } 在 Markdown 里是指令链接
// （点一下把 command 填进输入框，用户自己按回车），纯文本里只显示 text；{ hint } 只在发 Markdown 时出现。
// 链接只给曲名和白谱（2026-10-10 定的）：曲名填到「/谱面分析 id36 」为止，难度让用户自己补一个颜色字；
// 白谱各有各的 ID，难度只能是白，整条命令填好。绿黄红紫不单独做链接，一行里蓝字太多。
// 结果不止一页时还给出 pager（翻页按钮用）和 pagerLine（正文里写着「下一页：…」的那一行，有按钮时换掉它）。
function replyLines(query) {
  const r = search(query, { uncataloged: true });
  const lines = text => ({ lines: text.split("\n").map(line => [line]) });
  if (r.usage) return lines("给我一点曲名线索吧♪\n/搜索歌曲 サド\n也能用别名或 id；结果多时加 --page 2 翻页。");
  if (!r.total) return lines("本地音击曲库里没有找到匹配这个关键词的歌。换一小段曲名试试？");
  if (r.page > r.pages) return lines(`这一页没有结果，一共只有 ${r.pages} 页。`);
  const showId = id => id == null ? "ID待核实" : `id${id}`;
  // 0 级白谱的定数就是 0。先判它：《Perfect Shining!!》那张在曲库里记的是「定数未知」，不能显示成漏填。
  const showConstant = (difficulty, { level, value, known }) => difficulty === "LUN" && String(level) === "0" ? 0
    : known && value != null ? value : "定数未知";
  const link = (text, id, command) => id == null ? text : { text, command };
  // 白谱在游戏里是单独一条曲目（见 song-id.cjs）。ID 跟本曲不同的，跟在绿黄红紫后面、一张一对括号写上它自己的 ID：
  // 「MAS 11.5（id8003：LUN 0）（id8091：LUN 13.8）」。不写的话，用户会拿本曲的 ID 去查白谱，照着打「/谱面分析 id39 白」。
  const out = [[`查到 ${r.total} 首：`]];
  let linked = false;
  for (const song of r.matches) {
    const { id, main, lunatics } = entryBySong.get(song);
    // 只有白谱的（《怒槌～光吉猛修一部謎～》id8025）没得挑，难度直接填上白。
    const onlyLunatic = main.length > 0 && main.every(chart => chart.difficulty === "LUN");
    // 链接文字连同前面的 ID 一起（「id36   Perfect Shining!!」整段可点），点的范围大一些。
    const title = link(`${showId(id)}   ${song.meta.name}`, id, `/谱面分析 id${id} ${onlyLunatic ? "白" : ""}`);
    linked ||= id != null;
    out.push([""], [title, ...(song.meta.is_deleted ? ["（已删除）"] : [])]);
    const chartLine = [
      ...(main.length ? [main.map(chart => `${chart.difficulty} ${showConstant(chart.difficulty, chart)}`).join(" / ")] : []),
      ...lunatics.map(l => link(`（${showId(l.id)}：LUN ${showConstant("LUN", l)}${l.deleted ? "，已删除" : ""}）`, l.id, `/谱面分析 id${l.id} 白`)),
    ];
    if (chartLine.length) out.push(chartLine);
  }
  if (r.fuzzy) out.push([""], ["以上是曲名比较接近的候选。"]);
  let pager = null, pagerLine = null;
  if (r.pages > 1) {
    const next = `/搜索歌曲 ${r.repeatQuery} --page ${r.page + 1}`;
    pager = { query: r.repeatQuery, page: r.page, pages: r.pages };
    pagerLine = [`第 ${r.page}/${r.pages} 页；`, ...(r.page < r.pages ? ["下一页：", { text: next, command: next }] : ["已到最后一页"])];
    out.push([""], pagerLine);
  }
  if (linked) out.push([""], [{ hint: "（点曲名会填入 /谱面分析 和曲目 ID，再补一个难度字：绿/黄/红/紫；点括号里的白谱，回车即可）" }]);
  return { lines: out, pager, pagerLine };
}

// 翻页按钮见 pager-buttons.cjs。搜的是公开曲库，谁点都一样，不绑发起人；页码按钮填「/搜索歌曲 … --page 」。
function searchKeyboard({ query, page, pages }) {
  const command = `/搜索歌曲 ${query} --page `;
  return pagerKeyboard({ page, pages, jump: target => command + target, input: command });
}

const plainLine = line => line.map(part => typeof part === "string" ? part : part.text ?? "").join("");
const isHintLine = line => line.length > 0 && line.every(part => part?.hint);

// QQ 的指令链接：<qqbot-cmd-input text="…" show="…" />，点了只填输入框、不直接发出；群里会自动带上 @美亚（2026-10-10 实测）。
// 属性值里放不下半角双引号和尖括号（《Snow in "I love you"》），这种曲名不做链接、照原样显示。
// 单个换行在 QQ 的 Markdown 里就是换行（同日实测），所以行与行之间不用改成空一行。
function markdownLine(line) {
  return line.map(part => {
    if (typeof part === "string") return part;
    if (part.hint) return part.hint;
    if (/["<>&]/.test(part.text + part.command)) return part.text;
    return `<qqbot-cmd-input text="${part.command}" show="${part.text}" reference="false" />`;
  }).join("");
}

// 纯文本：跟以前逐字一样，提示行不出现（没有链接可点）。
function reply(query) {
  return replyLines(query).lines.filter(line => !isHintLine(line)).map(plainLine).join("\n").replace(/\n+$/, "");
}

// 按纯文本长度切块（跟 core.splitLines 同一个规则），每块同时给出 Markdown 和纯文本，
// Markdown 被拒时传输层用纯文本补发。提示行跟着最后一块走。
// 翻页那一块另带 keyboard：带按钮发时正文里那行「下一页：…」换成一句提示，
// 按钮被拒时传输层改发 markdownWithoutKeyboard（原来那行指令链接还在）。
function replyChunks(query, limit) {
  const { lines, pager, pagerLine } = replyLines(query);
  const hints = lines.filter(isHintLine);
  const body = lines.filter(line => !isHintLine(line));
  while (body.length && plainLine(body[body.length - 1]) === "") body.pop();
  const chunks = [];
  let current = [], length = 0;
  for (const line of body) {
    const addition = (current.length ? 1 : 0) + plainLine(line).length;
    if (current.length && length + addition > limit) {
      while (plainLine(current[current.length - 1]) === "") current.pop();
      chunks.push(current);
      current = [];
      length = 0;
      if (plainLine(line) === "") continue;
      length = plainLine(line).length;
      current.push(line);
    } else { current.push(line); length += addition; }
  }
  if (current.length) chunks.push(current);
  if (hints.length && chunks.length) chunks[chunks.length - 1].push([""], ...hints);
  return chunks.map(chunk => {
    const markdown = chunk.map(markdownLine).join("\n");
    const text = chunk.filter(line => !isHintLine(line)).map(plainLine).join("\n").replace(/\n+$/, "");
    if (!pager || !chunk.includes(pagerLine)) return { markdown, text };
    const buttonsHint = `第 ${pager.page}/${pager.pages} 页，点下面的按钮翻页；点页码可以自己填页数`;
    return {
      markdown: chunk.map(line => line === pagerLine ? buttonsHint : markdownLine(line)).join("\n"),
      text,
      keyboard: searchKeyboard(pager),
      markdownWithoutKeyboard: markdown,
    };
  });
}

module.exports = { search, reply, replyChunks, SEARCH_SPEC };
