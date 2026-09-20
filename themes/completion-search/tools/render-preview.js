#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawn } = require("node:child_process");

const THEME_DIR = path.resolve(__dirname, "..");
const RENDERER_DIR = path.join(THEME_DIR, "renderer");
const DATA_JS_PATH = path.join(RENDERER_DIR, "preview-data.js");
const LOCK_PATH = path.join(RENDERER_DIR, ".preview-render.lock");
const DEFAULT_SAMPLE = path.join(THEME_DIR, "examples", "preview-data.js");
const DEFAULT_OUTPUT = path.join(THEME_DIR, "previews", "completion-search-preview.png");
const WIDTH = 1080;
const HEIGHT = 1920;

const BROWSER_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  path.join(process.env.LOCALAPPDATA || "", "Microsoft", "Edge", "Application", "msedge.exe"),
];

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function findBrowser() {
  const browser = BROWSER_CANDIDATES.find((candidate) => candidate && fs.existsSync(candidate));
  if (!browser) throw new Error("未找到 Chrome 或 Edge，无法生成预览图");
  return browser;
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
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`CDP 错误：${message.error.message}`));
      else pending.resolve(message.result);
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
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ongeki-completion-preview-"));
  const proc = spawn(findBrowser(), [
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
  for (let attempt = 0; attempt < 30 && !target; attempt += 1) {
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
    await sleep(200);
  }
}

function argumentsFromCommandLine() {
  const args = process.argv.slice(2);
  const outputIndex = args.indexOf("--output");
  const sampleIndex = args.indexOf("--sample");
  return {
    outputPath: path.resolve(outputIndex >= 0 && args[outputIndex + 1] ? args[outputIndex + 1] : DEFAULT_OUTPUT),
    samplePath: path.resolve(sampleIndex >= 0 && args[sampleIndex + 1] ? args[sampleIndex + 1] : DEFAULT_SAMPLE),
  };
}

async function main() {
  const { outputPath, samplePath } = argumentsFromCommandLine();
  if (!fs.existsSync(samplePath)) throw new Error(`测试数据不存在：${samplePath}`);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  let lock;
  try {
    lock = fs.openSync(LOCK_PATH, "wx");
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error("完成度主题预览正在生成，请勿并发运行 render-preview.js");
    throw error;
  }
  fs.copyFileSync(samplePath, DATA_JS_PATH);

  let launched;
  let cdp;
  try {
    launched = await launchBrowser();
    cdp = new CDP(launched.wsUrl);
    await cdp.connect();
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: WIDTH,
      height: HEIGHT,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.send("Page.navigate", { url: pathToFileURL(path.join(RENDERER_DIR, "theme.html")).href });
    await waitForRender(cdp);
    const result = await cdp.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
      clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT, scale: 1 },
    });
    fs.writeFileSync(outputPath, Buffer.from(result.data, "base64"));
    const diagnostics = await cdp.evaluate("({groups: document.querySelectorAll('.level-group').length, songs: document.querySelectorAll('.song-tile').length, scale: document.getElementById('level-groups')?.dataset.verticalScale})");
    console.log(`预览图已生成：${outputPath}`);
    console.log(`布局校验：${diagnostics.groups} 个等级、${diagnostics.songs} 首曲目、纵向比例 ${diagnostics.scale}`);
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
    try { if (lock !== undefined) fs.closeSync(lock); } catch {}
    try { fs.rmSync(LOCK_PATH, { force: true }); } catch {}
  }
}

main().catch((error) => {
  console.error(`生成失败：${error?.message || error}`);
  process.exitCode = 1;
});
