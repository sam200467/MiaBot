#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");

const THEME_DIR = path.resolve(__dirname, "..", "..", "..");
const THEMES_ROOT = path.resolve(THEME_DIR, "..");
const EDITOR_DIR = path.join(__dirname, "live-editor");
const CSS_PATH = path.join(THEME_DIR, "renderer", "theme.css");
const THEME_HTML_PATH = path.join(THEME_DIR, "renderer", "theme.html");
const PREVIEW_DATA_PATH = path.join(THEME_DIR, "examples", "preview-data.js");
const THEME_ROUTE = "/chart-info/renderer/theme.html";
const HOST = "127.0.0.1";
const MAX_CSS_BYTES = 2 * 1024 * 1024;

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".otf": "font/otf",
  ".ttf": "font/ttf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

const BROWSER_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  path.join(process.env.LOCALAPPDATA || "", "Microsoft", "Edge", "Application", "msedge.exe"),
];

function send(response, status, body, contentType, headers) {
  response.writeHead(status, Object.assign({
    "Content-Type": contentType || "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  }, headers || {}));
  response.end(body);
}

function sendJson(response, status, value) {
  send(response, status, JSON.stringify(value), "application/json; charset=utf-8");
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    request.on("data", (chunk) => {
      length += chunk.length;
      if (length > MAX_CSS_BYTES) {
        reject(new Error("CSS 内容超过 2MB，已拒绝保存"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function safeStaticPath(urlPath) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath); }
  catch { return null; }
  const target = path.resolve(THEMES_ROOT, decoded.replace(/^\/+/, ""));
  if (target !== THEMES_ROOT && !target.startsWith(THEMES_ROOT + path.sep)) return null;
  return target;
}

function serveFile(response, filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    send(response, 404, "Not found");
    return;
  }
  const extension = path.extname(filePath).toLowerCase();
  send(response, 200, fs.readFileSync(filePath), MIME_TYPES[extension] || "application/octet-stream");
}

function serveThemeHtml(response) {
  const html = fs.readFileSync(THEME_HTML_PATH, "utf8");
  const version = Math.floor(Math.max(
    fs.statSync(THEME_HTML_PATH).mtimeMs,
    fs.statSync(CSS_PATH).mtimeMs,
    fs.statSync(path.join(THEME_DIR, "renderer", "theme.js")).mtimeMs,
  ));
  const result = html
    .replace('href="theme.css"', `href="theme.css?v=${version}"`)
    .replace(
      '<script src="preview-data.js"></script>',
      '<script>window.__LIVE_CSS_EDITOR__ = true;</script>\n  <script src="/__preview_data__.js"></script>',
    )
    .replace('src="theme.js"', `src="theme.js?v=${version}"`);
  send(response, 200, result, "text/html; charset=utf-8");
}

async function handleRequest(request, response) {
  const requestUrl = new URL(request.url || "/", "http://" + HOST);
  const pathname = requestUrl.pathname;

  if (pathname === "/") {
    response.writeHead(302, { Location: "/__editor__/" });
    response.end();
    return;
  }

  if (pathname === "/api/css" && request.method === "GET") {
    send(response, 200, fs.readFileSync(CSS_PATH), "text/css; charset=utf-8");
    return;
  }

  if (pathname === "/api/css" && request.method === "POST") {
    try {
      const css = await readRequestBody(request);
      if (css.includes("\u0000")) throw new Error("CSS 中包含无效的空字符");
      fs.writeFileSync(CSS_PATH, css, "utf8");
      const stat = fs.statSync(CSS_PATH);
      sendJson(response, 200, { ok: true, bytes: Buffer.byteLength(css), modifiedAt: stat.mtime.toISOString() });
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error.message || String(error) });
    }
    return;
  }

  if (pathname === "/api/meta" && request.method === "GET") {
    const stat = fs.statSync(CSS_PATH);
    sendJson(response, 200, {
      canvas: { width: 1800, height: 1200 },
      cssFile: CSS_PATH,
      modifiedAt: stat.mtime.toISOString(),
      experimental: false,
    });
    return;
  }

  if (pathname === "/__preview_data__.js" && request.method === "GET") {
    serveFile(response, PREVIEW_DATA_PATH);
    return;
  }

  if (pathname === THEME_ROUTE && request.method === "GET") {
    serveThemeHtml(response);
    return;
  }

  if (pathname === "/__editor__/" || pathname === "/__editor__/index.html") {
    serveFile(response, path.join(EDITOR_DIR, "index.html"));
    return;
  }

  if (pathname.startsWith("/__editor__/")) {
    const target = path.resolve(EDITOR_DIR, pathname.slice("/__editor__/".length));
    if (target !== EDITOR_DIR && !target.startsWith(EDITOR_DIR + path.sep)) {
      send(response, 403, "Forbidden");
      return;
    }
    serveFile(response, target);
    return;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    send(response, 405, "Method not allowed");
    return;
  }

  const staticPath = safeStaticPath(pathname);
  if (!staticPath) {
    send(response, 403, "Forbidden");
    return;
  }
  serveFile(response, staticPath);
}

function requestedPort() {
  const index = process.argv.indexOf("--port");
  if (index < 0) return 0;
  const value = Number(process.argv[index + 1]);
  return Number.isInteger(value) && value >= 0 && value <= 65535 ? value : 0;
}

function openBrowser(url) {
  if (process.argv.includes("--no-open")) return;
  const browser = BROWSER_CANDIDATES.find((candidate) => candidate && fs.existsSync(candidate));
  if (!browser) {
    console.log("未自动找到 Chrome/Edge，请手动打开：" + url);
    return;
  }
  const child = spawn(browser, [url], { detached: true, stdio: "ignore", windowsHide: false });
  child.unref();
}

const server = http.createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    sendJson(response, 500, { ok: false, error: error.message || String(error) });
  });
});

server.on("error", (error) => {
  console.error("调试器启动失败：" + (error.message || error));
  process.exitCode = 1;
});

server.listen(requestedPort(), HOST, () => {
  const address = server.address();
  const url = "http://" + HOST + ":" + address.port + "/__editor__/";
  console.log("");
  console.log("谱面分析 CSS 实时调试器已启动");
  console.log("地址：" + url);
  console.log("编辑目标：" + CSS_PATH);
  console.log("关闭此窗口或按 Ctrl+C 即可停止。");
  console.log("");
  openBrowser(url);
});

process.on("SIGINT", () => {
  console.log("\n正在关闭调试器……");
  server.close(() => process.exit(0));
});
