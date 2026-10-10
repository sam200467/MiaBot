"use strict";
// 官方接口传输层测试。全部走 mock-official，不需要真实凭据。
const test = require("node:test");
const assert = require("node:assert/strict");
const { createOfficial } = require("./official-transport.cjs");
const { createMockOfficial } = require("./mock-official.cjs");

// 每个用例起一套干净的 mock + transport
async function setup(overrides = {}) {
  // 心跳周期由网关的 Hello 指定，测试里给个短值并放开传输层的下限，否则要等 30 秒
  const mock = createMockOfficial({ heartbeatIntervalMs: 200 });
  await mock.start();
  const transport = createOfficial({
    appId: "123456", clientSecret: "secret",
    tokenUrl: mock.tokenUrl, apiBase: mock.apiBase, sandboxApiBase: mock.apiBase,
    minSendIntervalMs: 0, jitterMs: 0, perTargetIntervalMs: 0, minHeartbeatIntervalMs: 100,
    reconnectBaseMs: 100,
    ...overrides,
  });
  return { mock, transport };
}

async function connected(overrides = {}) {
  const ctx = await setup(overrides);
  const events = [];
  await ctx.transport.start((name, d) => events.push({ name, d }));
  const ok = await ctx.mock.waitFor(() => ctx.transport.state.connected);
  assert.ok(ok, "应当连上网关");
  return { ...ctx, events };
}

test("鉴权：换 token 后所有请求带 QQBot 头", async () => {
  const { mock, transport } = await connected();
  assert.ok(mock.state.tokenCalls >= 1, "应当请求过 access_token");
  assert.match(mock.state.identified[0].d.token, /^QQBot mock-token-/, "Identify 的 token 要带 QQBot 前缀");
  await transport.stop(); await mock.stop();
});

test("Identify 带上群+单聊的 intent 位", async () => {
  const { mock, transport } = await connected();
  const intents = mock.state.identified[0].d.intents;
  assert.ok(intents & (1 << 25), "缺少 GROUP_AND_C2C_EVENT(1<<25)");
  assert.ok(intents & (1 << 24), "缺少对冲用的 1<<24");
  assert.equal(mock.state.identified.length, 1, "只应 Identify 一次（Hello 在前，不能重复）");
  await transport.stop(); await mock.stop();
});

test("心跳：Hello 之后按时发 op=1 并收到 ACK", async () => {
  const { mock, transport } = await connected();
  assert.ok(await mock.waitFor(() => mock.state.heartbeats > 0, 4000), "应当发出过心跳");
  assert.ok(transport.healthy(), "收到 ACK 后 healthy 应为真");
  await transport.stop(); await mock.stop();
});

test("事件分发：群 @ 与单聊都归一化成同一种形状", async () => {
  const { mock, transport, events } = await connected();
  mock.push("GROUP_AT_MESSAGE_CREATE", { id: "m1", group_openid: "G1", content: "你好", timestamp: "2026-09-18T12:00:00+08:00", author: { member_openid: "U1" } });
  mock.push("C2C_MESSAGE_CREATE", { id: "m2", content: "在吗", timestamp: "2026-09-18T12:01:00+08:00", author: { user_openid: "U2" } });
  await mock.waitFor(() => events.length >= 2);
  const g = events.find((e) => e.name === "GROUP_AT_MESSAGE_CREATE");
  const c = events.find((e) => e.name === "C2C_MESSAGE_CREATE");
  const ng = transport.normalize(g.name, g.d);
  const nc = transport.normalize(c.name, c.d);
  assert.deepEqual([ng.type, ng.openid, ng.userId, ng.content, ng.msgId], ["group", "G1", "U1", "你好", "m1"]);
  assert.deepEqual([nc.type, nc.openid, nc.content, nc.msgId], ["c2c", "U2", "在吗", "m2"]);
  await transport.stop(); await mock.stop();
});

test("事件去重：同一条 id 重复推送只交给上层一次", async () => {
  const { mock, transport, events } = await connected();
  const d = { id: "dup-1", group_openid: "G1", content: "重复", timestamp: "2026-09-18T12:00:00+08:00", author: { member_openid: "U1" } };
  mock.push("GROUP_AT_MESSAGE_CREATE", d);
  mock.push("GROUP_AT_MESSAGE_CREATE", d);
  await mock.waitFor(() => events.length >= 1);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(events.length, 1, "重复推送应被丢弃");
  await transport.stop(); await mock.stop();
});

test("发群消息：走对路径，带 msg_id 且 msg_seq 递增", async () => {
  const { mock, transport } = await connected();
  await transport.sendText({ kind: "group", openid: "G1" }, "第一句", "msg-1");
  await transport.sendText({ kind: "group", openid: "G1" }, "第二句", "msg-1");
  assert.equal(mock.state.sent.length, 2);
  assert.equal(mock.state.sent[0].path, "/v2/groups/G1/messages");
  assert.equal(mock.state.sent[0].body.msg_id, "msg-1");
  assert.equal(mock.state.sent[0].body.msg_seq, 1, "同一 msg_id 的序号要从 1 开始");
  assert.equal(mock.state.sent[1].body.msg_seq, 2, "同一 msg_id 的序号必须递增，否则被判重复");
  assert.equal(mock.state.sent[0].body.msg_type, 0);
  await transport.stop(); await mock.stop();
});

test("发单聊消息：走 /v2/users/ 路径", async () => {
  const { mock, transport } = await connected();
  await transport.sendText({ kind: "c2c", openid: "U9" }, "私聊内容", "msg-2");
  assert.equal(mock.state.sent[0].path, "/v2/users/U9/messages");
  assert.equal(mock.state.sent[0].body.msg_id, "msg-2");
  await transport.stop(); await mock.stop();
});

test("没有 msg_id 时按主动消息发（不带被动回复凭据）", async () => {
  const { mock, transport } = await connected();
  await transport.sendText({ kind: "group", openid: "G1" }, "无凭据", null);
  assert.equal(mock.state.sent[0].body.msg_id, undefined);
  assert.equal(mock.state.sent[0].body.msg_seq, undefined);
  await transport.stop(); await mock.stop();
});

test("同一条消息重复投递：相同内容被抑制", async () => {
  // 抑制要挡的是「同一条消息被推了两遍」，所以凭据（msg_id）相同才算重复。
  const { mock, transport } = await connected({ duplicateWindowMs: 60000 });
  await transport.sendText({ kind: "group", openid: "G1" }, "一样的话", "m1");
  await assert.rejects(() => transport.sendText({ kind: "group", openid: "G1" }, "一样的话", "m1"), /相同内容在冷却期内/);
  assert.equal(mock.state.sent.length, 1);
  await transport.stop(); await mock.stop();
});

test("两条不同的消息、回复文案完全相同：两条都要发得出去", async () => {
  // 回归：抑制键原先只用 target + 正文，于是同一分钟里两个人问同一件事，
  // 第二条回复会被当成「重复内容」吞掉，用户看到的是「发了指令没反应」。
  // 美亚的指令回复是预写模板（不像梨绪那样带模型生成的随机性），撞车是常态。
  const { mock, transport } = await connected({ duplicateWindowMs: 60000 });
  await transport.sendText({ kind: "group", openid: "G1" }, "一样的话", "m1");
  await transport.sendText({ kind: "group", openid: "G1" }, "一样的话", "m2");
  assert.equal(mock.state.sent.length, 2, "不同的消息各有各的被动凭据，正文再像也不能吞");
  await transport.stop(); await mock.stop();
});

test("对同一目标的发送间隔：要等，不能说丢就丢", async () => {
  const { mock, transport } = await connected({ perTargetIntervalMs: 300 });
  const t0 = Date.now();
  await transport.sendText({ kind: "group", openid: "G1" }, "一", "m1");
  await transport.sendText({ kind: "group", openid: "G1" }, "二", "m2");
  const elapsed = Date.now() - t0;
  // 间隔靠「等」而不是靠抛异常 —— 抛出去这条回复就没了，聊天里表现为 bot 不吭声
  assert.equal(mock.state.sent.length, 2, "两条都要真的发出去");
  assert.ok(elapsed >= 250, "第二条要等够间隔（实际 " + elapsed + "ms）");
  await transport.stop(); await mock.stop();
});

test("熔断：连续服务端错误后停止发送", async () => {
  const { mock, transport } = await connected({ minSendIntervalMs: 1 });
  mock.failNext(500, undefined, "boom");
  await assert.rejects(() => transport.sendText({ kind: "group", openid: "G1" }, "x", "m1"));
  mock.failNext(500, undefined, "boom");
  await assert.rejects(() => transport.sendText({ kind: "group", openid: "G1" }, "y", "m2"));
  assert.ok(transport.state.circuitOpen, "连续 5xx 后应熔断");
  await assert.rejects(() => transport.sendText({ kind: "group", openid: "G1" }, "z", "m3"), /熔断中/);
  await transport.stop(); await mock.stop();
});

test("被动回复过期(40034128)不算平台异常，不熔断", async () => {
  const { mock, transport } = await connected();
  mock.failNext(400, 40034128, "被动回复超时或超次数");
  const error = await transport.sendText({ kind: "group", openid: "G1" }, "x", "m1").catch((e) => e);
  assert.equal(error.code, 40034128);
  assert.equal(transport.state.circuitOpen, false, "调用方自己重发即可，不该熔断");
  await transport.stop(); await mock.stop();
});

test("发图：先上传拿 file_info，再以 msg_type=7 发出", async () => {
  const { mock, transport } = await connected();
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  await transport.sendImage({ kind: "group", openid: "G1" }, png, "m1", "说明");
  assert.equal(mock.state.uploads.length, 1);
  assert.equal(mock.state.uploads[0].path, "/v2/groups/G1/files");
  assert.equal(mock.state.uploads[0].body.file_type, 1);
  assert.equal(mock.state.uploads[0].body.srv_send_msg, false, "应先上传再自己发，避免占用主动消息频次");
  assert.equal(mock.state.sent[0].path, "/v2/groups/G1/messages");
  assert.equal(mock.state.sent[0].body.msg_type, 7);
  assert.equal(mock.state.sent[0].body.media.file_info, "fileinfo-1");
  await transport.stop(); await mock.stop();
});

test("图片超过上限时拒绝，不发出去", async () => {
  const { mock, transport } = await connected({ maxImageBytes: 16 });
  await assert.rejects(() => transport.sendImage({ kind: "group", openid: "G1" }, Buffer.alloc(64), "m1"), /超过上限/);
  assert.equal(mock.state.uploads.length, 0);
  await transport.stop(); await mock.stop();
});

test("缺少凭据时启动直接报错，不静默重试", async () => {
  const mock = createMockOfficial();
  await mock.start();
  const transport = createOfficial({ appId: "", clientSecret: "", tokenUrl: mock.tokenUrl, apiBase: mock.apiBase, sandboxApiBase: mock.apiBase });
  await assert.rejects(() => transport.start(() => {}), /缺少 appId \/ clientSecret/);
  await mock.stop();
});

test("断线后自动重连", async () => {
  const { mock, transport } = await connected({ minSendIntervalMs: 0 });
  assert.equal(transport.state.connected, true);
  mock.dropClients();
  const back = await mock.waitFor(() => transport.state.connected, 8000);
  assert.ok(back, "断线后应自动重连");
  await transport.stop(); await mock.stop();
});

test("stop 之后不再重连", async () => {
  const { mock, transport } = await connected();
  await transport.stop();
  mock.dropClients();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(transport.state.connected, false);
  await mock.stop();
});

// ── 引用回复 ────────────────────────────────────────────────────────
// 官方接口里「被动回复」和「引用」是两个独立字段：前者用事件的 d.id，后者用
// message_scene.ext 里的 msg_idx。只带 msg_id 不会以引用形式展示。

test("从 message_scene.ext 取出引用 id（msg_idx）", async () => {
  const { mock, transport } = await connected();
  mock.push("GROUP_AT_MESSAGE_CREATE", {
    id: "m1", group_openid: "G1", content: "你好", timestamp: new Date().toISOString(),
    author: { member_openid: "U1" },
    message_scene: { source: "default", ext: ["auth_token=abc", "msg_idx=REFIDX_xyz==", "msg_idx_extra"] },
  });
  const ok = await mock.waitFor(() => {
    const ev = transport.normalize("GROUP_AT_MESSAGE_CREATE", { id: "m1", message_scene: { ext: ["msg_idx=REFIDX_xyz=="] } });
    return ev.refId === "REFIDX_xyz==";
  });
  assert.ok(ok, "应当从 ext 里取出 msg_idx");
  await transport.stop(); await mock.stop();
});

test("ext 里没有 msg_idx 时 refId 为 null，不编一个出来", async () => {
  const { mock, transport } = await connected();
  const ev = transport.normalize("GROUP_AT_MESSAGE_CREATE", { id: "m1", message_scene: { ext: ["auth_token=abc"] } });
  assert.equal(ev.refId, null);
  const ev2 = transport.normalize("GROUP_AT_MESSAGE_CREATE", { id: "m1" });
  assert.equal(ev2.refId, null, "连 message_scene 都没有时也要安全返回 null");
  // ⚠ mock.stop() 不能漏：漏一个就有个 HTTP server 一直 listen 着，事件循环永远不空。
  // 症状是整个文件跑完之后进程不退、等满 test-timeout 才被取消，退出码非零 ——
  // 于是这个套件没法当构建闸门用。（这条原来就漏了，README 里那句
  // 「某个用例留下的计时器会让进程等满退避时间」记的就是这个现象。）
  await transport.stop(); await mock.stop();
});

test("带 refId 时消息以引用形式发出", async () => {
  const { mock, transport } = await connected();
  await transport.sendText({ kind: "group", openid: "G1" }, "回复内容", "m1", "REFIDX_abc==");
  const body = mock.state.sent[0].body;
  assert.deepEqual(body.message_reference, { message_id: "REFIDX_abc==" }, "要带 message_reference 才会显示成引用");
  assert.equal(body.msg_id, "m1", "被动回复凭据仍然要在（两者是不同字段）");
  await transport.stop(); await mock.stop();
});

test("没有 refId 时不带 message_reference 字段", async () => {
  const { mock, transport } = await connected();
  await transport.sendText({ kind: "group", openid: "G1" }, "普通回复", "m1");
  assert.equal(mock.state.sent[0].body.message_reference, undefined);
  await transport.stop(); await mock.stop();
});

test("发图同样支持引用", async () => {
  const { mock, transport } = await connected();
  await transport.sendImage({ kind: "group", openid: "G1" }, Buffer.from("89504e47", "hex"), "m1", "图", "REFIDX_img==");
  assert.deepEqual(mock.state.sent[0].body.message_reference, { message_id: "REFIDX_img==" });
  await transport.stop(); await mock.stop();
});

// ── 全量群消息模式（2026-09-19 实测形状）──────────────────────────────

test("正文里的 @ 标记要摘掉：两种事件的形状不一样", () => {
  const setup = createOfficial({ appId: "1", clientSecret: "s" });
  // AT 事件（没开全量消息）：平台已经替我们摘掉了
  const at = setup.normalize("GROUP_AT_MESSAGE_CREATE", { id: "m1", content: " 2", group_openid: "G1" });
  assert.equal(at.content, "2");
  // 全量事件（开了之后）：@ 以 <@openid> 标记留在正文里
  const full = setup.normalize("GROUP_MESSAGE_CREATE", { id: "m2", content: "<@5FE5240E4627033E7488D3516E0DE79E> /help", group_openid: "G1" });
  assert.equal(full.content, "/help",
    "不摘掉的话上层按「开头是不是 /」判指令会认不出来 —— 实测抓到的症状是 @ 它发 /help 被当成闲聊喂给模型");
});

test("mentionsSelf：认的是 is_you，不是 id", () => {
  const t = createOfficial({ appId: "1", clientSecret: "s" });
  const mk = (mention) => t.normalize("GROUP_MESSAGE_CREATE", { id: "m", content: "x", group_openid: "G1", mentions: mention ? [mention] : undefined });

  const self = mk({ bot: true, id: "5FE5240E", is_you: true, member_openid: "5FE5240E" });
  assert.equal(self.mentionsSelf, true);
  assert.deepEqual(self.mentionedOpenids, [],
    "自己**不能**出现在「@ 过谁」的名单里 —— 名单的每个调用方要的都是别人。"
    + "不排除的话「@美亚 /牌子 耀击」会被当成「查美亚自己」，回一句「TA 还没把账号交给美亚」（线上实测踩到过）");

  // 同时 @ 自己和别人：名单里只该有别人
  const both = t.normalize("GROUP_MESSAGE_CREATE", {
    id: "m", content: "x", group_openid: "G1",
    mentions: [{ bot: true, id: "5FE5240E", is_you: true }, { bot: false, id: "OTHER1", is_you: false }],
  });
  assert.equal(both.mentionsSelf, true);
  assert.deepEqual(both.mentionedOpenids, ["OTHER1"], "只留别人");

  // 实测收到过另一只 bot 被 @ 的 /login —— 这条不能算「@ 到了我」
  const other = mk({ bot: true, id: "C19063DA", is_you: false, member_openid: "C19063DA" });
  assert.equal(other.mentionsSelf, false, "别人被 @ 不算 @ 我，否则会去抢答别人的指令");
  assert.deepEqual(other.mentionedOpenids, ["C19063DA"], "但名单要留着，查别人时用得上");

  const plain = mk(null);
  assert.equal(plain.mentionsSelf, false);
  assert.deepEqual(plain.mentionedOpenids, [], "普通群消息完全没有 mentions 字段");
});

test("@全体成员：可从正文或结构化 mention 识别，且不能混进查询对象", () => {
  const t = createOfficial({ appId: "1", clientSecret: "s" });
  const textShape = t.normalize("GROUP_AT_MESSAGE_CREATE", {
    id: "all-text", group_openid: "G1", content: "@全体成员 开会啦",
  });
  assert.equal(textShape.mentionsEveryone, true);

  const structured = t.normalize("GROUP_MESSAGE_CREATE", {
    id: "all-structured", group_openid: "G1", content: "<@all> 开会啦",
    // 部分平台形态会同时把 is_you 标成 true（机器人也属于“全体”）；仍应优先认作 @全体。
    mentions: [{ scope: "all", type: "all", is_you: true }],
  });
  assert.equal(structured.mentionsEveryone, true);
  assert.equal(structured.mentionsSelf, true, "保留平台原始语义，由入口层优先排除 @全体");
  assert.deepEqual(structured.mentionedOpenids, [], "全体标记不是一个可查询的用户");
});

test("被动凭据复用：开关关着时用原始凭据", async () => {
  const { mock, transport, events } = await connected({ minuteSendIntervalMs: 0, minSendIntervalMs: 0 });
  mock.push("GROUP_MESSAGE_CREATE", { id: "m-fresh", content: "有人在说话", group_openid: "G1", timestamp: new Date().toISOString(), author: { member_openid: "U9" } });
  await mock.waitFor(() => events.some((e) => e.name === "GROUP_MESSAGE_CREATE"));
  await transport.sendText({ kind: "group", openid: "G1" }, "回复", "m-old");
  assert.equal(mock.state.sent[0].body.msg_id, "m-old", "默认不动别人的凭据");
  await transport.stop(); await mock.stop();
});

test("被动凭据复用：开关打开后改用该目标最新一条消息的凭据", async () => {
  const { mock, transport, events } = await connected({ reuseLatestPassiveCredential: true, minSendIntervalMs: 0, perTargetIntervalMs: 0 });
  mock.push("GROUP_MESSAGE_CREATE", { id: "m-fresh", content: "有人在说话", group_openid: "G1", timestamp: new Date().toISOString(), author: { member_openid: "U9" } });
  await mock.waitFor(() => events.some((e) => e.name === "GROUP_MESSAGE_CREATE"));
  // 模拟「几分钟前那条指令触发的图终于画好了」：凭据还是老的，但群里刚有人说话
  await transport.sendText({ kind: "group", openid: "G1" }, "图好了", "m-old");
  assert.equal(mock.state.sent[0].body.msg_id, "m-fresh",
    "要用新鲜凭据，否则 5 分钟的群窗口早就过期了");
  await transport.stop(); await mock.stop();
});

// ── 引用回复的原文（message_type 103 + msg_elements）──────────────────
// 形状照官方文档（C2C_MESSAGE_CREATE / GROUP_MESSAGE_CREATE，2026-09-16 版）：
// 被引用那条在 msg_elements 里，ext 的 ref_msg_idx 指向它的 msg_idx。

const quotedEvent = (over = {}) => ({
  id: "q1", group_openid: "G1", content: "<@5FE5240E> 你觉得像吗", message_type: 103,
  author: { member_openid: "U1" },
  mentions: [{ bot: true, id: "5FE5240E", is_you: true, member_openid: "5FE5240E" }],
  message_scene: { source: "default", ext: ["msg_idx=REFIDX_self==", "auth_token=x", "ref_msg_idx=REFIDX_cake=="] },
  msg_elements: [{
    msg_idx: "REFIDX_cake==", message_type: 0, content: " 定做的蛋糕 ",
    author: { id: "U1", member_openid: "U1", username: "sam", bot: false },
    attachments: [{ content_type: "image/jpeg", filename: "cake.jpg", url: "https://multimedia.nt.qq.com.cn/download?fileid=SECRET_FILE&rkey=SECRET_RKEY" }],
  }],
  ...over,
});

test("引用回复：按 ref_msg_idx 取出被引用那条的正文和附件", () => {
  const t = createOfficial({ appId: "1", clientSecret: "s" });
  const ev = t.normalize("GROUP_MESSAGE_CREATE", quotedEvent());
  assert.equal(ev.content, "你觉得像吗");
  assert.equal(ev.refId, "REFIDX_self==", "回复时引用的仍是本条自己的 msg_idx，不是被引用那条的");
  assert.equal(ev.quote.content, "定做的蛋糕");
  assert.equal(ev.quote.fromSelf, false);
  assert.equal(ev.quote.attachments.length, 1);
  assert.equal(ev.quote.attachments[0].content_type, "image/jpeg");
});

test("引用回复：被引用的是美亚自己（作者 openid 跟本条 @ 到的自己对上）", () => {
  const t = createOfficial({ appId: "1", clientSecret: "s" });
  const mine = quotedEvent();
  mine.msg_elements[0].author = { id: "5FE5240E", member_openid: "5FE5240E", username: "MiaBot", bot: true };
  assert.equal(t.normalize("GROUP_MESSAGE_CREATE", mine).quote.fromSelf, true);
  // 别的 bot 发的不算自己
  const other = quotedEvent();
  other.msg_elements[0].author = { id: "C19063DA", member_openid: "C19063DA", bot: true };
  assert.equal(t.normalize("GROUP_MESSAGE_CREATE", other).quote.fromSelf, false);
  // 私聊里的机器人只可能是自己
  const c2c = t.normalize("C2C_MESSAGE_CREATE", { ...quotedEvent(), author: { user_openid: "U2" },
    msg_elements: [{ msg_idx: "REFIDX_cake==", content: "刚才那句", author: { id: "BOT", bot: true } }] });
  assert.equal(c2c.quote.fromSelf, true);
  assert.equal(c2c.quote.content, "刚才那句");
});

test("引用回复：对不上 msg_idx 时，列表只有一条就用那条（官方示例那种），多条就不猜", () => {
  const t = createOfficial({ appId: "1", clientSecret: "s" });
  const single = t.normalize("GROUP_MESSAGE_CREATE", quotedEvent({ msg_elements: [{ content: "=== 消息 1 ===" }] }));
  assert.equal(single.quote.content, "=== 消息 1 ===");
  assert.deepEqual(single.quote.attachments, []);
  const many = t.normalize("GROUP_MESSAGE_CREATE", quotedEvent({ msg_elements: [{ msg_idx: "A", content: "一" }, { msg_idx: "B", content: "二" }] }));
  assert.equal(many.quote, null);
  assert.match(many.quoteShape, /msg_elements 2 条：#0 msg_idx 对不上/);
});

test("不是引用回复：quote 为 null、没有结构摘要；有 103 没元素也不编一条", () => {
  const t = createOfficial({ appId: "1", clientSecret: "s" });
  const plain = t.normalize("GROUP_MESSAGE_CREATE", { id: "m", group_openid: "G1", content: "早", message_type: 0 });
  assert.equal(plain.quote, null);
  assert.equal(plain.quoteShape, "");
  const empty = t.normalize("GROUP_MESSAGE_CREATE", quotedEvent({ msg_elements: [] }));
  assert.equal(empty.quote, null);
  assert.match(empty.quoteShape, /^type=103｜ref_msg_idx 有｜msg_elements 0 条$/);
});

test("引用消息的结构摘要：只有字段名和附件种类，不带正文和图片地址", () => {
  const t = createOfficial({ appId: "1", clientSecret: "s" });
  const shape = t.normalize("GROUP_MESSAGE_CREATE", quotedEvent()).quoteShape;
  assert.equal(shape, "type=103｜ref_msg_idx 有｜msg_elements 1 条：#0 msg_idx 对上 type=0 正文 5 字 附件 image/jpeg×1 字段 attachments,author,content,message_type,msg_idx");
  assert.doesNotMatch(shape, /SECRET|蛋糕|https?:/);
});

test("Markdown：发成 msg_type=2；被拒就用纯文本补发、不熔断，之后直接发纯文本", async () => {
  const logs = [];
  const { mock, transport } = await connected({ log: (m) => logs.push(m) });
  await transport.sendMarkdown({ kind: "group", openid: "G1" }, "**md**", "纯文本", "m1");
  assert.equal(mock.state.sent[0].body.msg_type, 2);
  assert.equal(mock.state.sent[0].body.markdown.content, "**md**");
  assert.equal(mock.state.sent[0].body.content, undefined);

  mock.state.nextError = { status: 400, err_code: 40034012, message: "不允许发送原生 markdown" };
  await transport.sendMarkdown({ kind: "group", openid: "G1" }, "**md2**", "纯文本2", "m2");
  const last = mock.state.sent.at(-1).body;
  assert.equal(last.msg_type, 0);
  assert.equal(last.content, "纯文本2");
  assert.equal(last.msg_seq, 2, "补发要换新的 msg_seq，不然被判重复");
  assert.ok(logs.some((m) => /Markdown 消息被拒（40034012）/.test(m)));

  await transport.sendMarkdown({ kind: "group", openid: "G1" }, "**md3**", "纯文本3", "m3");
  assert.equal(mock.state.sent.at(-1).body.msg_type, 0, "拒过一次就不再试 Markdown");
  await transport.stop(); await mock.stop();
});

test("Markdown：被动回复过期不补发；关掉 markdown 配置就只发纯文本", async () => {
  const { mock, transport } = await connected();
  mock.state.nextError = { status: 400, err_code: 40034128, message: "被动回复过期" };
  await assert.rejects(() => transport.sendMarkdown({ kind: "c2c", openid: "U1" }, "**md**", "纯文本", "m1"));
  assert.equal(mock.state.sent.length, 0);
  await transport.stop(); await mock.stop();

  const off = await connected({ markdown: false });
  await off.transport.sendMarkdown({ kind: "c2c", openid: "U1" }, "**md**", "纯文本", "m1");
  assert.equal(off.mock.state.sent[0].body.msg_type, 0);
  await off.transport.stop(); await off.mock.stop();
});

test("按钮回调：订了 1<<26；群和单聊的点击都归一化成「这个人发了按钮里的指令」", async () => {
  const { mock, transport, events } = await connected();
  assert.ok(mock.state.identified[0].d.intents & (1 << 26), "缺少 INTERACTION(1<<26)，回调按钮点了收不到");
  mock.push("INTERACTION_CREATE", {
    id: "itr-1", type: 11, chat_type: 1, scene: "group", group_openid: "G1", group_member_openid: "U1",
    timestamp: "2026-10-10T12:00:00+08:00", data: { type: 11, resolved: { button_id: "next", button_data: "/搜索歌曲 Ai --page 2" } },
  });
  await mock.waitFor(() => events.length >= 1);
  const g = transport.normalize(events[0].name, events[0].d);
  assert.deepEqual([g.type, g.openid, g.userId, g.content, g.msgId, g.interactionId, g.mentionsSelf],
    ["group", "G1", "U1", "/搜索歌曲 Ai --page 2", "itr-1", "itr-1", true]);
  const c = transport.normalize("INTERACTION_CREATE", { id: "itr-2", chat_type: 2, user_openid: "U2", data: { resolved: { button_data: "/搜索歌曲 a" } } });
  assert.deepEqual([c.type, c.openid, c.userId], ["c2c", "U2", "U2"]);
  assert.equal(transport.normalize("INTERACTION_CREATE", { id: "itr-3", group_openid: "G1", group_member_openid: "U1", data: { resolved: {} } }), null, "没有按钮数据不接");
  assert.equal(transport.normalize("INTERACTION_CREATE", { id: "itr-4", guild_id: "X", channel_id: "C", data: { resolved: { button_data: "/x" } } }), null, "频道的回调不接");
  await transport.stop(); await mock.stop();
});

test("按钮回调：应答走 PUT /interactions/{回调 id}；回复的 event_id 是网关帧外层的 id，msg_seq 照样递增", async () => {
  const { mock, transport, events } = await connected();
  await transport.ackInteraction("itr-9");
  assert.deepEqual(mock.state.acks, [{ id: "itr-9", body: { code: 0 } }]);

  mock.push("INTERACTION_CREATE", { id: "itr-5", group_openid: "G1", group_member_openid: "U1", data: { resolved: { button_data: "/搜索歌曲 a --page 2" } } }, "INTERACTION_CREATE:frame-5");
  await mock.waitFor(() => events.length >= 1);
  await transport.sendText({ kind: "group", openid: "G1" }, "第一条", "itr-5");
  await transport.sendMarkdown({ kind: "group", openid: "G1" }, "**第二条**", "第二条", "itr-5");
  const [first, second] = mock.state.sent.map((s) => s.body);
  assert.equal(first.event_id, "INTERACTION_CREATE:frame-5", "回调 id（d.id）当 event_id 会被拒 40034025");
  assert.equal(first.msg_id, undefined, "回调事件的 id 不是 msg_id");
  assert.deepEqual([first.msg_seq, second.msg_seq], [1, 2]);

  await transport.sendText({ kind: "group", openid: "G1" }, "普通消息", "m1");
  assert.equal(mock.state.sent.at(-1).body.msg_id, "m1", "普通消息照旧用 msg_id");
  await transport.stop(); await mock.stop();
});

test("按钮：挂在 Markdown 上发；被拒就去掉按钮、换上不带按钮的正文再发一次，之后不再带按钮", async () => {
  const logs = [];
  const { mock, transport } = await connected({ log: (m) => logs.push(m) });
  const keyboard = { rows: [{ buttons: [{ id: "next" }] }] };
  const options = { keyboard, markdownWithoutKeyboard: "**无按钮**" };
  await transport.sendMarkdown({ kind: "group", openid: "G1" }, "**有按钮**", "纯文本", "m1", null, options);
  assert.deepEqual(mock.state.sent[0].body.keyboard, { content: keyboard });
  assert.equal(mock.state.sent[0].body.markdown.content, "**有按钮**");

  mock.state.nextError = { status: 400, err_code: 40034999, message: "不允许发送按钮" };
  await transport.sendMarkdown({ kind: "group", openid: "G1" }, "**有按钮2**", "纯文本2", "m2", null, options);
  const retry = mock.state.sent.at(-1).body;
  assert.equal(retry.msg_type, 2, "按钮被拒不等于 Markdown 被拒");
  assert.equal(retry.keyboard, undefined);
  assert.equal(retry.markdown.content, "**无按钮**");
  assert.ok(logs.some((m) => /带按钮的消息被拒（40034999）/.test(m)));

  await transport.sendMarkdown({ kind: "group", openid: "G1" }, "**有按钮3**", "纯文本3", "m3", null, options);
  assert.equal(mock.state.sent.at(-1).body.keyboard, undefined, "拒过一次就不再带按钮");
  assert.equal(mock.state.sent.at(-1).body.markdown.content, "**无按钮**");
  await transport.stop(); await mock.stop();

  const off = await connected({ keyboard: false });
  await off.transport.sendMarkdown({ kind: "c2c", openid: "U1" }, "**有按钮**", "纯文本", "m1", null, options);
  assert.equal(off.mock.state.sent[0].body.keyboard, undefined);
  assert.equal(off.mock.state.sent[0].body.markdown.content, "**无按钮**");
  await off.transport.stop(); await off.mock.stop();
});

test("按钮回调：开着 reuseLatestPassiveCredential 时也用这次点击的凭据，不换回群里更早的消息", async () => {
  const { mock, transport, events } = await connected({ reuseLatestPassiveCredential: true });
  mock.push("GROUP_AT_MESSAGE_CREATE", { id: "old-search", group_openid: "G1", content: "/搜索歌曲 a", author: { member_openid: "U1" } });
  mock.push("INTERACTION_CREATE", { id: "itr-new", group_openid: "G1", group_member_openid: "U1", data: { resolved: { button_data: "/搜索歌曲 a --page 2" } } }, "INTERACTION_CREATE:frame-new");
  await mock.waitFor(() => events.length >= 2);
  await transport.sendText({ kind: "group", openid: "G1" }, "第二页", "itr-new");
  const body = mock.state.sent.at(-1).body;
  assert.equal(body.event_id, "INTERACTION_CREATE:frame-new");
  assert.equal(body.msg_id, undefined);
  await transport.stop(); await mock.stop();
});

test("凭据错了（三种格式全被拒）：原样报错，不记成「平台不收按钮 / Markdown」，也不熔断", async () => {
  const { mock, transport } = await connected();
  const options = { keyboard: { rows: [{ buttons: [{ id: "next" }] }] }, markdownWithoutKeyboard: "**无按钮**" };
  // 带按钮、不带按钮、纯文本连着三次都被拒（2026-10-10 线上实测的形状）
  mock.state.nextError = { status: 400, err_code: 40034025, message: "请求参数event_id无效", times: 3 };
  await assert.rejects(() => transport.sendMarkdown({ kind: "group", openid: "G1" }, "**有按钮**", "纯文本", "m1", null, options), /event_id无效/);
  assert.equal(mock.state.nextError, null, "三种格式都试过了");
  assert.equal(transport.state.circuitOpen, false, "参数错误不是平台异常");

  await transport.sendMarkdown({ kind: "group", openid: "G1" }, "**有按钮**", "纯文本", "m2", null, options);
  const body = mock.state.sent.at(-1).body;
  assert.equal(body.msg_type, 2, "Markdown 没被记成不能用");
  assert.ok(body.keyboard, "按钮没被记成不能用");
  await transport.stop(); await mock.stop();
});
