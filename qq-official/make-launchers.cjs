#!/usr/bin/env node
"use strict";
// 生成美亚的两个无窗口启动器（跟 AnnaBot 的 tools/make-launchers.cjs 同一套）：
//   启动美亚.vbs  美亚在后台跑，没有窗口。已经有美亚在跑就不再开 —— 同一个 AppID 连两次，每句话会回两遍。
//                 有计划任务 MiaBot（服务器上开机自启的那个）就交给它启动，注销远程桌面也不会停。
//   停止美亚.vbs  停掉在跑的美亚，连同她开的出图核心和浏览器；别的 node 程序不动。
// .vbs 只是壳：真正干活的是同目录的 mia-background.cjs，.vbs 把它藏起来跑完，再按退出码弹窗说结果。
// 以前带实时日志窗口的启动器和「启动美亚（后台）.vbs」都不要了（2026-11-01 用户定的：跟 Anna 一样只留一个启动脚本），
// 生成时顺手删掉旧的「启动美亚（后台）.vbs」。要看日志就开 mia.log。
// 生成的 .vbs 不进仓库。里面只有相对路径，挪了目录也不用重新生成。
//
// VBScript 只认 ANSI 或 **UTF-16LE**：UTF-8 带 BOM 会被报「无效字符」，所以这里必须写 utf16le + BOM，不能直接写文本文件。
// 引号转义也是 VBScript 的「双写」，不是 JSON 的 \"。
//
// 用法：node qq-official/make-launchers.cjs [输出目录，默认 qq-official/]
// build-deploy.cjs 用同一个 writeLaunchers 往部署包里写。

const fs = require("node:fs");
const path = require("node:path");

const HERE = __dirname;
const BOM = String.fromCharCode(0xfeff);
const OBSOLETE = ["启动美亚（后台）.vbs"];
const vbsQuote = (value) => '"' + String(value).replace(/"/g, '""') + '"';

// 弹窗：成功的 5 秒后自己关；出了问题的（退出码 1 失败、2 要人看一眼）一直留着等人点。
// 4096 是「系统模态」，弹窗盖在别的窗口上面：启动要等几秒，这期间点了别处的话，普通弹窗会被压在底下。
function launcher(comment, action) {
  return [
    ...comment.map((line) => "' " + line),
    "' 这个文件是 qq-official/make-launchers.cjs 生成的，改了会被覆盖。",
    "Option Explicit",
    "Dim shell, fso, result, code, text",
    'Set shell = CreateObject("WScript.Shell")',
    'Set fso = CreateObject("Scripting.FileSystemObject")',
    "' 用脚本自己所在的目录，双击时不受「起始位置」影响",
    "shell.CurrentDirectory = fso.GetParentFolderName(WScript.ScriptFullName)",
    "result = fso.BuildPath(fso.GetSpecialFolder(2), fso.GetTempName())",
    "On Error Resume Next",
    "code = shell.Run(" + vbsQuote("node mia-background.cjs " + action + ' --result "') + " & result & " + vbsQuote('"') + ", 0, True)",
    // 找不到 node 时 Err.Description 是空的（Anna 那边实测），不拼进去
    "If Err.Number <> 0 Then",
    '  shell.Popup "运行不了 node，先装 Node.js 22 或更新的版本。", 0, "美亚", 16 + 4096',
    "  WScript.Quit 1",
    "End If",
    "On Error GoTo 0",
    'text = "没拿到结果（退出码 " & code & "）。"',
    "If fso.FileExists(result) Then",
    "  ' 结果是 UTF-16LE（-1），空文件 ReadAll 会报错",
    "  If fso.GetFile(result).Size > 2 Then",
    "    With fso.OpenTextFile(result, 1, False, -1)",
    "      text = .ReadAll",
    "      .Close",
    "    End With",
    "  End If",
    "  fso.DeleteFile result",
    "End If",
    "If code = 0 Then",
    '  shell.Popup text, 5, "美亚", 64 + 4096',
    "ElseIf code = 2 Then",
    '  shell.Popup text, 0, "美亚", 48 + 4096',
    "Else",
    '  shell.Popup text, 0, "美亚", 16 + 4096',
    "End If",
  ].join("\r\n") + "\r\n";
}

function buildLaunchers() {
  return {
    "启动美亚.vbs": launcher([
      "无窗口启动美亚。已经有美亚在跑就不再开第二个；连上 QQ 了、没起来，都会弹窗说一声。",
      "有计划任务 MiaBot 时交给它启动。日志在同目录 mia.log。停止：双击「停止美亚.vbs」。",
    ], "start"),
    "停止美亚.vbs": launcher([
      "停止美亚：结束命令行里带 mia-entry 的 node 进程，连同她开的出图核心和浏览器，别的 node 程序不动。",
    ], "stop"),
  };
}

const encode = (text) => Buffer.from(BOM + text, "utf16le");

// 写进 dir（默认 qq-official/），再删掉 dir 里已经不用的旧启动器。返回写出的文件名。
function writeLaunchers(dir = HERE) {
  const written = Object.entries(buildLaunchers()).map(([name, text]) => {
    fs.writeFileSync(path.join(dir, name), encode(text));
    return name;
  });
  for (const name of OBSOLETE) fs.rmSync(path.join(dir, name), { force: true });
  return written;
}

if (require.main === module) {
  const dir = path.resolve(process.argv[2] || HERE);
  for (const name of writeLaunchers(dir)) console.log("写出 " + name);
  console.log("双击「启动美亚.vbs」在后台启动美亚，「停止美亚.vbs」停掉她。真正干活的是同目录的 mia-background.cjs，要放在一起。");
}

module.exports = { buildLaunchers, writeLaunchers, encode, OBSOLETE };
