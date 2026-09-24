"use strict";

// Public metadata only: never consult player bindings or send a model-written result.
const { songs } = require("../ongeki-song-catalog.json");
const core = require("../mia-core.cjs");
const { botSongId } = require("./song-id.cjs");
// 两级归一化。**符号不能在唯一那一级里抹掉**：曲名里真的有符号，而 `∀` 这种
// 整条曲名就是一个符号的，抹完是空串 —— 空串 includes 一切，查询词抹成空串又会被
// 下面判成「没给线索」，于是这首歌谁也搜不到。所以第一级保留符号。
const normalize = value => String(value || "").normalize("NFKC").toLowerCase()
  .replace(/[ぁ-ゖ]/g, ch => String.fromCharCode(ch.charCodeAt(0) + 0x60))
  .replace(/[\s\p{P}]/gu, "");
// 第二级再去掉符号，也就是原来的行为：用户通常不会照着打「!」「☆」，
// 「ウキウキCandy」要能搜到《ウキウキ☆Candy!》。**只在前一级没结果时兜底**，
// 两级同时用会把这个宽松度换成另一批噪声。
const squash = value => normalize(value).replace(/\p{S}/gu, "");
const index = songs.map(song => ({ song, title: normalize(song.meta.name), squashed: squash(song.meta.name) }));
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

function search(raw) {
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
  const pool = index;
  const idMatch = query.match(/^(?:id\s*)?(\d+)$/i);
  const aliasTitles = idMatch ? null : new Set(core.searchSongs(query).map(s => normalize(s.name)));
  let matches = idMatch
    ? pool.filter(({ song }) => botSongId(song) === Number(idMatch[1]))
    : pool.filter(({ title, squashed }) =>
      title.includes(needle) || (squashedNeedle && squashed.includes(squashedNeedle)) || aliasTitles.has(title));
  let fuzzy = false;
  if (!matches.length && !idMatch && needle.length >= 3) {
    const limit = needle.length < 5 ? 1 : Math.min(3, Math.floor(needle.length * 0.25));
    matches = pool.map(item => ({ ...item, distance: Math.abs(item.title.length - needle.length) <= limit ? distance(needle, item.title) : Infinity }))
      .filter(item => item.distance <= limit).sort((a, b) => a.distance - b.distance || a.title.localeCompare(b.title));
    fuzzy = matches.length > 0;
  }
  if (!fuzzy) matches.sort((a, b) => Number(b.title === needle) - Number(a.title === needle) || a.title.localeCompare(b.title));
  const total = matches.length;
  const pages = Math.max(1, Math.ceil(total / 8));
  return { matches: matches.slice((page - 1) * 8, page * 8).map(x => x.song), total, pages, page, fuzzy, repeatQuery };
}

function reply(query) {
  const r = search(query);
  if (r.usage) return "给我一点曲名线索吧♪\n/搜索歌曲 サド\n也能用别名或 id；结果多时加 --page 2 翻页。";
  if (!r.total) return "本地音击曲库里没有找到匹配这个关键词的歌。换一小段曲名试试？";
  if (r.page > r.pages) return `这一页没有结果，一共只有 ${r.pages} 页。`;
  const entries = r.matches.map(song => {
    const id = botSongId(song);
    const title = `${id == null ? "ID待核实" : `id${id}`}   ${song.meta.name}${song.meta.is_deleted ? "（已删除）" : ""}`;
    const constants = ["BAS", "ADV", "EXP", "MAS", "LUN"].filter(d => song[d]?.has_chart)
      .map(d => {
        const chart = song[d];
        const value = chart.const_status === "known" && chart.const != null ? chart.const
          : d === "LUN" && String(chart.level) === "0" ? "无定数" : "定数未知";
        return `${d} ${value}`;
      }).join(" / ");
    return constants ? `${title}\n${constants}` : title;
  });
  const sections = [`查到 ${r.total} 首：`, entries.join("\n\n")];
  if (r.fuzzy) sections.push("以上是曲名比较接近的候选。");
  if (r.pages > 1) sections.push(`第 ${r.page}/${r.pages} 页；${r.page < r.pages ? `下一页：/搜索歌曲 ${r.repeatQuery} --page ${r.page + 1}` : "已到最后一页"}`);
  return sections.join("\n\n");
}

module.exports = { search, reply, SEARCH_SPEC };
