#!/usr/bin/env node
"use strict";
// 排版探针：带翻页按钮的 Markdown 消息开头会多出一个空行，找一种能去掉它的开头写法。回五条对照，看完自动退出。
// 第一轮（2026-10-11）已查明：空行只在带按钮时出现，跟 Markdown 本身无关；QQ 认 \* \_，不认 \[ \]。
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

// 第二轮：开头空行只在带按钮时出现（第一轮 E/F/G 已确认），但别的机器人（提比）开头是标题，点按钮翻页也不空行。
// 所以五条都带按钮，只改第一行的写法，看哪种能把空行去掉：
//   H1 对照（跟现在一样，普通一行） / H2 大标题 # / H3 小标题 ### / H4 粗体 / H5 引用 >
const rest = [
  "筛选：歌名包含ai",
  "符合条件：25 首",
  "",
  "《Ai C》",
  "《Ai Drew》",
  "",
  "第 1/4 页，点下面的按钮翻页吧。",
].join("\n");
// 按钮只填输入框（type 2），点了不会发出去，也不用处理回调。
const button = (id, label) => ({
  id, render_data: { label, visited_label: label, style: 1 },
  action: { type: 2, data: "探针按钮" + label, enter: false, permission: { type: 2 }, unsupport_tips: "这个版本的 QQ 不支持按钮" },
});
const keyboard = { rows: [{ buttons: [button("next", "下一页 ▶")] }, { buttons: [button("last", "末页 ⏭")] }] };
// 标题、引用后面要空一行，不然下一行会被并进标题/引用里。
const MESSAGES = [
  ["H1｜对照：普通一行", "【探针 H1】查到啦，给你整理在这里♪\n"],
  ["H2｜大标题 #", "# 【探针 H2】查到啦\n\n"],
  ["H3｜小标题 ###", "### 【探针 H3】查到啦\n\n"],
  ["H4｜粗体", "**【探针 H4】查到啦，给你整理在这里♪**\n"],
  ["H5｜引用 >", "> 【探针 H5】查到啦，给你整理在这里♪\n\n"],
].map(([name, head]) => ({ name, markdown: head + rest, keyboard }));

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
    console.log("  哪几条开头没有空行？（H1 是现在的写法，应该有空行）");
    console.log("  标题（H2、H3）的字号能不能接受？");
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
