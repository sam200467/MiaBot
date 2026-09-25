#!/usr/bin/env node
"use strict";
// 真模型校准：美亚会不会该办的办、该问的问？
//
// 设计上刻意的分界（写在 mia-entry.cjs 的 ability 里）：
//   · 「id870 的定数是多少」     —— **没说难度**。该先问「哪个难度」，不是硬调，
//                                   也不是摆手说「美亚记不住」（那个口径已经废弃）。
//   · 「id870 master 的定数是多少」—— 说清楚了。**该调工具**。
//   · 「帮我查一下 id870」        —— 明着让办，而且单曲图本来就不分难度。**该调工具**，
//                                   别反过来追问难度（实测做过头过）。
// 这条界线是模型判断，不是硬保证，所以必须拿真模型实测，不能靠读提示词想象。
//
// ⚠ 这个脚本**会真的调 DeepSeek**（花钱，但只调模型，不碰 QQ、不碰出图核心）。
//    它走的是 createMiaBot 的完整链路 —— 校准的是**生产用的那份提示词**
//    （ability + actions + chat.cjs 拼的 actionRule），不是另抄一份，免得两边漂移。
//
// 用法：node qq-official/calibrate-tools.cjs [--only 关键字]

const path = require("node:path");
const core = require("../mia-core.cjs");
const { loadConfig, createMiaBot } = require("./mia-entry.cjs");

const HERE = __dirname;
const argv = process.argv.slice(2);
const onlyAt = argv.indexOf("--only");
const only = onlyAt >= 0 ? String(argv[onlyAt + 1] || "") : "";

// expect 是**设计意图**，不是断言 —— 输出是给人读的表，判断要人来做。
// 校准的意义在于看它错在哪一类，不是拿到一个红绿。
const PROBES = [
  // ── 信息不全：**期望它先问，不是硬调** ──────────────────────────
  // 这几条曾经被写成「不该调工具，照实说记不住」—— 那是错的，已经撤掉。
  // 「id870 的定数是多少」真正的毛病不是「她在不在行」，而是**没说难度**：
  // 一首歌好几个难度、每个难度一个定数。正确反应是先问一句是哪个难度，
  // 而不是把自己的活儿推掉，更不是自己挑一个难度算出来。
  { text: "id870 的定数是多少", expect: false, why: "没说难度，该先问「哪个难度」" },
  // 这两条**问法和上面那条等价，但两种做法都算对**：先问哪个难度可以，
  // 直接出「单曲全难度成绩图」也可以 —— 那张图把每个难度都列出来了，等于一并回答了。
  // 实测它会选后者。expect=null 表示不判定，别让脚本自己喊狼来了。
  { text: "VIIIbit Explorer 这首歌几级啊", expect: null, why: "问难度或直接出全难度图都算对" },
  { text: "这歌定数多少来着", expect: null, why: "同上，更口语的说法" },

  // ── 信息给全了：该调工具 ────────────────────────────────────────
  // 上面那几条的反面。有这一条才能证明「不调」是因为缺信息，而不是因为不肯干活。
  { text: "id870 master 的定数是多少", expect: true, why: "难度给了，就该去查" },
  { text: "帮我查一下 id870", expect: true, why: "明着让办" },
  { text: "给我出张 b110 分表", expect: true, why: "要图，顺带验 b110 认不认" },
  { text: "算一下 14.2 打 1000737，铃铛 fb，连击 fc", expect: true, why: "四样给全了，该算" },
  { text: "帮我把 id870 的别名设成八爪鱼", expect: true, why: "要写数据，顺带验空格格式" },

  // ── 参数不全的 Rating：期望它先问 ───────────────────────────────
  // 实测抓出来的真问题：头一次跑它回来问铃铛和连击（对），第二次跑它**自己把铃铛
  // 补成 fb、连击补成 fc 就去算了**。那是替用户编输入，算出来的 Rating 会被当成
  // 事实报出去，而那两个值用户从没说过。程序侧另有一道闸（mia-commands 的
  // hasFullCalculateArgs）兜底，但提示词也该自己站住。
  // ⚠ 模型不是确定性的，单次通过不算数，要连着跑几轮看。
  { text: "算一下 14.2 打 1000737 能有多少 rating", expect: false, why: "只给了两个参数，该先问铃铛和连击（实测抓到过它自己补 fb/fc）" },

  // 注：别名候选/驳回/删除刻意**不在**工具清单里（CAPABILITY_SPECS 里就没有它们，
  // 跟梨绪保持一致：删除类操作只走指令）。所以不拿它做探针 —— 模型只能在邻居里挑，
  // 挑得不准也不算它的错。那几条的边界由命令路径自己守着。

  // ── 都不是：闲聊，不该调工具 ────────────────────────────────────
  { text: "美亚你好呀", expect: false, why: "打招呼" },
  { text: "在吗", expect: false, why: "寒暄——status 那条能力专门写了防误触" },
  { text: "你觉得我像什么水果？", expect: false, why: "闲聊，她的招牌" },
];

// ── 桩传输层 ────────────────────────────────────────────────────────
// 不连 QQ、不发任何东西，只把出站内容记下来。
//
// ⚠ normalize 必须用**真实实现**。它是 handleEvent 的第一道，
// 桩成 `() => null` 的话每条消息都会被当成「认不出的帧」直接丢掉 ——
// 症状是所有探针 0ms 返回空结果，看起来像模型没调工具，其实是压根没走到模型。
// 这里借一个没启动过的真传输层来拿它的 normalize（构造不产生任何 I/O）。
function stubTransport(realNormalize) {
  const sent = [];
  return {
    sent,
    state: { connected: true, appId: "calibration", sessionId: "stub" },
    healthy: () => true,
    normalize: realNormalize,
    async start() {}, stop() {},
    async sendText(target, text, msgId, refId) {
      sent.push({ kind: "text", text: String(text), msgId, refId });
      return { id: "stub-" + sent.length };
    },
    async sendImage(target, image, msgId, caption) {
      sent.push({ kind: "image", caption: String(caption || ""), msgId });
      return { id: "stub-" + sent.length };
    },
  };
}

(async () => {
  const config = loadConfig();
  const { createOfficial } = require("./official-transport.cjs");
  const realNormalize = createOfficial({ ...config, log: () => {} }).normalize;
  const transport = stubTransport(realNormalize);

  // 工具真被执行的话会去读凭据库、spawn 出图核心 —— 校准只关心「选了哪个工具」，
  // 不关心结果，所以这两层都顶掉。
  const realResolve = core.resolveCapability;
  const calls = [];
  core.resolveCapability = async (cfg, userId, name, query) => {
    calls.push({ name, query });
    return { kind: "text", text: "（校准占位：工具被调用了）" };
  };
  // 程序侧拦下的调用（比如模型自己补了铃铛/连击）不走 resolveCapability，
  // 所以光看 calls 会显示成「没调」，看不出到底是模型没调还是被拦了。
  // 把那些诊断行记下来，一起打出来。
  const intercepted = [];
  const realBinding = core.getBinding;
  core.getBinding = async () => ({ playerName: "校准玩家", email: "a@b.c", password: "x" });

  const bot = createMiaBot(config, {
    log: (m) => { if (/拦下|忽略|补了/.test(String(m))) intercepted.push(String(m)); },
    createTransport: () => transport,
    // 不传 fetchImpl → 用真实模型
  });
  // 传输层是桩，但 handleEvent 里那些 configure* 注册要照跑，否则提示词不完整
  await bot.start();

  console.log("校准：美亚会不会该办的办、该问的问？");
  console.log("（走的是生产那份 ability + actions，直接调 DeepSeek，不碰 QQ）\n");

  let wrong = 0, total = 0, seq = 0;        // seq 单独计数，见下面那条注释
  for (const probe of PROBES) {
    if (only && !probe.text.includes(only)) continue;
    if (probe.expect !== null) total++;      // 不判定的不计入分母
    // ⚠ 事件 id 用**独立的** seq，不能用 total：不判定的探针不增加 total，
    // 连着两条就会拿到同一个 id，而 handleEvent 的幂等闸会**静默丢掉**第二条 ——
    // 症状是那条探针显示「没调」且没有回复，看起来像模型的判断，
    // 其实它压根没跑到。这种假读数比报错难查得多。
    seq++;
    calls.length = 0;
    transport.sent.length = 0;
    intercepted.length = 0;
    const t0 = Date.now();
    let reply = "";
    try {
      await bot.handleEvent("GROUP_AT_MESSAGE_CREATE", {
        id: "cal-" + seq, group_openid: [...bot.allowGroups][0], content: probe.text,
        timestamp: new Date().toISOString(),
        // ⚠ 每条换一个 user id：chat.cjs 有 5 秒的用户冷却，同一个 id 连着发
        // 第二条会被挡在模型**之前**（回一句「等一下，我还在回你上一条呢」），
        // 那样测到的就不是模型的判断，而是冷却。校准会整个失真。
        author: { member_openid: "CAL_USER_" + seq },
      });
      reply = transport.sent.map((s) => s.text || ("［图］" + s.caption)).join(" ⏎ ");
    } catch (error) {
      reply = "（失败：" + core.safeError(error) + "）";
    }

    const used = calls.length > 0;
    const judged = probe.expect !== null;      // null = 不判定（两种做法都对）
    const ok = !judged || used === probe.expect;
    if (!ok) wrong++;
    console.log((!judged ? "·" : ok ? "✔" : "✘") + " " + probe.text);
    console.log("    设计意图：" + (probe.expect === null ? "怎么都行" : probe.expect ? "该调工具" : "不该调工具") + "（" + probe.why + "）");
    console.log("    实际    ：" + (used ? "调了 → " + calls.map((c) => c.name + (c.query ? "(" + c.query + ")" : "")).join(", ") : "没调"));
    if (intercepted.length) console.log("    ⚠ 被程序拦下：" + intercepted.join(" ｜ "));
    console.log("    美亚说  ：" + String(reply).replace(/\n/g, " / ").slice(0, 120));
    console.log("    (" + (Date.now() - t0) + "ms)\n");
  }

  core.resolveCapability = realResolve;
  core.getBinding = realBinding;

  console.log("──────── 汇总 ────────");
  console.log("与设计意图不符：" + wrong + " / " + total);
  if (wrong) {
    console.log("\n看错在哪一类：");
    console.log("  · 「问事实」被调了工具 → 提示词里那条分界（ability 最后一段）要加强；");
    console.log("  · 「要求办事」没调工具 → actionRule 太弱，或工具描述不够明确。");
    console.log("改完重跑这个脚本，别靠读提示词判断。");
  }
  bot.stop();
})().catch((error) => {
  console.error("校准失败：" + core.safeError(error));
  process.exitCode = 1;
});
