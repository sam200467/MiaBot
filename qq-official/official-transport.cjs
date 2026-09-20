"use strict";
// QQ 官方机器人开放平台传输层（WebSocket 网关 + REST）。
//
// 与 qq-onebot.cjs 的分工完全一致：连接、收发、限流全关在这个文件里，上层不碰协议。
// 但协议本身毫无共同点 —— OneBot 是「NapCat 主动连我们、动作走同一个 WS」，
// 官方是「我们主动连腾讯网关、收事件走 WS、发消息走 REST」。
//
// 协议要点（2026-09 核实，来源见 README）：
//   - 鉴权：AppID + AppSecret 换 access_token，有效期 7200 秒，要自己定时刷新
//   - 请求头 Authorization: QQBot {access_token}
//   - 事件走 WebSocket 网关；Identify(op=2) → Hello(op=10) → Ready → 心跳(op=1)/心跳ACK(op=11)
//   - **发消息不走 WS**，走 REST，且要带被动回复凭据 msg_id + 递增的 msg_seq
//   - 被动回复时效：群聊 5 分钟 5 次、单聊 60 分钟 4～5 次，超了报 40034128
//   - 主动消息自 2025-04 起基本不可用，本层不提供主动推送能力

const { WebSocket } = require("ws");

const OP = { DISPATCH: 0, HEARTBEAT: 1, IDENTIFY: 2, RESUME: 6, RECONNECT: 7, INVALID_SESSION: 9, HELLO: 10, HEARTBEAT_ACK: 11 };

// QQ 群/单聊 与 QQ 频道 是**两套互不相通的接口**：事件名、intent 位、发送路径全不同。
// 只订群聊的位时，频道里 @ 它一个事件都收不到 —— 这个坑实测踩过。
//
// 1<<24 是群成员进出。官方事件页给 GROUP_MESSAGE_CREATE 的 intent 也是 1<<25，
// 但社区有人报告单订 1<<25 收不到全量群消息，建议两个位都订（成本极低，对冲不确定性）。
// 1<<30 是频道的公域 @ 消息（不需要额外申请）；频道私域消息 1<<9 要申请，这里不订。
const INTENT_GROUP_AND_C2C = 1 << 25;
const INTENT_GROUP_MEMBER = 1 << 24;
const INTENT_PUBLIC_GUILD_MESSAGES = 1 << 30;

const DEFAULTS = Object.freeze({
  appId: "",
  clientSecret: "",
  sandbox: false,
  intents: INTENT_GROUP_AND_C2C | INTENT_GROUP_MEMBER | INTENT_PUBLIC_GUILD_MESSAGES,
  tokenUrl: "https://bots.qq.com/app/getAppAccessToken",
  // 2026-08-10 起官方统一域名。沙箱仍走 sandbox。
  apiBase: "https://api.bot.qq.com",
  sandboxApiBase: "https://sandbox.api.sgroup.qq.com",
  tokenRefreshMarginMs: 5 * 60 * 1000,
  callTimeoutMs: 20000,
  maxBackoffMs: 15 * 60 * 1000,
  reconnectBaseMs: 2000,
  // 心跳周期由网关的 Hello 指定；这里只是下限，防止测试里回一个荒谬的小值刷屏
  minHeartbeatIntervalMs: 5000,
  maxImageBytes: 8 * 1024 * 1024,

  // 官方有正式频控并会返回明确错误码，失败代价不再是封号（这点和 NapCat 版相反）。
  // 所以节流放宽，但**熔断保留** —— 它是识别「平台侧异常」的手段，不是为了保号。
  minSendIntervalMs: 500,
  jitterMs: 200,
  perTargetIntervalMs: 1000,
  perTargetPerHour: 60,
  dailyCap: 3000,
  duplicateWindowMs: 60000,
});

function createOfficial(host) {
  const config = { ...DEFAULTS };
  for (const [key, value] of Object.entries(host || {})) if (value !== undefined) config[key] = value;
  const log = typeof config.log === "function" ? config.log : () => {};
  const now = typeof config.now === "function" ? config.now : Date.now;
  const random = typeof config.random === "function" ? config.random : Math.random;
  const fetchImpl = config.fetchImpl || fetch;
  const WS = config.WebSocketImpl || WebSocket;
  const apiBase = () => (config.sandbox ? config.sandboxApiBase : config.apiBase);

  let socket = null;
  let startedAt = 0;
  let reconnectTimer = null;
  let heartbeatTimer = null;
  let heartbeatAckAt = 0;
  let sessionId = null;
  let lastSeq = null;
  let token = null, tokenExpireAt = 0;
  let reconnectAttempts = 0;
  let stopped = false;
  let onEvent = null;

  let sendChain = Promise.resolve();
  const msgSeq = new Map();               // msg_id -> 已用次数（被动回复要递增）
  const recentIds = new Map();            // 事件去重
  const recentTexts = new Map();          // 相同内容抑制
  // 每个目标最近一条 inbound 消息的被动凭据。开了 reuseLatestPassiveCredential 时，
  // 延迟发出的东西改用它当 msg_id —— 群窗口只有 5 分钟，而分表/牌子这类生成上限是
  // 6～10 分钟，等图出来时原始凭据往往已经过期。实测（2026-09-19）平台接受
  // 「用新消息的凭据 + 引用指向旧请求」这种搭配。
  const latestInbound = new Map();        // targetKey -> { msgId, at }
  const rateState = { day: "", dayCount: 0, lastSendAt: 0, byTarget: new Map() };
  let circuit = { failures: 0, openUntil: 0 };

  const state = {
    get connected() { return socket !== null && socket.readyState === 1 && Boolean(sessionId); },
    get appId() { return config.appId; },
    get sessionId() { return sessionId; },
    get circuitOpen() { return circuit.openUntil > now(); },
    get pendingSends() { return sendChain === null ? 0 : 0; },
  };

  const prune = (map, key, ttl) => {
    const current = now();
    for (const [k, expiry] of map) if (expiry <= current) map.delete(k);
    if (key !== undefined) map.set(key, current + ttl);
  };

  function tripCircuit(reason) {
    circuit.failures = Math.min(circuit.failures + 1, 6);
    const wait = Math.min(config.minSendIntervalMs * Math.pow(2, circuit.failures + 4), config.maxBackoffMs);
    circuit.openUntil = now() + wait;
    log("发送失败疑似平台异常，熔断 " + Math.round(wait / 1000) + " 秒：" + reason);
  }
  function resetCircuit() { circuit = { failures: 0, openUntil: 0 }; }
  function circuitOpenError() {
    return new Error("发送熔断中，还需等待 " + Math.ceil((circuit.openUntil - now()) / 1000) + " 秒");
  }

  // ── 鉴权 ────────────────────────────────────────────────────────────
  async function refreshToken(force) {
    if (!force && token && now() < tokenExpireAt - config.tokenRefreshMarginMs) return token;
    const response = await fetchImpl(config.tokenUrl, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appId: String(config.appId), clientSecret: String(config.clientSecret) }),
    });
    if (!response.ok) throw new Error("换 access_token 失败：HTTP " + response.status);
    const payload = await response.json();
    if (!payload.access_token) throw new Error("换 access_token 失败：" + JSON.stringify(payload).slice(0, 200));
    token = payload.access_token;
    tokenExpireAt = now() + Number(payload.expires_in || 7200) * 1000;
    log("已取得 access_token（" + Math.round(Number(payload.expires_in || 7200) / 60) + " 分钟后过期）");
    return token;
  }

  // 把 inbound 的 msg_id 按目标记下来。键的算法要和 targetKey 一致，
  // 否则发的时候取不到。只认带 d.id 的普通消息事件。
  function rememberInbound(eventName, d) {
    const id = d?.id;
    if (!id) return;
    let key = null;
    if (eventName === "GROUP_AT_MESSAGE_CREATE" || eventName === "GROUP_MESSAGE_CREATE") key = "group:" + String(d.group_openid || "");
    else if (eventName === "C2C_MESSAGE_CREATE") key = "c2c:" + String(d.author?.user_openid || d.author?.id || "");
    else if (eventName === "AT_MESSAGE_CREATE" || eventName === "MESSAGE_CREATE") key = "channel:" + String(d.channel_id || "");
    if (!key || key.endsWith(":")) return;
    latestInbound.set(key, { msgId: String(id), at: now() });
  }

  // 这次发送实际该用哪个被动凭据。
  // 默认就是调用方给的那个（= 触发这次回复的那条消息）。开了开关之后改用
  // 「该目标最新一条 inbound」—— 它一定比原始凭据新鲜，因为刚有人说过话。
  // ⚠ 它**不是万能补丁**：没人说话的话就没有新鲜凭据可用，照样过期。
  // 引用（message_reference）不受影响，仍然指向原始那条请求，所以视觉上还是
  // 「在回复那条指令」。
  function effectiveMsgId(target, msgId) {
    if (!config.reuseLatestPassiveCredential) return msgId;
    const latest = latestInbound.get(targetKey(target));
    if (!latest || !latest.msgId || latest.msgId === msgId) return msgId;
    // 这句话**不是错误**：只要群里在那之后有人说过话就会换，属于常态。
    // 措辞别写成告警，否则日志里满屏「失败」会把人带偏。
    log("被动凭据改用该目标最新一条消息（原凭据可能已过期，群窗口只有 5 分钟）");
    return latest.msgId;
  }

  // ── REST ────────────────────────────────────────────────────────────
  async function rest(method, path, body, { retryOnAuth = true } = {}) {
    const current = await refreshToken(false);
    const response = await fetchImpl(apiBase() + path, {
      method,
      headers: { "Content-Type": "application/json", Authorization: "QQBot " + current },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (response.status === 401 && retryOnAuth) {          // 令牌提前失效：强制换一次再试
      await refreshToken(true);
      return rest(method, path, body, { retryOnAuth: false });
    }
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch { /* 非 JSON 就原样带出去 */ }
    if (!response.ok) {
      const error = new Error("官方接口 HTTP " + response.status + (payload?.message ? "：" + payload.message : "：" + text.slice(0, 200)));
      error.status = response.status;
      error.code = payload?.err_code;
      // 原文也带上：有些错误码的**具体限制值只在这个响应体里**（比如 40030013
      // 「超出数量限制」会带一个 limit 字段），只留 message 的话等于把线索丢了 ——
      // 实测就卡在这儿：知道超限了，但不知道限到多少。
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  function classify(error) {
    if (!error) return "unknown";
    if (error.code === 40034128) return "passive_expired";   // 被动回复超时或超次数
    if (error.code === 40034105 || error.code === 40034102) return "no_permission";
    if (error.code === 40034100) return "rate_limited";
    if (error.status === 429) return "rate_limited";
    if (error.status >= 500) return "server";
    if (/ECONN|socket|timeout|超时/i.test(String(error.message || ""))) return "network";
    return "unknown";
  }

  function assertSendAllowed(target) {
    if (circuit.openUntil > now()) throw circuitOpenError();
    const today = new Date(now()).toISOString().slice(0, 10);
    if (rateState.day !== today) { rateState.day = today; rateState.dayCount = 0; }
    if (rateState.dayCount >= config.dailyCap) throw new Error("已达每日发送上限 " + config.dailyCap + " 条，停止发送");
    const entry = rateState.byTarget.get(target) || { last: 0, hour: 0, hourStart: 0 };
    if (now() - entry.hourStart > 3600000) { entry.hourStart = now(); entry.hour = 0; }
    // 每小时上限要抛（等一小时没有意义）；**间隔不抛，改成等** —— 见 nextSendDelay。
    // 抛出去等于这条回复直接丢了，聊天里就是「用户发了消息 bot 没反应」。
    if (entry.hour >= config.perTargetPerHour) throw new Error("对同一目标的发送已达每小时上限（" + config.perTargetPerHour + " 条）");
    rateState.byTarget.set(target, entry);
  }

  // 还要等多久才允许发出下一条：全局间隔与目标间隔取较大者。
  function nextSendDelay(key) {
    const globalWait = config.minSendIntervalMs + Math.floor(random() * config.jitterMs);
    let delay = 0;
    const globalGap = now() - rateState.lastSendAt;
    if (globalGap < globalWait) delay = globalWait - globalGap;
    const entry = rateState.byTarget.get(key);
    if (entry) {
      const gap = now() - entry.last;
      if (gap < config.perTargetIntervalMs) delay = Math.max(delay, config.perTargetIntervalMs - gap);
    }
    return delay;
  }

  // 相同内容抑制的键。**必须带上被动回复凭据（msg_id）**，不能只用 target + 正文：
  // 那样一来，同一分钟里两条**不同的**消息只要回复文案一样，第二条就被吞掉。
  // 梨绪的回复带模型生成的随机性，撞不上；美亚的指令回复是预写模板、每次都一样，
  // 撞车会是常态，而用户看到的现象是「发了指令没反应」——最难查的那一类。
  // 带上 msg_id 之后，不同消息各有各的凭据；同一条消息被重复投递仍然会被抑制，
  // 而那正是这个机制本来要挡的东西。
  // 分隔符用 NUL：它不可能出现在正文或 id 里，拼接不会撞键。写成转义而不是裸字节——
  // 裸字节会让整个文件被工具当成二进制（grep 要加 -a，diff 也读不了）。
  const suppressKey = (target, text, msgId) =>
    target + "\u0000" + String(msgId || "") + "\u0000" + String(text).slice(0, 120);

  function noteSend(target, text, msgId) {
    rateState.dayCount += 1;
    rateState.lastSendAt = now();
    const entry = rateState.byTarget.get(target) || { last: 0, hour: 0, hourStart: now() };
    entry.last = now(); entry.hour += 1;
    rateState.byTarget.set(target, entry);
    if (text) prune(recentTexts, suppressKey(target, text, msgId), config.duplicateWindowMs);
  }

  // msg_id -> { count, at }。**不能复用 prune** —— 那张表存的是计数不是过期时间戳，
  // prune 会把每个计数都判成已过期而删掉，msg_seq 就永远回到 1，官方会把第二条起
  // 全判成重复发送。
  function nextSeq(msgId) {
    const entry = msgSeq.get(msgId);
    const count = (entry?.count || 0) + 1;
    msgSeq.set(msgId, { count, at: now() });
    const current = now();
    for (const [k, v] of msgSeq) if (current - v.at > 3600000) msgSeq.delete(k);  // 单聊被动窗口最长 60 分钟
    return count;
  }

  // target: { kind: "group" | "c2c", openid }
  function targetKey(target) { return target.kind + ":" + target.openid; }
  function messagePath(target) {
    if (target.kind === "group") return "/v2/groups/" + target.openid + "/messages";
    if (target.kind === "channel") return "/channels/" + target.openid + "/messages";
    return "/v2/users/" + target.openid + "/messages";
  }
  function filePath(target) {
    if (target.kind === "group") return "/v2/groups/" + target.openid + "/files";
    if (target.kind === "channel") return "/channels/" + target.openid + "/files";
    return "/v2/users/" + target.openid + "/files";
  }

  async function sendText(target, text, msgId, refId) {
    const run = async () => {
      const key = targetKey(target);
      const suppress = suppressKey(key, text, msgId);
      if ((recentTexts.get(suppress) || 0) > now()) throw new Error("相同内容在冷却期内，已抑制");
      assertSendAllowed(key);
      const delay = nextSendDelay(key);
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));

      // 被动回复必须带 msg_id；msg_seq 对同一个 msg_id 要递增，否则被当成重复发送
      const useId = effectiveMsgId(target, msgId);
      const body = { content: String(text), msg_type: 0 };
      if (useId) { body.msg_id = useId; body.msg_seq = nextSeq(useId); }
      // 引用是**另一个**字段：填了才以「回复」形式展示，不填就是一条独立消息。
      // 拿不到 refId（对方引用的是更早的消息、ext 里没有 msg_idx）就退化成不引用。
      if (refId) body.message_reference = { message_id: String(refId) };
      try {
        const data = await rest("POST", messagePath(target), body);
        noteSend(key, text, msgId);
        resetCircuit();
        return data;
      } catch (error) {
        const kind = classify(error);
        if (kind === "server" || kind === "network" || kind === "unknown") tripCircuit(kind + "：" + error.message);
        throw error;
      }
    };
    const result = sendChain.then(run, run);
    sendChain = result.then(() => undefined, () => undefined);
    return result;
  }

  async function sendImage(target, image, msgId, caption = "", refId) {
    const run = async () => {
      const key = targetKey(target);
      if (config.maxImageBytes && image.length > config.maxImageBytes) {
        throw new Error("图片 " + (image.length / 1048576).toFixed(1) + " MiB 超过上限 " + (config.maxImageBytes / 1048576) + " MiB");
      }
      assertSendAllowed(key);
      const delay = nextSendDelay(key);
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      // 官方富媒体是两步：先上传拿 file_info，再以 msg_type=7 发出去。
      // 群上传的只能发群、单聊上传的只能发单聊，两者不互通。
      const uploaded = await rest("POST", filePath(target), {
        file_type: 1, file_data: Buffer.from(image).toString("base64"), srv_send_msg: false,
      });
      if (!uploaded?.file_info) throw new Error("富媒体上传未返回 file_info：" + JSON.stringify(uploaded).slice(0, 200));
      const body = { content: caption || " ", msg_type: 7, media: { file_info: uploaded.file_info } };
      const useId = effectiveMsgId(target, msgId);
      if (useId) { body.msg_id = useId; body.msg_seq = nextSeq(useId); }
      if (refId) body.message_reference = { message_id: String(refId) };
      try {
        const data = await rest("POST", messagePath(target), body);
        noteSend(key, "[image]", msgId);
        resetCircuit();
        return data;
      } catch (error) {
        const kind = classify(error);
        if (kind === "server" || kind === "network" || kind === "unknown") tripCircuit(kind + "：" + error.message);
        throw error;
      }
    };
    const result = sendChain.then(run, run);
    sendChain = result.then(() => undefined, () => undefined);
    return result;
  }

  // ── 事件归一化 ──────────────────────────────────────────────────────
  // 引用用的 id 和被动回复用的 id **不是同一个**：
  //   - 被动回复凭据 = 事件最外层的 d.id（msg_id）
  //   - 引用对象     = message_scene.ext 里的 msg_idx（形如 REFIDX_…），只对**别人发的**消息有值
  // ext 是 []string，形如 ["msg_idx=REFIDX_xxx","auth_token=..."]，所以要拆 key=value。
  function extractRefId(d) {
    const ext = d?.message_scene?.ext;
    if (!Array.isArray(ext)) return null;
    for (const item of ext) {
      const s = String(item);
      if (s.startsWith("msg_idx=")) return s.slice("msg_idx=".length).trim() || null;
    }
    return null;
  }

  // 本条消息 @ 了谁。官方把 @ 放在 d.mentions 数组里（跟 OneBot 的 at 段完全是两回事）。
  //
  // ── 实测形状（2026-09-19，正式环境，开了全量群消息的群）──
  //   mentions: [{"bot":true,"id":"5FE5240E…","is_you":true,"member_openid":"5FE5240E…",
  //               "member_role":"member","scope":"single","username":"MiaBot"}]
  // 三条要紧的：
  //   · **`is_you` 就是「@ 的是不是你自己」** —— 平台直接给答案，不用去比 id。
  //     而且 mentions 里的 id 是 openid，跟 READY 给的 botId（一串数字号）**不是一套**，
  //     拿 READY 的 id 来这里比对永远不会命中。
  //   · **别的 bot 被 @ 时同样会出现在这里**（实测收到过另一个 bot 的 `/login`，
  //     那条的 is_you 是 false）。这就是「抢答别人指令」那个风险的来源 ——
  //     所以判据必须是 is_you，**不能是「mentions 非空」**。
  //   · 普通群消息**完全没有 mentions 字段**（不是空数组），所以 typeof 判断要留着。
  function extractMentions(d) {
    const list = d?.mentions;
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const item of list) {
      const id = item?.id ?? item?.user_openid ?? item?.member_openid ?? item?.openid;
      const everyone = item?.scope === "all" || item?.type === "all" || item?.is_all === true ||
        item?.everyone === true || String(id || "").toLowerCase() === "all";
      if (id || everyone) out.push({ id: String(id || "all"), self: item?.is_you === true, everyone });
    }
    // 去重按 id 走：同一个人被 @ 两次不该算两票
    const seen = new Set();
    return out.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
  }

  // 上层只认这个形状，不碰官方字段名。
  // 把正文里的 @ 标记摘掉。
  //
  // 实测两种事件的正文形状**不一样**：
  //   AT 事件（没开全量消息时）  ：" 2"                ← 平台已经替我们摘掉了
  //   全量事件（开了全量消息之后）："<@5FE5240E…> 2"    ← @ 以标记形式留在正文里
  // 不归一化的话，上层按「正文开头是不是 /」判指令就会漏掉全量模式下所有的 @ 指令 ——
  // 实测抓到的症状：@ 它发 /help 会被当成闲聊喂给模型，指令静默失效。
  // 摘掉之后两种模式形状一致，下游只认一种。
  function stripMentionMarkers(text) {
    return String(text || "").replace(/<@!?[^>]*>/g, "").trim();
  }

  function containsEveryoneMention(d, mentions) {
    if (mentions.some((m) => m.everyone)) return true;
    const text = String(d?.content || "");
    return /@\s*(?:全体成员|全体|全员)(?:\s|$|[，,。！？!?])/u.test(text) || /<@!?all>/i.test(text);
  }

  function normalize(eventName, d) {
    const at = d?.timestamp ? Date.parse(d.timestamp) : now();
    const mentions = extractMentions(d);
    if (eventName === "GROUP_AT_MESSAGE_CREATE" || eventName === "GROUP_MESSAGE_CREATE") {
      return {
        type: "group", eventName,
        openid: String(d.group_openid || ""),
        userId: String(d.author?.member_openid || d.author?.id || ""),
        content: stripMentionMarkers(d.content),
        msgId: String(d.id || ""),
        mentioned: eventName === "GROUP_AT_MESSAGE_CREATE",   // 全量模式下这条是普通群消息
        // 开了全量群消息之后 @ 事件**不再推送**（实测：@ 只有 GROUP_MESSAGE_CREATE 一条），
        // 所以「有没有 @ 到美亚」只能靠这个字段判 —— 只认事件名的话她在那种群里会完全哑掉。
        //
        // ⚠ mentionedOpenids **排除自己**：它的每个调用方要的都是「@ 过的**别人**」
        // （查别人、@ 名单校验、推荐对象的隐私校验）。不排除的话，
        // 「@美亚 /牌子 耀击」里的那个 @ 会被当成「查美亚自己」，于是去查一个不存在的绑定，
        // 回一句「TA 还没把账号交给美亚过」—— 线上实测踩到过。
        mentionedOpenids: mentions.filter((m) => !m.self && !m.everyone).map((m) => m.id),
        mentionsSelf: mentions.some((m) => m.self),
        mentionsEveryone: containsEveryoneMention(d, mentions),
        refId: extractRefId(d),
        at, raw: d,
      };
    }
    if (eventName === "C2C_MESSAGE_CREATE") {
      return {
        type: "c2c", eventName,
        openid: String(d.author?.user_openid || d.author?.id || ""),
        userId: String(d.author?.user_openid || d.author?.id || ""),
        content: stripMentionMarkers(d.content),
        msgId: String(d.id || ""),
        mentioned: true,
        mentionedOpenids: [],   // 私聊没有 @ 这回事
        mentionsSelf: true,     // 私聊本来就等于对着它说话
        refId: extractRefId(d),
        at, raw: d,
      };
    }
    // QQ 频道：openid 位置放 channel_id，发送路径是 /channels/{id}/messages。
    // 频道没有 openid 概念，author.id 就是用户 ID。
    if (eventName === "AT_MESSAGE_CREATE" || eventName === "MESSAGE_CREATE") {
      return {
        type: "channel", eventName,
        openid: String(d.channel_id || ""),
        userId: String(d.author?.id || ""),
        content: stripMentionMarkers(d.content),
        msgId: String(d.id || ""),
        mentioned: eventName === "AT_MESSAGE_CREATE",
        mentionedOpenids: mentions.filter((m) => !m.self).map((m) => m.id),
        mentionsSelf: mentions.some((m) => m.self),
        guildId: String(d.guild_id || ""),
        refId: extractRefId(d),
        at, raw: d,
      };
    }
    return null;
  }

  // ── WebSocket ───────────────────────────────────────────────────────
  function sendFrame(payload) {
    if (!socket || socket.readyState !== 1) return false;
    try { socket.send(JSON.stringify(payload)); return true; } catch { return false; }
  }

  function startHeartbeat(intervalMs) {
    stopHeartbeat();
    const period = Math.max(config.minHeartbeatIntervalMs, Number(intervalMs) || 30000);
    heartbeatTimer = setInterval(() => {
      heartbeatAckAt = now();
      if (!sendFrame({ op: OP.HEARTBEAT, d: lastSeq })) log("心跳发送失败：连接不在");
    }, period);
  }
  function stopHeartbeat() { if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; } }

  function scheduleReconnect(reason) {
    if (stopped) return;
    reconnectAttempts += 1;
    const wait = Math.min(config.reconnectBaseMs * Math.pow(2, reconnectAttempts - 1), config.maxBackoffMs);
    log("将在 " + Math.round(wait / 1000) + " 秒后重连（" + reason + "）");
    // 计时器必须留引用：stop() 时不清掉的话，退避最长可达 15 分钟，
    // 进程会一直等它到点才退出（测试里表现为整个跑不完）。
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!stopped) void connect(true);
    }, wait);
  }

  function handleFrame(raw) {
    let frame;
    try { frame = JSON.parse(raw); } catch { return; }
    // 帧级探针：排查「连上了但什么都没收到」时用。默认不挂，不产生任何开销。
    if (config.onFrame) { try { config.onFrame(frame); } catch { /* 探针自己出错不该影响收包 */ } }
    switch (frame.op) {
      case OP.HELLO:
        startHeartbeat(frame.d?.heartbeat_interval);
        // 有 session 且没被判失效就续连（不重放历史事件），否则重新 Identify
        if (sessionId && lastSeq !== null) {
          sendFrame({ op: OP.RESUME, d: { token: "QQBot " + token, session_id: sessionId, seq: lastSeq } });
        } else {
          sendFrame({ op: OP.IDENTIFY, d: { token: "QQBot " + token, intents: config.intents, properties: {} } });
        }
        return;
      case OP.HEARTBEAT_ACK:
        heartbeatAckAt = now();
        return;
      case OP.RECONNECT:
        log("平台要求重连");
        try { socket?.close(); } catch {}
        return;
      case OP.INVALID_SESSION:
        log("会话失效，重新 Identify");
        sessionId = null; lastSeq = null;
        return;
      case OP.DISPATCH: {
        if (typeof frame.s === "number") lastSeq = frame.s;
        if (frame.t === "READY") {
          sessionId = frame.d?.session_id || sessionId;
          reconnectAttempts = 0;
          log("已连接官方网关（session=" + sessionId + "）");
          return;
        }
        if (frame.t === "RESUMED") { log("会话已恢复"); reconnectAttempts = 0; return; }
        // 事件去重：平台可能重复推送同一条
        const id = frame.d?.id;
        if (id) {
          const key = frame.t + ":" + id;
          if (recentIds.has(key)) return;
          prune(recentIds, key, 10 * 60 * 1000);
        }
        rememberInbound(frame.t, frame.d);
        onEvent?.(frame.t, frame.d);
        return;
      }
      default:
        return;
    }
  }

  async function connect(isReconnect) {
    if (stopped) return;
    if (isReconnect) { try { socket?.close(); } catch {} }
    await refreshToken(false);
    const info = await rest("GET", "/gateway");
    const url = info?.url;
    if (!url) throw new Error("取网关地址失败：" + JSON.stringify(info).slice(0, 200));
    if (!isReconnect) { sessionId = null; lastSeq = null; }

    socket = new WS(url);
    socket.on("open", () => { startedAt = now(); heartbeatAckAt = now(); log("网关连接已建立，等待 Hello"); });
    socket.on("message", (data) => {
      try { handleFrame(data.toString()); }
      catch (error) { log("处理帧出错：" + (error?.message || error)); }
    });
    socket.on("close", (code) => {
      stopHeartbeat();
      socket = null;
      scheduleReconnect("连接关闭 code=" + code);
    });
    socket.on("error", (error) => {
      log("网关连接出错：" + (error?.message || error));
    });
  }

  async function start(handler) {
    onEvent = handler;
    stopped = false;
    reconnectAttempts = 0;
    if (!String(config.appId).trim() || !String(config.clientSecret).trim()) {
      throw new Error("缺少 appId / clientSecret —— 官方接口需要开放平台的机器人凭据");
    }
    await connect(false);
  }

  function stop() {
    stopped = true;
    stopHeartbeat();
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    try { socket?.close(); } catch {}
    socket = null;
    sessionId = null;
  }

  // 连接在、且心跳有回音。官方网关的 Hello 会给 interval，正常情况下 ACK 很及时；
  // 超过 2.5 个周期没 ACK 就当作半死连接，交给重连。没有 Hello 之前不判定。
  function healthy() {
    if (!state.connected) return false;
    if (!heartbeatTimer) return true;
    return now() - heartbeatAckAt < 90000;
  }

  // rest 是**给非消息类接口留的口子**（指令面板就是这样：它不是收发消息，
  // 但要用同一套 access_token 和 base URL）。默认不导出它是有意的 ——
  // 上层不该绕过 sendText/sendImage 自己拼消息，那会把限流、抑制、熔断全绕过去。
  // 用它的人要自己负责：这里**没有**限流、没有去重、没有熔断。
  return { start, stop, sendText, sendImage, state, healthy, config, normalize, rest };
}

module.exports = { createOfficial, DEFAULTS, OP, INTENT_GROUP_AND_C2C, INTENT_GROUP_MEMBER, INTENT_PUBLIC_GUILD_MESSAGES };
