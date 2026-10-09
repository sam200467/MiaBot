"use strict";
// 聊天记录（chat-log.cjs）和引擎那头的 record 钩子。全程假模型，不碰真接口、不花钱。
// 接进 mia-entry 之后的整条链路（群上下文、绑定凭据、私聊不记）在 test-mia-entry.cjs 里测。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chatLogSettings, localTime, turnRecord, createChatLog } = require("./chat-log.cjs");
const { loadSettings, createChat } = require("../chat-core/chat.cjs");

// 本地时间 2026-10-09 14:03:22 —— 用本地时间构造，测试机在哪个时区都一样。
const T = new Date(2026, 9, 9, 14, 3, 22).getTime();
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "mia-chatlog-"));
const readLines = (file) => fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));

test("配置：缺省关；写错按关闭处理并说明原因，不拦启动", () => {
  assert.deepEqual(chatLogSettings(undefined), { mode: "off", keepDays: 14 });
  assert.deepEqual(chatLogSettings({ mode: "replies" }), { mode: "replies", keepDays: 14 });
  assert.deepEqual(chatLogSettings({ mode: "replies", keepDays: 7 }), { mode: "replies", keepDays: 7 });
  for (const bad of ["replies", [], { mode: "all" }, { mode: "replies", keepDays: 0 }, { mode: "replies", keepDays: 1.5 }, { mode: "replies", keepDays: 400 }]) {
    const s = chatLogSettings(bad);
    assert.equal(s.mode, "off", JSON.stringify(bad));
    assert.match(s.error, /聊天记录先按关闭处理/);
  }
});

test("一轮记成一行：原话、她看到的群上下文、回复、工具和联网判断", () => {
  const gate = { mode: "shadow", decision: { action: "none", reason: "在玩梗", would: { action: "none", reason: "在玩梗" } }, obs: { act: "play", about: "none" }, ms: 700 };
  const record = turnRecord({
    message: { id: "m1", __event: { type: "group", openid: "G1", userId: "U1", msgId: "m1" }, __media: { hasImage: true, hasReference: true } },
    text: "哈基米哈基米", at: T, context: ["群友：哈基米", "美亚：喵？"], historyTurns: 2, routed: false,
    result: { text: "这是什么梗？", action: null, research: { status: "not-needed" }, searchGate: gate },
    file: { id: "happy-01", absoluteFile: "C:/x.png" },
  }, T + 1500);
  assert.deepEqual(record, {
    time: "2026-10-09 14:03:22", group: "G1", user: "U1", msgId: "m1", text: "哈基米哈基米",
    image: true, quote: true, context: ["群友：哈基米", "美亚：喵？"], historyTurns: 2,
    reply: "这是什么梗？", sticker: "happy-01", research: { status: "not-needed" }, searchGate: gate, ms: 1500,
  });
  assert.equal(localTime(T), "2026-10-09 14:03:22");

  const routed = turnRecord({
    message: { __event: { type: "group", openid: "G1", userId: "U1", msgId: "m2" } }, text: "查一下 id870", at: T, context: [],
    result: { text: "好，我来查一下♪", action: { name: "song", query: "id870", target: "U9", extra: "不记" } }, routed: true,
  }, T);
  assert.deepEqual(routed.action, { name: "song", query: "id870", target: "U9" });
  assert.equal(routed.routed, true);
  assert.equal(routed.sticker, undefined);

  const failed = turnRecord({ message: { __event: { type: "group", openid: "G1", userId: "U1", msgId: "m3" } }, text: "在吗", at: T, context: [], error: "DeepSeek HTTP 400" }, T + 20);
  assert.equal(failed.error, "DeepSeek HTTP 400");
  assert.equal(failed.reply, undefined, "模型没回就没有 reply");
  const sendFailed = turnRecord({ message: {}, text: "在吗", at: T, result: { text: "在的♪" }, error: "发送失败" }, T);
  assert.equal(sendFailed.reply, "在的♪", "模型回了、发送失败：两样都要留着");
  assert.equal(sendFailed.error, "发送失败");
});

test("按本地日期分文件，一行一条；跨天换文件，顺手清掉刚过期的那个", () => {
  const dir = tmpDir();
  let now = new Date(2026, 9, 9, 23, 59, 59).getTime();
  const logs = [];
  fs.writeFileSync(path.join(dir, "2026-09-26.jsonl"), "{}\n");   // 10-09 时是 13 天前（留），10-10 时满 14 天（删）
  const chatLog = createChatLog({ dir, keepDays: 14, now: () => now, log: (line) => logs.push(line) });
  chatLog.write({ n: 1 });
  chatLog.write({ n: 2, text: "第二行\n换行也只占一行" });
  assert.ok(fs.existsSync(path.join(dir, "2026-09-26.jsonl")));
  now = new Date(2026, 9, 10, 0, 0, 1).getTime();
  chatLog.write({ n: 3 });
  assert.deepEqual(readLines(path.join(dir, "2026-10-09.jsonl")), [{ n: 1 }, { n: 2, text: "第二行\n换行也只占一行" }]);
  assert.deepEqual(readLines(path.join(dir, "2026-10-10.jsonl")), [{ n: 3 }]);
  assert.ok(!fs.existsSync(path.join(dir, "2026-09-26.jsonl")), "跨天时满 14 天的要删");
  assert.deepEqual(logs, []);
});

test("过期清理：只删超出保留期的「日期.jsonl」，别的文件一概不碰", () => {
  const dir = tmpDir();
  const names = ["2026-10-09.jsonl", "2026-09-26.jsonl", "2026-09-25.jsonl", "2026-08-01.jsonl",
    "2026-10-10.jsonl", "2026-02-30.jsonl", "notes.txt", "2026-09-01.jsonl.bak"];
  for (const name of names) fs.writeFileSync(path.join(dir, name), "{}\n");
  const chatLog = createChatLog({ dir, keepDays: 14, now: () => new Date(2026, 9, 9, 10, 0, 0).getTime() });
  assert.equal(chatLog.start(), 2);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["2026-02-30.jsonl", "2026-09-01.jsonl.bak", "2026-09-26.jsonl", "2026-10-09.jsonl", "2026-10-10.jsonl", "notes.txt"]);
});

test("写不进去：不抛错、只报一次；恢复后报一声", () => {
  const root = tmpDir();
  const dir = path.join(root, "chatlog");
  fs.writeFileSync(dir, "占着位置的同名文件");   // 目录建不出来
  const logs = [];
  const chatLog = createChatLog({ dir, now: () => T, log: (line) => logs.push(line) });
  assert.doesNotThrow(() => chatLog.write({ n: 1 }));
  chatLog.write({ n: 2 });
  assert.equal(logs.length, 1);
  assert.match(logs[0], /聊天记录写不进去.*回复不受影响/);
  fs.rmSync(dir);
  chatLog.write({ n: 3 });
  assert.match(logs.at(-1), /恢复写入/);
  assert.deepEqual(readLines(path.join(dir, "2026-10-09.jsonl")), [{ n: 3 }]);
});

// ── 引擎那头的钩子（chat.cjs 的 recordTurn）────────────────────────────

const SECRET = "sk-chatlog-fixture-secret";
const base = loadSettings(path.resolve(__dirname, "../mia-chat"));
const settings = { ...base, c: { ...base.c, provider: { ...base.c.provider, apiKey: SECRET }, limits: { ...base.c.limits, userCooldownSeconds: 0 } } };
const respond = (content) => ({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content } }] }) });
const replyWith = (text) => async () => respond(JSON.stringify({ text, emotion: "happy", scene: "ordinary", expressionIds: [] }));

function chatWith(fetchImpl, adapter = {}) {
  const sent = [], logs = [];
  const chat = createChat(settings, { guildId: "g", channelIds: ["c"] }, {
    fetchImpl, log: (line) => logs.push(line),
    adapter: {
      accepts: () => true, extractText: (m) => m.content, typing: async () => {},
      send: async (_, text, file) => { sent.push({ text, file }); },
      context: () => ["群友：刚才在聊 Opfer", "美亚：那首超难的！"],
      ...adapter,
    },
  });
  return { chat, sent, logs };
}
const message = (id, content) => ({ id, guildId: "g", channelId: "c", author: { id: "u1" }, content });

test("钩子：回复发出去之后才调，拿到的上下文就是模型看到的那份", async () => {
  const turns = [];
  let seenBySend = 0;
  const { chat, sent } = chatWith(replyWith("Opfer 确实难♪"), {
    send: async (_, text, file) => { sent.push({ text, file }); seenBySend = turns.length; },
    record: (turn) => { turns.push(turn); },
  });
  try {
    await chat.handle(message("m1", "那首歌难吗"));
    await chat.handle(message("m2", "那我先练别的"));
    assert.equal(turns.length, 2);
    assert.equal(seenBySend, 1, "第二轮发送时只记了第一轮：记录在发送之后");
    const [first, second] = turns;
    assert.equal(first.text, "那首歌难吗");
    assert.deepEqual(first.context, ["群友：刚才在聊 Opfer", "美亚：那首超难的！"]);
    assert.equal(first.result.text, "Opfer 确实难♪");
    assert.equal(first.file, sent[0].file, "配图就是发出去的那张");
    assert.equal(first.routed, false);
    assert.equal(first.historyTurns, 0);
    assert.equal(second.historyTurns, 1, "第二轮带着第一轮的对话");
    assert.equal(first.message.id, "m1");
    assert.equal(typeof first.at, "number");
  } finally { chat.close(); }
});

test("钩子抛错（同步或异步）不影响回复，只记一行日志", async () => {
  for (const record of [() => { throw new Error("磁盘满了"); }, async () => { throw new Error("磁盘满了"); }]) {
    const { chat, sent, logs } = chatWith(replyWith("在的♪"), { record });
    try {
      await chat.handle(message("m1", "在吗"));
      await new Promise((r) => setImmediate(r));
      assert.equal(sent.at(-1).text, "在的♪");
      assert.ok(logs.some((line) => /聊天记录出错：磁盘满了/.test(line)), logs.join("\n"));
      assert.ok(logs.some((line) => /聊天完成/.test(line)));
    } finally { chat.close(); }
  }
});

test("模型出错的那一轮也记：带原因、不带密钥，兜底那句照发", async () => {
  const turns = [];
  const fetchImpl = async () => ({ ok: false, status: 400, text: async () => "invalid api key " + SECRET });
  const { chat, sent } = chatWith(fetchImpl, { record: (turn) => { turns.push(turn); } });
  try {
    await chat.handle(message("m1", "在吗"));
    assert.match(sent.at(-1).text, /没能顺利完成/);
    assert.equal(turns.length, 1);
    assert.match(turns[0].error, /DeepSeek HTTP 400/);
    assert.ok(!JSON.stringify(turnRecord(turns[0])).includes(SECRET), "密钥不能进记录");
    assert.deepEqual(turns[0].context, ["群友：刚才在聊 Opfer", "美亚：那首超难的！"], "出错也知道她当时看到了什么");
    assert.equal(turns[0].result, undefined);
  } finally { chat.close(); }
});

test("宿主不给 record：钩子不存在，回复照旧", async () => {
  const { chat, sent, logs } = chatWith(replyWith("在的♪"));
  try {
    await chat.handle(message("m1", "在吗"));
    assert.equal(sent.at(-1).text, "在的♪");
    assert.ok(!logs.some((line) => /聊天记录/.test(line)));
  } finally { chat.close(); }
});
