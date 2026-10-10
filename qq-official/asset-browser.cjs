"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");

const SITE_DIR = path.join(__dirname, "asset-browser-site");
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".png": "image/png", ".json": "application/json; charset=utf-8" };

function parseCsv(text) {
  const rows = []; let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n") { row.push(field.replace(/\r$/, "")); rows.push(row); row = []; field = ""; }
    else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const headers = (rows.shift() || []).map((x) => x.replace(/^\uFEFF/, ""));
  return rows.filter((x) => x.some(Boolean)).map((values) => Object.fromEntries(headers.map((key, i) => [key, values[i] || ""])));
}

// 成绩图有 PNG 也有 JPG（/等级 出的是 JPG，2026-10-10 线上日志）。按文件头认，认不出返回 null。
// 尺寸：PNG 读 IHDR；JPG 找 SOF 段（C0–CF，除了 C4 DHT、C8、CC DAC）。
function imageInfo(buffer) {
  const data = Buffer.isBuffer(buffer) ? buffer : null;
  if (!data || data.length < 24) return null;
  if (data.readUInt32BE(0) === 0x89504e47 && data.toString("ascii", 12, 16) === "IHDR") {
    return { type: "png", mime: "image/png", width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  if (data[0] === 0xff && data[1] === 0xd8) {
    let i = 2;
    while (i + 9 < data.length) {
      if (data[i] !== 0xff) { i++; continue; }
      const marker = data[i + 1];
      if (marker === 0xff) { i++; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const length = data.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { type: "jpg", mime: "image/jpeg", width: data.readUInt16BE(i + 7), height: data.readUInt16BE(i + 5) };
      }
      if (marker === 0xd9 || marker === 0xda) return null;   // 到了图像数据还没见到 SOF
      i += 2 + length;
    }
  }
  return null;
}

function normalize(value) { return String(value || "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim(); }
function isInside(root, target) { const rel = path.relative(root, target); return rel && !rel.startsWith("..") && !path.isAbsolute(rel); }
function mediaUrl(parts, file) {
  const stat = fs.statSync(file);
  const version = `${Math.trunc(stat.mtimeMs).toString(36)}-${stat.size.toString(36)}`;
  return "/media/" + parts.map(encodeURIComponent).join("/") + `?v=${version}`;
}

function loadIndex(assetRoot) {
  const items = [];
  for (const setName of ["base-cards", "option-cards"]) {
    const csvPath = path.join(assetRoot, setName, "cards.csv");
    if (!fs.existsSync(csvPath)) continue;
    for (const row of parseCsv(fs.readFileSync(csvPath, "utf8"))) {
      if (!row.output_file || !fs.existsSync(path.join(assetRoot, setName, row.output_file))) continue;
      if ((Number(row.width) || 0) <= 2 && (Number(row.height) || 0) <= 2) continue;
      const item = {
        kind: "cards", id: row.id, name: row.name, characterName: row.character_name,
        rarity: row.rarity, attribute: row.attribute, package: row.package,
        visual: row.visual, width: Number(row.width) || 0, height: Number(row.height) || 0,
        media: "/media/" + [setName, ...row.output_file.replace(/\\/g, "/").split("/")].map(encodeURIComponent).join("/"),
      };
      item.search = normalize([item.id, item.name, item.characterName, item.rarity, item.attribute, item.package].join(" "));
      items.push(item);
    }
  }
  const expressionPath = path.join(assetRoot, "expressions", "expressions.json");
  if (fs.existsSync(expressionPath)) {
    for (const row of JSON.parse(fs.readFileSync(expressionPath, "utf8"))) {
      const file = path.join(assetRoot, "expressions", row.output_file || "");
      if (!row.output_file || !fs.existsSync(file)) continue;
      const item = {
        kind: "expressions", id: String(row.modelId || ""), name: row.expression || "",
        characterName: row.characterName || "", rarity: "", attribute: "", package: row.bundle || "",
        visual: "expression", width: Number(row.width) || 0, height: Number(row.height) || 0,
        media: mediaUrl(["expressions", ...row.output_file.replace(/\\/g, "/").split("/")], file),
      };
      item.search = normalize([item.id, item.name, item.characterName, item.package].join(" "));
      items.push(item);
    }
  }
  return items;
}

function createAssetBrowser(options = {}) {
  const assetRoot = path.resolve(options.assetRoot || "");
  const host = String(options.host || "127.0.0.1");
  // port 写 0 是测试用的：让系统挑空闲端口，起来之后用 port() 读实际的。
  const port = options.port === 0 ? 0 : Math.max(1, Math.min(65535, Number(options.port) || 47831));
  const log = options.log || (() => {});
  if (!fs.existsSync(assetRoot)) throw new Error("卡面资源目录不存在：" + assetRoot);
  const items = loadIndex(assetRoot);
  if (!items.length) throw new Error("卡面资源索引为空：" + assetRoot);

  // ── 临时图片（/shared/<随机串>.png 或 .jpg）──────────────────────────
  // 给 QQ 的 Markdown 引用：Markdown 里的图只能写网址，而美亚的成绩图是程序刚画的、没有网址。
  // 放在内存里：地址是 32 位随机串，猜不到；24 小时后作废；最多留 SHARED_MAX 张，多了先丢最旧的。
  // QQ 什么时候来取图（发送时一次，还是每次有人看都来）没法确认，所以留得久一点。
  const SHARED_TTL_MS = Number(options.sharedTtlMs) || 24 * 60 * 60 * 1000;
  const SHARED_MAX = Number(options.sharedMax) || 30;
  const shared = new Map();   // token -> { buffer, mime, expiry }
  const now = options.now || Date.now;
  const publicBase = String(options.publicBaseUrl || "").replace(/\/+$/, "");
  function pruneShared() {
    for (const [token, entry] of shared) if (entry.expiry <= now()) shared.delete(token);
    while (shared.size > SHARED_MAX) shared.delete(shared.keys().next().value);
  }
  // 返回 { url, width, height }；没配 publicBaseUrl、或者不是认得的 PNG/JPG，返回 null。
  function publishImage(buffer) {
    const info = imageInfo(buffer);
    if (!publicBase || !info) return null;
    const token = crypto.randomBytes(16).toString("hex");
    shared.set(token, { buffer, mime: info.mime, expiry: now() + SHARED_TTL_MS });
    pruneShared();
    return { url: publicBase + "/shared/" + token + "." + info.type, width: info.width, height: info.height };
  }

  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url || "/", "http://localhost");
      if (url.pathname === "/api/items") {
        const kind = url.searchParams.get("view") === "expressions" ? "expressions" : "cards";
        const query = normalize(url.searchParams.get("q"));
        const visual = normalize(url.searchParams.get("visual"));
        const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
        const limit = Math.max(1, Math.min(120, Number(url.searchParams.get("limit")) || 48));
        const matches = items.filter((item) => item.kind === kind && (!visual || item.visual === visual) && (!query || item.search.includes(query)));
        return json(res, { total: matches.length, offset, items: matches.slice(offset, offset + limit).map(({ search, ...item }) => item) });
      }
      const sharedMatch = url.pathname.match(/^\/shared\/([0-9a-f]{32})\.(?:png|jpg)$/);
      if (sharedMatch) {
        pruneShared();
        const entry = shared.get(sharedMatch[1]);
        if (!entry) return reply(res, 404, "text/plain; charset=utf-8", "Not found");
        res.writeHead(200, { "Content-Type": entry.mime, "Cache-Control": "public, max-age=86400", "X-Content-Type-Options": "nosniff" });
        return res.end(entry.buffer);
      }
      if (url.pathname.startsWith("/media/")) {
        const segments = url.pathname.slice(7).split("/").map(decodeURIComponent);
        const target = path.resolve(assetRoot, ...segments);
        if (!isInside(assetRoot, target) || !fs.existsSync(target) || !fs.statSync(target).isFile()) return reply(res, 404, "text/plain; charset=utf-8", "Not found");
        res.writeHead(200, { "Content-Type": MIME[path.extname(target).toLowerCase()] || "application/octet-stream", "Cache-Control": "public, max-age=86400" });
        return fs.createReadStream(target).pipe(res);
      }
      const relative = ["/", "/cards", "/expressions"].includes(url.pathname) ? "index.html" : url.pathname.slice(1);
      const target = path.resolve(SITE_DIR, relative);
      if (!isInside(SITE_DIR, target) || !fs.existsSync(target) || !fs.statSync(target).isFile()) return reply(res, 404, "text/plain; charset=utf-8", "Not found");
      return reply(res, 200, MIME[path.extname(target).toLowerCase()] || "application/octet-stream", fs.readFileSync(target));
    } catch (error) {
      log("素材网页请求失败：" + (error?.message || error));
      return reply(res, 500, "text/plain; charset=utf-8", "Internal error");
    }
  });
  return {
    items,
    publishImage,
    port: () => server.address()?.port,
    start: () => new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => { server.off("error", reject); log(`素材检索网页已启动：http://${host}:${port}（${items.length} 项）`); resolve(); });
    }),
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function reply(res, status, type, body) { res.writeHead(status, { "Content-Type": type, "X-Content-Type-Options": "nosniff" }); res.end(body); }
function json(res, value) { reply(res, 200, MIME[".json"], JSON.stringify(value)); }

module.exports = { createAssetBrowser, loadIndex, parseCsv, normalize, imageInfo };
