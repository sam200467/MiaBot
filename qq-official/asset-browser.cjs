"use strict";

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
  const port = Math.max(1, Math.min(65535, Number(options.port) || 47831));
  const log = options.log || (() => {});
  if (!fs.existsSync(assetRoot)) throw new Error("卡面资源目录不存在：" + assetRoot);
  const items = loadIndex(assetRoot);
  if (!items.length) throw new Error("卡面资源索引为空：" + assetRoot);

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
    start: () => new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => { server.off("error", reject); log(`素材检索网页已启动：http://${host}:${port}（${items.length} 项）`); resolve(); });
    }),
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function reply(res, status, type, body) { res.writeHead(status, { "Content-Type": type, "X-Content-Type-Options": "nosniff" }); res.end(body); }
function json(res, value) { reply(res, 200, MIME[".json"], JSON.stringify(value)); }

module.exports = { createAssetBrowser, loadIndex, parseCsv, normalize };
