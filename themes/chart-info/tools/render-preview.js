#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawn } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const renderer = path.join(root, "renderer");
const sample = path.join(root, "examples", "preview-data.js");
const output = path.resolve(process.argv[2] || path.join(root, "previews", "chart-info-preview.png"));
const previewData = path.join(renderer, "preview-data.js");
const browser = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].find(fs.existsSync);
if (!browser) throw new Error("未找到 Chrome 或 Microsoft Edge");

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.copyFileSync(sample, previewData);
const port = 9533 + Math.floor(Math.random() * 400);
const userDataDir = path.join(os.tmpdir(), `chart-info-preview-${process.pid}`);
const child = spawn(browser, [
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
    await send("Emulation.setDeviceMetricsOverride", { width: 1800, height: 1200, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url: pathToFileURL(path.join(renderer, "theme.html")).href });
    let state;
    for (let index = 0; index < 240; index += 1) {
      const result = await send("Runtime.evaluate", { expression: "({ready:window.__THEME_READY__===true,error:window.__THEME_ERROR__||null})", returnByValue: true });
      state = result.result.value;
      if (state.error) throw new Error(state.error);
      if (state.ready) break;
      await sleep(250);
    }
    if (!state?.ready) throw new Error("等待谱面分析主题渲染超时");
    const shot = await send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false, clip: { x: 0, y: 0, width: 1800, height: 1200, scale: 1 } });
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
