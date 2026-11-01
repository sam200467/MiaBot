#!/usr/bin/env node
"use strict";
// 后台运行美亚：「启动美亚.vbs」「停止美亚.vbs」（make-launchers.cjs 生成）背后干活的就是这个文件，
// .vbs 只是把它藏起来跑，再把结果弹窗说一声。照 AnnaBot 的 tools/background.cjs 写的。
//
// 用法：node mia-background.cjs start    无窗口启动，等日志里出现「已就绪」再报；已经有美亚在跑就不再开
//       node mia-background.cjs stop     停掉在跑的美亚，连同她开的出图核心和无头浏览器
//       加 --result <文件> 时结果写进这个文件（UTF-16LE，给 .vbs 读），不加就打在终端里。
// 退出码：0 成功，1 失败，2 要人看一眼（已经在跑了、启动了但还没连上）。.vbs 按它选弹窗的图标。
//
// 怎么认美亚：命令行里带 mia-entry 的 node 进程，跟 stop-mia.cjs、mia-task.cmd 一样。启动器和计划任务跑的都是
// 相对路径的 node mia-entry.cjs，看不出是哪个目录的，所以不分目录：一台机器上只该有一个美亚。
//
// 真正把美亚跑起来的是同目录的 mia-task.cmd：不开第二个，清掉 %TEMP% 里出图剩下的 ongeki-exe-*，
// mia.log 太大就换一份，stderr 接到 mia-stderr.log。
// 有计划任务 MiaBot（启动的是这个目录的 mia-task.cmd，没被禁用）时交给它启动：这样开的美亚跟开机自启的一样，
// 不挂在谁的登录会话上，远程桌面注销了也接着跑。没有就自己在后台起一个（开发机上就是这样）。

const fs = require("node:fs");
const path = require("node:path");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");

const run = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const HERE = __dirname;
// mia-entry.cjs 连上网关后打的那句（test-mia-background.cjs 核对两边一致）
const READY_LINE = "已就绪，等待消息";
// 服务器上开机自启的计划任务（换服务器工具包的 3 号脚本注册的）
const TASK_NAME = "MiaBot";
const TASK_SCRIPT = "mia-task.cmd";
const LOG_FILE = "mia.log";
const STDERR_FILE = "mia-stderr.log";
// 开放平台的 IP 白名单没加这台机器时，换 access_token 的报错里带这个码
const WHITELIST_CODE = "11298";

const psQuote = (value) => "'" + String(value).replace(/'/g, "''") + "'";
const pidList = (procs) => procs.map((proc) => proc.pid).join("、");
const sizeOf = (file) => { try { return fs.statSync(file).size; } catch { return 0; } };
// 读 offset 之后新写的。文件比 offset 还短，说明 mia-task.cmd 刚把它换成了新的一份，从头读。
function readFrom(file, offset) {
  try {
    const data = fs.readFileSync(file);
    return data.subarray(data.length < offset ? 0 : offset).toString("utf8");
  } catch { return ""; }
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } };
// 报错太长时只留开头：有用的（出错位置、错误信息）在最前面，后面是很长的调用栈
function head(text, maxLines = 10) {
  const lines = String(text).trim().split(/\r?\n/);
  return lines.length > maxLines ? lines.slice(0, maxLines).join("\n") + "\n…" : lines.join("\n");
}

// PowerShell 的报错可能是 CLIXML，只留第一行人话
function powerShellError(stderr) {
  const text = String(stderr || "");
  const parts = [...text.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)].map((match) => match[1]);
  const plain = (parts.length ? parts.join("") : text)
    .replace(/_x([0-9A-F]{4})_/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  return plain.split(/\r?\n/).map((line) => line.trim()).find((line) => line && !line.startsWith("#< CLIXML")) || "";
}

// 跑一段 PowerShell，返回标准输出。脚本走 -EncodedCommand（UTF-16LE base64），中文路径、引号都不用转义。
// 别把 error.message 原样往外报：里面是整条命令，带一大串 base64。
async function powershell(script, { what = "PowerShell", timeout = 60000 } = {}) {
  try {
    const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { encoding: "utf8", windowsHide: true, timeout });
    return stdout.trim();   // trim 连开头的 BOM 一起去掉（U+FEFF 算空白）
  } catch (error) {
    const detail = error.killed ? "超时" : "出错，退出码 " + error.code + (error.stderr ? "：" + powerShellError(error.stderr) : "");
    throw new Error(what + "（PowerShell " + detail + "）");
  }
}

// 列出所有 node.exe 和它们的命令行。用 CIM 不用 wmic：wmic 已被弃用，新的 Windows 11 上直接没有。
const LIST_SCRIPT = [
  "$ProgressPreference = 'SilentlyContinue'",   // 头一回用 CIM 模块时会往 stderr 打一段进度条
  "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false",   // 不设的话中文路径会乱码
  "$list = @(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; commandLine = [string]$_.CommandLine } })",
  "ConvertTo-Json -InputObject $list -Compress",
].join("\n");

async function listNodeProcesses() {
  return [].concat(JSON.parse(await powershell(LIST_SCRIPT, { what: "查不了进程列表" }) || "[]"));
}

const isMiaCommand = (commandLine) => /mia-entry/i.test(String(commandLine || ""));

async function findMia({ list = listNodeProcesses } = {}) {
  return (await list()).filter((proc) => proc.pid !== process.pid && isMiaCommand(proc.commandLine));
}

const TASK_QUERY = [
  "$ProgressPreference = 'SilentlyContinue'",
  "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false",
  "$task = Get-ScheduledTask -TaskName " + psQuote(TASK_NAME) + " -ErrorAction SilentlyContinue | Select-Object -First 1",
  "if ($task) { ConvertTo-Json -Compress -InputObject @{ state = [string]$task.State; " +
    "actions = (@($task.Actions | ForEach-Object { [string]$_.Execute + ' ' + [string]$_.Arguments }) -join ' | ') } } else { 'null' }",
].join("\n");

// 只认启动的是这个目录里那个 mia-task.cmd、又没被禁用的。指着别的目录，或者被禁用了（比如退回旧服务器时），
// 都当它不存在，自己直接起。
function taskStartsHere(task, dir = HERE) {
  if (!task || String(task.state) === "Disabled") return false;
  const script = path.win32.join(dir, TASK_SCRIPT).toLowerCase();
  return String(task.actions || "").replace(/\//g, "\\").toLowerCase().includes(script);
}

const scheduledTask = {
  async find(dir = HERE) {
    if (process.platform !== "win32") return null;
    const task = JSON.parse(await powershell(TASK_QUERY, { what: "查不了计划任务" }) || "null");
    return taskStartsHere(task, dir) ? task : null;
  },
  async run() {
    await powershell("$ErrorActionPreference = 'Stop'\nStart-ScheduledTask -TaskName " + psQuote(TASK_NAME), { what: "计划任务 " + TASK_NAME + " 启动不了" });
  },
};

// 没有计划任务：自己在后台起 mia-task.cmd。detached：这个脚本退出以后美亚接着跑；windowsHide：不弹黑框。
// 带 task 参数，美亚的 stderr 才会接到 mia-stderr.log。cmd 的 /s /c 去掉最外面那对引号、剩下的原样执行，
// 所以整条命令自己拼好，不让 Node 再加一层引号。
function launchDirect(dir = HERE) {
  const child = spawn("cmd.exe", ["/d", "/s", "/c", '""' + path.join(dir, TASK_SCRIPT) + '" task"'],
    { cwd: dir, detached: true, windowsHide: true, stdio: "ignore", windowsVerbatimArguments: true });
  child.once("error", () => { /* 起不来的话下面等不到进程，会报「没起来」 */ });
  child.unref();
}

async function start({ dir = HERE, list = listNodeProcesses, task = scheduledTask, launch = launchDirect,
  timeoutMs = 90000, appearMs = 15000, pollMs = 500, lookMs = 2000, now = () => Date.now() } = {}) {
  const running = await findMia({ list });
  if (running.length) {
    return { code: 2, text: "美亚已经在运行了（进程 " + pidList(running) + "），没有再开一个：同时开两个，每句话会回两遍。\n" +
      "要重启的话，先双击「停止美亚.vbs」。" };
  }

  const logFile = path.join(dir, LOG_FILE);
  const errFile = path.join(dir, STDERR_FILE);
  const logOffset = sizeOf(logFile);
  const errOffset = sizeOf(errFile);
  let viaTask = null;
  try { viaTask = await task.find(dir); } catch { /* 查不了计划任务就照常直接起 */ }
  try {
    if (viaTask) await task.run();
    else launch(dir);
  } catch (error) {
    return { code: 1, text: "美亚启动不了：" + error.message };
  }
  const by = viaTask ? "（计划任务 " + TASK_NAME + "）" : "";

  // 交给计划任务时拿不到子进程，所以都隔一会儿看一眼进程列表：进程出现过又没了，或者 mia-stderr.log 里有了新报错，
  // 就是没起来；一直没见到进程，多半是计划任务（或 mia-task.cmd）本身没跑起来。
  const started = now();
  let pid = null;
  let nextLook = started;
  for (;;) {
    await sleep(pollMs);
    const fresh = readFrom(logFile, logOffset);
    if (fresh.includes(READY_LINE)) {
      if (pid === null) pid = (await findMia({ list }).catch(() => []))[0]?.pid ?? null;
      return { code: 0, pid, text: "美亚已在后台启动" + by + "，连上 QQ 了" + (pid ? "（进程 " + pid + "）" : "") + "。" };
    }
    if (fresh.includes(WHITELIST_CODE)) {
      return { code: 1, pid, text: "美亚连不上 QQ：这台机器的公网 IP 不在开放平台的白名单里（" + WHITELIST_CODE + "）。\n" +
        "到 q.qq.com → 开发 → 开发设置 → IP白名单 加上它。加好后美亚会自己重连，等不及就先停止再启动。" };
    }
    if (now() >= nextLook) {
      nextLook = now() + lookMs;
      let procs = null;
      try { procs = await findMia({ list }); } catch { /* 这一回查不了进程列表，下一回再看，别因此判它没起来 */ }
      if (procs && procs.length) pid = procs[0].pid;
      else if (procs) {
        const errors = readFrom(errFile, errOffset).trim();
        if (pid !== null || errors) {
          return { code: 1, text: errors
            ? "美亚没能启动：\n" + head(errors) + "\n\n（报错也记在 " + STDERR_FILE + "）"
            : "美亚刚启动就退出了，没留下报错。看看日志：" + LOG_FILE };
        }
        if (now() - started > appearMs) {
          return { code: 1, text: viaTask
            ? "计划任务 " + TASK_NAME + " 没把美亚拉起来（" + Math.round(appearMs / 1000) + " 秒内没见到进程），也没留下报错。打开「任务计划程序」看看 " + TASK_NAME + " 的「上次运行结果」。"
            : "美亚没起来（" + Math.round(appearMs / 1000) + " 秒内没见到进程），也没留下报错。看看 " + TASK_SCRIPT + " 和 node 在不在。" };
        }
      }
    }
    if (now() - started >= timeoutMs) {
      return { code: 2, pid, text: "美亚已在后台启动" + by + (pid ? "（进程 " + pid + "）" : "") + "，但 " + Math.round(timeoutMs / 1000) +
        " 秒内还没连上 QQ。\n看看日志：" + LOG_FILE };
    }
  }
}

// taskkill /T 连子进程一起结束：出图核心和无头浏览器都是美亚的子进程。/F 是因为 Windows 上没法让别的进程收到 SIGTERM。
async function killTree(pid) {
  try {
    await run("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
  } catch (error) {
    // 进程在这之前自己退了的话 taskkill 也报错，那不算失败
    if (alive(pid)) throw new Error("taskkill 失败（退出码 " + error.code + "）");
  }
}

// 跟 mia-entry 的 makeFileLog 一样的格式（时间是 UTC）
function note(dir, line) {
  try { fs.appendFileSync(path.join(dir, LOG_FILE), "[" + new Date().toISOString().slice(11, 19) + "] " + line + "\n"); } catch { /* 记不进去不影响停止 */ }
}

async function stop({ dir = HERE, list = listNodeProcesses, kill = killTree, isAlive = alive, waitMs = 5000 } = {}) {
  const running = await findMia({ list });
  if (!running.length) return { code: 0, text: "美亚本来就没在运行。" };
  const problems = [];
  for (const proc of running) {
    try { await kill(proc.pid); } catch (error) { problems.push("进程 " + proc.pid + "：" + error.message); }
  }
  const deadline = Date.now() + waitMs;
  while (running.some((proc) => isAlive(proc.pid)) && Date.now() < deadline) await sleep(100);
  const left = running.filter((proc) => isAlive(proc.pid));
  if (left.length) {
    return { code: 1, text: "停止失败，进程 " + pidList(left) + " 还在。" + (problems.length ? "\n" + problems.join("\n") : "") };
  }
  // 记进 mia.log：不然日志就那么断了，回头看不出是停掉的还是挂了
  note(dir, "停止美亚：结束了进程 " + pidList(running));
  return { code: 0, text: "美亚已停止（结束了进程 " + pidList(running) + "）。" };
}

// VBScript 读文件只认 ANSI 或 UTF-16LE（见 make-launchers.cjs），换行也得是 CRLF
const encodeResult = (text) => Buffer.from(String.fromCharCode(0xfeff) + String(text).replace(/\r?\n/g, "\r\n"), "utf16le");

async function main() {
  const argv = process.argv.slice(2);
  const at = argv.indexOf("--result");
  const resultFile = at >= 0 ? argv[at + 1] : "";
  let result;
  try {
    if (process.platform !== "win32") result = { code: 1, text: "后台启动器只支持 Windows。" };
    else if (argv[0] === "start") result = await start();
    else if (argv[0] === "stop") result = await stop();
    else result = { code: 1, text: "用法：node mia-background.cjs start|stop [--result 文件]" };
  } catch (error) {
    result = { code: 1, text: "出错了：" + (error?.message || error) };
  }
  if (resultFile) fs.writeFileSync(resultFile, encodeResult(result.text));
  else (result.code === 1 ? console.error : console.log)(result.text);
  process.exitCode = result.code;
}

if (require.main === module) void main();

module.exports = {
  start, stop, findMia, isMiaCommand, taskStartsHere, readFrom, encodeResult, powerShellError, launchDirect, scheduledTask,
  READY_LINE, TASK_NAME, TASK_SCRIPT, LOG_FILE, STDERR_FILE,
};
