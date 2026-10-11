"use strict";

// 本地游戏数据里的谱面文件索引（谱面图用）。
//
// 部署者在配置里填 ongekiChartRoots（一个或多个目录），比如游戏的
// StreamingAssets 目录或单独拷出来的 music 目录。这里递归找形如 0036_03.ogkr 的文件：
// 前半是曲目 ID（与 ongeki-music-internal.json 的 id 一致，前导零不计），后半是难度序号
// 00 BASIC … 03 MASTER，04 LUNATIC。不假设目录层级，A000 / option 包怎么摆都能找到。
// 同一张谱面出现多份时取路径排序靠后的那份（option/A001 之类的更新包排在 A000 之后）。
const fs = require("node:fs");
const path = require("node:path");

const FILE_PATTERN = /^(\d+)_(\d{2})\.ogkr$/i;
const MAX_DEPTH = 10;
const MAX_ENTRIES = 200000;
// 没找到时允许重扫的最短间隔：游戏数据更新后不用重启，但也不至于每条消息都扫一遍硬盘。
const RESCAN_INTERVAL_MS = 60 * 1000;

function normalizeRoots(value) {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return [...new Set(list.map((item) => String(item || "").trim()).filter(Boolean))];
}

function scanRoots(roots) {
  const index = new Map();
  let visited = 0;
  const walk = (dir, depth) => {
    if (depth > MAX_DEPTH || visited > MAX_ENTRIES) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (++visited > MAX_ENTRIES) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full, depth + 1); continue; }
      if (!entry.isFile()) continue;
      const match = FILE_PATTERN.exec(entry.name);
      if (!match) continue;
      const key = chartKey(Number(match[1]), Number(match[2]));
      const previous = index.get(key);
      if (!previous || previous.localeCompare(full) < 0) index.set(key, full);
    }
  };
  for (const root of roots) walk(root, 0);
  return index;
}

function chartKey(songId, position) {
  return songId + "_" + position;
}

function createChartFileIndex(rootsValue, options = {}) {
  const roots = normalizeRoots(rootsValue);
  const now = options.now || Date.now;
  let index = null;
  let scannedAt = 0;
  const rescan = () => { index = scanRoots(roots); scannedAt = now(); return index; };
  return {
    roots,
    // position：0–3 对应 BASIC–MASTER，4 是 LUNATIC
    find(songId, position) {
      if (!roots.length) return null;
      const key = chartKey(Number(songId), Number(position));
      if (!index) rescan();
      if (!index.has(key) && now() - scannedAt >= RESCAN_INTERVAL_MS) rescan();
      return index.get(key) || null;
    },
    get size() { return index ? index.size : 0; },
    rescan,
  };
}

// 按配置缓存一份索引，配置里的目录变了才换新的
let shared = null;
function chartFileIndexFor(config) {
  const roots = normalizeRoots(config?.ongekiChartRoots);
  const signature = roots.join("\n");
  if (!shared || shared.signature !== signature) shared = { signature, index: createChartFileIndex(roots) };
  return shared.index;
}

module.exports = { createChartFileIndex, chartFileIndexFor, normalizeRoots, FILE_PATTERN };
