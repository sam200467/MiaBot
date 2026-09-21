"use strict";
// 美亚的指令层：解析、分发、图片队列、绑定会话。
//
// ── 为什么这份代码是「抄」梨绪的，而不是两边共用一个模块 ──────────────
//
// qq/qq-entry.cjs 里那套东西看着平台无关，其实每一步都粘在 OneBot 上：
// sayGroup 拼的是 {type:"at"} 消息段，sendImage 传的是 file:/// 本地路径，
// mentionedQqs 读的是 CQ 码，quotedContext 要调 get_msg，memberName 要调
// get_group_member_info —— 后两个官方接口**根本没有**。真抽公共层的话，
// 得到的是个带十个注入点的壳子，不是共享逻辑，而且要先动正在稳定运行的梨绪
// 和它 50 个用例的测试。takase-core.cjs:8-12 也早就写明「队列/冷却/去重各前端
// 自带一份，等二期统一到 ctx 接口再搬」—— 现在抽正是在做作者刻意推迟的那次重构。
//
// 所以这里复制的是**规则**（队列语义、会话状态机、别名策略），不是代码形状。
// 美亚这份还更小：没有 CQ 码解析、没有引用内容、没有群成员查询、没有「引用失败
// 就摘掉引用重发」（官方那边引用是独立字段，过期不会连累正文）。
//
// ── 与平台有关的三条硬约束，注释里凡是「官方」都在指它们 ──────────────
//
//   1. **主动消息不可用**（40034105）。发私聊必须带该用户 C2C 会话的 msg_id，
//      而那凭据只有「用户先私聊过 bot」才有。所以这里**所有提示都回在原地**，
//      不存在梨绪那种「优先私聊、失败退回群里」的降级链。
//   2. **被动回复窗口**：群 5 分钟 5 条、单聊 60 分钟 4～5 条，超了是 40034128。
//   3. **没有 get_msg**。引用只用于「以回复形式展示」，读不到内容。

const core = require("../takase-core.cjs");
const songSearch = require("./song-search.cjs");
const { MIA_HELP, MIA_HINTS, MIA_TEMPLATES: T } = require("./mia-voice.cjs");

const SESSION_TTL_MS = 5 * 60 * 1000;
const BIND_MAX_EMAIL_ATTEMPTS = 3;

// 幂等闸的保留时长。要盖过「同一条消息以两种事件名先后到达」的间隔，
// 那通常是毫秒级；10 分钟是照着被动回复窗口取的宽松值。
const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;
const IDEMPOTENCY_MAX = 500;

// 长文本分块上限。官方文档**没有写正文长度上限**，这里取一个保守值：
// 定数表、别名列表这类「lines」结果会被 splitLines 切开分多条发。
// 真撞上限了（表现为发送报错）就把这个值调小，别动 splitLines 的默认值
// ——那是 Discord 的 1900。
const LINES_LIMIT = 900;

// ── 命令解析 ────────────────────────────────────────────────────────
// 与 qq/qq-entry.cjs:50-107 逐字节一致（前缀规则 `^[#＃/]` 本来就是三家通吃：
// 斜杠、半角井号、全角井号），只多了 chart 的 b110 别名。
// 私聊里裸关键字也认（见 handleEvent 的第 7 步），群里必须带前缀且 @ 到美亚。
const COMMANDS = Object.freeze({
  help: "帮助",
  bind: "绑定",
  chart: "分表",
  plate: "牌子",
  song: "单曲",
  songsearch: "搜索歌曲",
  chartinfo: "谱面分析",
  constant: "定数表",
  level: "等级",
  calculate: "计算",
  aliasadd: "添加别名",
  aliasdelete: "删除别名",
  aliases: "查看别名",
  whatis: "是什么歌",
  allow: "允许查询",
  deny: "禁止查询",
  status: "状态",
  unbind: "解绑",
  cancel: "取消",
  cardbrowser: "查卡面",
  expressionbrowser: "查表情",
});

const ALIASES = Object.freeze({
  help: ["帮助", "help", "幫助", "菜单", "指令"],
  bind: ["绑定", "bind", "綁定", "登录", "登陆"],
  // b110 = B50 + N10 + P50 正好 110 张，是分表的俗称
  chart: ["分表", "chart", "b50", "b110", "成绩图"],
  plate: ["牌子", "plate", "完成度"],
  song: ["单曲", "song", "歌曲"],
  songsearch: ["搜索歌曲", "搜歌", "查歌", "songsearch"],
  chartinfo: ["谱面分析", "譜面分析", "chartinfo", "谱面"],
  constant: ["定数表", "定數表", "constant", "定数"],
  level: ["等级", "等級", "level", "lv"],
  calculate: ["计算", "計算", "calculate", "rating"],
  aliasadd: ["添加别名", "新增別名", "aliasadd"],
  aliasdelete: ["删除别名", "刪除別名", "aliasdelete"],
  aliases: ["查看别名", "查看別名", "aliases"],
  whatis: ["是什么歌", "是什麼歌", "whatis"],
  allow: ["允许查询", "允許查詢", "开放查询", "開放查詢", "allowquery", "允许别人查我"],
  deny: ["禁止查询", "禁止查詢", "关闭查询", "關閉查詢", "denyquery", "禁止别人查我"],
  status: ["状态", "status", "狀態"],
  unbind: ["解绑", "unbind", "解綁"],
  cancel: ["取消", "cancel", "取消绑定"],
  cardbrowser: ["查卡面", "卡面", "cardbrowser"],
  expressionbrowser: ["查表情", "表情", "expressionbrowser"],
});

const LOOKUP = new Map();
for (const [name, words] of Object.entries(ALIASES)) {
  for (const word of words) LOOKUP.set(word.toLowerCase(), name);
}

function parseCommand(text) {
  const raw = String(text || "").normalize("NFKC").trim();
  const match = raw.match(/^[#＃/]\s*([^\s]+)\s*([\s\S]*)$/);
  if (!match) return null;
  const name = LOOKUP.get(match[1].toLowerCase());
  return name ? { name, rest: match[2].trim() } : { name: null, rest: match[2].trim() };
}

// ── 工厂 ────────────────────────────────────────────────────────────
// 平台相关的三件事全部由调用方注入，这个文件不 require 任何 qq-official 的传输层：
//   send(event, text)            回原地发一条文本
//   sendImage(event, image, cap) 回原地发一张图（image 是 {buffer, meta}）
//   transport                    只为 statusText 读「网关连上没有」
function createMiaCommands(options = {}) {
  const config = options.config || {};
  const send = options.send;
  const sendImage = options.sendImage;
  const transport = options.transport;
  const log = options.log || (() => {});
  const now = options.now || Date.now;
  const random = options.random || Math.random;
  // Mia 的图片任务很轻，连续查看时 60 秒会显得像卡住。这里只覆盖 Mia，
  // 不改 shared core 的默认值，避免顺手改变梨绪和 Discord 版。
  const generateCooldownMs = Math.max(0, Number.isFinite(Number(config.generateCooldownMs))
    ? Number(config.generateCooldownMs) : 2000);

  if (typeof send !== "function") throw new Error("mia-commands 需要注入 send");
  if (typeof sendImage !== "function") throw new Error("mia-commands 需要注入 sendImage");

  const startedAt = now();
  const pick = (value) => (Array.isArray(value) ? value[Math.floor(random() * value.length)] : value);
  const isGroup = (event) => event.type === "group";

  // 删除别名的白名单：**只认名单里的 openid**，不看群角色，而且只走「删除别名」
  // 这条命令 —— 聊天路径连这个能力都看不到（CAPABILITY_SPECS 里刻意没有它，
  // 见 takase-core.cjs 该处的注释）。名单放在 config.local.json 而不是源码里，
  // 因为这个文件会同步进公开仓库。没配就是谁都不能删（失败往安全的方向倒）。
  // ⚠ openid 换 AppID 或换环境就会变（跟 allowedGroupIds 同理），换环境后要重新探。
  const aliasDeleteOpenids = new Set((config.aliasDeleteOpenids || []).map((id) => String(id).trim()));

  // ── 幂等闸 ────────────────────────────────────────────────────────
  // GROUP_MESSAGE_CREATE 与 GROUP_AT_MESSAGE_CREATE 可能对**同一条消息**双投递，
  // 而传输层的去重键是「事件名:消息id」（official-transport.cjs），两种事件名
  // 互相不去重。要挡的是两件事，不是一件：
  //   1. 副作用（回两条、起两个会话、别名写两遍）
  //   2. **群上下文**（同一条消息被记两遍，模型看到的上下文里同一句话出现两次，
  //      「上面那首」这类指代就被污染了）
  // 所以闸放在最前面，命中就整条 return —— 连上下文都不记。
  //
  // 取键单独抽成函数：**d.id 在两种事件下是不是同一个值还没有实测过**
  // （要用 probe-official.cjs 看真实 payload）。probe 出结论之前先按 d.id 走，
  // 它是「被动回复凭据」，语义上最接近「这条消息」。
  const seenEvents = new Map();
  const messageKey = options.messageKey || ((event) => String(event.msgId || ""));

  function claimEvent(event) {
    const key = messageKey(event);
    if (!key) return true;   // 没有 id 就没法判重，放行（宁可重复也不能整条吞掉）
    const expiry = seenEvents.get(key);
    const current = now();
    if (expiry && expiry > current) return false;
    // 顺手清过期的，避免这张表无限长大
    if (seenEvents.size >= IDEMPOTENCY_MAX) {
      for (const [k, v] of seenEvents) if (v <= current) seenEvents.delete(k);
    }
    seenEvents.set(key, current + IDEMPOTENCY_TTL_MS);
    return true;
  }

  // ── 队列与冷却 ────────────────────────────────────────────────────
  const queue = [];
  const queuedUsers = new Set();
  const lastGenerateAt = new Map();
  let busy = false;
  let currentOperation = "空闲";

  function queuePosition() { return queue.length + (busy ? 1 : 0); }

  function enqueue(task) {
    if (queue.length >= core.MAX_QUEUE) return false;
    queue.push(task);
    void pumpQueue();
    return true;
  }

  async function pumpQueue() {
    if (busy || queue.length === 0) return;
    const task = queue.shift();
    busy = true;
    currentOperation = task.label;
    try { await task.run(); }
    catch (error) { log("任务失败：" + core.safeError(error)); }
    finally {
      queuedUsers.delete(task.userKey);
      busy = false;
      currentOperation = "空闲";
      void pumpQueue();
    }
  }

  // 图片任务的唯一收口：去重、冷却、入队、出图，**不发送**。
  // 发什么、什么时候发由 dispatch 决定 —— 命令路径要先回执再等着发图。
  //
  // 与梨绪的两处有意不同：
  //   · 失败文案用 plan.failText（core 给的），不用 label 推导。梨绪那边
  //     `label.replace(/^正在生成/,"")` 那段其实是死代码（qq-entry.cjs:595）。
  //   · **队列满不再烧掉冷却**。梨绪在入队前就写了 lastGenerateAt，被队列挡回来
  //     的那次也算「刚生成过」，用户要白等冷却才能重试。这里挪到入队成功之后。
  function startImageJob(event, plan) {
    const userKey = plan.key + ":" + event.userId;
    if (queuedUsers.has(userKey)) return { started: false, reason: pick(T.jobSameKindPending) };
    const remaining = generateCooldownMs - (now() - (lastGenerateAt.get(userKey) || 0));
    if (remaining > 0) return { started: false, reason: T.jobCooldown(Math.ceil(remaining / 1000)) };

    const ahead = queuePosition();
    queuedUsers.add(userKey);
    let settle;
    const done = new Promise((resolve) => { settle = resolve; });
    const accepted = enqueue({
      userKey, label: plan.label,
      run: async () => {
        try { settle({ ok: true, image: await plan.run() }); }
        catch (error) {
          log("出图失败：" + core.safeError(error));
          settle({ ok: false, reason: T.jobFailed(plan.failText || (plan.label + "生成失败："), core.safeError(error)) });
        }
      },
    });
    if (!accepted) {
      queuedUsers.delete(userKey);
      return { started: false, reason: pick(T.jobQueueFull) };
    }
    lastGenerateAt.set(userKey, now());
    return { started: true, ahead, done };
  }

  // ── 发送 ──────────────────────────────────────────────────────────
  // 一律回原地（群里回群里、私聊回私聊）。官方平台不让主动开私聊，
  // 所以没有梨绪那套「优先私聊、失败退回群里」的降级链。
  async function sendLines(event, header, lines, footer = "") {
    const chunks = core.splitLines(header, lines, footer, LINES_LIMIT);
    for (const chunk of chunks) await send(event, chunk);
  }

  async function dispatch(event, plan, chatLine = "") {
    if (plan.kind === "notice") return send(event, plan.text);
    // 闲聊触发 /帮助 时，模型的角色化开场和长清单之间留一行；直接 /帮助 则不在
    // 消息开头塞空行。其他短结果仍只换一行，免得每条都显得松散。
    const isHelpText = plan.kind === "text" && plan.text === MIA_HELP;
    const lead = chatLine ? chatLine + (isHelpText ? "\n\n" : "\n") : "";
    if (plan.kind === "text") return send(event, lead + plan.text);
    if (plan.kind === "lines") return sendLines(event, lead + plan.header, plan.lines, plan.footer);
    if (plan.kind !== "image") throw new Error("未知的能力结果类型：" + plan.kind);

    const job = startImageJob(event, plan);
    if (!job.started) return send(event, job.reason);
    // 官方平台没有消息编辑 API：先发一条占位，出好了再另发图片。
    await send(event, chatLine || (job.ahead === 0 ? pick(T.jobAccepted) : T.jobQueued(job.ahead)));
    const done = await job.done;
    if (!done.ok) return send(event, done.reason);
    try {
      return await sendImage(event, done.image, plan.caption);
    } catch (error) {
      // 被动回复窗口过期。**只记日志、不补发文字** —— 补发会同样失败，
      // 结果是「操作失败」压在一条本来就只是超时的消息上，比静默更难懂。
      if (error?.code === 40034128) { log(T.imageWindowExpired); return null; }
      throw error;
    }
  }

  // Rating 计算的参数完整性。**只在这个入口加这道闸** —— 梨绪和 Discord 的既有行为不动
  // （它们的命令路径早就上线了，改共享核心等于顺手改掉两个已经在跑的东西）。
  //
  // 为什么需要它：核心的 calculate 分支缺参数会静默按「铃铛无 / 连击无」算出一个具体的数。
  // 输出里确实写了「铃铛 0（无）」，算是有披露，但用户问的是半句话、拿到的却是一个
  // 确定的 Rating —— 这跟「参数不全就拒绝并给出正确格式」是相反的。
  // 判据是**值点**的个数，不是按分隔符切的段数 —— 核心吃自然语序，
  // 「定数 14.2，技术分 1000737」切出来也是 4 段，但「定数」「技术分」是标签不是值，
  // 按段数算会把半套参数误判成齐的。（这条是测试里抓出来的。）
  function hasFullCalculateArgs(query) {
    const q = String(query || "").replace(/(\d)[,，](\d)/g, "$1$2");
    const numbers = (q.match(/\d+(?:\.\d+)?/g) || []).length;   // 定数 + 技术分
    if (numbers < 2) return false;
    let markers = 0;
    if (/\bfb\b/i.test(q)) markers++;                            // 铃铛 fb
    if (/ab\s*\+|abplus|ab-plus/i.test(q)) markers++;            // 连击三档
    else if (/\bab\b/i.test(q)) markers++;
    if (/\bfc\b/i.test(q)) markers++;
    markers += (q.match(/none|无|沒有|没有/gi) || []).length;    // 明确说了「没有」也算数
    return numbers + markers >= 4;
  }

  // 模型有没有替用户填「铃铛 / 连击」这两个枚举值。返回它编出来的那些（空数组 = 没编）。
  //
  // 为什么只查这两个：它们是**枚举**，用户真说过就一定会留下痕迹；而定数和分数
  // 用户可能写成全角逗号、千分位、「一万分」之类，逐字比对会大面积误伤。
  //
  // ⚠ 判据不能是逐字相等 —— 模型会把用户的话**规范化**（「没有」→ none、
  // 「ab+」→ ab-plus、「全连」→ fc）。逐字比会把这类正常翻译误拦成「编的」，
  // 用户会莫名其妙被反复追问。所以两边都过同一张同义词表再比。
  const CALC_ENUM_SYNONYMS = Object.freeze({
    "ab-plus": ["ab-plus", "abplus", "ab+", "ab plus"],
    ab: ["ab"],
    fc: ["fc", "full combo", "全连", "全連"],
    fb: ["fb", "full bell", "全铃"],
    none: ["none", "无", "沒有", "没有", "不带", "沒帶", "没开", "沒開", "不用"],
  });
  // 长键排前面：ab-plus / ab 共用前缀，先匹短的会把 ab-plus 认成 ab
  const CALC_ENUM_KEYS = Object.keys(CALC_ENUM_SYNONYMS).sort((a, b) => b.length - a.length);

  // 用户原话里描述到了哪些枚举（同义词归一化后的集合）
  function describedEnums(userText) {
    const source = String(userText || "").toLowerCase();
    return new Set(CALC_ENUM_KEYS.filter((key) =>
      CALC_ENUM_SYNONYMS[key].some((word) => source.includes(word))));
  }

  function hasInventedEnum(query, userText) {
    const q = String(query || "");
    // 只看**真正决定结果**的那两个值，不是模型顺手写的所有标记。
    // 实测：用户说「铃铛 fb，连击 fc」，模型传的是 `14.2 1000737 none fb fc` ——
    // 多塞了一个对结果无害的 none（核心按 fb/fc 取值，那个 none 会被忽略）。
    // 按「所有标记都要在用户原话里」判的话，这种正常请求会被误拦成「编参数」。
    // 取值优先级跟 takase-core 的 calculate 分支保持一致。
    const bell = /\bfb\b/i.test(q) ? "fb" : "none";
    const combo = /ab\s*\+|abplus|ab-plus/i.test(q) ? "ab-plus"
      : /\bab\b/i.test(q) ? "ab"
      : /\bfc\b/i.test(q) ? "fc" : "none";
    const described = describedEnums(userText);
    return [bell, combo].filter((value) => !described.has(value));
  }

  async function runCapability(event, name, query, chatLine = "", target = null) {
    if (name === "songsearch") return sendLines(event, "", songSearch.reply(query).split("\n"));
    if (name === "calculate" && !hasFullCalculateArgs(query)) {
      // notice 不带引出语：这不是「查到了」，是「这次不算」
      return dispatch(event, {
        kind: "notice",
        text: T.calculateIncomplete + "\n" + MIA_HINTS.calculateUsage,
      });
    }
    const plan = await core.resolveCapability(
      config, String(event.userId), name, query,
      (line) => log(core.safeError(line)), target);
    return dispatch(event, plan, chatLine);
  }

  // ── 绑定会话 ──────────────────────────────────────────────────────
  // 邮箱和密码不进模型请求体、不进日志，也不进群上下文。QQ 官方机器人当前
  // 撤回接口不可靠，因此群里的原消息由用户按提示手动撤回。密码连 session 都不落
  //（只活在 continueSession 的局部变量里，用完在 finally 里清掉）。
  const sessions = new Map();   // userId -> {state, email, attempts, startedAt, type, openid}

  function getSession(userId) {
    const key = String(userId);
    const session = sessions.get(key);
    if (!session) return null;
    // TTL 从会话创建算起，中途的状态迁移不续期：整个绑定流程（邮箱+密码+验证）
    // 必须在这段时间内走完。
    if (now() - session.startedAt > SESSION_TTL_MS) { sessions.delete(key); return null; }
    return session;
  }

  function endSession(userId) {
    const key = String(userId);
    const session = sessions.get(key);
    if (session) session.email = "";   // 邮箱也擦掉，别留在内存快照里
    sessions.delete(key);
  }

  function sessionMatches(event, session = getSession(event.userId)) {
    return Boolean(session && session.type === event.type && session.openid === String(event.openid));
  }

  async function startBind(event) {
    sessions.set(String(event.userId), {
      state: "awaitingEmail", email: "", attempts: 0, startedAt: now(),
      type: event.type, openid: String(event.openid),
    });
    await send(event, isGroup(event) ? T.bindGroupIntro : T.bindIntro);
  }

  async function handleBind(event) {
    return startBind(event);
  }

  async function continueSession(event, text) {
    const session = getSession(event.userId);
    if (!session) return false;
    if (!sessionMatches(event, session)) return false;
    if (session.state === "confirmUnbind") return false;   // 解绑确认由 handleUnbind 接管

    if (session.state === "awaitingEmail") {
      const email = String(text).trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        session.attempts += 1;
        if (session.attempts >= BIND_MAX_EMAIL_ATTEMPTS) {
          endSession(event.userId);
          await send(event, T.bindEmailGiveUp);
          return true;
        }
        await send(event, T.bindEmailBad(BIND_MAX_EMAIL_ATTEMPTS - session.attempts));
        return true;
      }
      session.email = email;
      session.state = "awaitingPassword";
      await send(event, T.bindPasswordPrompt);
      return true;
    }

    if (session.state === "awaitingPassword") {
      // 密码**不做 trim**：用户从别处复制来的密码可能带尾空格，那是密码的一部分。
      const password = String(text);
      const { email } = session;
      session.state = "verifying";
      await send(event, T.bindVerifying);

      const userKey = "verify:" + event.userId;
      if (queuedUsers.has(userKey)) {
        endSession(event.userId);
        await send(event, T.bindAlreadyVerifying);
        return true;
      }
      queuedUsers.add(userKey);
      let secret = password;
      const accepted = enqueue({
        label: "正在验证账号", userKey,
        run: async () => {
          let reply;
          try {
            const playerName = await core.verifyAccount(config, email, secret, (line) => log(core.safeError(line)));
            await core.saveBinding(config, {
              userId: String(event.userId), email, password: secret,
              playerName, boundAt: new Date().toISOString(),
            });
            reply = T.bindSuccess(core.escapeDiscordText(playerName));
          } catch (error) {
            reply = T.bindFailed(core.safeError(error));
          } finally {
            secret = "";             // 明文密码的生命到此为止
            // 必须在最终提示发出**之前**结束会话。发送要经过限流/网络，期间用户若再说一句，
            // 旧写法会把那句话误判成仍在验证，回出「正在验证，请稍候」。
            endSession(event.userId);
          }
          await send(event, reply);
        },
      });
      if (!accepted) {
        queuedUsers.delete(userKey);
        endSession(event.userId);
        await send(event, T.bindQueueBusy);
      }
      return true;
    }

    // verifying：上一轮还在跑
    await send(event, T.bindBusyVerifying);
    return true;
  }

  async function handleUnbind(event) {
    const binding = await core.getBinding(config, String(event.userId));
    if (!binding) return send(event, T.unbindNotBound);
    const session = getSession(event.userId);
    if (session?.state === "confirmUnbind") {
      endSession(event.userId);
      await core.vaultCall(config, "delete", [String(event.userId)]);
      return send(event, T.unbindDone);
    }
    // QQ 没有按钮和确认弹窗，用「再发一次」代替二次确认
    sessions.set(String(event.userId), { state: "confirmUnbind", email: "", attempts: 0, startedAt: now() });
    return send(event, T.unbindConfirm(Math.round(SESSION_TTL_MS / 60000)));
  }

  async function handleCancel(event) {
    const session = getSession(event.userId);
    if (session && sessionMatches(event, session)) {
      endSession(event.userId);
      return send(event, T.cancelDone);
    }
    return send(event, T.cancelNone);
  }

  async function handleQueryPermission(event, allowed) {
    const binding = await core.getBinding(config, String(event.userId));
    if (!binding) return send(event, pick(MIA_HINTS.bindNotice));
    await core.saveBinding(config, { ...binding, allowOthers: allowed });
    return send(event, pick(allowed ? MIA_HINTS.allowDone : MIA_HINTS.denyDone));
  }

  // ── 别名 ──────────────────────────────────────────────────────────
  async function handleAlias(event, name, input) {
    if (name === "aliasdelete" && !aliasDeleteOpenids.has(String(event.userId))) {
      return send(event, T.aliasDeleteDenied);
    }
    // 候选/驳回那一套**已经去掉了**（2026-09-19）：美亚这边只要「加就加上了、
    // 删就删掉了」。候选是梨绪那边的流程 —— 引擎自己猜出来的叫法先记成候选、
    // 人工复核后才进正式库；对美亚来说那是多余的一层，用户看不出为什么要等复核。
    // 梨绪不受影响（它的命令表和这个文件是两份）。
    if (name === "whatis") {
      // 宿主曲库只有音击，作用域固定 "ongeki"：别的游戏专属别名不该在这条命令里命中。
      // 反查是给人看的，候选全都列出来（解析路径才要求唯一）。
      const found = core.normalizeSongQuery(input) ? core.getAliasStore().names(input, "ongeki") : [];
      const matches = core.INTERNAL_SONGS.filter((song) =>
        found.some((hit) => core.normalizeSongQuery(hit.title) === core.normalizeSongQuery(song.name)));
      return sendLines(event,
        matches.length ? "喵哼哼，这个叫法指的是下面这些歌：" : "唔，美亚没翻到这个叫法。",
        core.songMatchLines(matches));
    }

    let query = input, alias = "";
    if (["aliasadd", "aliasdelete"].includes(name)) {
      const divider = input.indexOf("|");
      if (divider < 0) return send(event, T.aliasNeedPipe);
      query = input.slice(0, divider).trim();
      alias = input.slice(divider + 1).trim();
    }
    const matches = core.searchSongs(query);
    if (matches.length !== 1) {
      return sendLines(event,
        matches.length ? "一下翻出来好几首呢——用完整 Song ID 指给美亚看吧：" : "唔，美亚翻了一圈也没找到这首歌。",
        core.songMatchLines(matches));
    }
    const song = matches[0], store = core.getAliasStore();
    if (name === "aliases") {
      const list = store.list(song.name, "ongeki");
      return sendLines(event,
        core.songMatchLines([song])[0] + " 的别名都在这里啦（" + list.length + " 个）：",
        list.length ? list.map((x) => "• " + x) : ["还一个别名都没有呢。"]);
    }
    try { alias = store.validateAlias(alias); }
    catch (error) { return send(event, error.message); }

    if (name === "aliasdelete") {
      const result = store.remove(alias, song.name);
      return send(event, (result.removed ? "好，别名摘掉啦：" : "这首歌本来就没有这个别名呀：") + alias + " → " + core.songMatchLines([song])[0]);
    }
    const result = store.add({ title: song.name, game: "ongeki", alias, addedBy: event.userId });
    const shared = core.INTERNAL_SONGS.filter((other) =>
      other.id !== song.id && store.matches(other.name, core.normalizeSongQuery(alias), "ongeki", true));
    return send(event, (result.added ? "记住啦，这个别名是：" : "这个别名美亚早就记着啦：") + alias + " → " + core.songMatchLines([song])[0] +
      (shared.length ? "\n不过它还指着另外 " + shared.length + " 首歌，叫的时候可别认错～" : ""));
  }

  // ── 状态 ──────────────────────────────────────────────────────────
  function statusText() {
    const minutes = Math.max(0, Math.floor((now() - startedAt) / 60000));
    const online = Boolean(transport?.state?.connected) && Boolean(transport?.healthy?.());
    return [
      "美亚在的哦～",
      "腾讯网关：" + (online ? "已连接" : "没连上"),
      "现在：" + currentOperation,
      "排队：" + queue.length + " 项",
      "已经跑了 " + minutes + " 分钟",
    ].join("\n");
  }

  function browserLink(event, kind, query) {
    const browser = config.assetBrowser || {};
    if (browser.enabled === false || !String(browser.publicBaseUrl || "").trim()) {
      return send(event, "素材检索网页还没有配置好。请管理员检查 assetBrowser.publicBaseUrl。 ");
    }
    const base = String(browser.publicBaseUrl).trim().replace(/\/+$/, "");
    const params = new URLSearchParams();
    if (String(query || "").trim()) params.set("q", String(query).trim());
    const suffix = params.size ? `?${params}` : "";
    if (kind === "cards") return send(event, `卡面仓库给你翻开啦♪ 想找谁，直接搜名字或编号就好～\n${base}/cards${suffix}`);
    return send(event, `角色们的小表情都整理好啦～ 可别挑花眼哦！\n${base}/expressions${suffix}`);
  }

  // ── 命令入口 ──────────────────────────────────────────────────────
  // event.__target 由调用方（mia-entry）在确认「本条消息真的 @ 过谁」之后设进来。
  async function handleCommand(event, command) {
    switch (command.name) {
      case "help": return runCapability(event, "help", "");
      case "bind": return handleBind(event);
      case "chart": return runCapability(event, "chart", "", "", event.__target);
      case "plate": return runCapability(event, "plate", command.rest, "", event.__target);
      case "song": return runCapability(event, "song", command.rest, "", event.__target);
      case "songsearch": return runCapability(event, "songsearch", command.rest);
      case "chartinfo": return runCapability(event, "chartinfo", command.rest);
      case "constant": return runCapability(event, "constant", command.rest);
      case "level": return runCapability(event, "level", command.rest, "", event.__target);
      case "calculate": return runCapability(event, "calculate", command.rest);
      case "aliasadd": case "aliasdelete": case "aliases": case "whatis":
        return handleAlias(event, command.name, command.rest);
      case "allow": return handleQueryPermission(event, true);
      case "deny": return handleQueryPermission(event, false);
      case "status": return send(event, statusText());
      case "unbind": return handleUnbind(event);
      case "cancel": return handleCancel(event);
      case "cardbrowser": return browserLink(event, "cards", command.rest);
      case "expressionbrowser": return browserLink(event, "expressions", command.rest);
      default: return send(event, T.unknownCommand);
    }
  }

  // ── core 的注册 ───────────────────────────────────────────────────
  // 这几个都是 takase-core 的**模块级单例**（别名库、转义函数、提示文案、
  // 状态提供者）。梨绪和美亚永远是两个独立进程 —— 各自的启动器、GUI 各起一个
  // ProcessInfo、stop-mia.cjs 只匹配 mia-entry —— 所以不会互相覆盖。
  // ⚠ 但**测试里不要在同一进程同时启动两个入口**，后注册的会盖掉前一个。
  function registerCore() {
    // QQ 不渲染 markdown。core 默认按 Discord 转义，照搬会让用户看到一堆反斜杠。
    core.configureFormatting({ escapeText: (value) => String(value ?? "") });
    // 别名作用域固定 "qq"，跟梨绪的一致 —— 社区词汇不该按 bot 分叉。
    // ⚠ 要真共用一份，aliasDir 和 aliasScope **两个都得一样**（文件名是
    // song-aliases-<scope>.json）；只改其中一个会得到两个并排的文件，
    // 看上去「配了 aliasDir」其实各写各的。
    core.configureAliases({ ...config, aliasScope: config.aliasScope || "qq" });
    core.configureCapabilities(MIA_HINTS);
    core.setStatusProvider(statusText);
  }

  return {
    COMMANDS, ALIASES, LOOKUP, parseCommand,
    handleCommand, continueSession, handleBind, handleUnbind,
    getSession, sessionMatches, runCapability, hasInventedEnum,
    claimEvent, messageKey,
    statusText, registerCore,
    aliasDeleteOpenids,
    state: { sessions, queue, queuedUsers, seenEvents },
  };
}

module.exports = { createMiaCommands, parseCommand, COMMANDS, ALIASES, LOOKUP, MIA_HELP };
