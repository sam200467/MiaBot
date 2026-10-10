#!/usr/bin/env node
"use strict";
// Markdown 探针：实测这个机器人能不能发 Markdown 消息（msg_type=2），以及「指令链接」长什么样。
//
// 为什么要实测：社区说法互相矛盾（有说 2026-04 起已对全部机器人开放自定义 markdown，
// 也有 2026-02 实测被拒 40034012「不允许发送原生 markdown」的），只有真发一条才知道。
// /搜索歌曲 想把曲名和白谱 ID 做成「点一下就把 /谱面分析 填进输入框」的链接，前提就是这里能过。
//
// 它做什么：连上网关，等你私聊它或在群里 @ 它一句话（随便说什么），然后用那条消息的
// 被动凭据回两条 Markdown：
//   A｜新写法 <qqbot-cmd-input text="…" show="…" />，顺带测换行规则
//   B｜旧写法 [显示文字](mqqapi://aio/inlinecmd?command=…&enter=false&reply=false)
// 每条成功还是被拒（含错误码和响应原文）都打在控制台。私聊和群各测一次，测完自动退出。
//
// 用法：
//   node qq-official/stop-mia.cjs                 # 先停掉正在跑的美亚，免得同一个 AppID 两条网关连接互相挤
//   node qq-official/probe-markdown.cjs [--seconds 180]
//
// 回来要看的三件事：
//   1. 控制台：A、B 是「✔ 接受」还是「✘ 被拒 + 错误码」
//   2. 手机/电脑 QQ 上：链接显示成蓝字了吗？哪种写法能点？单个换行有没有换行？
//   3. 点一下链接：输入框里填进去的是什么？**群里有没有自动带上 @美亚**（不带的话群里发出去美亚收不到）
//
// 凭据只从 config.local.json 读，跟 probe-official.cjs 一样。

const fs = require("node:fs");
const path = require("node:path");
const { createOfficial } = require("./official-transport.cjs");

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const seconds = Number(argOf("--seconds", 180));

const configPath = path.join(__dirname, "config.local.json");
if (!fs.existsSync(configPath)) {
  console.error("找不到 qq-official/config.local.json —— 从 config.example.json 复制一份并填 appId / clientSecret");
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(configPath, "utf8").replace(/^﻿/, ""));
if (!String(cfg.appId || "").trim() || !String(cfg.clientSecret || "").trim()) {
  console.error("config.local.json 里 appId / clientSecret 是空的");
  process.exit(1);
}
if (argv.includes("--no-sandbox")) cfg.sandbox = false;

// 示例用的就是截图里那首：Perfect Shining!!，本曲 id36，两张白谱各自单独的 ID。
const SAMPLE = [
  { show: "Perfect Shining!!", command: "/谱面分析 id36 master" },
  { show: "（id8003：LUN 0）", command: "/谱面分析 id8003 白" },
  { show: "（id8091：LUN 13.8）", command: "/谱面分析 id8091 白" },
];

const attr = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const cmdInput = ({ show, command }) => `<qqbot-cmd-input text="${attr(command)}" show="${attr(show)}" reference="false" />`;
const inlineCmd = ({ show, command }) =>
  `[${show}](mqqapi://aio/inlinecmd?command=${encodeURIComponent(command)}&enter=false&reply=false)`;

const MESSAGES = [
  {
    name: "A｜新写法 qqbot-cmd-input",
    content: [
      "**Markdown 探针 A**（新写法，点蓝字应把指令填进输入框，不会直接发出）",
      "",
      "id36   " + cmdInput(SAMPLE[0]),
      "BAS 3 / ADV 6 / EXP 8 / MAS 11.5" + cmdInput(SAMPLE[1]) + cmdInput(SAMPLE[2]),
      "",
      "换行测试：这一行后面是单个换行",
      "这一行如果跟上一行挤在一起，说明单个换行不算换行",
    ].join("\n"),
  },
  {
    name: "B｜旧写法 mqqapi inlinecmd",
    content: [
      "**Markdown 探针 B**（旧写法）",
      "",
      "id36   " + inlineCmd(SAMPLE[0]),
      "",
      "BAS 3 / ADV 6 / EXP 8 / MAS 11.5" + inlineCmd(SAMPLE[1]) + inlineCmd(SAMPLE[2]),
    ].join("\n"),
  },
];

console.log("appId :", cfg.appId, "（secret 不回显）");
console.log("环境  :", cfg.sandbox ? "沙箱 sandbox.api.sgroup.qq.com（只有沙箱成员能触发）" : "正式 api.bot.qq.com");
console.log("监听  :", seconds + " 秒");
console.log("");

const transport = createOfficial({ ...cfg, log: (m) => console.log("[传输] " + m) });
const tested = new Map();   // "c2c" | "group" -> [{ name, ok, code, message, payload }]
const KIND = { group: "群聊", c2c: "私聊", channel: "QQ频道" };

async function runFor(target, msgId) {
  const results = [];
  tested.set(target.kind, results);
  console.log("\n── 在" + KIND[target.kind] + "里回两条 Markdown（凭据 " + msgId + "）──");
  let seq = 0;
  for (const { name, content } of MESSAGES) {
    const body = { msg_type: 2, markdown: { content }, msg_id: msgId, msg_seq: ++seq };
    const path = target.kind === "group" ? "/v2/groups/" + target.openid + "/messages" : "/v2/users/" + target.openid + "/messages";
    try {
      await transport.rest("POST", path, body);
      results.push({ name, ok: true });
      console.log("  ✔ " + name + "：平台接受了");
    } catch (error) {
      const r = { name, ok: false, status: error.status, code: error.code, message: String(error.message || error), payload: error.payload };
      results.push(r);
      console.log("  ✘ " + name + "：被拒 HTTP " + (r.status ?? "?") + "，err_code " + (r.code ?? "（无）"));
      console.log("    " + r.message);
      if (r.payload) console.log("    响应原文：" + JSON.stringify(r.payload).slice(0, 400));
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
  if (tested.has("c2c") && tested.has("group")) setTimeout(finish, 2000);
  else console.log("\n  还可以去" + (target.kind === "group" ? "私聊" : "群里 @ ") + "它一下，测另一种场景。");
}

function finish() {
  console.log("\n══════════ 结果 ══════════");
  if (!tested.size) {
    console.log("一条消息都没收到。私聊它，或在群里 @ 它一句话再跑一次。沙箱环境要先把自己加进沙箱成员。");
  }
  for (const [kind, results] of tested) {
    console.log(KIND[kind] + "：");
    for (const r of results) console.log("  " + (r.ok ? "✔" : "✘") + " " + r.name + (r.ok ? "" : "  err_code=" + (r.code ?? "?")));
  }
  const all = [...tested.values()].flat();
  if (all.some((r) => r.code === 40034012)) {
    console.log("\n出现 40034012「不允许发送原生 markdown」：这个机器人还没有 Markdown 权限。");
    console.log("  → 去 q.qq.com 开放平台看「开发 → 高阶能力」有没有 Markdown 的开关/申请入口，");
    console.log("    沙箱下确认自己在沙箱成员里；仍不行就到 QQ 开发者社区问官方。");
  } else if (all.length && all.every((r) => r.ok)) {
    console.log("\n全部被接受。接下来在 QQ 里看：哪种写法显示成可点的蓝字、点了填进输入框的是什么、群里带没带 @。");
  }
  console.log("\n把这段结果和 QQ 里的截图一起贴回来。");
  transport.stop();
  process.exit(0);
}

(async () => {
  await transport.start((eventName, d) => {
    const shape = transport.normalize(eventName, d);
    if (!shape || (shape.type !== "c2c" && shape.type !== "group")) return;
    if (tested.has(shape.type)) return;
    const msgId = String(d?.id || "");
    if (!msgId) return;
    console.log("\n收到" + KIND[shape.type] + "消息：" + shape.content.slice(0, 40));
    runFor({ kind: shape.type, openid: shape.openid }, msgId).catch((e) => console.log("  出错：" + (e?.message || e)));
  });
  console.log("连上了。现在私聊它，或在群里 @ 它随便说一句。");
  setTimeout(finish, seconds * 1000);
})().catch((error) => {
  console.error("\n连接失败：" + String(error?.message || error).replace(/QQBot [\w.-]+/g, "QQBot ***"));
  process.exit(1);
});
