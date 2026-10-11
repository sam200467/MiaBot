#!/usr/bin/env node
"use strict";
// 排版探针：查清两件事，各回一条对照消息，看完自动退出。
//   1. 带翻页按钮的消息开头多出来的那个空行，是 Markdown 带来的，还是按钮带来的？
//      → 同一段正文发三遍：E 是 Markdown 不带按钮，F 是 Markdown 带按钮，G 是纯文本。
//   2. QQ 的 Markdown 认不认反斜杠转义？（曲名里的 * [ ] _ 现在是转义了再发的）
//      → E、F 里有一行转义过的曲名：显示成原样的曲名就是认；冒出反斜杠就是不认。
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

// 跟公共查询现在发出去的一样：三段、段间空一行；曲名行带着需要转义的符号。
const escape = (text) => String(text).replace(/[*_]/g, (ch) => "\\" + ch);   // 跟 song-search.cjs 的 escapeMarkdown 一致
const body = (title) => [
  title,
  "筛选：歌名包含ai",
  "符合条件：25 首",
  "",
  "《ワタシConnect*》",
  "《セガサターン起動音[H.][Remix]》",
  "《ALLNIGHT_DANCER》",
  "",
  "第 1/4 页，点下面的按钮翻页吧。",
].join("\n");
// 按钮只填输入框（type 2），点了不会发出去，也不用处理回调。
const button = (id, label) => ({
  id, render_data: { label, visited_label: label, style: 1 },
  action: { type: 2, data: "探针按钮" + label, enter: false, permission: { type: 2 }, unsupport_tips: "这个版本的 QQ 不支持按钮" },
});
const MESSAGES = [
  { name: "E｜Markdown，不带按钮", markdown: escape(body("【探针 E】Markdown，不带按钮")) },
  { name: "F｜Markdown，带按钮", markdown: escape(body("【探针 F】Markdown，带按钮")), keyboard: { rows: [{ buttons: [button("next", "下一页 ▶")] }, { buttons: [button("last", "末页 ⏭")] }] } },
  { name: "G｜纯文本（对照）", text: body("【探针 G】纯文本") },
];

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
    console.log("\n回 QQ 里看这三条，截图贴回来：");
    console.log("  1. 开头空行：E 有没有？F 有没有？（G 是纯文本，应该没有）");
    console.log("  2. E、F 里的三个曲名：显示成「ワタシConnect*」「セガサターン起動音[H.][Remix]」「ALLNIGHT_DANCER」，");
    console.log("     还是冒出了反斜杠？");
    console.log("  3. E、F 里段与段之间有没有空一行？");
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
    console.log("\n收到" + (shape.type === "group" ? "群聊" : "私聊") + "消息，回三条对照：");
    reply({ kind: shape.type, openid: shape.openid }, msgId).catch((e) => { console.log("  出错：" + (e?.message || e)); finish(); });
  });
  console.log("连上了。现在私聊它，或在群里 @ 它随便说一句。");
  setTimeout(finish, seconds * 1000);
})().catch((error) => {
  console.error("\n连接失败：" + String(error?.message || error).replace(/QQBot [\w.-]+/g, "QQBot ***"));
  process.exit(1);
});
