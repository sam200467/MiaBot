#!/usr/bin/env node
"use strict";
// 查歌检查：在服务器上确认各条指令认得哪些写法，不连 QQ、不出图、不写任何文件。
//
//   node check-song-query.cjs            先跑一遍内置用例，再进入交互，自己输词看结果
//   node check-song-query.cjs sado 战争   只看这几个词
//   node check-song-query.cjs --cases    只跑内置用例（全过退出码 0）
//
// 别名库读的是 config.local.json 指向的那份（只读）。找不到配置就不带别名，照样能跑。

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const core = require("../mia-core.cjs");
const songSearch = require("./song-search.cjs");

const HERE = __dirname;

function loadAliases() {
  const configPath = path.join(HERE, "config.local.json");
  if (!fs.existsSync(configPath)) return "没找到 config.local.json，不带别名";
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const dir = String(config.aliasDir || "").trim() || path.dirname(String(config.vaultPath || "./data/bindings.dat"));
    // 跟 mia-commands 的 registerCore 一样，scope 缺省是 "qq"。configureAliases 只读盘，不写。
    core.configureAliases({ ...config, aliasDir: path.resolve(HERE, dir), aliasScope: config.aliasScope || "qq" });
    return "别名库：" + core.getAliasStore().filePath + "（" + core.getAliasStore().entries.length + " 条）";
  } catch (error) {
    return "别名库读取失败，不带别名：" + error.message;
  }
}

const label = (song) => "id" + song.id + " " + song.name;
const catalogName = (item) => item?.name || item?.meta?.name || "";

// 四条指令各自查到什么。/单曲 和 /谱面分析 要求唯一，多首时机器人会让人再挑。
function lookup(query) {
  const song = core.searchSongs(query);
  const whatis = core.searchSongClues(query);
  const searched = songSearch.search(query, { uncataloged: true });
  const chart = core.searchChartInfo(query);
  return { song, whatis, searched, chart };
}

function show(query) {
  const { song, whatis, searched, chart } = lookup(query);
  const list = (items) => items.length ? items.slice(0, 6).map(label).join("、") + (items.length > 6 ? " …共 " + items.length + " 首" : "") : "（没有）";
  console.log("\n「" + query + "」");
  console.log("  /单曲      " + list(song) + (song.length > 1 ? "  ← 多首，会让你再挑" : ""));
  console.log("  /是什么歌  " + list(whatis));
  console.log("  /搜索歌曲  " + (searched.usage ? "（没给线索）"
    : searched.total ? searched.matches.slice(0, 6).map(catalogName).join("、") + (searched.total > 6 ? " …共 " + searched.total + " 首" : "") + (searched.fuzzy ? "  ← 近似结果" : "")
      : "（没有）"));
  if (chart.parsed) console.log("  /谱面分析  " + (chart.matches.length ? chart.matches.map((m) => label(m.song) + " " + m.difficultyName).join("、") : "（没有）"));
}

// 内置用例：这几轮改动要保证的写法。want 是一定要查到的歌的 ID；only 表示 /单曲 只能查到这些。
const CASES = [
  { group: "数字 ID", query: "833", want: [833], only: true },
  { group: "数字 ID", query: "id833", want: [833], only: true },
  { group: "数字 ID", query: "39", want: [39, 213], note: "ID 39 和曲名《39》都列出来" },
  { group: "数字 ID", query: "id39", want: [39], only: true },
  { group: "曲名片段", query: "viiibit", want: [870] },
  { group: "曲名片段", query: "explorer", want: [870] },
  { group: "简繁", query: "梦", want: [641] },
  { group: "日本汉字", query: "战争", want: [22] },
  { group: "日本汉字", query: "戰爭", want: [22] },
  { group: "日本汉字", query: "气", want: [32] },
  { group: "希腊字母/符号", query: "omega4", want: [220] },
  { group: "希腊字母/符号", query: "ataraxia", want: [8071] },
  { group: "希腊字母/符号", query: "倒a", want: [1070] },
  { group: "重音字母", query: "fatalite", want: [94] },
  { group: "重音字母", query: "loschen", want: [755] },
  { group: "重音字母", query: "astronotes", want: [386] },
  { group: "平假名/片假名", query: "さど", want: [252] },
  { group: "罗马音", query: "sado", want: [252] },
  { group: "罗马音", query: "senbonzakura", want: [50] },
  { group: "罗马音", query: "shuga-songu", want: [24] },
  { group: "罗马音", query: "yureitokyo", want: [720] },
  { group: "罗马音", query: "vanpaia", want: [911] },
  { group: "不误伤", query: "sage", want: [833], only: true, note: "英文曲名命中了就不按罗马音多拖歌" },
];

function runCases() {
  let failed = 0;
  let group = "";
  for (const item of CASES) {
    if (item.group !== group) { group = item.group; console.log("\n【" + group + "】"); }
    const { song, whatis, searched } = lookup(item.query);
    const ids = (songs) => songs.map((s) => Number(s.id));
    const searchedNames = new Set(searched.matches.map(catalogName));
    const wantNames = item.want.map((id) => core.INTERNAL_SONGS.find((s) => Number(s.id) === id)?.name);
    const problems = [];
    if (!item.want.every((id) => ids(song).includes(id))) problems.push("/单曲 查到 " + (song.map(label).join("、") || "（没有）"));
    if (item.only && song.length !== item.want.length) problems.push("/单曲 多出 " + song.filter((s) => !item.want.includes(Number(s.id))).map(label).join("、"));
    if (!item.want.every((id) => ids(whatis).includes(id))) problems.push("/是什么歌 查到 " + (whatis.map(label).join("、") || "（没有）"));
    if (!wantNames.every((name) => searchedNames.has(name))) problems.push("/搜索歌曲 查到 " + ([...searchedNames].join("、") || "（没有）"));
    const target = item.want.map((id) => label(core.INTERNAL_SONGS.find((s) => Number(s.id) === id))).join("、");
    if (problems.length) {
      failed++;
      console.log("  ✗ " + item.query + " → 应该是 " + target);
      for (const problem of problems) console.log("      " + problem);
    } else {
      console.log("  ✓ " + item.query + " → " + target + (item.note ? "（" + item.note + "）" : ""));
    }
  }
  console.log("\n" + (failed ? "✗ " + failed + " / " + CASES.length + " 条没通过" : "✓ " + CASES.length + " 条全部通过"));
  return failed;
}

async function interactive() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log("\n输入要查的词，看四条指令各查到什么（/谱面分析 要带难度，比如「sado 紫」）。直接回车退出。");
  for (;;) {
    const line = await new Promise((resolve) => rl.question("\n> ", resolve));
    if (!String(line).trim()) break;
    show(String(line).trim());
  }
  rl.close();
}

async function main() {
  const args = process.argv.slice(2);
  console.log(loadAliases());
  if (args.length && args[0] !== "--cases") {
    for (const query of args) show(query);
    return;
  }
  const failed = runCases();
  if (args[0] === "--cases" || !process.stdin.isTTY) { process.exitCode = failed ? 1 : 0; return; }
  await interactive();
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
