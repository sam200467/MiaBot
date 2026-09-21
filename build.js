#!/usr/bin/env node
/**
 * 构建脚本：生成 GUI 版音击小工具 v3.0.exe
 *
 * 流程：
 *   1. 注入朋友脚本 → 自包含 ongenki-exe.js
 *   2. Node SEA → ongenki-core.exe（自动化核心）
 *   3. csc 编译 gui.cs → 音击小工具 v3.0.exe（WinForms 界面，内嵌核心）
 *
 * 用法：node build.js
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execSync, execFileSync } = require("node:child_process");

const DIR = __dirname;
const FRIEND_SCRIPT = path.join(DIR, "reiwa-ongeki-from-otogame-rating-json.js");
const TEMPLATE = path.join(DIR, "app-template.js");
const GENERATED = path.join(DIR, "ongeki-exe.js");
// undici（代理支持）需要由 esbuild 打包进单文件；SEA 环境不提供 node:undici 内置模块
const BUNDLED = path.join(DIR, "ongeki-bundle.cjs");
const SEA_CONFIG = path.join(DIR, "sea-config.json");
const BLOB = path.join(DIR, "sea-prep.blob");
const CORE = path.join(DIR, "ongeki-core.exe");
const GUI_SRC = path.join(DIR, "gui.cs");
const GUI_EXE = path.join(DIR, "音击小工具 v3.0.exe");
const GUI_ICON = path.join(DIR, "ongeki-icon.ico");
const INTERNAL_SONGS = path.join(DIR, "ongeki-music-internal.json");
const SUPPLEMENTAL_SONGS = path.join(DIR, "ongeki-song-catalog.json");
const SDDT_EXTRAS = path.join(DIR, "ongeki-sddt-extras.json");
const THEME_ROOT = path.join(DIR, "themes");
const JACKET_FALLBACK_DIR = path.join(DIR, "jacket-fallback");
const CSC = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";

function step(msg) {
  console.log("== " + msg);
}

step("1/5 注入朋友脚本，生成 ongenki-exe.js");
const friend = fs.readFileSync(FRIEND_SCRIPT, "utf8");
if (!friend.includes("window.openOtogameRatingJsonToReiwaOngeki")) {
  throw new Error("朋友脚本内容异常，缺少 window.openOtogameRatingJsonToReiwaOngeki");
}
const template = fs.readFileSync(TEMPLATE, "utf8");
const marker = '"__FRIEND_SCRIPT_JSON__"';
if (!template.includes(marker)) throw new Error("模板中未找到注入标记 " + marker);
const themeMarker = '"__THEME_BUNDLE_JSON__"';
const themeHashMarker = '"__THEME_BUNDLE_HASH__"';
const catalogMarker = '"__SONG_CATALOG_JSON__"';
const internalCatalogMarker = '"__INTERNAL_SONG_CATALOG_JSON__"';
const sddtExtrasMarker = '"__SDDT_EXTRAS_JSON__"';
for (const value of [themeMarker, themeHashMarker, catalogMarker, internalCatalogMarker, sddtExtrasMarker]) {
  if (!template.includes(value)) throw new Error("模板中未找到注入标记 " + value);
}

const runtimeThemeFiles = [
  "rating-chart/renderer/theme.html",
  "rating-chart/renderer/theme.css",
  "rating-chart/renderer/theme.js",
  "song-detail/renderer/theme.html",
  "song-detail/renderer/theme.css",
  "song-detail/renderer/theme.js",
  "chart-info/renderer/theme.html",
  "chart-info/renderer/theme.css",
  "chart-info/renderer/theme.js",
  "chart-info/assets/spring-green-background.png",
  "completion-search/renderer/theme.html",
  "completion-search/renderer/theme.css",
  "completion-search/renderer/theme.js",
  "constant-table/renderer/theme.html",
  "constant-table/renderer/theme.css",
  "constant-table/renderer/theme.js",
  "level-score/renderer/theme.html",
  "level-score/renderer/theme.css",
  "level-score/renderer/theme.js",
  "level-score/assets/background.png",
  "level-score/assets/diff_basic_59x15.png",
  "level-score/assets/diff_advanced_59x15.png",
  "level-score/assets/diff_expert_59x15.png",
  "level-score/assets/diff_master_59x15.png",
  "level-score/assets/diff_lunatic_59x15.png",
  "level-score/assets/score_detail_ab.png",
  "level-score/assets/score_detail_fc.png",
  "level-score/assets/score_detail_fb.png",
  "level-score/assets/platinum_score_icon.png",
  "level-score/assets/score_tr_a.png",
  "level-score/assets/score_tr_aa.png",
  "level-score/assets/score_tr_aaa.png",
  "level-score/assets/score_tr_b.png",
  "level-score/assets/score_tr_bb.png",
  "level-score/assets/score_tr_bbb.png",
  "level-score/assets/score_tr_c.png",
  "level-score/assets/score_tr_d.png",
  "level-score/assets/score_tr_s.png",
  "level-score/assets/score_tr_ss.png",
  "level-score/assets/score_tr_sss.png",
  "level-score/assets/score_tr_sssplus.png",
  "shared/fonts/ChenYuluoyan-2.0-Thin.ttf",
  "shared/fonts/NotoSansCJKsc-Regular.otf",
  "shared/fonts/NotoSansCJKsc-Bold.otf",
  "shared/fonts/NotoSansSymbols2-Regular.ttf",
  "shared/fonts/FOT-GMARUGOPRO-DB.OTF",
  "shared/fonts/ResourceHanRoundedCN-Medium.ttf",
  "rating-chart/assets/overlay.png",
  "rating-chart/assets/basic_plate.png",
  "rating-chart/assets/advanced_plate.png",
  "rating-chart/assets/expert_plate.png",
  "rating-chart/assets/master_plate.png",
  "rating-chart/assets/lunatic_plate.png",
  "rating-chart/assets/basic_plate_platinum.png",
  "rating-chart/assets/advanced_plate_platinum.png",
  "rating-chart/assets/expert_plate_platinum.png",
  "rating-chart/assets/master_plate_platinum.png",
  "rating-chart/assets/lunatic_plate_platinum.png",
  "rating-chart/assets/diff_basic_59x15.png",
  "rating-chart/assets/diff_advanced_59x15.png",
  "rating-chart/assets/diff_expert_59x15.png",
  "rating-chart/assets/diff_master_59x15.png",
  "rating-chart/assets/diff_lunatic_59x15.png",
  "rating-chart/assets/platinum_score_icon.png",
  "rating-chart/assets/score_detail_ab.png",
  "rating-chart/assets/score_detail_fc.png",
  "rating-chart/assets/score_detail_fb.png",
  "rating-chart/assets/score_tr_a.png",
  "rating-chart/assets/score_tr_aa.png",
  "rating-chart/assets/score_tr_aaa.png",
  "rating-chart/assets/score_tr_b.png",
  "rating-chart/assets/score_tr_bb.png",
  "rating-chart/assets/score_tr_bbb.png",
  "rating-chart/assets/score_tr_c.png",
  "rating-chart/assets/score_tr_d.png",
  "rating-chart/assets/score_tr_s.png",
  "rating-chart/assets/score_tr_ss.png",
  "rating-chart/assets/score_tr_sss.png",
  "rating-chart/assets/score_tr_sssplus.png",
  "song-detail/assets/overlay.png",
  "completion-search/assets/back_base.png",
  "completion-search/assets/diff_basic_59x15.png",
  "completion-search/assets/diff_advanced_59x15.png",
  "completion-search/assets/diff_expert_59x15.png",
  "completion-search/assets/diff_master_59x15.png",
  "completion-search/assets/level.png",
  "completion-search/assets/score_detail_ab.png",
  "completion-search/assets/score_detail_fc.png",
  "completion-search/assets/score_detail_fb.png",
  "completion-search/assets/special-plates.json",
  "completion-search/assets/ui_userplate_040100.png",
  "completion-search/assets/ui_userplate_040105.png",
  "completion-search/assets/ui_userplate_040110.png",
  "completion-search/assets/ui_userplate_040115.png",
  "completion-search/assets/ui_userplate_040120.png",
  "completion-search/assets/ui_userplate_040125.png",
  "completion-search/assets/ui_userplate_040130.png",
  "completion-search/assets/ui_userplate_040135.png",
  "completion-search/assets/ui_userplate_040140.png",
  "completion-search/assets/ui_userplate_040145.png",
  "completion-search/assets/ui_userplate_040150.png",
];
// 素材与字体由部署者自备（见 ASSETS.md），仓库里没有。缺了不算错：
// 打出来的核心少这几张图，对应渲染退化，但不用为了试一次构建先去凑齐素材。
// 主题代码（html/css/js）是本仓库自己的，缺了就是工程坏了 —— 照旧抛错。
const isDeployerSupplied = (name) => name.includes("/assets/") || name.startsWith("shared/fonts/");

const themeBundle = {};
const themeHasher = crypto.createHash("sha256");
const missingThemeFiles = [];
for (const relativeName of runtimeThemeFiles) {
  const sourcePath = path.join(THEME_ROOT, ...relativeName.split("/"));
  if (!fs.existsSync(sourcePath)) {
    if (isDeployerSupplied(relativeName)) { missingThemeFiles.push(relativeName); continue; }
    throw new Error("缺少主题运行资源: " + sourcePath);
  }
  const content = fs.readFileSync(sourcePath);
  themeBundle[relativeName] = content.toString("base64");
  themeHasher.update(relativeName).update(content);
}
if (missingThemeFiles.length) {
  console.warn(`   跳过 ${missingThemeFiles.length} 个本地没有的素材/字体（见 ASSETS.md），其余 ${Object.keys(themeBundle).length} 个已打包`);
}
const themeHash = themeHasher.digest("hex").slice(0, 16);
const catalogSource = fs.readFileSync(SUPPLEMENTAL_SONGS, "utf8");
const internalCatalogSource = fs.readFileSync(INTERNAL_SONGS, "utf8");
const sddtExtrasSource = fs.readFileSync(SDDT_EXTRAS, "utf8");
const generatedSource = template
  .replace(marker, JSON.stringify(friend))
  .replace(themeMarker, JSON.stringify(themeBundle))
  .replace(themeHashMarker, JSON.stringify(themeHash))
  .replace(catalogMarker, JSON.stringify(catalogSource))
  .replace(internalCatalogMarker, JSON.stringify(internalCatalogSource))
  .replace(sddtExtrasMarker, JSON.stringify(sddtExtrasSource));
fs.writeFileSync(GENERATED, generatedSource, "utf8");
console.log(`   已打包 ${runtimeThemeFiles.length} 个主题文件，主题版本 ${themeHash}`);

step("2/5 用 esbuild 打包 undici 依赖（SEA 不提供 node:undici）");
execFileSync(process.execPath, [
  path.join(DIR, "node_modules", "esbuild", "bin", "esbuild"),
  GENERATED,
  "--bundle",
  "--platform=node",
  "--format=cjs",
  "--target=node22",
  "--outfile=" + BUNDLED,
], { cwd: DIR, stdio: "inherit" });
if (!fs.existsSync(BUNDLED)) throw new Error("esbuild 打包失败");

step("3/5 生成 SEA blob 并构建核心 ongenki-core.exe");
execSync(`node --experimental-sea-config "${SEA_CONFIG}"`, { stdio: "inherit", cwd: DIR });
if (!process.execPath.toLowerCase().endsWith("node.exe")) {
  throw new Error("请用 node 运行本脚本: node build.js");
}
fs.copyFileSync(process.execPath, CORE);
try {
  execSync(
    `npx --yes postject "${CORE}" NODE_SEA_BLOB "${BLOB}" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`,
    { stdio: "inherit", cwd: DIR }
  );
} catch (e) {
  fs.rmSync(CORE, { force: true });
  throw e;
}
fs.rmSync(BLOB, { force: true });

step("4/5 核心自测");
execSync(`"${CORE}" --selftest`, { stdio: "inherit", cwd: DIR });

// 拆成两段：核心（ongeki-core.exe）是部署真正要的东西；GUI（音击小工具 v3.0.exe）
// 是本地查分工具，需要 gui.cs、ongeki-icon.ico 和 csc.exe，这三样都不在公开仓库里。
// 所以要有个只出核心的模式，否则新克隆上跑 build 必然卡在最后一步。
const CORE_ONLY = process.argv.includes("--core-only") || process.env.MIA_SKIP_WIN_GUI === "1";
if (CORE_ONLY) {
  console.log("");
  console.log("构建完成 -> " + CORE);
  console.log("（--core-only：只出核心，跳过 WinForms GUI）");
  process.exit(0);
}

step("5/5 编译 GUI（内嵌核心）");
if (!fs.existsSync(CSC)) throw new Error("未找到 csc.exe: " + CSC);
if (!fs.existsSync(GUI_ICON)) throw new Error("未找到程序图标: " + GUI_ICON);
if (!fs.existsSync(INTERNAL_SONGS)) throw new Error("未找到内置曲库: " + INTERNAL_SONGS);
if (!fs.existsSync(SUPPLEMENTAL_SONGS)) throw new Error("未找到曲绘补充曲库: " + SUPPLEMENTAL_SONGS);
if (!fs.existsSync(SDDT_EXTRAS)) throw new Error("未找到 SDDT 补充数据: " + SDDT_EXTRAS);
fs.rmSync(GUI_EXE, { force: true });
try {
  const cscArgs = [
    "/nologo",
    "/target:winexe",
    `/out:${GUI_EXE}`,
    `/win32icon:${GUI_ICON}`,
    GUI_SRC,
    "/resource:ongeki-core.exe,ongeki-core.exe",
    "/resource:ongeki-music-internal.json,ongeki-music-internal.json",
    "/resource:ongeki-song-catalog.json,ongeki-song-catalog.json",
    "/resource:ongeki-sddt-extras.json,ongeki-sddt-extras.json",
    "/r:System.Windows.Forms.dll",
    "/r:System.Drawing.dll",
    "/r:System.Web.Extensions.dll",
  ];
  if (fs.existsSync(JACKET_FALLBACK_DIR)) {
    for (const name of fs.readdirSync(JACKET_FALLBACK_DIR).filter((value) => /^\d+\.png$/.test(value))) {
      const songId = path.basename(name, ".png");
      cscArgs.push(`/resource:${path.join(JACKET_FALLBACK_DIR, name)},jacket.${songId}.png`);
    }
  }
  execFileSync(CSC, cscArgs, { stdio: "inherit", cwd: DIR });
} catch (e) {
  console.error("csc 编译失败（详见上方错误）");
  throw e;
}

console.log("");
console.log("构建完成 -> " + GUI_EXE);
console.log("（界面程序，内嵌自动化核心）");
