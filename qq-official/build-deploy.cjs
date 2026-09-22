#!/usr/bin/env node
"use strict";
// 打一个可直接丢到 Windows 机器上的部署包。
//
// 关键设计：**目标机器的目录结构与本仓库保持一致** ——
//   deploy/qq-official/mia-entry.cjs 里 HERE=qq-official/、ROOT=deploy/，
//   于是 ./config.local.json 和 ../mia-chat 的相对解析全部不用改。
//
// 用 esbuild 打成单文件，目标机器**只需要装 Node，不需要 npm install**。
// 这跟 qq/build-qq-bot.js 是同一套做法。
//
// 用法：node qq-official/build-deploy.cjs [输出目录，默认 deploy/] [服务器参数]
// 服务器参数：
//   --asset-root=../extracted-ongeki-assets
//   --public-base-url=http://47.101.132.248:47831
//   --host=0.0.0.0
//   --port=47831

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const HERE = __dirname;
const ROOT = path.resolve(HERE, "..");
const OUT = path.resolve(ROOT, process.argv[2] || "deploy");
const ESBUILD = path.join(ROOT, "node_modules", "esbuild", "bin", "esbuild");
const DEPLOY_ARGS = new Map(process.argv.slice(3).map((arg) => {
  const match = String(arg).match(/^--([^=]+)=(.*)$/s);
  if (!match) throw new Error("无法识别部署参数：" + arg);
  return [match[1], match[2]];
}));
const DEPLOY_PORT = DEPLOY_ARGS.has("port") ? Number(DEPLOY_ARGS.get("port")) : undefined;
if (DEPLOY_PORT !== undefined && (!Number.isInteger(DEPLOY_PORT) || DEPLOY_PORT < 1 || DEPLOY_PORT > 65535)) {
  throw new Error("--port 必须是 1 到 65535 之间的整数");
}

if (!fs.existsSync(ESBUILD)) throw new Error("缺少 esbuild，请先在项目根目录执行 npm ci");

function copyDir(from, to, filter) {
  fs.mkdirSync(to, { recursive: true });
  let n = 0, bytes = 0;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name), dst = path.join(to, entry.name);
    if (filter && !filter(entry.name)) continue;
    if (entry.isDirectory()) { const r = copyDir(src, dst, filter); n += r.n; bytes += r.bytes; }
    else { fs.copyFileSync(src, dst); n++; bytes += fs.statSync(src).size; }
  }
  return { n, bytes };
}

// ── 清空输出目录（只清我们自己的产物，避免误删同名目录）────────────────
// ⚠ 先挡住「就在输出目录里跑」这种情况：Windows 删不掉自己所在的工作目录，
// 报出来是一串 syscall EBUSY 加调用栈，看不出真正的原因。
{
  const cwd = path.resolve(process.cwd());
  if (cwd === path.resolve(OUT) || cwd.startsWith(path.resolve(OUT) + path.sep)) {
    console.error("不要站在输出目录里跑这个脚本：" + cwd);
    console.error("Windows 删不掉进程当前所在的工作目录。先 cd 回仓库根目录再跑。");
    process.exit(1);
  }
}
if (fs.existsSync(OUT)) {
  if (!fs.existsSync(path.join(OUT, ".deploy-marker"))) {
    console.error("输出目录已存在且不是本脚本建的：" + OUT);
    console.error("如果确认可以覆盖，先手动删掉它，或在里面建一个空的 .deploy-marker");
    process.exit(1);
  }
  fs.rmSync(OUT, { recursive: true, force: true });
}

// ── 0. 测试闸门 ────────────────────────────────────────────────────
// 打出来的包是要拷到另一台机器上跑的，那边没有源码可查。所以坏了的代码不该出门。
// 全部走 mock，不需要真实凭据、不花 API 费用。
// ⚠ `--test-timeout` 不是可选的：入口测试里某个用例留下的计时器会让进程等满退避时间
// （最长 15 分钟），不设超时看起来就像卡死了。
console.log("跑测试（全部走 mock，不花钱）…");
for (const file of [
  path.join(ROOT, "test-mia-core.cjs"),
  path.join(ROOT, "test-song-alias-store.cjs"),
]) {
  execFileSync(process.execPath, [file], { cwd: ROOT, stdio: "inherit" });
}
for (const file of [
  path.join(HERE, "test-official-transport.cjs"),
  path.join(HERE, "test-mia-entry.cjs"),
  path.join(HERE, "test-mia-commands.cjs"),
  path.join(HERE, "test-song-search.cjs"),
  path.join(HERE, "test-semantic-router.cjs"),
  path.join(HERE, "test-public-query.cjs"),
  path.join(ROOT, "test-rinnet-client.cjs"),
  path.join(ROOT, "test-rinnet-renderer.cjs"),
  path.join(ROOT, "test-data-source-vault.cjs"),
  // 面板那条「命令表和描述必须一一对应」是防漂移的唯一防线，进闸门才有意义
  path.join(HERE, "test-mia-command-panel.cjs"),
  // 美亚的入口 bundle 里有 chat.cjs，引擎契约坏了这边一样会挂
  path.join(ROOT, "chat-core/knowledge.test.cjs"),
  path.join(ROOT, "chat-core/research-policy.test.cjs"),
  path.join(ROOT, "chat-core/search.test.cjs"),
]) {
  execFileSync(process.execPath, ["--test", "--test-timeout=60000", file], { cwd: ROOT, stdio: "inherit" });
}

// ── 1. 打包入口 ────────────────────────────────────────────────────
const outEntryDir = path.join(OUT, "qq-official");
fs.mkdirSync(outEntryDir, { recursive: true });
console.log("打包 mia-entry.cjs …");
execFileSync(process.execPath, [
  // Windows 上不能直接 exec 那个带 shebang 的 esbuild 脚本，要用 node 去跑它 ——
  // qq/build-qq-bot.js 也是这么调的。
  ESBUILD, path.join(HERE, "mia-entry.cjs"),
  "--bundle", "--platform=node", "--format=cjs", "--target=node22",
  // ws 的这两个可选 peerDependency 没装，不排除的话 esbuild 解析失败
  "--external:bufferutil", "--external:utf-8-validate",
  "--outfile=" + path.join(outEntryDir, "mia-entry.cjs"),
], { stdio: "inherit" });
copyDir(path.join(HERE, "asset-browser-site"), path.join(outEntryDir, "asset-browser-site"));
console.log("带上素材检索网页静态文件");

// ── 2. 角色资源 ────────────────────────────────────────────────────
// desktop.ini 是 Windows 自动生成的文件夹视图配置，不是素材，别跟着打包
const skip = (name) => name !== "desktop.ini";
const a = copyDir(path.join(ROOT, "mia-chat"), path.join(OUT, "mia-chat"), skip);
console.log("mia-chat/ ：" + a.n + " 个文件，" + (a.bytes / 1048576).toFixed(1) + " MiB");

// ── 3. 共享客观事实层（剧情/角色档案/术语/曲库）─────────────────────
// 引擎已经被打进单文件，这里只需要运行时按路径读的 knowledge/。
const b = copyDir(path.join(ROOT, "chat-core/knowledge"), path.join(OUT, "chat-core/knowledge"));
console.log("chat-core/knowledge/ ：" + b.n + " 个文件，" + (b.bytes / 1048576).toFixed(1) + " MiB");

// ── 4. 入口层的运行期文件 ──────────────────────────────────────────
// config.local.json 里有 AppSecret 和你的真实选择，但**路径不能照抄** ——
// 开发目录的布局和发布包的布局不一样，照抄的结果是「开发目录能用、发布包不能用」，
// 而且失败发生在每条指令各自 spawn 的时候，症状分散。
// 这里按包内布局重写路径键：参考物全放在 qq-official/ 自己下面，包是自包含的。
const devConfigPath = path.join(HERE, "config.local.json");
if (!fs.existsSync(devConfigPath)) throw new Error("找不到 qq-official/config.local.json —— 部署包必须有它（里面有 AppSecret）");
const devConfig = JSON.parse(fs.readFileSync(devConfigPath, "utf8"));

// ── 4b. 出图核心与凭据库 ────────────────────────────────────────────
// 指令层要用它们。**不拷的话，分表/单曲/等级/牌子在目标机器上全跑不了**，
// 而且是在运行期一条一条失败，症状最分散。
//
// 拷的是**开发配置实际指向的那两个文件** —— 不在这里另写一套路径猜测。
// 那两个文件被 .gitignore 忽略（超过 GitHub 单文件上限），放哪儿由配置说了算；
// 按配置走，打包出来的就和本机跑的是同一个二进制。
const packagedPaths = {};
for (const key of ["corePath", "vaultHelperPath"]) {
  const value = String(devConfig[key] || "").trim();
  const src = value ? path.resolve(HERE, value) : "";
  if (!src || !fs.existsSync(src)) {
    throw new Error("配置里的 " + key + " 找不到：" + (value || "（空）") +
      "\n  解析成 " + (src || "（无）") +
      "\n  指令层要用它，缺了打不出可用的包。先把它放到配置指向的位置。");
  }
  const base = path.basename(src);
  fs.copyFileSync(src, path.join(outEntryDir, base));
  packagedPaths[key] = "./" + base;
  console.log("带上 " + base + "（" + (fs.statSync(src).size / 1048576).toFixed(0) + " MiB，来自 " + key + "=" + value + "）");
}

{
  const config = {
    ...devConfig,
    ...packagedPaths,
    workDir: "./data",
    outputDir: "./data/output",
    vaultPath: "./data/bindings.dat",
    // 独立部署的那台机器上没有梨绪，别名库就是美亚自己那份
    aliasDir: "./data",
    assetBrowser: devConfig.assetBrowser ? {
      ...devConfig.assetBrowser,
      // 素材体积约 6 GiB，不重复塞进部署包。默认仍兼容仓库内的 deploy/，
      // 正式服务器包可通过命令行参数把路径和公网地址一次写好。
      assetRoot: DEPLOY_ARGS.get("asset-root") || "../../extracted-ongeki-assets",
      ...(DEPLOY_ARGS.has("public-base-url") ? {
        enabled: true,
        publicBaseUrl: DEPLOY_ARGS.get("public-base-url"),
      } : {}),
      ...(DEPLOY_ARGS.has("host") ? { host: DEPLOY_ARGS.get("host") } : {}),
      ...(DEPLOY_PORT !== undefined ? { port: DEPLOY_PORT } : {}),
    } : undefined,
  };
  fs.writeFileSync(path.join(outEntryDir, "config.local.json"), JSON.stringify(config, null, 2) + "\n");
  console.log("带上 config.local.json（路径已按包内布局重写）");
}
{
  const src = path.join(HERE, "stop-mia.cjs");
  if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(outEntryDir, "stop-mia.cjs")); console.log("带上 stop-mia.cjs"); }
  else console.log("⚠ 没找到 stop-mia.cjs");
}

// ── 5. 启动器（用同一套生成器，只是输出到部署目录）──────────────────
{
  const vbsQuote = (v) => '"' + String(v).replace(/"/g, '""') + '"';
  const write = (fileName, comment, command, visible) => {
    const body = [
      "' " + comment,
      'Set shell = CreateObject("WScript.Shell")',
      'Set fso = CreateObject("Scripting.FileSystemObject")',
      "shell.CurrentDirectory = fso.GetParentFolderName(WScript.ScriptFullName)",
      "shell.Run " + vbsQuote(command) + (visible ? ", 1, True" : ", 0, False"),
      "",
    ].join("\r\n");
    fs.writeFileSync(path.join(outEntryDir, fileName), Buffer.from("﻿" + body, "utf16le"));
  };
  // 默认显示日志窗口：状态只有日志里看得见，纯静默启动出了事完全不知道。
  // 入口自己也写 mia.log，所以窗口关掉日志还在。
  write("启动美亚.vbs", "启动美亚并显示实时日志。关掉窗口即停止。日志同时写到 mia.log。", "cmd /k node " + vbsQuote("mia-entry.cjs"), true);
  write("启动美亚（后台）.vbs", "无窗口后台启动美亚。日志只写到 mia.log。", "cmd /c node " + vbsQuote("mia-entry.cjs") + " > " + vbsQuote("mia.log") + " 2>&1", false);
  write("停止美亚.vbs", "停止美亚。只结束命令行里带 mia-entry 的 node 进程。", "cmd /c node " + vbsQuote("stop-mia.cjs") + " & timeout /t 3", true);
}

// ── 6. 开机自启（可选，放个说明而不是直接改注册表）───────────────────
fs.writeFileSync(path.join(OUT, "开机自启.txt"),
  "想让美亚开机自动跑，把「启动美亚.vbs」的快捷方式放进：\r\n" +
  "  Win+R → 输入 shell:startup → 回车\r\n" +
  "把快捷方式拖进打开的文件夹即可。\r\n\r\n" +
  "注意：同一时间只能有一个实例连着腾讯网关，两个进程会让它把每句话回两遍。\r\n" +
  "从旧机器迁过来时，先停旧的再启新的。\r\n");

// 部署说明单独维护成 .md —— 塞进模板字符串的话，里面的反引号会把字面量提前闭合。
// 两份文档不随公开仓库分发（写明了部署姿势），缺失时跳过而不是让打包失败。
for (const doc of ["部署说明.md", "服务器部署清单.md"]) {
  const src = path.join(HERE, doc);
  if (!fs.existsSync(src)) {
    console.log("跳过 " + doc + "（本地没这份文档）");
    continue;
  }
  fs.copyFileSync(src, path.join(OUT, doc));
  console.log("带上 " + doc);
}

// ── 7. 打包后自检 ──────────────────────────────────────────────────
// 「开发目录能用、发布包不能用」是这一层最容易出的错：路径在源码里对，
// 到了包里就不对，而且失败发生在运行期每条指令各 spawn 一次的时候，症状分散。
// 所以按**包内路径**把关键文件重新验一遍，缺什么现在就说。
{
  const packaged = JSON.parse(fs.readFileSync(path.join(outEntryDir, "config.local.json"), "utf8"));
  const missing = [];
  for (const key of ["corePath", "vaultHelperPath"]) {
    const value = String(packaged[key] || "").trim();
    if (!value || !fs.existsSync(path.resolve(outEntryDir, value))) missing.push(key + " → " + (value || "（空）"));
  }
  // 目录类的不要求存在（首次启动会建），但必须能定出绝对路径
  for (const key of ["workDir", "outputDir", "vaultPath", "aliasDir"]) {
    if (!String(packaged[key] || "").trim()) missing.push(key + " → （空）");
  }
  if (missing.length) {
    console.error("\n⚠ 部署包自检没过，以下路径在包里对不上：\n  " + missing.join("\n  "));
    process.exit(1);
  }
  console.log("自检通过：corePath / vaultHelperPath 在包里都在，" +
    "workDir / outputDir / vaultPath / aliasDir 都已指向包内。");
}

fs.writeFileSync(path.join(OUT, ".deploy-marker"), "由 qq-official/build-deploy.cjs 生成\n");
console.log("\n部署包已生成：" + OUT);
console.log("把它整个拷到目标机器，装好 Node 22+，双击 qq-official/启动美亚.vbs 即可。");
