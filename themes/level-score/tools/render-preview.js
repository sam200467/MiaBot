#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawn } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const renderer = path.join(root, "renderer");
const sample = path.join(root, "examples", "preview-data.js");
const output = path.resolve(process.argv[2] || path.join(root, "previews", "level-score-preview.jpg"));
const previewData = path.join(renderer, "preview-data.js");
const edge = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find(fs.existsSync);
if (!edge) throw new Error("未找到 Microsoft Edge");

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.copyFileSync(sample, previewData);
const port = 9333 + Math.floor(Math.random() * 500);
const userDataDir = path.join(require("node:os").tmpdir(), `level-score-preview-${process.pid}`);
const child = spawn(edge, [
  "--headless=new",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${userDataDir}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-features=msEdgeFirstRunExperience",
  "--allow-file-access-from-files",
  "about:blank",
], { stdio: "ignore", windowsHide: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function json(url, options) {
  const response = await fetch(url, options);
  return response.json();
}

(async () => {
  let socket;
  try {
    let tabs;
    for (let i = 0; i < 80; i += 1) {
      try { tabs = await json(`http://127.0.0.1:${port}/json`); break; } catch { await sleep(100); }
    }
    const target = tabs?.find((item) => item.type === "page" && item.url === "about:blank")
      || tabs?.find((item) => item.type === "page");
    if (!target?.webSocketDebuggerUrl) throw new Error("无法连接 Edge 调试页面");
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    let id = 0;
    const pending = new Map();
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
      }
    };
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const messageId = ++id;
      pending.set(messageId, { resolve, reject });
      socket.send(JSON.stringify({ id: messageId, method, params }));
    });
    await send("Page.enable");
    await send("Runtime.enable");
    await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 3200, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url: pathToFileURL(path.join(renderer, "theme.html")).href });
    let state;
    for (let i = 0; i < 80; i += 1) {
      state = await send("Runtime.evaluate", { expression: "({ready:window.__THEME_READY__===true,error:window.__THEME_ERROR__||null,height:parseFloat(getComputedStyle(document.getElementById('level-sheet')).height),url:location.href,charts:document.querySelectorAll('.chart-card').length})", returnByValue: true });
      state = state.result.value;
      if (state.error) throw new Error(state.error);
      if (state.ready) break;
      await sleep(250);
    }
    if (!state?.ready) throw new Error(`等待主题渲染超时：${JSON.stringify(state)}`);
    const height = Number(state.height);
    await send("Emulation.setDeviceMetricsOverride", { width: 1440, height, deviceScaleFactor: 1, mobile: false });
    const shot = await send("Page.captureScreenshot", { format: "jpeg", quality: 90, fromSurface: true, captureBeyondViewport: false, clip: { x: 0, y: 0, width: 1440, height, scale: 1 } });
    fs.writeFileSync(output, Buffer.from(shot.data, "base64"));
    console.log(output);
  } finally {
    try { socket?.close(); } catch {}
    child.kill();
    await sleep(250);
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(previewData, { force: true }); } catch {}
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
