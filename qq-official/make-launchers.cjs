#!/usr/bin/env node
"use strict";
// 生成两个无窗口启动器（照 qq/build-qq-bot.js 里那套）。
//
// VBScript 只认 ANSI 或 **UTF-16LE**：UTF-8 带 BOM 会被报「无效字符」，
// 所以这里必须写 utf16le + BOM，不能直接写文本文件。
// 引号转义也是 VBScript 的「双写」，不是 JSON 的 \"。
//
// 用法：node qq-official/make-launchers.cjs

const fs = require("node:fs");
const path = require("node:path");

const HERE = __dirname;
const vbsQuote = (value) => '"' + String(value).replace(/"/g, '""') + '"';

function writeLauncher(fileName, comment, command, visible) {
  const body = [
    "' " + comment,
    'Set shell = CreateObject("WScript.Shell")',
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    // 用脚本自身所在目录，双击时不受「起始位置」影响
    "shell.CurrentDirectory = fso.GetParentFolderName(WScript.ScriptFullName)",
    "shell.Run " + vbsQuote(command) + (visible ? ", 1, True" : ", 0, False"),
    "",
  ].join("\r\n");
  fs.writeFileSync(path.join(HERE, fileName), Buffer.from("﻿" + body, "utf16le"));
  console.log("写出 " + fileName);
}

// 美亚不需要 .bat/.exe 之类的打包 —— 直接跑 mia-entry.cjs 就行，
// 它 require 的 ws 会从仓库根的 node_modules 解析到（Node 按目录向上找）。
// 默认**显示日志窗口**：美亚的状态（连没连上、收到什么、报什么错）只有日志里看得见，
// 纯静默启动的话出了事完全不知道。入口自己也会写 mia.log，所以窗口关掉日志还在。
// 想要无窗口后台跑，用「启动美亚（后台）.vbs」。
writeLauncher("启动美亚.vbs",
  "启动美亚并显示实时日志。关掉窗口即停止。日志同时写到 mia.log。",
  "cmd /k node " + vbsQuote("mia-entry.cjs"),
  true);

writeLauncher("启动美亚（后台）.vbs",
  "无窗口后台启动美亚。日志只写到同目录 mia.log。停止：双击 停止美亚.vbs",
  "cmd /c node " + vbsQuote("mia-entry.cjs") + " > " + vbsQuote("mia.log") + " 2>&1",
  false);

writeLauncher("停止美亚.vbs",
  "停止美亚。只结束命令行里带 mia-entry 的 node 进程。",
  "cmd /c node " + vbsQuote("stop-mia.cjs") + " & timeout /t 3",
  true);
