#!/usr/bin/env node
"use strict";
/**
 * macOS 版构建脚本：在 Mac 上运行（SEA 产物按平台区分，必须在本平台构建）
 *
 * 流程：
 *   1/8 重建分表核心（复用根目录 build.js，TAKASE_SKIP_WIN_GUI=1 跳过 WinForms GUI）
 *   2/8 esbuild 打包 Discord 服务并注入 Gateway 代理挂钩
 *   3/8 Discord 核心 SEA（node --experimental-sea-config + postject + ad-hoc 签名）
 *   4/8 凭据库 SEA（Keychain 版，同上）
 *   5/8 图标：ICO → iconset → icns
 *   6/8 Avalonia 单文件发布（dotnet publish，需先有 3 个 SEA 供 EmbeddedResource 编译期读取）
 *   7/8 组装 Takase Bot Discord.app
 *   8/8 签名与总自测
 *
 * 前置：npm install 已执行；本机有 .NET 8 SDK 与 Node >= 20.12
 */
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, execSync } = require("node:child_process");

const DIR = __dirname;
const ROOT = path.resolve(DIR, "..");
const DIST = path.join(DIR, "dist");
const NODE = fs.realpathSync(process.execPath); // brew 安装的 node 是符号链接，必须 realpath
const RID = process.arch === "arm64" ? "osx-arm64" : "osx-x64";
const SEA_FUSE = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

const ENTRY = path.join(ROOT, "takase-discord-entry.mjs");
const BUNDLE = path.join(DIR, "takase-discord-bundle.cjs");
const SEA_CONFIG = path.join(DIR, "takase-discord-sea-config.json");
const SEA_BLOB = path.join(DIR, "takase-discord-sea.blob");
const DISCORD_CORE = path.join(DIST, "takase-discord-core");

const VAULT_SOURCE = path.join(DIR, "vault", "vault-main.js");
const VAULT_BUNDLE = path.join(DIR, "vault", "vault-bundle.cjs");
const VAULT_SEA_CONFIG = path.join(DIR, "vault", "vault-sea-config.json");
const VAULT_SEA_BLOB = path.join(DIR, "vault", "vault-sea.blob");
const VAULT = path.join(DIST, "takase-discord-vault");

const ONGEKI_CORE = path.join(DIST, "ongeki-core");
const APP = path.join(DIST, "Takase Bot Discord.app");

function step(text) { console.log("== " + text); }

/** 与 Windows 版 build-discord-bot.js 相同的 Gateway WebSocket 代理挂钩注入 */
function injectGatewayProxyHook(bundlePath) {
  const needle = "handshakeTimeout: this.strategy.options.handshakeTimeout ?? void 0";
  const replacement = needle + ",\n          agent: globalThis.__TAKASE_DISCORD_WS_AGENT ?? void 0";
  const source = fs.readFileSync(bundlePath, "utf8");
  const occurrences = source.split(needle).length - 1;
  if (occurrences !== 1) throw new Error("Discord Gateway 代理挂钩定位失败，命中数量：" + occurrences);
  fs.writeFileSync(bundlePath, source.replace(needle, replacement), "utf8");
}

/** ad-hoc 签名：postject 会破坏 node 原始签名，Apple Silicon 上不签会 "Killed: 9" */
function sign(target) {
  execSync(`codesign --force --sign - "${target}"`, { stdio: "inherit" });
}

/** 标准 SEA 构建：sea-config → blob → 拷贝 node → postject → 签名 */
function buildSea(configPath, blobPath, outPath) {
  execFileSync(NODE, ["--experimental-sea-config", configPath], { cwd: DIR, stdio: "inherit" });
  fs.copyFileSync(NODE, outPath);
  try {
    execSync(
      `npx --yes postject "${outPath}" NODE_SEA_BLOB "${blobPath}" --sentinel-fuse ${SEA_FUSE}`,
      { cwd: DIR, stdio: "inherit" }
    );
  } catch (error) {
    fs.rmSync(outPath, { force: true });
    throw error;
  }
  fs.rmSync(blobPath, { force: true });
  sign(outPath);
}

/** esbuild 打包（node 内置模块保留，undici 等 npm 依赖打进单文件） */
function bundle(input, output) {
  execFileSync(NODE, [
    path.join(ROOT, "node_modules", "esbuild", "bin", "esbuild"),
    input, "--bundle", "--platform=node", "--format=cjs", "--target=node22",
    "--outfile=" + output,
  ], { cwd: DIR, stdio: "inherit" });
}

function main() {
  if (process.platform !== "darwin") {
    throw new Error("请在 macOS 上运行本脚本（SEA 产物按平台区分，无法跨平台构建）");
  }
  if (!fs.existsSync(path.join(ROOT, "node_modules"))) {
    throw new Error("缺少 node_modules，请先在项目根目录执行 npm install");
  }
  try { execFileSync("dotnet", ["--version"], { stdio: "ignore" }); }
  catch { throw new Error("未找到 dotnet，请先安装 .NET 8 SDK（brew install dotnet）"); }
  fs.mkdirSync(DIST, { recursive: true });

  step("1/8 重建分表核心（复用 build.js，跳过 WinForms GUI）");
  execFileSync(NODE, [path.join(ROOT, "build.js")], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, TAKASE_SKIP_WIN_GUI: "1" },
  });
  fs.copyFileSync(path.join(ROOT, "ongeki-core.exe"), ONGEKI_CORE); // 文件名为 exe 后缀，实为 mac 二进制
  for (const f of ["ongeki-exe.js", "ongeki-bundle.cjs", "ongeki-core.exe", "sea-prep.blob"]) {
    try { fs.rmSync(path.join(ROOT, f), { force: true }); } catch {}
  }
  sign(ONGEKI_CORE);
  execFileSync(ONGEKI_CORE, ["--selftest"], { stdio: "inherit" });

  step("2/8 打包 Discord.js 与 Bot 服务");
  bundle(ENTRY, BUNDLE);
  injectGatewayProxyHook(BUNDLE);
  console.log("   已为 Discord Gateway WebSocket 注入代理支持");
  execFileSync(NODE, [BUNDLE, "--selftest"], { cwd: DIR, stdio: "inherit" });

  step("3/8 构建 Discord SEA 核心");
  buildSea(SEA_CONFIG, SEA_BLOB, DISCORD_CORE);
  execFileSync(DISCORD_CORE, ["--selftest"], { cwd: DIR, stdio: "inherit" });

  step("4/8 构建凭据库 SEA（Keychain）");
  bundle(VAULT_SOURCE, VAULT_BUNDLE);
  buildSea(VAULT_SEA_CONFIG, VAULT_SEA_BLOB, VAULT);
  execFileSync(VAULT, ["--selftest"], { cwd: DIR, stdio: "inherit" });

  step("5/8 生成应用图标");
  execFileSync(NODE, [path.join(DIR, "make-icon.js")], { cwd: DIR, stdio: "inherit" });

  step("6/8 Avalonia 单文件发布（" + RID + "）");
  execFileSync("dotnet", [
    "publish", path.join(DIR, "AvaloniaGUI"),
    "-c", "Release", "-r", RID, "--self-contained",
    "-p:PublishSingleFile=true", "-p:IncludeNativeLibrariesForSelfExtract=true", "-p:PublishTrimmed=false",
  ], { cwd: DIR, stdio: "inherit" });
  const published = path.join(DIR, "AvaloniaGUI", "bin", "Release", "net8.0", RID, "publish", "TakaseBotDiscord");
  if (!fs.existsSync(published)) throw new Error("Avalonia 发布产物缺失：" + published);

  step("7/8 组装 Takase Bot Discord.app");
  const macosDir = path.join(APP, "Contents", "MacOS");
  const resourcesDir = path.join(APP, "Contents", "Resources");
  fs.mkdirSync(macosDir, { recursive: true });
  fs.mkdirSync(resourcesDir, { recursive: true });
  fs.copyFileSync(path.join(DIR, "Info.plist.template"), path.join(APP, "Contents", "Info.plist"));
  fs.copyFileSync(published, path.join(macosDir, "TakaseBotDiscord"));
  const icns = path.join(DIR, "assets", "app.icns");
  if (fs.existsSync(icns)) fs.copyFileSync(icns, path.join(resourcesDir, "app.icns"));
  fs.chmodSync(path.join(macosDir, "TakaseBotDiscord"), 0o755);

  step("8/8 签名与总自测");
  sign(APP);
  execFileSync(path.join(macosDir, "TakaseBotDiscord"), ["--selftest"], { cwd: DIR, stdio: "inherit" });

  console.log("");
  console.log("macOS 版构建完成 -> " + APP);
  console.log("跨机分发提示（目标机器执行）：xattr -dr com.apple.quarantine \"" + APP + "\"");
}

main();
