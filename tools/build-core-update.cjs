"use strict";
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const {execFileSync}=require("node:child_process");
const root=path.resolve(__dirname,"..");
const name=process.argv[2]||"MiaBot-server-constants-update-20261004";
if(!/^[A-Za-z0-9._-]+$/.test(name))throw new Error("Invalid package name");
const skipLiveVerification=process.argv.includes("--skip-live-verification");
let liveVerified=false;
if(!skipLiveVerification){
  const proof=JSON.parse(fs.readFileSync(path.join(root,"output","otogame-live-20261003","verification.json"),"utf8"));
  liveVerified=proof.passed===true&&proof.version==="4.1.5-server-constants"&&proof.sources?.includes("u.otogame.net")&&proof.sources?.includes("rinnet");
  if(!liveVerified)throw new Error("两数据源实账号联调尚未通过；制作待联调包时显式使用 --skip-live-verification");
}
const out=path.join(root,"server-updates",name);
if(fs.existsSync(out))throw new Error("Package already exists: "+out);
const core=path.join(root,"ongeki-core.exe");
const entry=path.join(root,"output","mia-entry-server-constants.cjs");
fs.mkdirSync(path.dirname(entry),{recursive:true});
execFileSync(process.execPath,[path.join(root,"node_modules/esbuild/bin/esbuild"),path.join(root,"qq-official/mia-entry.cjs"),"--bundle","--platform=node","--format=cjs","--target=node22","--external:bufferutil","--external:utf-8-validate","--outfile="+entry],{stdio:"inherit",windowsHide:true});
const payload=path.join(out,"payload","qq-official");
fs.mkdirSync(payload,{recursive:true});
const bytes=fs.readFileSync(core);
fs.writeFileSync(path.join(payload,"ongeki-core.exe"),bytes);
const hash=crypto.createHash("sha256").update(bytes).digest("hex");
const version=fs.readFileSync(path.join(root,"app-template.js"),"utf8").match(/const VERSION\s*=\s*"([^"]+)"/)?.[1];
if(!version)throw new Error("Missing core version");
const entryBytes=fs.readFileSync(entry);
fs.writeFileSync(path.join(payload,"mia-entry.cjs"),entryBytes);
fs.writeFileSync(path.join(out,"manifest.json"),JSON.stringify({name,version,kind:"core-and-entry",platform:"win32-x64",dataSources:["u.otogame.net","rinnet"],constantSources:{otogame:"server-rating-inference-only",rinnet:"server-music-catalog-only"},liveVerified,verificationStatus:liveVerified?"passed":"pending-server-validation",files:[{path:"qq-official/ongeki-core.exe",bytes:bytes.length,sha256:hash},{path:"qq-official/mia-entry.cjs",bytes:entryBytes.length,sha256:crypto.createHash("sha256").update(entryBytes).digest("hex")}]},null,2)+"\n");
for(const file of ["Apply-Update.ps1","Restore-Backup.ps1"])fs.copyFileSync(path.join(__dirname,"core-update",file),path.join(out,file));
fs.writeFileSync(path.join(out,"Apply-Update.cmd"),'@echo off\r\nif "%~1"=="" (\r\n powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Apply-Update.ps1"\r\n) else (\r\n powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Apply-Update.ps1" -TargetRoot "%~1"\r\n)\r\nif errorlevel 1 (echo UPDATE FAILED. Read the error above.)\r\npause\r\n');
const readme=[
"MiaBot 双数据源分表定数更新（2026-10-04，v4.1.5）",
"适用于已部署的 Windows x64 MiaBot，同时更新 QQ 入口与出图核心。默认部署根目录：C:\\MiaBot\\deploy-windows-server。",
"",
"本次变化",
"大饼分表所有谱面一律根据三榜的 Rating、成绩、达成标记或白金星数还原定数，不采用本地内部或补充曲库的定数。严格匹配失败时允许原始 Rating ±1，仍须候选唯一并通过等级与跨榜校验。",
"rinnet 的新版接口没有独立单曲 Rating，因此每次分表读取服务器 musicList 中的当前定数。缺失、无效或读取失败时中止，不回退本地定数。技术分、N10 截断及 P50 计算保持 rinnet 口径。",
"两数据源均不采用本地分表定数。本地曲库仍用于其他功能和音符数量；rinnet P50 的理论分仍需有效音符数量。本地缺少曲绘时使用占位图。",
"曲库外新歌的曲绘按大饼资源哈希下载并缓存。",
liveVerified?"两数据源实账号联调已通过。":"按用户要求制作待服务器联调包，尚未进行两数据源实账号验收。请由服务器使用者验证。",
"",
"安装",
"1. 完整解压更新包到独立目录。暂停自动重启任务，停止机器人，并等待出图任务结束。",
"2. 默认路径可双击 Apply-Update.cmd。自定义路径在 PowerShell 中执行：",
'powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\\Apply-Update.ps1 -TargetRoot "D:\\实际部署目录"',
"加 -CheckOnly 可仅检查，不修改部署文件。",
"3. 看到 UPDATE COMPLETE 后，用原启动方式启动机器人，再恢复自动重启任务。",
"4. 分别用大饼和 rinnet 数据源发 /分表，核对服务器定数。其中大饼还需确认含零号车辆的分表正常生成。",
"5. 核对新歌定数、成绩与曲绘；重复查询，确认曲绘缓存可复用。记录报错文字和所用指令即可，反馈时不要附带密码或令牌。",
"此补丁补齐分表中的曲库外歌曲，不会使新歌自动进入本地单曲搜索、定数表或牌子列表。",
"",
"安装程序按 config.local.json 的 corePath 定位核心，同时更新 qq-official/mia-entry.cjs。两者一并备份和回退，保留账号绑定、配置、别名、曲绘缓存及所有其他程序。此次无需更新 QQ 指令面板。",
"",
"回退",
"停止机器人后，使用安装程序打印的 Backup 路径执行：",
'powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\\Restore-Backup.ps1 -TargetRoot "D:\\实际部署目录" -BackupPath "D:\\实际部署目录\\update-backups\\本次备份目录"',
"",
"包中只含核心及安装工具，个人成绩、账号、密码、令牌、曲绘缓存均未打包。"
];
fs.writeFileSync(path.join(out,"使用说明.txt"),"\ufeff"+readme.join("\r\n")+"\r\n");
console.log(JSON.stringify({package:out,bytes:bytes.length,sha256:hash}));
