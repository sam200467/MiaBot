"use strict";
// MiaBot 平台无关核心。
//
// 这里只放与聊天平台无关的东西：曲库检索、定数计算、结果格式化、子进程调用、
// 凭据库读写、分表渲染任务。各前端入口（本仓库里是 qq-official/）都从这里取用。
//
// 刻意**不**收进来的东西：
//   - 命令定义、按钮、弹窗、交互回复时序（各平台自己写）
//   - 队列 / 冷却 / 去重（前端的 handler 直接引用这些闭包变量，共 36 处，
//     等二期 handler 统一到 ctx 接口时再一起搬；QQ 侧目前自带一份）
//   - helpText（带 markdown 风格的文案，QQ 需要自己的版本）

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { Converter } = require("opencc-js");
const { SongAliasStore, SongAliasCandidateStore } = require("./song-alias-store.cjs");
const INTERNAL_SONGS = require("./ongeki-music-internal.json");
const rinnet = require("./rinnet-client.cjs");

const GENERATE_COOLDOWN_MS = 60 * 1000;
const MAX_QUEUE = 3;
const PLATE_CHOICES = Object.freeze([
  { id: "040100", nameJa: "桜撃", nameZhHans: "樱击", version: "ONGEKI" },
  { id: "040105", nameJa: "進撃", nameZhHans: "进击", version: "ONGEKI PLUS" },
  { id: "040110", nameJa: "夏撃", nameZhHans: "夏击", version: "ONGEKI SUMMER" },
  { id: "040115", nameJa: "波撃", nameZhHans: "波击", version: "ONGEKI SUMMER PLUS" },
  { id: "040120", nameJa: "赤撃", nameZhHans: "赤击", version: "ONGEKI R.E.D." },
  { id: "040125", nameJa: "皇撃", nameZhHans: "皇击", version: "ONGEKI R.E.D. PLUS" },
  { id: "040130", nameJa: "輝撃", nameZhHans: "辉击", version: "ONGEKI bright" },
  { id: "040135", nameJa: "耀撃", nameZhHans: "耀击", version: "ONGEKI bright MEMORY Act.1" },
  { id: "040140", nameJa: "閃撃", nameZhHans: "闪击", version: "ONGEKI bright MEMORY Act.2" },
  { id: "040145", nameJa: "想撃", nameZhHans: "想击", version: "ONGEKI bright MEMORY Act.3" },
  { id: "040150", nameJa: "爽撃", nameZhHans: "爽击", version: "ONGEKI Re:Fresh Act.1" },
]);
const LEVEL_CHOICES = Object.freeze([
  "0", "1", "2", "3", "4", "5", "6", "7", "7+", "8", "8+", "9", "9+",
  "10", "10+", "11", "11+", "12", "12+", "13", "13+", "14", "14+", "15", "15+",
]);

// 给宿主 GUI 的日志协议。tag 名与分隔符是**冻结**的：外部的启动器 GUI 用硬编码
// Substring 偏移解析（BOT_READY / BOT_BINDING_COUNT: / BOT_BINDING_SAVED: / BOT_BUSY: /
// BOT_FATAL: / BOT_ERROR: / BOT_LOG:），一个字符都不能改。未知 tag 会被 GUI 兜底打进
// 日志区，所以新增 tag 是安全的。
// BOT_NAPCAT:1|0 是 OneBot 那一侧专有的：NapCat 连接状态，别的入口不会发。
// 加新 tag 时记得同步 GUI 的 HandleLine，否则会原样打进日志区。
function emit(tag, value = "") {
  process.stdout.write(tag + (value === "" ? "" : ":" + String(value)) + "\n");
}

function safeError(error) {
  return String(error?.message || error || "未知错误")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[代理凭据已隐藏]@")
    .replace(/([\w.+-]{1,80})@([\w.-]{1,120})/g, "[邮箱已隐藏]")
    .replace(/(secret|password|passwd|token|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1=[已隐藏]")
    .replace(/\b\d{20}\b/g, "[卡号已隐藏]")
    .replace(/[A-Za-z0-9_.-]{48,}/g, "[敏感内容已隐藏]")
    .slice(0, 800);
}

const simplifySongQuery = Converter({ from: "tw", to: "cn" });

function normalizeSongQuery(value) {
  return simplifySongQuery(String(value || "")
    .normalize("NFKC")
    .replace(/[\s　]+/g, " ")
    .trim()
    .toLowerCase())
    // OpenCC 的简繁表未涵盖「焔 / 燄 / 焰」这组异体字。
    .replace(/[焔燄]/g, "焰");
}

function normalizeLevelCommandQuery(value) {
  const query = String(value || "")
    .normalize("NFKC")
    .trim()
    .toUpperCase()
    .replace(/^LEVEL\s*/i, "")
    .replace(/^LV\.?\s*/i, "")
    .replace(/\s+/g, "");
  if (query === "ABFB" || LEVEL_CHOICES.includes(query)) return query;
  if (/^\d{1,2}\.\d$/.test(query)) {
    const constant = Number(query);
    if (constant >= 0 && constant <= 15.9) return constant.toFixed(1);
  }
  return "";
}

function levelCommandTarget(query) {
  if (query === "ABFB") return "ABFB 全难度";
  if (/^\d+\.\d$/.test(query)) return `定数 ${query}`;
  return `LEVEL ${query}`;
}

let songAliases = new SongAliasStore(null, normalizeSongQuery);
let songAliasCandidates = new SongAliasCandidateStore(null, normalizeSongQuery);

function getAliasStore() {
  return songAliases;
}

function setAliasStore(store) {
  songAliases = store;
  return songAliases;
}

function getAliasCandidateStore() {
  return songAliasCandidates;
}

function setAliasCandidateStore(store) {
  songAliasCandidates = store;
  return songAliasCandidates;
}

// 别名文件按 scope 命名。Discord 传 guildId（文件名与旧版逐字节一致），QQ 传 "qq"
// （别名是社区词汇，不该按群各存一份）。候选库跟着正式库放在同一目录、同一 scope——
// 两者是一对，分开配置迟早会不一致。
//
// 目录默认跟着凭据库走，但可以用 config.aliasDir 单独指定 —— 梨绪和美亚是两个独立
// 进程、各有各的凭据库，别名库却该是同一份（同一个社区词汇表，不该按 bot 分叉）。
// ⚠ 想让两个入口共用一份，**目录和 scope 两个都要一样**：文件名是
// song-aliases-<scope>.json，只改目录不改 scope 会得到两个并排的新文件，
// 表面上「配了 aliasDir」实际各写各的。Discord 不传 aliasDir，行为与旧版一致。
function configureAliases(config) {
  const scope = String(config.aliasScope || config.guildId || "").trim();
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(scope)) throw new Error("别名作用域不合法：" + (scope || "（空）"));
  const dir = config.aliasDir ? path.resolve(String(config.aliasDir)) : path.dirname(config.vaultPath);
  songAliases = new SongAliasStore(
    path.join(dir, "song-aliases-" + scope + ".json"),
    normalizeSongQuery,
    // 只给迁移用：旧文件按 songId 存，读进来时换回曲名与游戏。
    { resolveSong: (id) => { const song = INTERNAL_SONGS.find((item) => Number(item.id) === Number(id)); return song ? { title: String(song.name), game: "ongeki" } : null; } },
  );
  songAliases.load();
  songAliasCandidates = new SongAliasCandidateStore(
    path.join(dir, "song-alias-candidates-" + scope + ".json"),
    normalizeSongQuery,
  );
  songAliasCandidates.load();
  return songAliases;
}

// 别名 → 正式曲名。这是聊天侧曲库查询的**前置解析**：聊天侧读的是 chat-core 的水鱼
// 快照，宿主读的是 ongeki-music-internal.json，两套 id 空间实测零重叠（0/4163），
// 所以衔接点只能是**曲名**——别名本身也只挂曲名，不挂任何一份曲库的 songId。
// 解析规则全部留在 SongAliasStore（同一套 normalize、同一套 entries），聊天侧不重复
// 实现第二套。game 是当前对话的游戏作用域：同一条叫法在多款游戏下指向不同曲名时，
// 由它来消歧；没给作用域又撞上歧义就是 null，绝不任选一个。
function resolveAliasTitle(value, game = "") {
  return getAliasStore().lookup(value, game);
}

const SONG_SEARCH_INDEX = INTERNAL_SONGS.map(song => ({ song, title: normalizeSongQuery(song?.name) }));

function searchSongs(query) {
  const raw = String(query || "").normalize("NFKC").trim();
  if (!raw) return [];
  const idMatch = raw.match(/^(?:id\s*)?(\d+)$/i);
  if (idMatch) {
    const id = Number(idMatch[1]);
    return INTERNAL_SONGS.filter((song) => Number(song?.id) === id);
  }
  const needle = normalizeSongQuery(raw);
  return SONG_SEARCH_INDEX
    .filter(({ song, title }) => title.includes(needle) || songAliases.matches(song.name, needle, "ongeki"))
    .map(({ song }) => song)
    .sort((a, b) => Number(a.id) - Number(b.id));
}

// 添加/删除别名的两个参数。新格式只用空格；旧竖线写法继续兼容。
// 没有竖线时逐个空格试切，优先选「完整曲名/完整别名/完整 ID」那个边界，
// 这样 VIIIbit Explorer 这种自带空格的曲名不会被切成两半。
function parseAliasWriteInput(input) {
  const raw = String(input || "").normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!raw) return null;
  const divider = raw.indexOf("|");
  if (divider >= 0) {
    return { query: raw.slice(0, divider).trim(), alias: raw.slice(divider + 1).trim() };
  }
  const words = raw.split(" ").filter(Boolean);
  if (words.length < 2) return null;
  const candidates = [];
  for (let i = 1; i < words.length; i++) {
    const query = words.slice(0, i).join(" ");
    const matches = searchSongs(query);
    if (matches.length !== 1) continue;
    const song = matches[0];
    const idMatch = query.match(/^(?:id\s*)?(\d+)$/i);
    const key = normalizeSongQuery(query);
    const exact = idMatch ? Number(song.id) === Number(idMatch[1])
      : normalizeSongQuery(song.name) === key || songAliases.matches(song.name, key, "ongeki", true);
    candidates.push({ query, alias: words.slice(i).join(" "), exact });
  }
  if (!candidates.length) return { query: words.slice(0, -1).join(" "), alias: words.at(-1) };
  const exact = candidates.filter((item) => item.exact);
  return (exact.length ? exact : candidates).sort((a, b) => b.query.length - a.query.length)[0];
}

// /是什么歌 同时接受曲名片段和别名；别名沿用反查原有的“精确优先”规则。
function searchSongClues(query) {
  const raw = String(query || "").normalize("NFKC").trim();
  if (!raw) return [];
  if (/^(?:id\s*)?\d+$/i.test(raw)) return searchSongs(raw);
  const needle = normalizeSongQuery(raw);
  const aliasTitles = new Set(songAliases.names(raw, "ongeki").map((hit) => normalizeSongQuery(hit.title)));
  return searchSongs(raw).filter((song) => {
    const title = normalizeSongQuery(song.name);
    return title.includes(needle) || aliasTitles.has(title);
  });
}

const CHART_INFO_DIFFICULTY_ALIASES = Object.freeze(new Map([
  ["basic", 0], ["bas", 0], ["bsc", 0], ["绿", 0], ["绿谱", 0], ["緑", 0], ["緑譜", 0],
  ["advanced", 1], ["adv", 1], ["黄", 1], ["黄谱", 1], ["黃", 1], ["黃譜", 1],
  ["expert", 2], ["exp", 2], ["红", 2], ["红谱", 2], ["紅", 2], ["紅譜", 2],
  ["master", 3], ["mas", 3], ["mst", 3], ["紫", 3], ["紫谱", 3], ["紫譜", 3],
  ["lunatic", 10], ["lun", 10], ["lnt", 10], ["白", 10], ["白谱", 10], ["白譜", 10],
]));
const CHART_INFO_DIFFICULTY_NAMES = Object.freeze({ 0: "BASIC", 1: "ADVANCED", 2: "EXPERT", 3: "MASTER", 10: "LUNATIC" });
const CHART_INFO_DIFFICULTY_POSITIONS = Object.freeze({ 0: 0, 1: 1, 2: 2, 3: 3, 10: 4 });

function parseChartInfoQuery(value) {
  const normalized = String(value || "").normalize("NFKC").replace(/[\s　]+/g, " ").trim();
  const match = normalized.match(/^(.*\S)\s+(\S+)$/);
  if (!match) return null;
  const difficultyId = CHART_INFO_DIFFICULTY_ALIASES.get(match[2].toLowerCase());
  if (difficultyId === undefined) return null;
  return { songQuery: match[1].trim(), difficultyId, difficultyName: CHART_INFO_DIFFICULTY_NAMES[difficultyId] };
}

function songHasChartDifficulty(song, difficultyId) {
  const position = CHART_INFO_DIFFICULTY_POSITIONS[difficultyId];
  if (position === undefined) return false;
  const level = song?.level?.[position];
  const constant = Number(song?.const?.[position]);
  const notes = Number(song?.noteTotal?.[position]);
  return level !== null && level !== undefined && String(level).trim() !== "" && String(level) !== "-" &&
    Number.isFinite(constant) && constant >= 0 && Number.isFinite(notes) && notes > 0;
}

function searchChartInfo(value) {
  const parsed = parseChartInfoQuery(value);
  if (!parsed) return { parsed: null, matches: [] };
  const matches = searchSongs(parsed.songQuery)
    .filter((song) => songHasChartDifficulty(song, parsed.difficultyId))
    .map((song) => ({ song, difficultyId: parsed.difficultyId, difficultyName: parsed.difficultyName }));
  return { parsed, matches };
}

// Candidate values use IDs so duplicate titles and shortened labels stay unambiguous.
function songAutocomplete(commandName, value) {
  if (!["song", "chartinfo"].includes(commandName)) return [];
  const raw = String(value || "").normalize("NFKC").replace(/[\s　]+/g, " ").trim();
  let query = raw;
  let difficulties = [3, 2, 1, 0, 10];
  if (commandName === "chartinfo") {
    const parsed = parseChartInfoQuery(raw);
    if (parsed) {
      query = parsed.songQuery;
      difficulties = [parsed.difficultyId];
    } else {
      const suffix = raw.match(/^(.*\S)\s+(\S+)$/);
      const partial = suffix && [...CHART_INFO_DIFFICULTY_ALIASES]
        .filter(([alias]) => alias.startsWith(suffix[2].toLowerCase())).map(([, id]) => id);
      if (partial?.length) {
        query = suffix[1];
        difficulties = [...new Set(partial)];
      }
    }
  }
  const needle = normalizeSongQuery(query);
  const idMatch = query.match(/^(?:id\s*)?(\d+)$/i);
  const songs = SONG_SEARCH_INDEX.filter(({ song, title }) => !needle ||
    (idMatch ? String(song.id).startsWith(idMatch[1]) : title.includes(needle) || songAliases.matches(song.name, needle, "ongeki")))
    .sort((a, b) => {
      const rank = item => idMatch ? (String(item.song.id) === idMatch[1] ? 0 : 1)
        : item.title === needle || songAliases.matches(item.song.name, needle, "ongeki", true) ? 0 : item.title.startsWith(needle) ? 1 : 2;
      return rank(a) - rank(b) || Number(a.song.id) - Number(b.song.id);
    });
  const choices = [];
  for (const { song } of songs) {
    const entries = commandName === "song" ? [null] : difficulties.filter(id => songHasChartDifficulty(song, id));
    for (const id of entries) {
      const difficulty = id === null ? "" : CHART_INFO_DIFFICULTY_NAMES[id];
      choices.push({
        name: ("id" + song.id + " " + (difficulty ? "[" + difficulty + "] " : "") + song.name + " — " + (song.artistName || "")).slice(0, 100),
        value: "id" + song.id + (difficulty ? " " + difficulty.toLowerCase() : ""),
      });
      if (choices.length === 25) return choices;
    }
  }
  return choices;
}

function aliasAutocomplete(value) {
  const needle = normalizeSongQuery(value);
  const seen = new Set();
  const choices = [];
  for (const entry of songAliases.entries) {
    const key = normalizeSongQuery(entry.alias);
    if (!key.includes(needle) || seen.has(key)) continue;
    seen.add(key);
    choices.push({ name: entry.alias, value: entry.alias });
    if (choices.length === 25) break;
  }
  return choices;
}

function escapeDiscordText(value) {
  return String(value || "").replace(/([\\`*_{}[\]()<>#+\-.!|])/g, "\\$1");
}

// Discord 会对 * ` # - 之类的字符做反斜杠转义；QQ 不渲染任何 markdown，照搬会让用户
// 看到一堆裸反斜杠。所以曲名格式化走这个可配置的转义器，默认保持 Discord 行为不变。
let escapeText = escapeDiscordText;

function configureFormatting(options = {}) {
  escapeText = typeof options.escapeText === "function" ? options.escapeText : escapeDiscordText;
}

function chartInfoMatchLines(matches) {
  return matches.map(({ song, difficultyName }) =>
    `id${song.id}　${escapeText(song.name)}　[${difficultyName}]　— ${escapeText(song.artistName)}`
  );
}

function songMatchLines(matches) {
  return matches.map((song) => {
    const lunaticMark = song.isLunatic === true ? " [LUNATIC]" : "";
    return `id${song.id}　${escapeText(song.name)}${lunaticMark}　— ${escapeText(song.artistName)}`;
  });
}

function calculateBaseRating(chartConstant, score) {
  if (score >= 1010000) return chartConstant + 2.0;
  if (score >= 1007500) {
    return chartConstant + 1.75 + (score - 1007500) * (2.0 - 1.75) / (1010000.0 - 1007500.0);
  }
  if (score >= 1000000) {
    return chartConstant + 1.25 + (score - 1000000) * (1.75 - 1.25) / (1007500.0 - 1000000.0);
  }
  if (score >= 990000) {
    return chartConstant + 0.75 + (score - 990000) * (1.25 - 0.75) / (1000000.0 - 990000.0);
  }
  if (score >= 970000) {
    return chartConstant + (score - 970000) * (0.75 - 0.0) / (990000.0 - 970000.0);
  }
  if (score >= 900000) {
    return chartConstant - 4.0 + (score - 900000) * (0.0 - (-4.0)) / (970000.0 - 900000.0);
  }
  if (score >= 800000) {
    return chartConstant - 6.0 + (score - 800000) * (-4.0 - (-6.0)) / (900000.0 - 800000.0);
  }
  if (score >= 500000) return (score - 500000) * (-6.0) / (800000.0 - 500000.0);
  return 0;
}

function calculateSingleRating(chartConstant, score, bellMark, comboMark) {
  if (!Number.isFinite(chartConstant) || chartConstant < 0 || chartConstant > 20 ||
      Math.abs(chartConstant * 10 - Math.round(chartConstant * 10)) > 1e-9) {
    throw new Error("谱面定数不合法：请输入 0–20，且最多一位小数（如 13、13.0、13.4）。");
  }
  if (!Number.isInteger(score) || score < 0 || score > 1010000) {
    throw new Error("技术分不合法：请输入 0–1010000 的纯整数。");
  }
  if (!new Set(["none", "fb"]).has(bellMark)) throw new Error("铃铛加成只能选择 FB 或无。");
  if (!new Set(["none", "fc", "ab", "ab-plus"]).has(comboMark)) throw new Error("连击加成只能选择 FC、AB、AB+ 或无。");

  const baseRating = calculateBaseRating(chartConstant, score);
  const scoreMark = score >= 1007500 ? "SSS+" : score >= 1000000 ? "SSS" : score >= 990000 ? "SS" : "无";
  const scoreBonus = scoreMark === "SSS+" ? 0.30 : scoreMark === "SSS" ? 0.20 : scoreMark === "SS" ? 0.10 : 0;
  const bellBonus = bellMark === "fb" ? 0.05 : 0;
  const comboBonus = comboMark === "fc" ? 0.10 : comboMark === "ab" ? 0.30 : comboMark === "ab-plus" ? 0.35 : 0;
  const total = baseRating + scoreBonus + bellBonus + comboBonus;
  const truncateTwo = (value) => Math.trunc(value * 100) / 100;
  const compact = (value) => String(truncateTwo(value));
  const comboLabel = comboMark === "fc" ? "FC" : comboMark === "ab" ? "AB" : comboMark === "ab-plus" ? "AB+" : "无";
  return {
    result: truncateTwo(total).toFixed(2),
    text: "基础分 " + truncateTwo(baseRating).toFixed(2) +
      " + 成绩加成 " + compact(scoreBonus) + "（" + scoreMark + "）" +
      "+ 铃铛 " + compact(bellBonus) + "（" + (bellMark === "fb" ? "FB" : "无") + "）" +
      "+ 连击 " + compact(comboBonus) + "（" + comboLabel + "）" +
      "= " + truncateTwo(total).toFixed(2),
  };
}

// 原名 splitDiscordLines；limit 默认值仍是 Discord 的 1900，QQ 侧调用时显式传自己的上限。
function splitLines(header, lines, footer, limit = 1900) {
  const chunks = [];
  let current = header;
  for (const line of lines) {
    const addition = (current ? "\n" : "") + line;
    if (current && current.length + addition.length > limit) {
      chunks.push(current);
      current = line;
    } else current += addition;
  }
  const footerAddition = (current ? "\n" : "") + footer;
  if (current.length + footerAddition.length > limit) {
    if (current) chunks.push(current);
    current = footer;
  } else current += footerAddition;
  if (current) chunks.push(current);
  return chunks;
}

// stdin 上的单个 JSON 配置块，各平台入口通用。
async function readConfig() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8").replace(/^\uFEFF/, "").trim();
  if (!text) throw new Error("未收到启动配置");
  return JSON.parse(text);
}

function runProcess(exe, args, input = "", timeoutMs = 15000, env) {
  return new Promise((resolve, reject) => {
    const command = scriptCommand(exe, args);
    const child = spawn(command.file, command.args, { windowsHide: true, env: env || process.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill();
      reject(new Error("子进程执行超时"));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    child.on("error", (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(input, "utf8");
  });
}

// Windows 发布包继续直接运行 .exe；macOS/Linux 发布包把同一组件打成
// 单文件 Node 脚本。配置仍只需要一个路径，不把平台差异泄漏到命令层。
function scriptCommand(file, args = []) {
  const ext = path.extname(String(file || "")).toLowerCase();
  if (ext === ".js" || ext === ".cjs" || ext === ".mjs") {
    return { file: process.execPath, args: [file, ...args] };
  }
  return { file, args };
}

async function vaultCall(config, command, args = [], input = "") {
  const executable = scriptCommand(config.vaultHelperPath, [command, config.vaultPath, ...args]);
  const result = await runProcess(executable.file, executable.args, input, 15000);
  if (result.code === 4) return null;
  if (result.code !== 0) throw new Error(result.stderr.replace(/^VAULT_ERROR:/, "").trim() || "本地加密账号库操作失败");
  return result.stdout;
}

async function getDataSource(config, userId) {
  if (!fs.existsSync(config.vaultPath)) return "otogame";
  const text = await vaultCall(config, "get", [userId]);
  return text && JSON.parse(text).dataSource === "rinnet" ? "rinnet" : "otogame";
}

function selectBinding(entry, source) {
  if (!entry) return null;
  source = source || entry.dataSource || "otogame";
  if (source === "rinnet") return entry.rinnet ? { ...entry.rinnet, userId: entry.userId, dataSource: "rinnet" } : null;
  if (!entry.email || !entry.password) return null;
  const { rinnet: ignored, ...binding } = entry;
  return { ...binding, dataSource: "otogame" };
}

async function getBinding(config, userId, source) {
  const text = await vaultCall(config, "get", [userId]);
  return selectBinding(text ? JSON.parse(text) : null, source);
}

async function setDataSource(config, userId, source) {
  if (!["otogame", "rinnet"].includes(source)) throw new Error("数据源无效");
  await vaultCall(config, "source", [String(userId), source]);
}

async function deleteBinding(config, userId, source) {
  await module.exports.vaultCall(config, "delete-source", [String(userId), source || await getDataSource(config, userId)]);
}

async function saveBinding(config, entry) {
  await vaultCall(config, "set", [], JSON.stringify(entry));
}

const rinnetClients = new Map();
function getRinnetClient(config) {
  const proxyUrl = config.proxyUrl || "";
  if (!rinnetClients.has(proxyUrl)) rinnetClients.set(proxyUrl, rinnet.createClient({ proxyUrl }));
  return rinnetClients.get(proxyUrl);
}
async function personalJob(config, binding, kind, songId) {
  if (binding.dataSource !== "rinnet") return { email: binding.email, password: binding.password };
  // Re-read tokens at execution time: queued jobs may have captured an older token.
  const current = await module.exports.getBinding(config, binding.userId, "rinnet");
  if (!current || current.sessionId !== binding.sessionId) throw new Error("这份 rinnet 绑定已更换或解除，请重新发起查询。");
  const snapshot = await module.exports.getRinnetClient(config).snapshot(current, kind, songId, async account => {
    const saved = await vaultCall(config, "refresh-rinnet", [], JSON.stringify({ userId: current.userId, sessionId: current.sessionId, account }));
    if (!saved) throw new Error("rinnet 绑定已更换或解除，请重新 /绑定。");
  });
  return { playerData: snapshot };
}

// 分表核心把图片以 base64 经 stdout 流式吐回来，那些行绝不能进日志 ——
// 否则整张图的 base64 会刷屏（safeError 只能把它打码成 [敏感内容已隐藏]，照样是几 MB）。
const PAYLOAD_LINE = /^(?:OUTPUT|SONG_OUTPUT|CHART_INFO_OUTPUT|COMPLETION_OUTPUT|LEVEL_OUTPUT|CONSTANT_OUTPUT)_(?:BASE64|FILE):|^(?:CHART|SONG|CHART_INFO|COMPLETION|LEVEL)_SUMMARY:/;

function isPayloadLine(line) {
  return PAYLOAD_LINE.test(line) || line.length > 500;
}

function runCore(config, mode, job, timeoutMs, onLine) {
  return new Promise((resolve, reject) => {
    const command = scriptCommand(config.corePath, [mode]);
    const child = spawn(command.file, command.args, {
      cwd: config.workDir,
      windowsHide: true,
      env: {
        ...process.env,
        ONGEKI_APP_DIR: config.workDir,
        // 分表核心（ongeki-core）用同一代理访问 u.otogame / reiwa 渲染服务
        ONGEKI_HTTPS_PROXY: config.proxyUrl || "",
        ONGEKI_HTTP_PROXY: config.proxyUrl || "",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill();
      reject(new Error("操作超时，已中止本次任务"));
    }, timeoutMs);
    // 行缓冲：数据是分块到达的，一行可能被切断。不缓冲的话，base64 的半截
    // 会因为既不以 OUTPUT_BASE64: 开头、又不够长而漏进日志。
    let stdoutRest = "";
    let stderrRest = "";
    const receive = (isError, data) => {
      const text = String(data);
      if (isError) stderr += text;
      else stdout += text;
      // 注意：stdout/stderr 仍然完整累积（图片数据在里面），只是不往日志里送
      const pending = (isError ? stderrRest : stdoutRest) + text;
      const lines = pending.split(/\r?\n/);
      const rest = lines.pop();
      if (isError) stderrRest = rest; else stdoutRest = rest;
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !isPayloadLine(trimmed)) onLine(trimmed);
      }
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (data) => receive(false, data));
    child.stderr.on("data", (data) => receive(true, data));
    child.on("error", (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code !== 0) {
        const detail = stderr.match(/(?:CONSTANT_JOB|CHART_INFO_JOB|COMPLETION_JOB|LEVEL_JOB|SONG_JOB|JOB|VERIFY)_ERROR:\s*(.+)/)?.[1] || "分表核心异常退出";
        reject(new Error(detail + "（代码 " + code + "）"));
      } else resolve({ stdout, stderr });
    });
    child.stdin.end(JSON.stringify(job), "utf8");
  });
}

// 核心的 XXX_SUMMARY 行是给程序看的结构化数据。解析失败只影响「摘要」，
// 不能用它把一次成功的生成判成失败 —— 所以一律吞掉异常返回 null。
function parseSummary(stdout, pattern) {
  try {
    const text = String(stdout || "").match(pattern)?.[1];
    return text ? JSON.parse(text) : null;
  } catch { return null; }
}

async function verifyAccount(config, email, password, onLine) {
  const result = await runCore(config, "--verify-job-stdin", { email, password }, 120000, onLine);
  const playerName = result.stdout.match(/^PLAYER_NAME:(.+)$/m)?.[1]?.trim();
  if (!playerName) throw new Error("账号验证成功，但没有读取到玩家名");
  return playerName;
}

async function generateChart(config, binding, onLine) {
  const result = await runCore(config, "--job-stdin", {
    ...await personalJob(config, binding, "chart"),
    streamOutput: true, // 图片不落盘，以 base64 经 stdout 返回
  }, 360000, onLine);
  const meta = parseSummary(result.stdout, /^CHART_SUMMARY:(.+)$/m);
  const streamed = result.stdout.match(/^OUTPUT_BASE64:([^:]+):(.+)$/m);
  if (streamed) return { name: streamed[1], buffer: Buffer.from(streamed[2], "base64"), meta };
  // 兼容回退：旧核心仍可能写文件，读取后立即删除
  const outputPath = result.stdout.match(/^OUTPUT_FILE:(.+)$/m)?.[1]?.trim();
  if (!outputPath || !fs.existsSync(outputPath)) throw new Error("分表核心未返回有效的图片数据");
  const buffer = fs.readFileSync(outputPath);
  try { fs.unlinkSync(outputPath); } catch {}
  return { name: path.basename(outputPath), buffer, meta };
}

async function generateSongChart(config, binding, song, onLine) {
  const result = await runCore(config, "--song-job-stdin", {
    ...await personalJob(config, binding, "song", song.id),
    playerName: binding.playerName || "",
    songId: Number(song.id),
    streamOutput: true,
  }, 360000, onLine);
  const meta = parseSummary(result.stdout, /^SONG_SUMMARY:(.+)$/m);
  const streamed = result.stdout.match(/^SONG_OUTPUT_BASE64:([^:]+):(.+)$/m);
  if (streamed) return { name: streamed[1], buffer: Buffer.from(streamed[2], "base64"), meta };
  const outputPath = result.stdout.match(/^SONG_OUTPUT_FILE:(.+)$/m)?.[1]?.trim();
  if (!outputPath || !fs.existsSync(outputPath)) throw new Error("分表核心未返回有效的单曲图片数据");
  const buffer = fs.readFileSync(outputPath);
  try { fs.unlinkSync(outputPath); } catch {}
  return { name: path.basename(outputPath), buffer, meta };
}

async function generateChartInfo(config, match, onLine) {
  const result = await runCore(config, "--chart-info-job-stdin", {
    songId: Number(match.song.id),
    difficultyId: Number(match.difficultyId),
    streamOutput: true,
  }, 180000, onLine);
  const summaryText = result.stdout.match(/^CHART_INFO_SUMMARY:(.+)$/m)?.[1];
  let meta = null;
  try { if (summaryText) meta = JSON.parse(summaryText); } catch {}
  const streamed = result.stdout.match(/^CHART_INFO_OUTPUT_BASE64:([^:]+):(.+)$/m);
  if (streamed) return { name: streamed[1], buffer: Buffer.from(streamed[2], "base64"), meta };
  const outputPath = result.stdout.match(/^CHART_INFO_OUTPUT_FILE:(.+)$/m)?.[1]?.trim();
  if (!outputPath || !fs.existsSync(outputPath)) throw new Error("分表核心未返回有效的谱面分析图片数据");
  const buffer = fs.readFileSync(outputPath);
  try { fs.unlinkSync(outputPath); } catch {}
  return { name: path.basename(outputPath), buffer, meta };
}

async function generateCompletionChart(config, binding, plate, onLine) {
  const result = await runCore(config, "--completion-job-stdin", {
    ...await personalJob(config, binding, "plate"),
    playerName: binding.playerName || "",
    plateId: plate.id,
    streamOutput: true,
  }, 600000, onLine);
  const summaryText = result.stdout.match(/^COMPLETION_SUMMARY:(.+)$/m)?.[1];
  let meta = null;
  try { if (summaryText) meta = JSON.parse(summaryText); } catch {}
  const streamed = result.stdout.match(/^COMPLETION_OUTPUT_BASE64:([^:]+):(.+)$/m);
  if (streamed) return { name: streamed[1], buffer: Buffer.from(streamed[2], "base64"), meta };
  const outputPath = result.stdout.match(/^COMPLETION_OUTPUT_FILE:(.+)$/m)?.[1]?.trim();
  if (!outputPath || !fs.existsSync(outputPath)) throw new Error("分表核心未返回有效的牌子完成度图片数据");
  const buffer = fs.readFileSync(outputPath);
  try { fs.unlinkSync(outputPath); } catch {}
  return { name: path.basename(outputPath), buffer, meta };
}

async function generateLevelChart(config, binding, level, page, onLine) {
  const result = await runCore(config, "--level-job-stdin", {
    ...await personalJob(config, binding, "level"),
    playerName: binding.playerName || "",
    level,
    page,
    streamOutput: true,
  }, 600000, onLine);
  const summaryText = result.stdout.match(/^LEVEL_SUMMARY:(.+)$/m)?.[1];
  let meta = null;
  try { if (summaryText) meta = JSON.parse(summaryText); } catch {}
  const streamed = result.stdout.match(/^LEVEL_OUTPUT_BASE64:([^:]+):(.+)$/m);
  if (streamed) return { name: streamed[1], buffer: Buffer.from(streamed[2], "base64"), meta };
  const outputPath = result.stdout.match(/^LEVEL_OUTPUT_FILE:(.+)$/m)?.[1]?.trim();
  if (!outputPath || !fs.existsSync(outputPath)) throw new Error("分表核心未返回有效的等级成绩图片数据");
  const buffer = fs.readFileSync(outputPath);
  try { fs.unlinkSync(outputPath); } catch {}
  return { name: path.basename(outputPath), buffer, meta };
}

// 读取 PNG 的 IHDR，返回 {width, height}。QQ 对图片边长有上限，发送前需要预判。
// 零依赖，只读前 24 字节。
function pngSize(buffer) {
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  if (data.length < 24) throw new Error("图片数据不完整");
  if (data.readUInt32BE(0) !== 0x89504e47 || data.readUInt32BE(4) !== 0x0d0a1a0a) throw new Error("不是有效的 PNG 数据");
  if (data.toString("ascii", 12, 16) !== "IHDR") throw new Error("PNG 缺少 IHDR 数据块");
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

// 图片本身读不到（聊天模型没有视觉），但**生成它的数据读得到** —— 把图上已经画出来的
// 关键数字压成一句话，记进群上下文，之后「他这首歌打多少分」「榜首是哪首」就答得上。
// 摘要失败一律退回原说明：这只是锦上添花，不能影响正常出图。
function describeImage(kind, image, caption) {
  const head = String(caption || "");
  const meta = image?.meta;
  if (!meta || typeof meta !== "object") return head;
  const difficultyName = (id) => CHART_INFO_DIFFICULTY_NAMES[id] || ("难度" + id);
  const marks = (item, sep = " ") => [item.allBreak ? "AB" : "", item.fullCombo ? "FC" : "", item.fullBell ? "FB" : ""].filter(Boolean).join(sep);
  const number = (value, digits) => (Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : null);
  try {
    if (kind === "chart") {
      const counts = meta.counts || {};
      const top = Array.isArray(meta.top) ? meta.top[0] : null;
      const bits = [];
      if (meta.rating != null) bits.push("RATING " + Number(meta.rating).toFixed(3));
      if (counts.best != null) bits.push("三榜 " + counts.best + "/" + counts.new + "/" + counts.platinum + " 曲");
      if (top?.title) bits.push("榜首 " + top.title + (top.techScore != null ? " " + top.techScore + " 分" : "") + (marks(top) ? " " + marks(top) : ""));
      return bits.length ? head + "｜" + bits.join(" · ") : head;
    }
    if (kind === "song") {
      const scores = Array.isArray(meta.scores) ? meta.scores : [];
      // 只有核心明确说「没找到记录」才这么讲；摘要缺字段时退回原说明，别替它下结论
      if (!scores.length) return meta.found === false ? head + "｜没有该曲目的游玩记录" : head;
      return head + "｜" + scores.slice(0, 4).map((item) =>
        difficultyName(item.difficultyId) + " " + (item.techScore ?? "未游玩") + (marks(item) ? " " + marks(item, " · ") : "")).join("；");
    }
    if (kind === "level") {
      const bits = [
        meta.total != null ? "ALL " + meta.total : null,
        meta.sssPlus != null ? "SSS+ " + meta.sssPlus : null,
        meta.sss != null ? "SSS " + meta.sss : null,
        meta.allBreak != null ? "AB " + meta.allBreak : null,
        meta.fullBell != null ? "FB " + meta.fullBell : null,
        meta.allBreakFullBell != null ? "ABFB " + meta.allBreakFullBell : null,
      ].filter(Boolean);
      return bits.length ? head + "｜" + bits.join(" · ") : head;
    }
    if (kind === "plate") {
      const master = meta.summary?.master;
      if (!master) return head;
      return head + "｜MASTER AB " + master.allBreak + "/" + master.total + " · FB " + master.fullBell + "/" + master.total;
    }
    if (kind === "chartinfo") {
      const bits = [
        meta.difficulty || null,
        number(meta.constant, 1) ? "定数 " + number(meta.constant, 1) : null,
        Number.isFinite(Number(meta.noteCount)) ? "音符 " + meta.noteCount : null,
      ].filter(Boolean);
      return bits.length ? head + "｜" + bits.join(" · ") : head;
    }
  } catch { /* 摘要只是锦上添花 */ }
  return head;
}

// ── 能力（自然语言工具调用）──────────────────────────────────────────
// 聊天入口把 CAPABILITY_SPECS 写进模型提示词；模型挑一个名字加一句参数，
// resolveCapability 把它翻成「要发什么」。这里只解析和取数，**不发送任何东西** ——
// 两个平台的发送模型不同（Discord 走 message.reply，QQ 走 OneBot 消息段），
// 由各自入口 dispatch。井号/斜杠命令与自然语言聊天共用这一层，两条路不会漂移。
//
// 返回四种形态：
//   {kind:"notice", text}                    私聊优先的短提示（未绑定、冷却、队列满）
//   {kind:"text",   text}                    一条文本
//   {kind:"lines",  header, lines, footer}   需要分块的列表
//   {kind:"image",  key, label, failText, caption, run}   run() 出图
const CAPABILITY_SPECS = Object.freeze([
  { name: "help", label: "功能清单", argHint: "不需要参数", needsBinding: false },
  { name: "chart", label: "B50 + N10 + P50 分表", argHint: "不需要参数", needsBinding: true },
  // argHint 后半句是给「有哪些牌子」这类问法兜底的：版本名是静态公共资料，
  // 留空参数程序就会把 11 个版本列出来。没有这句，模型会自己编一句「列不全」。
  { name: "plate", label: "版本牌子完成度图", argHint: "版本牌子名，如 闪击、赤击、想击；用户问有哪些版本牌子、或想查却说不出版本名时留空，程序会列出全部可选的版本", needsBinding: true },
  { name: "song", label: "单曲全难度成绩图", argHint: "曲名或 Song ID", needsBinding: true },
  { name: "chartinfo", label: "单张谱面分数线分析图", argHint: "曲名或 Song ID 加难度，如 id870 master", needsBinding: false },
  { name: "constant", label: "定数表", argHint: "0–20 的整数或一位小数，如 14 或 14.2", needsBinding: false },
  { name: "level", label: "等级成绩长图", argHint: "14、14+、14.1 或 ABFB，可再加页码", needsBinding: true },
  { name: "calculate", label: "单曲 Rating 计算", argHint: "定数、技术分、铃铛 none/fb、连击 none/fc/ab/ab-plus", needsBinding: false },
  // 别名库：社区词汇，读的谁都能读，添加也照命令路径的既有策略对所有人开放。
  // 「添加」要两个参数，按命令路径的空格约定切开（旧竖线写法仍兼容）。
  // **删除刻意不在这里** —— 它只认白名单里的那一个账号，而且只走命令格式，
  // 所以留在各入口的命令路径上（QQ 侧见 aliasDeleteQqs），模型永远碰不到它。
  { name: "aliases", label: "查看某首歌的全部别名", argHint: "曲名、已有别名或 Song ID", needsBinding: false },
  { name: "whatis", label: "按别名或部分曲名查歌", argHint: "别名、部分曲名或 Song ID", needsBinding: false },
  { name: "aliasadd", label: "给歌曲添加别名", argHint: "曲目和别名用空格分开，例如 id870 八爪鱼", needsBinding: false },
  // argHint 里那段约束是防寒暄误触发的：没有它，模型会把「在吗」当成问状态，
  // 回一串运维数据，比人设答一句「好得很」体验差得多。
  { name: "status", label: "机器人当前的运行状态",
    argHint: "不需要参数。只在用户明确问机器人在不在线、是不是掉线了、队列里排了多少、运行了多久时才调用；用户只是打招呼、「在吗」、闲聊寒暄时绝对不要调用",
    needsBinding: false },
  { name: "bind", label: "绑定当前数据源账号的引导", argHint: "不需要参数，不得传邮箱、密码、卡号或验证码", needsBinding: false },
]);

// 少数几处必须写命令的地方，各平台叫法不同（Discord 是 /bind，QQ 是 #绑定）。
// 默认值按 Discord 写，QQ 入口在 start() 里覆盖。
// 值可以是字符串，也可以是**多句说法**的数组 —— 同一个提示反复出现时换着说，
// 免得像系统通知。数组里每句都要自带完整意思（含命令名），测试按共同关键字断言。
let capabilityHints = Object.freeze({
  bindNotice: [
    "唔，你还没把大饼账号交给我呢。执行 `/bind` 把账号给我，我才能帮你翻成绩。",
    "查成绩得先有账号呀 —— 执行 `/bind` 交给我，马上就能用了。",
    "你的绑定还没做哦。执行 `/bind`，之后想查什么我都给你翻出来。",
  ],
  // 查别人：对方没绑定。要说清楚原因，别让人以为是机器人坏了
  targetNotBound: [
    "TA 还没绑定过大饼账号，我手里没有 TA 的数据，查不了。",
    "TA 没绑过账号呀，我上哪儿给 TA 翻成绩去。",
  ],
  helpText: "发送 `/help` 查看 MiaBot 的功能清单。",
  chartInfoUsage: "请在曲名或 Song ID 后写明难度，例如 `id870 master`、`初音ミクの激唱 lunatic`。支持 BASIC / ADVANCED / EXPERT / MASTER / LUNATIC 及常用缩写。",
  levelUsage: "请输入显示等级（如 14、14+）、一位小数定数（如 14.1）或 ABFB。",
  constantUsage: "请输入 0–20 的整数或一位小数，例如 14、14.2。",
  calculateUsage: "请给出定数、技术分、铃铛（none 或 fb）和连击（none / fc / ab / ab-plus），例如 14.2 1000737 fb none。",
  // 以下按 Discord 写默认值，QQ 入口在 start() 里覆盖成 # 命令的说法。
  // 新工具漏配 hint 不会在启动时报错（configureCapabilities 只校验已存在的键），
  // 只会在运行期返回空串 —— 两边入口都必须覆盖。
  aliasUsage: "请把曲目和别名用空格分开，例如 `id870 八爪鱼`；曲目可以是曲名、已有别名或 Song ID。",
  bindUsage: "绑定得单独走一遍流程：执行 `/bind`，我带你填账号。别把邮箱密码发在频道里。",
  statusUnavailable: "我现在没法自查状态，这条功能暂时没开。",
});

function isValidHint(value) {
  if (Array.isArray(value)) return value.length > 0 && value.every((item) => String(item || "").trim());
  return Boolean(String(value || "").trim());
}

// 数组就随机挑一句。刻意用 Math.random：这些文案互不影响逻辑，
// 不需要为了测试可控而给 core 再开一个随机源。
function pickHint(value) {
  if (!Array.isArray(value)) return String(value || "");
  return String(value[Math.floor(Math.random() * value.length)]);
}

// 宿主自己实现的路径（比如 Discord 的斜杠命令）要复用同一批提示文案时用这个
function capabilityHint(name) {
  return pickHint(capabilityHints[name]);
}

function configureCapabilities(options = {}) {
  const merged = { ...capabilityHints, ...options };
  for (const key of Object.keys(merged)) {
    if (!isValidHint(merged[key])) throw new Error("能力提示文案不能为空：" + key);
  }
  capabilityHints = Object.freeze(merged);
}

// 状态文本要读各平台自己的东西（QQ 是 NapCat 连接和队列，Discord 是 client），
// core 拿不到，所以由宿主注册一个取文本的函数。没注册就当作这条能力没开放，
// 不影响其余能力。文案不在这里拼，免得两个平台各写一套措辞。
let statusProvider = null;
function setStatusProvider(fn) {
  if (fn !== null && typeof fn !== "function") throw new Error("状态提供者必须是函数");
  statusProvider = fn;
  return statusProvider;
}

// 宿主的集成测试会替换 core.getBinding / core.generateChart 这类函数（真实账号
// 和真实分表核心跑不了）。这里必须经由 module.exports 取调用目标 —— 直接写函数名
// 拿到的是模块内部引用，替换不掉：命令路径用的是替换后的，聊天路径用的还是原版。
function coreCall(name, ...args) {
  return module.exports[name](...args);
}

// 版本牌子名的唯一解析口，认不出来（含空参数）返回 null。
// 调用方据此把 11 个版本原样列出来 —— 那是**静态公共资料**，ID、日文名、中文名和
// 版本号全在 PLATE_CHOICES 里，跟 /定数表 一样不需要绑定任何人。出图才需要。
function findPlate(query) {
  const needle = normalizeSongQuery(query);
  return needle ? PLATE_CHOICES.find((item) => [item.id, item.nameJa, item.nameZhHans, item.version]
    .some((value) => normalizeSongQuery(value) === needle)) || null : null;
}

function plateChoiceText() {
  return "请选择版本牌子：\n" + PLATE_CHOICES
    .map((item) => item.id + "：" + item.nameJa + "（" + item.nameZhHans + "）/ " + item.version).join("\n");
}

// targetUserId 非空且不是自己时，表示「替群里另一个人查」——取的是对方的数据，
// 所以对方必须绑定过。绑定即视为同意群友查询（2026-09-22 起不再单独开关）。
async function resolveCapability(config, userId, name, query, onLine = () => {}, targetUserId = null) {
  const spec = CAPABILITY_SPECS.find((item) => item.name === name);
  if (!spec) return { kind: "notice", text: "这个功能暂时没有开放。" };
  const q = String(query || "").normalize("NFKC").trim();
  const text = (value) => ({ kind: "text", text: value });
  if (spec.name === "help") return text(pickHint(capabilityHints.helpText));

  // 这道闸**必须在绑定之前**。原先它在绑定之后，于是没绑定的人问「有哪些牌子」
  // 拿到的是 bindNotice（「先去 /绑定」）—— 而他连有哪些版本都还不知道，
  // 那句提示解不了他的题。实测群里问「总共有哪些牌子可以拿」就卡在这里。
  const plate = spec.name === "plate" ? findPlate(q) : null;
  if (spec.name === "plate" && !plate) return text(plateChoiceText());

  let binding = null;
  if (spec.needsBinding) {
    const targetId = targetUserId ? String(targetUserId) : "";
    if (targetId && targetId !== String(userId)) {
      const target = await coreCall("getBinding", config, targetId);
      if (!target) return { kind: "notice", text: pickHint(capabilityHints.targetNotBound) };
      binding = target;
    } else {
      binding = await coreCall("getBinding", config, userId);
      if (!binding) return { kind: "notice", text: pickHint(capabilityHints.bindNotice) };
    }
  }
  const player = binding?.playerName || "玩家";

  if (spec.name === "chart") {
    return {
      kind: "image", key: "chart", label: "正在生成 " + player + " 的分表", failText: "分表生成失败：",
      caption: escapeText(player) + " 的 B50 + N10 + P50 分表",
      run: () => coreCall("generateChart", config, binding, onLine),
    };
  }

  if (spec.name === "plate") {
    // plate 在这里一定是解析好的：认不出来上面就已经返回清单了。
    return {
      kind: "image", key: "plate", label: "正在生成牌子完成度图", failText: "牌子完成度图生成失败：",
      caption: escapeText(player) + " 的 " + plate.nameJa + "（" + plate.nameZhHans + "）完成度 · " + plate.version,
      run: () => coreCall("generateCompletionChart", config, binding, plate, onLine),
    };
  }

  if (spec.name === "song") {
    const matches = searchSongs(q);
    if (matches.length !== 1) {
      return { kind: "lines", header: matches.length ? "找到多首曲目，请用完整 Song ID 明确选择：" : "没有找到曲目。", lines: songMatchLines(matches), footer: "" };
    }
    const song = matches[0];
    return {
      kind: "image", key: "song", label: "正在生成单曲成绩图", failText: "单曲成绩图生成失败：",
      caption: escapeText(player) + " 的单曲全难度成绩：id" + song.id + " " + escapeText(song.name),
      run: () => coreCall("generateSongChart", config, binding, song, onLine),
    };
  }

  if (spec.name === "chartinfo") {
    const result = searchChartInfo(q);
    if (!result.parsed) return text(capabilityHints.chartInfoUsage);
    if (result.matches.length !== 1) {
      return { kind: "lines", header: result.matches.length ? "找到多张谱面，请用完整 Song ID 明确选择：" : "没有找到符合要求的谱面。", lines: chartInfoMatchLines(result.matches), footer: "" };
    }
    const match = result.matches[0];
    return {
      kind: "image", key: "chartinfo", label: "正在生成谱面分析图", failText: "谱面分析图生成失败：",
      caption: "谱面分析：id" + match.song.id + " " + escapeText(match.song.name) + " · " + match.difficultyName,
      run: () => coreCall("generateChartInfo", config, match, onLine),
    };
  }

  if (spec.name === "constant") {
    const token = q.replace(/[^\d.]/g, " ").trim().split(/\s+/).filter(Boolean)[0] || "";
    if (!/^(?:[0-9]|1[0-9]|20)(?:\.[0-9])?$/.test(token) || Number(token) > 20) return text(capabilityHints.constantUsage);
    return {
      kind: "image", key: "constant", label: "正在生成定数表", failText: "定数表生成失败：",
      caption: "音击定数表 · " + token,
      run: async () => {
        const result = await coreCall("runCore", config, "--constant-job-stdin", { query: token, streamOutput: true }, 180000, onLine);
        const match = result.stdout.match(/^CONSTANT_OUTPUT_BASE64:([^:]+):(.+)$/m);
        if (!match) throw new Error("核心未返回定数表图片");
        return { buffer: Buffer.from(match[2], "base64"), name: match[1] };
      },
    };
  }

  if (spec.name === "level") {
    const parts = q.split(/\s+/).filter(Boolean);
    const level = normalizeLevelCommandQuery(parts[0]);
    let page = 1;
    if (parts.length > 1) {
      // 「第2页」这种写法也认，取数字就行
      const digits = parts.slice(1).join("").replace(/\D/g, "");
      if (!digits) return text(capabilityHints.levelUsage);
      page = Number(digits);
    }
    if (!level || !Number.isInteger(page) || page < 1 || page > 99) return text(capabilityHints.levelUsage);
    const target = levelCommandTarget(level);
    return {
      kind: "image", key: "level", label: "正在生成等级成绩图", failText: "等级成绩图生成失败：",
      caption: escapeText(player) + " 的 " + target + " 全谱面成绩 · 第 " + page + " 页",
      run: () => coreCall("generateLevelChart", config, binding, level, page, onLine),
    };
  }

  if (spec.name === "calculate") {
    // 位置参数与自然语序都吃：「14.2 1000737 fb none」和「定数 14.2，技术分 1000737，铃铛 fb，连击 ab+」等价
    const numbers = [...q.replace(/(\d)[,，](\d)/g, "$1$2").matchAll(/\d+(?:\.\d+)?/g)].map((match) => match[0]);
    if (numbers.length < 2) return text(capabilityHints.calculateUsage);
    const bell = /\bfb\b|fb/i.test(q) ? "fb" : "none";
    const combo = /ab\s*\+|abplus/i.test(q) ? "ab-plus" : /\bab\b/i.test(q) ? "ab" : /\bfc\b/i.test(q) ? "fc" : "none";
    try {
      return text(calculateSingleRating(Number(numbers[0]), Number(numbers[1]), bell, combo).text);
    } catch (error) {
      return text(safeError(error));
    }
  }

  // ── 别名库 ────────────────────────────────────────────────────────
  // 命令路径（#添加别名 / /aliasadd）各有自己的实现，这里只服务闲聊路径：
  // 模型给的是一个字符串，「添加」要的两个参数按命令路径的空格约定切开。
  // 删除不在这条链路上，见 CAPABILITY_SPECS 上的说明。
  if (spec.name === "aliases" || spec.name === "whatis") {
    const store = coreCall("getAliasStore");
    if (spec.name === "whatis") {
      const matches = searchSongClues(q);
      return { kind: "lines", header: matches.length ? "匹配到以下曲目：" : "没有找到曲目。", lines: songMatchLines(matches), footer: "" };
    }
    const matches = searchSongs(q);
    if (matches.length !== 1) {
      return { kind: "lines", header: matches.length ? "找到多首曲目，请用完整 Song ID 明确选择：" : "没有找到曲目。", lines: songMatchLines(matches), footer: "" };
    }
    const song = matches[0];
    const list = store.list(song.name, "ongeki");
    return {
      kind: "lines",
      header: songMatchLines([song])[0] + " 的全部别名（" + list.length + " 个）：",
      lines: list.length ? list.map((alias) => "• " + alias) : ["暂未添加别名。"],
      footer: "",
    };
  }

  if (spec.name === "aliasadd") {
    const parsed = parseAliasWriteInput(q);
    if (!parsed) return text(capabilityHints.aliasUsage);
    const matches = searchSongs(parsed.query);
    if (matches.length !== 1) {
      return { kind: "lines", header: matches.length ? "找到多首曲目，请用完整 Song ID 明确选择：" : "没有找到曲目。", lines: songMatchLines(matches), footer: "" };
    }
    const song = matches[0];
    const store = coreCall("getAliasStore");
    let alias;
    try { alias = store.validateAlias(parsed.alias); }
    catch (error) { return text(safeError(error)); }
    const result = store.add({ title: song.name, game: "ongeki", alias, addedBy: userId });
    const shared = INTERNAL_SONGS.filter((other) => other.id !== song.id && store.matches(other.name, normalizeSongQuery(alias), "ongeki", true));
    return text((result.added ? "已添加别名：" : "这首歌已有该别名：") + alias + " → " + songMatchLines([song])[0] +
      (shared.length ? "\n这个别名还对应 " + shared.length + " 首歌。" : ""));
  }

  if (spec.name === "status") {
    const provided = statusProvider ? String(statusProvider() || "").trim() : "";
    return provided ? text(provided) : { kind: "notice", text: pickHint(capabilityHints.statusUnavailable) };
  }

  // 绑定只是把用户引到原来的流程上去，模型经不了手，也传不了任何凭据。
  if (spec.name === "bind") return { kind: "notice", text: pickHint(capabilityHints.bindUsage) };

  return { kind: "notice", text: "这个功能暂时没有开放。" };
}

module.exports = {
  // 常量
  GENERATE_COOLDOWN_MS,
  MAX_QUEUE,
  PLATE_CHOICES,
  LEVEL_CHOICES,
  INTERNAL_SONGS,
  CHART_INFO_DIFFICULTY_NAMES,
  // 日志与错误
  emit,
  safeError,
  // 曲库检索
  normalizeSongQuery,
  normalizeLevelCommandQuery,
  levelCommandTarget,
  searchSongs,
  searchSongClues,
  parseAliasWriteInput,
  parseChartInfoQuery,
  songHasChartDifficulty,
  searchChartInfo,
  songAutocomplete,
  aliasAutocomplete,
  // 别名库
  getAliasStore,
  setAliasStore,
  configureAliases,
  getAliasCandidateStore,
  setAliasCandidateStore,
  resolveAliasTitle,
  // 格式化
  escapeDiscordText,
  configureFormatting,
  chartInfoMatchLines,
  songMatchLines,
  splitLines,
  describeImage,
  // 能力（自然语言工具调用）
  CAPABILITY_SPECS,
  configureCapabilities,
  capabilityHint,
  setStatusProvider,
  resolveCapability,
  // 定数
  calculateBaseRating,
  calculateSingleRating,
  // 配置
  readConfig,
  // 子进程与凭据库
  runProcess,
  vaultCall,
  getBinding,
  saveBinding,
  selectBinding,
  getDataSource,
  setDataSource,
  deleteBinding,
  getRinnetClient,
  personalJob,
  runCore,
  verifyAccount,
  generateChart,
  generateSongChart,
  generateChartInfo,
  generateCompletionChart,
  generateLevelChart,
  // 图片元数据
  pngSize,
};
