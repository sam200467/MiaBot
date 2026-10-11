#!/usr/bin/env node
"use strict";
// 排版探针：一轮查一件 Markdown 排版上拿不准的事，在线上那个 AppID 实测。回几条对照，看完自动退出。
// 第一轮（2026-10-11）：空行只在带按钮时出现，跟 Markdown 本身无关；QQ 认 \* \_，不认 \[ \]。
// 第二轮（2026-10-11）：带按钮时第一行写成 # / ### / > 就没有开头空行，普通一行、粗体都有。
// 第三轮（2026-10-11）：指令链接 <qqbot-cmd-input show="…" /> 里的曲名能不能带 &。直接写 & 的 A2 没显示出来；
//   写成 &amp; 的 A3 显示成「C & B」，全角＆的 A4、写在链接外面的 A5 也正常。见 song-search.cjs 的 markdownLine。
// 第四轮（现在这轮）：曲名里的半角双引号能不能转义了放进 show="…"。现在《Snow in "I love you"》显示成弯引号。
//
// 部署包里带着打好的单文件版（build-deploy.cjs），在部署目录的 qq-official/ 里就能跑，
// 跟 mia-entry.cjs、config.local.json 放在一起：
//   node stop-mia.cjs                 # 先停掉美亚，免得同一个 AppID 两条网关连接互相挤
//   node probe-layout.cjs             # 然后私聊它，或在群里 @ 它随便说一句
//   （看完结果再用「启动美亚.vbs」把美亚开回来）
//
// 凭据只从同目录的 config.local.json 读，不回显 secret。

const fs = require("node:fs");
const path = require("node:path");
const { createOfficial } = require("./official-transport.cjs");

const argv = process.argv.slice(2);
const seconds = Number(argv[argv.indexOf("--seconds") + 1]) || 180;

const configPath = path.join(__dirname, "config.local.json");
if (!fs.existsSync(configPath)) {
  console.error("找不到 " + configPath + " —— 这个文件要放在 mia-entry.cjs 和 config.local.json 旁边");
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(configPath, "utf8").replace(/^﻿/, ""));
if (!String(cfg.appId || "").trim() || !String(cfg.clientSecret || "").trim()) {
  console.error("config.local.json 里 appId / clientSecret 是空的");
  process.exit(1);
}

// 第四轮：五条各带一种写法，分开发，哪条被拒只影响那一条。被动回复一条消息最多回五条，正好五条。
// 链接点了只填输入框（不发出去），填的是真的命令（《Snow in "I love you"》是 id390），回车就能核对。
const link = (command, show, quote = '"') => `<qqbot-cmd-input text=${quote}${command}${quote} show=${quote}${show}${quote} reference=${quote}false${quote} />`;
const MESSAGES = [
  ["B1｜对照：弯引号（现在的发法）", "【探针 B1】对照：弯引号，现在美亚就是这么发的\n\n" + link("/谱面分析 id390 ", "《Snow in “I love you”》")],
  ["B2｜写成 &quot;", "【探针 B2】直引号写成 HTML 转义（＆quot;）\n\n" + link("/谱面分析 id390 ", "《Snow in &quot;I love you&quot;》")],
  ["B3｜写成 &#34;", "【探针 B3】直引号写成数字转义（＆#34;）\n\n" + link("/谱面分析 id390 ", "《Snow in &#34;I love you&#34;》")],
  ["B4｜写成 \\\"", "【探针 B4】直引号前面加反斜杠\n\n" + link("/谱面分析 id390 ", "《Snow in \\\"I love you\\\"》")],
  ["B5｜属性用单引号包", "【探针 B5】属性值用单引号包，里面直接写直引号\n\n" + link("/谱面分析 id390 ", "《Snow in \"I love you\"》", "'")],
].map(([name, markdown]) => ({ name, markdown }));

console.log("appId :", cfg.appId, "（secret 不回显）");
console.log("环境  :", cfg.sandbox ? "沙箱" : "正式");
console.log("监听  :", seconds + " 秒");

const transport = createOfficial({ ...cfg, log: (m) => console.log("[传输] " + m) });
const messagePath = (target) => target.kind === "group" ? "/v2/groups/" + target.openid + "/messages" : "/v2/users/" + target.openid + "/messages";
const results = [];
let done = false;

function finish() {
  console.log("\n══════════ 结果 ══════════");
  if (!results.length) console.log("一条消息都没收到。私聊它，或在群里 @ 它一句话再跑一次。");
  for (const r of results) console.log("  " + (r.ok ? "✔" : "✘") + " " + r.name + (r.ok ? "" : "  err_code=" + (r.code ?? "?") + "  " + r.message));
  if (results.length) {
    console.log("\n回 QQ 里看这五条，截图贴回来：");
    console.log("  B2～B5 哪几条是蓝字？显示出来的是不是「Snow in \"I love you\"」（直引号），有没有多出反斜杠、＆quot; 或整段源码？");
    console.log("  点一下能显示的那几条，输入框里填进去的是不是「/谱面分析 id390 」？");
    console.log("  B1 是对照（现在的弯引号），应该正常。");
  }
  console.log("\n记得把美亚开回来（启动美亚.vbs）。");
  transport.stop();
  process.exit(0);
}

async function reply(target, msgId) {
  let seq = 0;
  for (const m of MESSAGES) {
    const payload = m.markdown
      ? { msg_type: 2, markdown: { content: m.markdown }, ...(m.keyboard ? { keyboard: { content: m.keyboard } } : {}) }
      : { msg_type: 0, content: m.text };
    try {
      await transport.rest("POST", messagePath(target), { ...payload, msg_id: msgId, msg_seq: ++seq });
      results.push({ name: m.name, ok: true });
      console.log("  ✔ " + m.name);
    } catch (error) {
      results.push({ name: m.name, ok: false, code: error.code, message: String(error.message || error) });
      console.log("  ✘ " + m.name + "：被拒 err_code " + (error.code ?? "?") + "  " + (error.message || error));
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
  setTimeout(finish, 1500);
}

(async () => {
  await transport.start((eventName, d) => {
    const shape = transport.normalize(eventName, d);
    if (done || !shape || shape.interactionId || (shape.type !== "c2c" && shape.type !== "group")) return;
    const msgId = String(d?.id || "");
    if (!msgId) return;
    done = true;
    console.log("\n收到" + (shape.type === "group" ? "群聊" : "私聊") + "消息，回五条对照：");
    reply({ kind: shape.type, openid: shape.openid }, msgId).catch((e) => { console.log("  出错：" + (e?.message || e)); finish(); });
  });
  console.log("连上了。现在私聊它，或在群里 @ 它随便说一句。");
  setTimeout(finish, seconds * 1000);
})().catch((error) => {
  console.error("\n连接失败：" + String(error?.message || error).replace(/QQBot [\w.-]+/g, "QQBot ***"));
  process.exit(1);
});
