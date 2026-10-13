"use strict";
// 梗库（/入典、/典来、审典）的单元测试。不碰网络；存储写到临时目录。
// 走完整 QQ 入口的两条（开关关着跟改造前一样、开着从入典到抽出来）在 test-mia-entry.cjs 里。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { memeSettings, matchCommand, createMemeLibrary, USER_PENDING_MAX } = require("./meme-library.cjs");
const { parseCommand } = require("./mia-commands.cjs");
const { MIA_TEMPLATES: T } = require("./mia-voice.cjs");

const REVIEWER = "ADMIN_OPENID";
const GROUP = "GROUP_A";
// 水鸡筹那段的样子：全角标点、省略号、空行都在，入典前后要一字不差。
const COPYPASTA = "【水鸡筹】很抱歉打扰大家，本人于2026年9月24日查出周期性蛋白脂肪缺乏症……\n\n现众筹50元治疗费！（V我50）";

function setup({ settings = {}, random = () => 0, send } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-memes-"));
  const file = path.join(dir, "meme-library.json");
  const sent = [], logs = [];
  let clock = 1_000_000;
  const lib = createMemeLibrary({
    settings: memeSettings({ mode: "on", reviewers: [REVIEWER], ...settings }),
    file,
    send: send || (async (event, text) => { sent.push({ to: event.type + ":" + (event.type === "group" ? event.openid : event.userId), text }); }),
    log: (line) => logs.push(line),
    now: () => clock,
    random,
  });
  assert.equal(lib.start().ok, true);
  return { lib, file, sent, logs, tick: (ms) => { clock += ms; }, last: () => sent.at(-1)?.text };
}
const group = (userId, extra = {}) => ({ type: "group", openid: GROUP, userId, ...extra });
const c2c = (userId, extra = {}) => ({ type: "c2c", openid: userId, userId, ...extra });
const quoting = (content, attachments = []) => ({ quote: { fromSelf: false, content, attachments } });
async function run(ctx, event, text) {
  const command = matchCommand(text, { direct: event.type === "c2c" });
  assert.ok(command, "应当认成梗库的指令：" + text);
  await ctx.lib.handle(event, command);
  return ctx.last();
}

test("配置：缺省关；写错按关闭并说明原因；审核人不填就用删别名那份名单", () => {
  assert.deepEqual(memeSettings(undefined), { mode: "off" });
  assert.deepEqual(memeSettings({ mode: "off" }).mode, "off");
  assert.match(memeSettings({ mode: "yes" }).error, /memes\.mode 只能是 off \/ on，梗库先按关闭处理/);
  assert.equal(memeSettings({ mode: "yes" }).mode, "off");
  assert.match(memeSettings([]).error, /应当是一个对象/);
  assert.match(memeSettings({ mode: "on", cooldownSeconds: -1 }).error, /cooldownSeconds/);
  assert.match(memeSettings({ mode: "on", maxChars: 99999 }).error, /maxChars/);
  assert.match(memeSettings({ mode: "on", reviewers: ["X", " "] }).error, /reviewers/);
  const fallback = memeSettings({ mode: "on" }, { aliasDeleteOpenids: [" A1 "] });
  assert.deepEqual([...fallback.reviewers], ["A1"]);
  assert.equal(fallback.reviewersFrom, "aliasDeleteOpenids");
  assert.equal(fallback.cooldownSeconds, 10);
  assert.equal(fallback.maxChars, 1500);
  const own = memeSettings({ mode: "on", reviewers: [] }, { aliasDeleteOpenids: ["A1"] });
  assert.equal(own.reviewers.size, 0, "写了空数组就是谁都审不了，不退回删别名那份");
});

test("指令识别：原文一字不差（全角标点、省略号、空行都留着）；别的指令后面只能是空白、编号或结尾", () => {
  const typed = "/入典 " + COPYPASTA + "  ";
  assert.deepEqual(matchCommand(typed), { name: "add", label: "入典", rest: COPYPASTA });
  // 对照：老的指令解析先做 NFKC，标点全变了——入典不能用它的结果。
  assert.notEqual(parseCommand(typed).rest, COPYPASTA);
  assert.equal(matchCommand("/入典\n" + COPYPASTA).rest, COPYPASTA);
  assert.equal(matchCommand("/入典" + COPYPASTA).rest, COPYPASTA, "入典后面直接贴原文也认");
  assert.equal(matchCommand("＃入典　全角空格隔开").rest, "全角空格隔开");
  assert.equal(matchCommand("／典来").name, "draw");
  assert.equal(matchCommand("#典來").name, "draw");
  assert.equal(matchCommand("/典来了"), null, "不是在叫指令，交给原来的解析");
  assert.equal(matchCommand("/过典 12 13").rest, "12 13");
  assert.equal(matchCommand("/删典#12").name, "remove");
  assert.equal(matchCommand("/待審典").name, "pending");
  assert.equal(matchCommand("典来"), null, "群里不认裸关键字");
  assert.equal(matchCommand("典来", { direct: true }).name, "draw");
  assert.equal(matchCommand("入典了属于是", { direct: true }), null, "私聊里这是在聊天");
  assert.equal(matchCommand("入典 一段文案", { direct: true }).rest, "一段文案");
  assert.equal(matchCommand("/单曲 id870"), null);
});

test("群友入的先进待审，/典来 抽不到；审核人私聊 /过典 之后原样抽出来，一个字不加，日志里不写原文", async () => {
  const ctx = setup();
  assert.equal(await run(ctx, group("U1"), "/入典 " + COPYPASTA), T.memePending(1));
  assert.equal(await run(ctx, group("U2"), "/典来"), T.memeEmpty);
  assert.equal(await run(ctx, c2c(REVIEWER), "/过典 1"), T.memeApproved("#1"));
  assert.equal(await run(ctx, group("U2"), "/典来"), COPYPASTA);
  assert.deepEqual(ctx.sent.at(-1), { to: "group:" + GROUP, text: COPYPASTA });
  const saved = JSON.parse(fs.readFileSync(ctx.file, "utf8"));
  assert.equal(saved.entries.length, 1);
  assert.equal(saved.entries[0].text, COPYPASTA, "存的也是原文");
  assert.equal(saved.entries[0].state, "approved");
  assert.equal(saved.entries[0].scope, "group:" + GROUP);
  assert.equal(saved.entries[0].by, "U1");
  assert.equal(saved.entries[0].reviewedBy, REVIEWER);
  assert.ok(ctx.logs.some((line) => /^梗库：#1 入典（待审｜群｜\d+ 字）$/.test(line)), ctx.logs.join("\n"));
  assert.ok(!ctx.logs.some((line) => line.includes("水鸡筹")), "日志里不写原文");
});

test("审核人入的直接生效；同一篇（标点、全半角不一样也算）不重收；删掉过的别人再交不进待审，审核人再入就放回来", async () => {
  const ctx = setup();
  assert.equal(await run(ctx, group(REVIEWER), "/入典 " + COPYPASTA), T.memeAdded(1));
  assert.equal(await run(ctx, group("U1"), "/入典 " + COPYPASTA.normalize("NFKC")), T.memeAlreadyIn(1));
  assert.equal(await run(ctx, group("U1"), "/入典 再来一篇不一样的"), T.memePending(2));
  assert.equal(await run(ctx, group("U3"), "/入典 再来一篇不一样的！"), T.memeAlreadyPending(2));
  assert.equal(await run(ctx, group(REVIEWER), "/入典 再来一篇不一样的"), T.memeAdded(2), "审核人再入一次就是过了");
  assert.equal(await run(ctx, c2c(REVIEWER), "/删典 2"), T.memeRemoved("#2"));
  assert.equal(await run(ctx, group("U1"), "/入典 再来一篇不一样的"), T.memeRejectedBefore);
  assert.equal(await run(ctx, group(REVIEWER), "/入典 再来一篇不一样的"), T.memeRestored(2));
  assert.equal(ctx.lib.store.get(2).state, "approved");
  // 私聊里入的是另一份，跟群里那份不算重复
  assert.equal(await run(ctx, c2c("U1"), "/入典 " + COPYPASTA), T.memePending(3));
});

test("回复某条消息再发 /入典：收被回复那条的原文；只有图、读不到的分别说清楚；后面贴了字就按贴的算", async () => {
  const ctx = setup();
  assert.equal(await run(ctx, group("U1", quoting(COPYPASTA)), "/入典"), T.memePending(1));
  assert.equal(ctx.lib.store.get(1).text, COPYPASTA);
  assert.equal(ctx.lib.store.get(1).source, "quote");
  assert.equal(await run(ctx, group("U1", quoting("", [{ content_type: "image/png" }])), "/入典"), T.memeQuoteNoText);
  assert.equal(await run(ctx, group("U1", { raw: { message_type: 103 } }), "/入典"), T.memeQuoteUnreadable);
  assert.equal(await run(ctx, group("U1"), "/入典"), T.memeUsage);
  assert.equal(await run(ctx, group("U1", quoting("被回复的那条")), "/入典 贴出来的这句"), T.memePending(2));
  assert.equal(ctx.lib.store.get(2).text, "贴出来的这句");
  assert.equal(ctx.lib.store.get(2).source, "typed");
});

test("太短、太长的不收；长度按字算，表情也算一个字", async () => {
  const ctx = setup({ settings: { maxChars: 20 } });
  assert.equal(await run(ctx, group("U1"), "/入典 草"), T.memeTooShort);
  assert.equal(await run(ctx, group("U1"), "/入典 ！！！？？？"), T.memeTooShort, "全是标点不算");
  assert.equal(await run(ctx, group("U1"), "/入典 " + "啊".repeat(21)), T.memeTooLong(20, 21));
  assert.equal(await run(ctx, group("U1"), "/入典 " + "😂".repeat(18) + "啊啊"), T.memePending(1));
  assert.equal(ctx.lib.store.entries().length, 1);
});

test("待审上限：一个人最多压 10 篇，别人照样能交", async () => {
  const ctx = setup();
  for (let i = 1; i <= USER_PENDING_MAX; i++) assert.equal(await run(ctx, group("U1"), "/入典 第" + i + "篇文案"), T.memePending(i));
  assert.equal(await run(ctx, group("U1"), "/入典 第十一篇文案"), T.memeUserQueueFull(USER_PENDING_MAX));
  assert.equal(await run(ctx, group("U2"), "/入典 别人的文案"), T.memePending(USER_PENDING_MAX + 1));
});

test("典来：一轮抽完才重复，新一轮第一篇不跟上一篇撞；群和私聊各抽各的；同一个群两次之间要隔冷却", async () => {
  // 前三次都挑头一个；第四次挑最后一个——不躲开上一篇的话，第四次就会又抽到「第三篇」。
  const picks = [0, 0, 0, 0.99];
  const ctx = setup({ random: () => picks.shift() ?? 0 });
  for (const text of ["第一篇文案", "第二篇文案", "第三篇文案"]) await run(ctx, group(REVIEWER), "/入典 " + text);
  const drawn = [];
  for (let i = 0; i < 4; i++) { drawn.push(await run(ctx, group("U1"), "/典来")); ctx.tick(10_000); }
  assert.deepEqual(drawn, ["第一篇文案", "第二篇文案", "第三篇文案", "第二篇文案"]);

  await run(ctx, group("U1"), "/典来");
  assert.equal(await run(ctx, group("U2"), "/典来"), T.memeCooldown(10), "冷却按群算，换个人也一样");
  ctx.tick(4_000);
  assert.equal(await run(ctx, group("U1"), "/典来"), T.memeCooldown(6));
  assert.equal(await run(ctx, c2c("U1"), "/典来"), T.memeEmpty, "私聊抽不到群里的典");
  assert.equal(await run(ctx, { type: "group", openid: "GROUP_B", userId: "U1" }, "/典来"), T.memeEmpty, "别的群也抽不到");
});

test("审典：只认审核人、只在私聊；/待审典 只列开头一段，/看典 给全文；过典一次写好几个号", async () => {
  const ctx = setup();
  await run(ctx, group("U1"), "/入典 " + COPYPASTA);
  await run(ctx, group("U1", quoting("短短的一句")), "/入典");
  assert.equal(await run(ctx, c2c("U1"), "/待审典"), T.memeReviewDenied);
  assert.equal(await run(ctx, c2c("U1"), "/过典 1"), T.memeReviewDenied);
  for (const text of ["/待审典", "/看典 1", "/过典 1"]) assert.equal(await run(ctx, group(REVIEWER), text), T.memeReviewPrivate);
  assert.equal(ctx.lib.store.get(1).state, "pending", "群里发的过典不算");

  const list = await run(ctx, c2c(REVIEWER), "/待审典");
  assert.match(list, /^待审 2 篇（典里已有 0 篇）：\n\n#1｜群｜\d\d-\d\d \d\d:\d\d\n【水鸡筹】很抱歉打扰大家，[^\n]*…（共 \d+ 字）\n\n#2｜群｜\d\d-\d\d \d\d:\d\d｜回复入的\n短短的一句\n\n看全文 \/看典 12｜通过 \/过典 12｜删掉 \/删典 12；一次可以写好几个号。$/);
  assert.ok(!list.includes(COPYPASTA), "列表里只给开头一段");
  const full = await run(ctx, c2c(REVIEWER), "看典 1");   // 私聊里裸关键字也认
  assert.match(full, /^#1｜待审｜群｜\d{4}-\d\d-\d\d \d\d:\d\d｜\d+ 字\n/);
  assert.ok(full.endsWith("\n" + COPYPASTA));
  assert.equal(await run(ctx, c2c(REVIEWER), "/过典 1、2，99"), T.memeApproved("#1、#2") + "\n" + T.memeNotFound("#99"));
  assert.equal(await run(ctx, c2c(REVIEWER), "/过典 1"), T.memeAlreadyApproved("#1"));
  assert.equal(await run(ctx, c2c(REVIEWER), "/待审典"), T.memeNoPending(2));
  assert.equal(await run(ctx, c2c(REVIEWER), "/过典"), T.memeApproveUsage);
  assert.equal(await run(ctx, c2c(REVIEWER), "/看典"), T.memeViewUsage);
  assert.equal(await run(ctx, c2c(REVIEWER), "/看典 42"), T.memeNotFound("#42"));
});

test("待审太多时一次只列 8 篇，告诉还剩几篇", async () => {
  const ctx = setup();
  for (let i = 1; i <= 9; i++) await run(ctx, group("U" + i), "/入典 第" + i + "篇待审的文案");
  const list = await run(ctx, c2c(REVIEWER), "/待审典");
  assert.match(list, /^待审 9 篇/);
  assert.equal((list.match(/^#\d+｜/gm) || []).length, 8);
  assert.match(list, /还有 1 篇，审完这些再发 \/待审典。/);
});

test("删典：审核人在群里回复抽出来的那篇发 /删典 就删掉，别人删不了；删掉的不再抽到", async () => {
  const ctx = setup({ settings: { cooldownSeconds: 0 } });
  await run(ctx, group(REVIEWER), "/入典 " + COPYPASTA);
  await run(ctx, group(REVIEWER), "/入典 另一篇文案内容");
  const drawn = await run(ctx, group("U1"), "/典来");
  const mine = { quote: { fromSelf: true, content: drawn, attachments: [] } };
  assert.equal(await run(ctx, group("U1", mine), "/删典"), T.memeReviewDenied);
  const id = ctx.lib.store.entries().find((e) => e.text === drawn).id;
  assert.equal(await run(ctx, group(REVIEWER, mine), "/删典"), T.memeRemoved("#" + id));
  for (let i = 0; i < 4; i++) assert.notEqual(await run(ctx, group("U1"), "/典来"), drawn);
  assert.equal(await run(ctx, group(REVIEWER, quoting("不在典里的一句话")), "/删典"), T.memeQuoteNotFound);
  assert.equal(await run(ctx, group(REVIEWER), "/删典"), T.memeRemoveUsage);
  assert.equal(await run(ctx, c2c(REVIEWER), "/删典 " + id), T.memeAlreadyRemoved("#" + id));
});

test("存储：重启后还在；文件坏了就不接活，原文件一个字不动", async () => {
  const ctx = setup();
  await run(ctx, group(REVIEWER), "/入典 " + COPYPASTA);
  await run(ctx, group("U1"), "/入典 待审的一篇");
  const settings = memeSettings({ mode: "on", reviewers: [REVIEWER] });
  const again = createMemeLibrary({ settings, file: ctx.file, send: async () => {} });
  assert.deepEqual(again.start(), { ok: true, approved: 1, pending: 1 });
  assert.equal(again.store.get(1).text, COPYPASTA);
  assert.ok(!fs.existsSync(ctx.file + ".tmp"), "临时文件改完名就不在了");

  fs.writeFileSync(ctx.file, "{ 坏掉的");
  const sent = [];
  const broken = createMemeLibrary({ settings, file: ctx.file, send: async (event, text) => { sent.push(text); } });
  const opened = broken.start();
  assert.equal(opened.ok, false);
  assert.match(opened.error, /^梗库文件读不了（.+），先按关闭处理，文件没动：/);
  await broken.handle(group(REVIEWER), matchCommand("/入典 新的一篇"));
  assert.deepEqual(sent, [T.memeUnavailable]);
  assert.equal(fs.readFileSync(ctx.file, "utf8"), "{ 坏掉的");
});

test("存储：写不进去时这次不算，回一句没存上，内存里也退回去", async () => {
  const ctx = setup();
  fs.mkdirSync(ctx.file);   // 文件的位置被一个目录占着：改名那一步会失败
  assert.equal(await run(ctx, group(REVIEWER), "/入典 " + COPYPASTA), T.memeSaveFailed);
  assert.equal(ctx.lib.store.entries().length, 0);
  assert.ok(ctx.logs.some((line) => /^⚠ 梗库写不进去：/.test(line)), ctx.logs.join("\n"));
  fs.rmSync(ctx.file, { recursive: true });
  assert.equal(await run(ctx, group(REVIEWER), "/入典 " + COPYPASTA), T.memeAdded(1), "编号也退回去了");
});

test("典来发不出去：被动回复窗口过期只记日志；别的失败补一句说明", async () => {
  const sent = [];
  let failWith = null;
  const ctx = setup({
    settings: { cooldownSeconds: 0 },
    send: async (event, text) => {
      if (failWith && text === COPYPASTA) throw Object.assign(new Error("发送失败"), { code: failWith });
      sent.push(text);
    },
  });
  await ctx.lib.handle(group(REVIEWER), matchCommand("/入典 " + COPYPASTA));
  failWith = 40034128;
  await ctx.lib.handle(group("U1"), matchCommand("/典来"));
  assert.deepEqual(sent, [T.memeAdded(1)]);
  assert.ok(ctx.logs.some((line) => /典来 #1 没发出去：被动回复窗口已过期/.test(line)));
  failWith = 40054005;
  await ctx.lib.handle(group("U1"), matchCommand("/典来"));
  assert.deepEqual(sent, [T.memeAdded(1), T.memeSendFailed]);
  assert.ok(ctx.logs.some((line) => /^⚠ 典来 #1 没发出去（\d+ 字）：40054005$/.test(line)), ctx.logs.join("\n"));
});
