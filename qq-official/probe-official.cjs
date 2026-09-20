#!/usr/bin/env node
"use strict";
// 官方接口连接探针：验证凭据、网关、会话，并把收到的事件原样打出来。
// 与 qq/probe-napcat.cjs 同一个用途 —— 排查连接问题时先跑它。
//
// 它同时是**上线前的闸门**：有三件事官方没有文档、只能实测，测试里用假 payload
// 证明不了。这三件事全在这里量：
//
//   闸门 1｜双投递的键 —— GROUP_MESSAGE_CREATE 和 GROUP_AT_MESSAGE_CREATE 会不会
//           对同一条消息各推一次？推两次的话，两次的 d.id 是同一个值吗？
//           这决定 mia-commands.cjs 里幂等闸的 messageKey 该取哪个字段。
//   闸门 2｜mentions 的真实形状 —— 群里「到底 @ 没 @ 到美亚」靠它判。
//           官方没有文档，所以这里把原始数组打出来，并和机器人自己的 id 对照。
//   闸门 3｜被动凭据能不能借用 —— 延迟发出的图片能不能拿「群里别人的消息」当
//           msg_id。这个**必须真发一条**才知道，所以做成显式开关，默认不跑。
//
// 用法：
//   node qq-official/probe-official.cjs [--seconds 120]
//   node qq-official/probe-official.cjs --probe-credential   # 闸门 3，会在群里发消息
//
// 拿 group_openid 的办法：把它拉进群，在群里 @ 它一次，探针会把事件打出来。
//
// 凭据只从 config.local.json 读，不接受命令行参数 —— 免得密钥进 shell 历史和进程列表。

const fs = require("node:fs");
const path = require("node:path");
const { createOfficial } = require("./official-transport.cjs");

const HERE = __dirname;
const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const seconds = Number(argOf("--seconds", 120));
const probeCredential = argv.includes("--probe-credential");

const configPath = path.join(HERE, "config.local.json");
if (!fs.existsSync(configPath)) {
  console.error("找不到 qq-official/config.local.json —— 从 config.example.json 复制一份并填 appId / clientSecret");
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
if (!String(cfg.appId || "").trim() || !String(cfg.clientSecret || "").trim()) {
  console.error("config.local.json 里 appId / clientSecret 是空的");
  process.exit(1);
}
if (argv.includes("--no-sandbox")) cfg.sandbox = false;

console.log("appId      :", cfg.appId, "（secret 不回显）");
console.log("环境       :", cfg.sandbox ? "沙箱 sandbox.api.sgroup.qq.com" : "正式 api.bot.qq.com");
console.log("监听       :", seconds + " 秒");
if (probeCredential) {
  console.log("⚠ 闸门 3 已开启：探针会在群里**真发一条消息**来测被动凭据能不能借用。");
}
console.log("");

const truncate = (value, n) => {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s && s.length > n ? s.slice(0, n) + "…" : s;
};

// ── 收集到的样本，最后统一分析 ──────────────────────────────────────
const records = [];
let botIdentity = null;

function fingerprint(eventName, d) {
  // 双投递的两次事件，`d` 里稳定不变的那些字段拼一个指纹。
  // 用内容 + 发送者 + 群，而**不是用 id** —— 用 id 拼就等于假设了要验证的结论。
  //
  // ⚠ 内容必须先归一化：AT 事件的 content 很可能已经把「@美亚」摘掉了，
  // 而全量事件还留着 @ 的痕迹（或者反过来）。不归一化的话同一句话两条事件的
  // 指纹对不上，双投递就看不出来 —— 而「看不出来」会被误读成「没有双投递」。
  const group = d?.group_openid || d?.channel_id || "?";
  const who = d?.author?.member_openid || d?.author?.id || d?.author?.user_openid || "?";
  const text = String(d?.content || "")
    .replace(/<@!?[^>]*>/g, "")   // <@!1234> 这类结构化 @ 标记
    .replace(/@\S+/g, "")          // 纯文本的 @某某
    .replace(/\s+/g, "")           // 空格差异也不该影响配对
    .slice(0, 30);
  return group + "|" + who + "|" + text;
}

let frames = 0, beats = 0;
const transport = createOfficial({
  ...cfg,
  log: (m) => console.log("[传输] " + m),
  // 帧级探针：确认网关上到底有没有东西过来。心跳只计数不逐条打，免得刷屏。
  onFrame: (f) => {
    frames++;
    if (f.op === 11) { beats++; return; }
    if (f.op === 1) return;
    const bits = ["op=" + f.op];
    if (f.t) bits.push("t=" + f.t);
    if (f.d?.session_id) bits.push("session=" + f.d.session_id);
    if (f.d?.shard) bits.push("shard=" + JSON.stringify(f.d.shard));
    // READY 里带着机器人自己的身份 —— 闸门 2 要拿它跟 mentions 对照
    if (f.t === "READY" && f.d?.user) {
      botIdentity = f.d.user;
      bits.push("botId=" + f.d.user.id);
      bits.push("botName=" + (f.d.user.username || "?"));
    }
    console.log("[帧 #" + frames + "] " + bits.join(" "));
  },
});

// 闸门 3：借用被动凭据。必须真发一条才知道平台认不认。
//
// 要验的场景是**延迟发图**：图是几分钟前那条指令触发的，等图出来时那条的被动窗口
// 可能已经过期（群只有 5 分钟）。补救办法是改用「这个目标最新一条消息」的凭据发出去，
// 但引用仍指向原始那条请求。
//
// ⚠ 所以**不能**拿第一条的凭据发第二条 —— 那是在验「延迟发一条旧凭据」，
// 而实际要验的是「用新凭据发旧请求」。这里记下第一条，等第二条来了，
// 用**第二条的 msg_id**（新鲜凭据）配上**第一条的 refId**（引用指向原始请求）发一条。
// msg_id 和 message_reference 是独立字段，平台认不认这种搭配就是结论本身。
let firstGroup = null, credentialResult = null;
function maybeProbeCredential(d, eventName) {
  if (!probeCredential || credentialResult) return;
  if (!/GROUP/.test(eventName)) return;
  const id = String(d?.id || "");
  if (!id) return;
  const ext = Array.isArray(d?.message_scene?.ext) ? d.message_scene.ext : [];
  let refId = null;
  for (const item of ext) if (String(item).startsWith("msg_idx=")) refId = String(item).slice("msg_idx=".length);

  if (!firstGroup) { firstGroup = { id, refId, group: d.group_openid, at: Date.now() }; return; }
  if (id === firstGroup.id) return;
  credentialResult = {
    status: "sending",
    freshId: id,                    // 新凭据：这条刚到，一定在窗口内
    originalRefId: firstGroup.refId, // 引用仍指向最早那条请求
    group: d.group_openid,
    gapMs: Date.now() - firstGroup.at,
  };
}

(async () => {
  const t0 = Date.now();
  await transport.start((eventName, d) => {
    const shape = transport.normalize(eventName, d);
    const KIND = { group: "群聊", c2c: "单聊", channel: "QQ频道" };

    console.log("\n── 原始事件 #" + (records.length + 1) + "：" + eventName + " ──");
    // 先无条件打一行原始信息 —— 归一化失败的事件同样要看得见，
    // 否则「平台推了但我们认不出」会被误判成「平台什么都没推」。
    if (!shape) {
      console.log("  ⚠ 未归一化的事件。原始键：" + Object.keys(d || {}).join(","));
      console.log("  原始内容（截断）:", truncate(d, 300));
      return;
    }

    const msgIdx = (() => {
      const ext = d?.message_scene?.ext;
      if (!Array.isArray(ext)) return "";
      for (const item of ext) if (String(item).startsWith("msg_idx=")) return String(item).slice("msg_idx=".length);
      return "";
    })();

    console.log("  类型     :", KIND[shape.type] || shape.type);
    console.log("  目标 id  :", shape.openid, shape.type === "group" ? "（group_openid，填进 allowedGroupIds）" : shape.type === "channel" ? "（channel_id）" : "（user_openid）");
    console.log("  发送者   :", shape.userId);
    console.log("  内容     :", shape.content.slice(0, 80));
    console.log("  d.id     :", String(d?.id || "（没有）"), "← 被动回复凭据");
    console.log("  msg_idx  :", msgIdx || "（没有）", "← 引用对象，两者**不是**同一个字段");
    console.log("  是@触发  :", shape.mentioned, "（这个字段只说明事件类型，不说明 @ 了谁）");

    // 闸门 2 的关键：mentions 原样打出来 + 和机器人自己对照
    const mentions = Array.isArray(d?.mentions) ? d.mentions : null;
    if (mentions) {
      console.log("  mentions :", truncate(mentions, 240));
      if (botIdentity) {
        const ids = mentions.map((m) => String(m?.id ?? m?.user_openid ?? m?.member_openid ?? ""));
        console.log("  认出自己 :", ids.includes(String(botIdentity.id))
          ? "✔ 有 mentions[].id 等于机器人 id（" + botIdentity.id + "）"
          : "✘ mentions 里没有 " + botIdentity.id + " —— 得看上面的原始形状另找判据");
      } else {
        console.log("  认出自己 : 还不知道机器人 id（没收到 READY）");
      }
    } else {
      console.log("  mentions : （没有这个字段）");
    }
    console.log("  author   :", truncate(d?.author, 160));
    console.log("  指纹     :", fingerprint(eventName, d));

    records.push({
      eventName, id: String(d?.id || ""), msgIdx,
      print: fingerprint(eventName, d),
      mentions: mentions ? mentions.map((m) => String(m?.id ?? m?.user_openid ?? m?.member_openid ?? "")) : null,
      mentionsSelf: mentions ? mentions.some((m) => m?.is_you === true) : false,
    });

    maybeProbeCredential(d, eventName);
    if (credentialResult && credentialResult.status === "sending") {
      const job = credentialResult;
      job.status = "done";
      console.log("\n  ⚠ 闸门 3：用**这条新消息**的 msg_id 当被动凭据，引用仍指向最早那条请求……");
      console.log("     凭据（新）:", job.freshId);
      console.log("     引用（旧）:", job.originalRefId || "（最早那条没有 msg_idx，只发凭据不给引用）");
      console.log("     两条相隔  :", Math.round(job.gapMs / 1000) + " 秒");
      transport.sendText({ kind: "group", openid: job.group },
        "（探针在测被动凭据复用，收到请忽略）", job.freshId, job.originalRefId)
        .then(() => { job.ok = true; console.log("  ✔ 被接受了 —— 可以用新消息的凭据补发旧请求的结果"); })
        .catch((error) => { job.ok = false; job.error = String(error?.message || error); console.log("  ✘ 被拒了：" + job.error); });
    }
  });

  console.log("\n连上了（" + (Date.now() - t0) + "ms）。");
  console.log("现在去群里 @ 它一下（开了全量群消息的群，普通消息也会推过来）。\n");

  setTimeout(async () => {
    console.log("\n══════════ 观察窗口结束，收到 " + records.length + " 个事件 ══════════");
    if (!records.length) {
      console.log("一个事件都没有。常见的三个原因：");
      console.log("  1. 没把机器人拉进群（或没加好友）—— 沙箱环境还要在开放平台配沙箱成员");
      console.log("  2. 群里没 @ 它 —— 只有 GROUP_AT_MESSAGE_CREATE 是默认推送的");
      console.log("  3. 沙箱配置的成员/群和实际用的不是同一批");
      return finish();
    }

    // ── 闸门 1 ──────────────────────────────────────────────────────
    console.log("\n【闸门 1】双投递的键 —— 决定幂等闸用 d.id 还是 msg_idx");
    const byPrint = new Map();
    for (const r of records) {
      const list = byPrint.get(r.print) || [];
      list.push(r);
      byPrint.set(r.print, list);
    }
    let doubled = 0;
    for (const [print, list] of byPrint) {
      if (list.length < 2) continue;
      doubled++;
      const names = [...new Set(list.map((x) => x.eventName))];
      const ids = [...new Set(list.map((x) => x.id))];
      const idxs = [...new Set(list.map((x) => x.msgIdx).filter(Boolean))];
      console.log("  · 同一条消息收到 " + list.length + " 次，事件名 " + names.join(" + "));
      console.log("    d.id    ：" + (ids.length === 1 ? "✔ 两次相同（" + ids[0] + "）→ 幂等闸取 d.id 就对" : "✘ 不同：" + ids.join(" / ")));
      if (idxs.length > 1) console.log("    msg_idx ：✘ 也不同：" + idxs.join(" / "));
      else if (idxs.length === 1) console.log("    msg_idx ：两次相同（" + idxs[0] + "）");
    }
    if (!doubled) {
      console.log("  这一轮没抓到双投递 —— 同一条消息没有以两种事件名各来一次。");
      console.log("  ⚠ 但要注意平台的**事件名会随群设置切换**（实测 2026-09-19）：");
      console.log("     没开「获取群内全部消息」→ @ 消息走 GROUP_AT_MESSAGE_CREATE，且没有 mentions 字段；");
      console.log("     开了之后　　→ @ 消息改走 GROUP_MESSAGE_CREATE，带 mentions（is_you=true），AT 事件不再推。");
      console.log("     所以「两种事件名都出现过」**不等于**双投递，要按指纹配对看，别按事件名数数。");
      console.log("  结论：d.id 作为幂等键是安全的。幂等闸留着当保险（万一平台哪天改成两种都推）。");
    }
    const allIds = records.map((r) => r.id).filter(Boolean);
    console.log("  参考：本轮 " + records.length + " 个事件，d.id 去重后 " + new Set(allIds).size + " 个。");

    // ── 闸门 2 ──────────────────────────────────────────────────────
    console.log("\n【闸门 2】mentions 的形状 —— 决定「群里确实 @ 到美亚」怎么判");
    const withMentions = records.filter((r) => r.mentions && r.mentions.length);
    if (!withMentions.length) {
      console.log("  本轮没有任何事件带 mentions。");
      console.log("  → 这通常意味着这个群没开「获取群内全部消息」：");
      console.log("     实测那种情况下 @ 消息走 GROUP_AT_MESSAGE_CREATE，**正文里连 mentions 字段都没有**，");
      console.log("     只能靠事件类型本身判「@ 到了」。代码里那条兜底就是给这种情况用的。");
    } else {
      const selfCount = withMentions.filter((r) => r.mentionsSelf).length;
      const otherCount = withMentions.length - selfCount;
      console.log("  带 mentions 的事件：" + withMentions.length + " 条（其中 " + selfCount + " 条 @ 的是美亚自己）");
      console.log("  **判据是 `is_you`，不是 id** —— 平台直接告诉你「这个 @ 的就是你自己」。");
      console.log("  实测：mentions 里的 id 和 READY 给的 botId **不是一套 id 空间**");
      console.log("        （READY 是数字号" + (botIdentity ? " " + botIdentity.id : "") + "，mentions 是 openid），拿它们比对永远不会命中。");
      if (otherCount) {
        console.log("  ⚠ 有 " + otherCount + " 条 mentions 里 @ 的是**别人**（is_you=false）。");
        console.log("    实测收到过另一只 bot 被 @ 的 /login —— 判据用「mentions 非空」的话就会去抢答别人的指令。");
      }
      console.log("  → 代码已经按 is_you 实现了（official-transport.cjs 的 extractMentions）；");
      console.log("     config 里的 botOpenid 可以删掉，它已经用不上了。");
    }

    // ── 闸门 3 ──────────────────────────────────────────────────────
    console.log("\n【闸门 3】被动凭据能不能借用 —— 决定 reuseLatestPassiveCredential");
    if (!probeCredential) {
      console.log("  没开（默认）。要测就加 --probe-credential，注意它会在群里真发一条消息。");
      console.log("  → 保持 reuseLatestPassiveCredential=false。");
    } else if (!credentialResult) {
      console.log("  没测成：这个窗口里同一目标只收到一条消息，凑不出「用别人的凭据」这个场景。");
      console.log("  → 保持 false。");
    } else if (credentialResult.ok) {
      console.log("  ✔ 平台接受：可以用「最新一条消息」的凭据补发更早那条请求的结果。");
      console.log("    → 可以把 reuseLatestPassiveCredential 改成 true。");
      console.log("    （注意它只在「群里在那之后有人说过话」时才有新鲜凭据可用；");
      console.log("     没人说话的话照样过期，所以它不是万能补丁。）");
    } else {
      console.log("  ✘ 平台拒绝：" + (credentialResult.error || "（无错误信息）"));
      console.log("  → 保持 reuseLatestPassiveCredential=false。");
    }

    console.log("\n把这一整段贴回来就能定下三个开关。");
    finish();
  }, seconds * 1000);

  function finish() {
    transport.stop();
    process.exit(0);
  }
})().catch((error) => {
  const msg = String(error?.message || error);
  console.error("\n连接失败：" + msg.replace(/R4hLze[A-Za-z0-9]*/g, "***").replace(/QQBot [\w.-]+/g, "QQBot ***"));
  console.error("\n常见原因：");
  console.error("  · appId / clientSecret 不对（HTTP 401 / 100007）");
  console.error("  · 机器人还没通过审核，正式环境不可用 —— 先用沙箱（config 里 sandbox: true）");
  console.error("  · 沙箱模式下要先在开放平台把测试账号加进沙箱成员");
  process.exit(1);
});
