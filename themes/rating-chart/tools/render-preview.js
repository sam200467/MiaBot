#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawn } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const THEME_DIR = path.resolve(__dirname, "..");
const RENDERER_DIR = path.join(THEME_DIR, "renderer");
const ASSET_DIR = path.join(THEME_DIR, "assets");
const RATING_PATH = path.join(ROOT, "ongeki-rating.json");
const CATALOG_PATH = path.join(ROOT, "ongeki-song-catalog.json");
const INTERNAL_CATALOG_PATH = path.join(ROOT, "ongeki-music-internal.json");
const DATA_JS_PATH = path.join(RENDERER_DIR, "preview-data.js");
const SAMPLE_DATA_PATH = path.join(THEME_DIR, "examples", "preview-data.js");
const DEFAULT_OUTPUT = path.join(THEME_DIR, "previews", "ongeki-theme-preview.png");
const DEFAULT_AVATAR = "https://u.otogame.net/img/ongeki/icon_proto_1.png";
const COVER_BASE = "https://oss-hd1.bemanicn.com/SDDT/cover/";

const BROWSER_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  path.join(process.env.LOCALAPPDATA || "", "Microsoft", "Edge", "Application", "msedge.exe"),
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readSampleData() {
  const source = fs.readFileSync(SAMPLE_DATA_PATH, "utf8").replace(/^\uFEFF/, "").trim();
  const match = source.match(/^window\.__THEME_DATA__\s*=\s*([\s\S]+);$/);
  if (!match) throw new Error("examples/preview-data.js 格式无效");
  return JSON.parse(match[1]);
}

function findBrowser() {
  const result = BROWSER_CANDIDATES.find((candidate) => candidate && fs.existsSync(candidate));
  if (!result) throw new Error("未找到 Chrome 或 Edge，无法生成预览图");
  return result;
}

function normalizeTitle(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\s　]+/g, " ")
    .trim()
    .toLocaleLowerCase("ja-JP");
}

function chartKey(difficultyId) {
  return ({ 0: "basic", 1: "advanced", 2: "expert", 3: "master", 10: "lunatic" })[Number(difficultyId)];
}

function catalogRows(catalog) {
  if (Array.isArray(catalog)) return catalog;
  for (const key of ["songs", "music", "data", "items", "records"]) {
    if (Array.isArray(catalog?.[key])) return catalog[key];
  }
  throw new Error("无法识别 ongeki-song-catalog.json 的曲目列表结构");
}

function getTitle(song) {
  return song?.meta?.name || song?.title || song?.name || song?.music_name || song?.musicName || "";
}

function getArtist(song) {
  return song?.meta?.artist || song?.artist || song?.composer || song?.music_artist || song?.musicArtist || "";
}

function chartArray(song) {
  for (const key of ["charts", "chart", "difficulties", "level_list", "levels"]) {
    if (Array.isArray(song?.[key])) return song[key];
  }
  return [];
}

function chartDifficulty(chart) {
  const raw = chart?.difficulty ?? chart?.difficulty_id ?? chart?.difficultyId ?? chart?.type ?? chart?.name;
  if (typeof raw === "number") return chartKey(raw);
  return String(raw || "").trim().toLowerCase().replace(/re[:_-]?master/, "lunatic");
}

function chartConstant(chart) {
  for (const key of ["constant", "chart_constant", "chartConstant", "ds", "const", "level_decimal", "levelDecimal"]) {
    const value = Number(chart?.[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  const rawLevel = chart?.level;
  const value = Number(rawLevel);
  if (Number.isFinite(value) && value > 0 && value < 20) return value;
  return null;
}

function directConstant(song, key) {
  const aliases = [
    `${key}_constant`, `${key}Constant`, `${key}_const`, `${key}Const`, `${key}_ds`, `${key}Ds`,
  ];
  for (const alias of aliases) {
    const value = Number(song?.[alias]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

function buildCatalogIndex(catalog, internalRows) {
  const supplementByTitle = new Map();
  for (const song of catalogRows(catalog)) {
    const title = normalizeTitle(getTitle(song));
    if (!title) continue;
    if (!supplementByTitle.has(title)) supplementByTitle.set(title, []);
    supplementByTitle.get(title).push(song);
  }

  const internalById = new Map();
  const internalByTitle = new Map();
  for (const song of internalRows) {
    const id = Number(song?.id);
    const title = normalizeTitle(song?.name);
    if (Number.isInteger(id) && id > 0) internalById.set(id, song);
    if (!title) continue;
    if (!internalByTitle.has(title)) internalByTitle.set(title, []);
    internalByTitle.get(title).push(song);
  }
  return { supplementByTitle, internalById, internalByTitle };
}

function findSong(index, title, artist, difficultyId) {
  const candidates = index.supplementByTitle.get(normalizeTitle(title)) || [];
  if (candidates.length <= 1) return candidates[0] || null;
  const artistKey = normalizeTitle(artist);
  const artistMatch = candidates.find((song) => normalizeTitle(getArtist(song)) === artistKey);
  if (artistMatch) return artistMatch;
  const key = chartKey(difficultyId);
  return candidates.find((song) => chartArray(song).some((chart) => chartDifficulty(chart) === key)) || candidates[0];
}

function getInternalConstant(song, difficultyId) {
  const position = ({ 0: 0, 1: 1, 2: 2, 3: 3, 10: 4 })[Number(difficultyId)];
  if (!song || position === undefined || !Array.isArray(song.const)) return null;
  const raw = song.const[position];
  if (raw === null || raw === undefined || raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function findInternalSong(index, item, title, artist, difficultyId) {
  const itemMusicId = Number(item?.music_id ?? item?.musicId ?? item?.song_id ?? item?.songId);
  if (Number.isInteger(itemMusicId) && itemMusicId > 0) {
    const exact = index.internalById.get(itemMusicId);
    if (getInternalConstant(exact, difficultyId) !== null) return exact;
  }

  const candidates = index.internalByTitle.get(normalizeTitle(title)) || [];
  const withChart = candidates.filter((song) => getInternalConstant(song, difficultyId) !== null);
  if (withChart.length <= 1) return withChart[0] || null;
  const artistKey = normalizeTitle(artist);
  return withChart.find((song) => normalizeTitle(song?.artistName) === artistKey) || withChart[0];
}

function getConstant(song, difficultyId) {
  const key = chartKey(difficultyId);
  if (!song || !key) return null;
  const compactKey = ({ basic: "BAS", advanced: "ADV", expert: "EXP", master: "MAS", lunatic: "LUN" })[key];
  const compactValue = Number(song?.[compactKey]?.const);
  if (Number.isFinite(compactValue) && compactValue > 0) return compactValue;
  const chart = chartArray(song).find((item) => chartDifficulty(item) === key);
  return chartConstant(chart) ?? directConstant(song, key);
}

function mapRatingItem(item, catalogIndex) {
  const music = item?.music || {};
  const title = music.name || item.music_name || item.title || "未命名曲目";
  const artist = music.artist || item.artist || "";
  const difficultyId = Number(item.difficulty_id ?? music?.level_info?.difficulty ?? 3);
  const song = findSong(catalogIndex, title, artist, difficultyId);
  const internalSong = findInternalSong(catalogIndex, item, title, artist, difficultyId);
  const constant = getInternalConstant(internalSong, difficultyId) ?? getConstant(song, difficultyId);
  if (!Number.isFinite(constant)) {
    throw new Error(`曲目“${title}”的 ${chartKey(difficultyId) || difficultyId} 定数未找到，已中止生成`);
  }
  const coverId = music.music_id || item.resource_id || item.music_resource_id;
  if (!coverId) throw new Error(`曲目“${title}”缺少曲绘资源 ID，已中止生成`);

  return {
    title,
    artist,
    difficulty_id: difficultyId,
    constant,
    score: Number(item.score || 0),
    rating: Number(item.rating || 0),
    isAllBreak: Boolean(item.is_all_break),
    isFullCombo: Boolean(item.is_full_combo),
    isFullBell: Boolean(item.is_full_bell),
    platinumScoreStar: Number(item.platinum_score_star || 0),
    platinumScoreMax: Number(item.platinum_score_max || 0),
    platinumScoreTheory: Number(item.platinum_score_theory || 0),
    jacketUrl: `${COVER_BASE}${encodeURIComponent(coverId)}.webp-thumbnail`,
  };
}

function unwrapRating(payload) {
  const root = payload?.data && typeof payload.data === "object" ? payload.data : payload;
  const firstArray = (...keys) => {
    for (const key of keys) if (Array.isArray(root?.[key])) return root[key];
    return [];
  };
  return {
    root,
    best: firstArray("best", "b50", "best_rating_list", "best_list", "bestList"),
    new: firstArray("new", "n10", "best_new_rating_list", "new_list", "newList"),
    platinum: firstArray("platinum", "p50", "p_score_rating_list", "platinum_list", "platinumList"),
  };
}

function buildPreviewData() {
  if (!fs.existsSync(path.join(ASSET_DIR, "overlay.png"))) throw new Error("缺少 themes/rating-chart/assets/overlay.png");
  if (!fs.existsSync(RATING_PATH)) {
    if (!fs.existsSync(SAMPLE_DATA_PATH)) throw new Error("缺少 ongeki-rating.json 和 examples/preview-data.js");
    console.log("未找到 ongeki-rating.json，使用 examples/preview-data.js 生成视觉预览");
    return readSampleData();
  }
  const ratingPayload = readJson(RATING_PATH);
  const catalog = readJson(CATALOG_PATH);
  const internalRows = readJson(INTERNAL_CATALOG_PATH);
  if (!Array.isArray(internalRows) || !internalRows.length) throw new Error("完整内部曲库为空");
  const catalogIndex = buildCatalogIndex(catalog, internalRows);
  const { root, best, new: newest, platinum } = unwrapRating(ratingPayload);

  const mapAll = (items) => items.map((item) => mapRatingItem(item, catalogIndex));
  return {
    generatedAt: new Date().toISOString(),
    generatorName: "Takase bot",
    profile: {
      // 这里只是离线视觉预览。正式接入时由 /api/game/ongeki/profile 的真实字段覆盖。
      playerName: "DEMO PLAYER",
      level: 49,
      playCount: 100,
      // 离线预览固定值；正式接入后必须由个人档案的 lastPlayDate 覆盖。
      lastPlayTime: "2026-01-01    12:00:00",
      avatarUrl: DEFAULT_AVATAR,
    },
    summary: {
      rating: Number(root.rating || 0),
      bestRating: Number(root.best_rating ?? root.bestRating ?? 0),
      bestNewRating: Number(root.best_new_rating ?? root.bestNewRating ?? 0),
      pScoreRating: Number(root.p_score_rating ?? root.pScoreRating ?? 0),
    },
    best: mapAll(best),
    new: mapAll(newest),
    platinum: mapAll(platinum),
  };
}

class CDP {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.sequence = 0;
    this.pending = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", () => reject(new Error("无法连接浏览器调试端口")), { once: true });
    });
    this.ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !this.pending.has(message.id)) return;
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(`CDP 错误：${message.error.message}`));
      else resolve(message.result);
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "页面脚本执行失败");
    }
    return result.result?.value;
  }

  close() {
    try { this.ws?.close(); } catch {}
  }
}

async function launchBrowser() {
  const browser = findBrowser();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ongeki-theme-preview-"));
  const proc = spawn(browser, [
    "--headless=new",
    `--user-data-dir=${userDataDir}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=msEdgeFirstRunExperience",
    "--disable-popup-blocking",
    "--allow-file-access-from-files",
    "about:blank",
  ], { stdio: "ignore", windowsHide: true });

  const portPath = path.join(userDataDir, "DevToolsActivePort");
  const deadline = Date.now() + 30000;
  while (!fs.existsSync(portPath) && Date.now() < deadline) await sleep(200);
  if (!fs.existsSync(portPath)) {
    try { proc.kill(); } catch {}
    throw new Error("浏览器启动失败：未获得调试端口");
  }
  const port = Number(fs.readFileSync(portPath, "utf8").split(/\r?\n/)[0]);
  let target = null;
  for (let i = 0; i < 30 && !target; i++) {
    await sleep(200);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await response.json();
      target = list.find((item) => item.type === "page");
    } catch {}
  }
  if (!target) throw new Error("浏览器启动失败：无法连接渲染页面");
  return { proc, userDataDir, wsUrl: target.webSocketDebuggerUrl };
}

async function waitForRender(cdp, timeoutMs = 120000) {
  const started = Date.now();
  for (;;) {
    const state = await cdp.evaluate("({ready: window.__THEME_READY__ === true, error: window.__THEME_ERROR__ || null})");
    if (state?.error) throw new Error(state.error);
    if (state?.ready) return;
    if (Date.now() - started > timeoutMs) throw new Error("等待主题图片与字体加载超时");
    await sleep(250);
  }
}

async function main() {
  const outputPath = path.resolve(process.argv[2] || DEFAULT_OUTPUT);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const data = buildPreviewData();
  fs.writeFileSync(DATA_JS_PATH, `window.__THEME_DATA__ = ${JSON.stringify(data, null, 2)};\n`, "utf8");

  let launched;
  let cdp;
  try {
    launched = await launchBrowser();
    cdp = new CDP(launched.wsUrl);
    await cdp.connect();
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 3600,
      height: 1800,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.send("Page.navigate", { url: pathToFileURL(path.join(RENDERER_DIR, "theme.html")).href });
    await waitForRender(cdp);
    const result = await cdp.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
      clip: { x: 0, y: 0, width: 3600, height: 1800, scale: 1 },
    });
    fs.writeFileSync(outputPath, Buffer.from(result.data, "base64"));
    console.log(`预览图已生成：${outputPath}`);
    console.log(`B50=${data.best.length}，N10=${data.new.length}，P50=${data.platinum.length}`);
  } finally {
    cdp?.close();
    if (launched?.proc?.pid) {
      try { spawn("taskkill", ["/pid", String(launched.proc.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); } catch {}
    }
    if (launched?.userDataDir) {
      await sleep(500);
      try { fs.rmSync(launched.userDataDir, { recursive: true, force: true }); } catch {}
    }
    try { fs.rmSync(DATA_JS_PATH, { force: true }); } catch {}
  }
}

main().catch((error) => {
  console.error(`生成失败：${error?.message || error}`);
  process.exitCode = 1;
});
