#!/usr/bin/env node
"use strict";

// 本地预览：把一份 .ogkr 渲染成 PNG。
//   node themes/ongeki-chart/tools/render-preview.js <谱面.ogkr> [输出.png] [--id 36] [--difficulty 3]
// 文件名形如 0036_03.ogkr 时，Song ID 和难度会自动从文件名推出，曲名等信息取自 ongeki-music-internal.json。
// 浏览器：Windows 上找 Chrome / Edge；其他平台可用环境变量 CHROME_PATH 指定。

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawn } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const renderer = path.join(root, "renderer");
const previewData = path.join(renderer, "preview-data.js");
const internalSongs = require("../../../ongeki-music-internal.json");

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(name);
  if (at < 0) return null;
  const [, value] = args.splice(at, 2);
  return value;
};
const songIdFlag = flag("--id");
const difficultyFlag = flag("--difficulty");
const [input, outputArg] = args;
if (!input) {
  console.error("用法：node themes/ongeki-chart/tools/render-preview.js <谱面.ogkr> [输出.png] [--id 36] [--difficulty 3]");
  process.exit(2);
}
const output = path.resolve(outputArg || path.join(root, "previews", path.basename(input, path.extname(input)) + ".png"));

// 文件名里的难度序号：00 BASIC … 03 MASTER，04 LUNATIC（主题里 LUNATIC 的 difficultyId 是 10）
const nameMatch = path.basename(input).match(/(\d+)_(\d{2})\.ogkr$/i);
const songId = Number(songIdFlag ?? nameMatch?.[1]);
const position = difficultyFlag != null ? Number(difficultyFlag) : Number(nameMatch?.[2] ?? 3);
const difficultyId = position === 4 ? 10 : position;
const song = internalSongs.find((item) => item.id === songId);

const data = {
  song: {
    songId: song?.id ?? (Number.isFinite(songId) ? songId : null),
    title: song?.name || path.basename(input),
    artist: song?.artistName || "",
    jacketUrl: "",
  },
  chart: {
    difficultyId,
    level: song?.level?.[position] && song.level[position] !== "-" ? String(song.level[position]) : "",
    constant: song?.const?.[position] > 0 ? song.const[position] : null,
    designer: song?.creator?.[position] || "",
    noteCount: song?.noteTotal?.[position] || null,
    bellCount: song?.bellTotal?.[position] || null,
  },
  ogkr: fs.readFileSync(input, "utf8"),
};

const browser = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find((file) => file && fs.existsSync(file));
if (!browser) throw new Error("未找到 Chrome 或 Microsoft Edge（可用 CHROME_PATH 指定）");

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(previewData, `window.__THEME_DATA__ = ${JSON.stringify(data)};\n`, "utf8");
const port = 9533 + Math.floor(Math.random() * 400);
const userDataDir = path.join(os.tmpdir(), `ongeki-chart-preview-${process.pid}`);
const child = spawn(browser, [
  "--headless=new",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${userDataDir}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-features=msEdgeFirstRunExperience",
  "--allow-file-access-from-files",
  // Linux 下以 root 运行（容器里常见）时 Chrome 不开沙箱就起不来
  ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []),
  "about:blank",
], { stdio: "ignore", windowsHide: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  let socket;
  try {
    let tabs;
    for (let index = 0; index < 100; index += 1) {
      try { tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; }
      catch { await sleep(100); }
    }
    const target = tabs?.find((item) => item.type === "page" && item.url === "about:blank") || tabs?.find((item) => item.type === "page");
    if (!target?.webSocketDebuggerUrl) throw new Error("无法连接浏览器调试页面");
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    let id = 0;
    const pending = new Map();
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (!message.id || !pending.has(message.id)) return;
      const task = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) task.reject(new Error(message.error.message));
      else task.resolve(message.result);
    };
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const messageId = ++id;
      pending.set(messageId, { resolve, reject });
      socket.send(JSON.stringify({ id: messageId, method, params }));
    });
    await send("Page.enable");
    await send("Runtime.enable");
    await send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url: pathToFileURL(path.join(renderer, "theme.html")).href });
    let state;
    for (let index = 0; index < 240; index += 1) {
      const result = await send("Runtime.evaluate", {
        expression: "({ready:window.__THEME_READY__===true,error:window.__THEME_ERROR__||null,size:window.__THEME_SIZE__||null})",
        returnByValue: true,
      });
      state = result.result.value;
      if (state.error) throw new Error(state.error);
      if (state.ready) break;
      await sleep(250);
    }
    if (!state?.ready) throw new Error("等待谱面图主题渲染超时");
    const { width, height } = state.size;
    // 和核心一样按最多 2 倍像素截图，单边不超过 16000
    const scale = Math.min(2, 16000 / width, 16000 / height);
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile: false });
    await sleep(100);
    const jpeg = /\.jpe?g$/i.test(output);
    const shot = await send("Page.captureScreenshot", { format: jpeg ? "jpeg" : "png", ...(jpeg ? { quality: 92 } : {}), fromSurface: true, captureBeyondViewport: true, clip: { x: 0, y: 0, width, height, scale: 1 } });
    fs.writeFileSync(output, Buffer.from(shot.data, "base64"));
    console.log(`${output}（${Math.round(width * scale)}×${Math.round(height * scale)}，${Math.round(fs.statSync(output).size / 1024)} KB）`);
  } finally {
    try { socket?.close(); } catch {}
    child.kill();
    await sleep(250);
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(previewData, { force: true }); } catch {}
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
