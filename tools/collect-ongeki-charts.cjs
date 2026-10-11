#!/usr/bin/env node
"use strict";

// 把本机游戏数据里的谱面文件（.ogkr）收集到一个平铺的文件夹，拿去给没有装游戏的服务器用。
//
//   node tools/collect-ongeki-charts.cjs <游戏目录> [更多目录…] --out <输出目录>
//
// 例：node tools/collect-ongeki-charts.cjs E:\ "D:\SDDT\option" --out D:\ongeki-charts
//
// 递归查找形如 0036_03.ogkr 的文件（曲目 ID_难度号，LUNATIC 是 10），按 ID 补零到 4 位平铺到输出目录。
// 同一张谱面有多份时取 option 包号最大的那份，和机器人的查找规则一致。
// 本体谱面通常在 HDD 里的 .vhd 镜像中，要先挂载，再把挂载出来的盘符一起传进来。
// 只拷谱面，不碰其他游戏文件。输出目录里的谱面属于游戏数据，不要提交进仓库或公开分发。
const fs = require("node:fs");
const path = require("node:path");
const { FILE_PATTERN, preferChartFile, chartFileName } = require("../ongeki-chart-files.cjs");

const MAX_BYTES = 4 * 1024 * 1024;   // 与 /谱面图 读取上限一致
const DIFFICULTIES = ["BASIC", "ADVANCED", "EXPERT", "MASTER", "LUNATIC"];
const FILE_DIFFICULTY = [0, 1, 2, 3, 10];   // 曲库 level 数组下标 -> 文件里的难度号

const args = process.argv.slice(2);
const outAt = args.indexOf("--out");
const out = outAt >= 0 ? args[outAt + 1] : "";
const roots = args.filter((_, i) => i !== outAt && i !== outAt + 1);
if (!out || !roots.length) {
  console.error("用法：node tools/collect-ongeki-charts.cjs <游戏目录> [更多目录…] --out <输出目录>");
  process.exit(2);
}
const outDir = path.resolve(out);
for (const root of roots) {
  const full = path.resolve(root);
  if (!fs.existsSync(full)) { console.error("目录不存在：" + full); process.exit(2); }
  if (outDir === full || outDir.startsWith(full + path.sep)) {
    console.error("输出目录不能放在游戏目录里面：" + outDir);
    process.exit(2);
  }
}

const found = new Map();      // "36_3" / "8003_10" -> 源文件
const unmatched = [];         // 扩展名是 .ogkr 但文件名对不上的
const tooLarge = [];
let scanned = 0;
const walk = (dir) => {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(full); continue; }
    if (!entry.isFile()) continue;
    scanned++;
    if (!/\.ogkr$/i.test(entry.name)) continue;
    const match = FILE_PATTERN.exec(entry.name);
    if (!match) { unmatched.push(full); continue; }
    if (fs.statSync(full).size > MAX_BYTES) { tooLarge.push(full); continue; }
    const key = Number(match[1]) + "_" + Number(match[2]);
    if (preferChartFile(found.get(key), full)) found.set(key, full);
  }
};
for (const root of roots) walk(path.resolve(root));

console.log(`扫描了 ${scanned} 个文件，找到 ${found.size} 张谱面。`);
if (unmatched.length) {
  console.log(`另有 ${unmatched.length} 个 .ogkr 文件名不是「曲目ID_难度序号.ogkr」的形式，没有收集，例如：`);
  for (const file of unmatched.slice(0, 5)) console.log("  " + file);
}
if (tooLarge.length) console.log(`${tooLarge.length} 个文件超过 4 MB，跳过：${tooLarge.slice(0, 3).join("、")}`);
if (!found.size) {
  console.log("一张谱面都没找到。请确认目录选对了（游戏的 package 目录、挂载出来的 .vhd 盘符或 option 目录），");
  console.log("或者在游戏目录里搜一下 *.ogkr，把找到的路径和文件名发给开发者。");
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
let bytes = 0;
for (const [key, source] of found) {
  const [id, difficulty] = key.split("_");
  const target = path.join(outDir, chartFileName(id, difficulty));
  fs.copyFileSync(source, target);
  bytes += fs.statSync(target).size;
}
console.log(`已拷到 ${outDir}，共 ${(bytes / 1024 / 1024).toFixed(1)} MB。`);

// 对一下本地曲库：曲库里有、却没找到文件的谱面，/谱面图 会回复「没有找到谱面文件」
try {
  const songs = require("../ongeki-music-internal.json");
  const missing = [];
  let expected = 0;
  for (const song of songs) {
    if (["unavailable", "deleted", "removed"].includes(String(song.status || "").toLowerCase())) continue;
    (song.level || []).forEach((level, position) => {
      if (level == null || String(level).trim() === "" || String(level) === "-") return;
      expected++;
      if (!found.has(song.id + "_" + FILE_DIFFICULTY[position])) missing.push(`id${song.id} ${song.name} ${DIFFICULTIES[position]}`);
    });
  }
  console.log(`本地曲库在线谱面 ${expected} 张，其中 ${expected - missing.length} 张找到了文件。`);
  if (missing.length) {
    console.log(`缺 ${missing.length} 张，例如：`);
    for (const line of missing.slice(0, 8)) console.log("  " + line);
  }
} catch {}
