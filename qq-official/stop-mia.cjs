"use strict";
// 停止美亚。
//
// 只结束命令行里带 mia-entry 的 node 进程 —— **绝不能用 taskkill /IM node.exe**，
// 那会把机器上所有 node 进程（编辑器插件、别的开发工具）一起干掉。
//
// 用 PowerShell 而不是 wmic：wmic 已被微软弃用，Windows 11 较新版本上直接没有这个命令。

const { execFileSync } = require("node:child_process");

const POWERSHELL = [
  "$ErrorActionPreference = 'Stop'",
  "try {",
  "  $targets = Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" |",
  "    Where-Object { $_.CommandLine -like '*mia-entry*' }",
  "  if (-not $targets) { Write-Output 'NOT_RUNNING'; exit 0 }",
  "  foreach ($p in $targets) {",
  "    Write-Output ('KILLED ' + $p.ProcessId)",
  "    Stop-Process -Id $p.ProcessId -Force",
  "  }",
  "} catch { Write-Output ('ERROR ' + $_.Exception.Message); exit 1 }",
].join("\n");

let output;
try {
  output = execFileSync("powershell", ["-NoProfile", "-Command", POWERSHELL], { encoding: "utf8" }).trim();
} catch (error) {
  console.error("停止失败：" + (error.message || error));
  process.exitCode = 1;
  return;
}

if (output === "NOT_RUNNING") {
  console.log("美亚没在跑（没有找到 mia-entry 进程）。");
} else if (output.startsWith("ERROR")) {
  console.error("停止失败：" + output.slice(6));
  process.exitCode = 1;
} else {
  for (const line of output.split(/\r?\n/)) if (line.startsWith("KILLED")) console.log("已结束进程 " + line.slice(7));
  console.log("美亚已停止。");
}
