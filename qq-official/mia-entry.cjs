"use strict";
// 美亚的 QQ 官方接口入口。
//
// 与 qq/qq-entry.cjs 是同一层（前端），两条路都走：
//   · **指令路径**（/help、/b110…）：命令解析完全由程序做，**不经过模型**
//   · **聊天路径**（@ 它说人话）：交给 chat.cjs，模型只负责挑工具和参数，
//     执行权在程序侧（见 mia-commands.cjs）
//
// 平台差异全部关在 official-transport.cjs 里，这里只碰归一化后的事件形状。
// createMiaBot 是工厂形式（传输层可注入），否则整条链路没法在 mock 上测。

const fs = require("node:fs");
const path = require("node:path");
const { createOfficial } = require("./official-transport.cjs");
const { loadSettings, createChat } = require("../chat-core/chat.cjs");
const core = require("../mia-core.cjs");
const { createMiaCommands } = require("./mia-commands.cjs");
const songSearch = require("./song-search.cjs");
const { routeIntent } = require("./semantic-router.cjs");
const { MIA_TEMPLATES: T } = require("./mia-voice.cjs");
const { createAssetBrowser } = require("./asset-browser.cjs");

const HERE = __dirname;
const ROOT = path.resolve(HERE, "..");

const CONTEXT_MAX = 12;
const CONTEXT_TTL_MS = 10 * 60 * 1000;

// ── 配置 ────────────────────────────────────────────────────────────
// 相对路径一律按 HERE 解析，**不能用 process.cwd()** —— GUI 启动子进程时
// 工作目录可能由启动器或服务管理器指定，与入口脚本所在目录不同。
function resolveFrom(config, keys) {
  for (const key of keys) {
    const value = String(config[key] || "").trim();
    if (value) config[key] = path.resolve(HERE, value);
  }
  return config;
}

function loadConfig(file) {
  const target = file || path.join(HERE, "config.local.json");
  if (!fs.existsSync(target)) throw new Error("找不到 qq-official/config.local.json —— 从 config.example.json 复制一份");
  const c = JSON.parse(fs.readFileSync(target, "utf8"));
  if (!String(c.appId || "").trim() || !String(c.clientSecret || "").trim()) throw new Error("配置缺少 appId / clientSecret");
  if (!Array.isArray(c.allowedGroupIds) || c.allowedGroupIds.length === 0) {
    throw new Error(
      "allowedGroupIds 是空的，拒绝启动。\n" +
      "  这不是群号，是 group_openid（形如 1A2B3C4D…），换 AppID 或换沙箱都会变。\n" +
      "  拿它的办法：node qq-official/probe-official.cjs，然后在群里 @ 它一次，探针会把 openid 打出来。");
  }

  resolveFrom(c, ["workDir", "outputDir", "corePath", "vaultPath", "vaultHelperPath", "aliasDir", "characterDir"]);
  if (c.assetBrowser && String(c.assetBrowser.assetRoot || "").trim()) {
    c.assetBrowser.assetRoot = path.resolve(HERE, c.assetBrowser.assetRoot);
  }

  // 指令层的运行组件。**不存在就在这里拦下来**，不要放它降级成纯聊天 ——
  // 那样每条指令会在运行期各自失败一次，症状分散、最难查。
  // （这条是梨绪那边 qq-entry.cjs:33-35 的同一套校验。）
  if (!String(c.workDir || "").trim()) throw new Error("配置缺少 workDir");
  for (const key of ["corePath", "vaultHelperPath"]) {
    const value = String(c[key] || "").trim();
    if (!value) throw new Error("配置缺少 " + key + "（指令层要用它出图和读写凭据库）");
    if (!fs.existsSync(value)) throw new Error("运行组件缺失：" + key + " = " + value);
  }
  if (!String(c.vaultPath || "").trim()) throw new Error("配置缺少 vaultPath（美亚自己的凭据库路径）");

  // openid 是 32 位十六进制，**不能套 QQ 号那个 /^\d{5,11}$/ 校验**。
  if (c.aliasDeleteOpenids !== undefined) {
    if (!Array.isArray(c.aliasDeleteOpenids)) throw new Error("aliasDeleteOpenids 必须是 openid 数组");
    for (const id of c.aliasDeleteOpenids) {
      if (!String(id || "").trim()) throw new Error("aliasDeleteOpenids 里有空值");
    }
  }
  return c;
}

// ── 状态标记 ────────────────────────────────────────────────────────
// 给图形界面读的机器可读行（照梨绪那套 BOT_* 的做法）。只有带 --markers 时才打，
// 独立启动时不打 —— 否则日志窗口里会满屏前缀。
const MARKERS = process.argv.includes("--markers");
const mark = (text) => { if (MARKERS) console.log(text); };

function makeFileLog(logFile) {
  const { inspect } = require("node:util");
  return (...parts) => {
    const line = "[" + new Date().toISOString().slice(11, 19) + "] " + parts.map((p) => (typeof p === "string" ? p : inspect(p))).join(" ");
    console.log(line);
    // 同一行也以标记形式发一份：界面据此填日志区，无需自己解析时间戳格式
    mark("MIA_LOG:" + line);
    if (logFile) { try { fs.appendFileSync(logFile, line + "\n"); } catch { /* 日志写不进去不该让 bot 挂掉 */ } }
  };
}

// 回答跟着消息走：群里问的回群里，私聊问的回私聊。
// 一律带 msg_id 走被动回复 —— 主动消息自 2025-04 起基本不可用。
function makeTarget(event) {
  return { kind: event.type === "group" ? "group" : event.type === "channel" ? "channel" : "c2c", openid: event.openid };
}

function makeSender(transport, log) {
  return function send(event, text, file) {
    const target = makeTarget(event);
    // 三个 id 各司其职：msgId 是被动回复凭据（必带）、refId 决定要不要以「回复」形式展示。
    if (!file) return transport.sendText(target, text, event.msgId, event.refId);
    // 表情是本地文件，官方富媒体要先上传再发，这一步由传输层做。
    // ⚠ 这里**不能截断正文**：原先写的是 slice(0,100)，结果所有带图的回复都被砍到
    // 正好 100 字、半句话结尾（线上实测两条截图都恰好 100 字符）。官方文档对
    // msg_type=7 的 content 没写长度上限，而正文长度 chat.cjs 已经按 maxReplyChars
    // 卡过了，这里原样传即可。
    const buffer = fs.readFileSync(file.absoluteFile);
    log("发送表情 " + path.basename(file.absoluteFile) + "（" + (buffer.length / 1024).toFixed(0) + " KiB）");
    return transport.sendImage(target, buffer, event.msgId, text ? String(text) : "", event.refId);
  };
}

// 指令层要的两个发送器。跟聊天的那个分开，是因为它们不走 chat.cjs 那套
// 「\n\n 折叠成 \n」的排版处理 —— 指令结果是程序拼的，原文该什么样就什么样。
// 出图这里**不落盘**：官方富媒体是先上传再发（official-transport.cjs 的 sendImage），
// 手里就是个 Buffer，不像梨绪那边要写成 PNG 再传 file:/// 路径。
function makeCommandSenders(transport, log) {
  return {
    send: (event, text) => transport.sendText(makeTarget(event), text, event.msgId, event.refId),
    sendImage: (event, image, caption) => {
      const buffer = image?.buffer;
      if (!Buffer.isBuffer(buffer)) throw new Error("出图结果里没有图片数据");
      log("发送图片 " + (image.name || "?") + "（" + (buffer.length / 1024).toFixed(0) + " KiB）");
      return transport.sendImage(makeTarget(event), buffer, event.msgId, caption ? String(caption) : "", event.refId);
    },
  };
}

function createMiaBot(config, deps = {}) {
  const log = deps.log || (() => {});
  const characterDir = config.characterDir ? path.resolve(HERE, config.characterDir) : deps.characterDir || path.join(ROOT, "mia-chat");
  const settings = deps.settings || loadSettings(characterDir);
  if (!settings) throw new Error("美亚聊天未启用：检查 " + path.join(characterDir, "config.local.json"));

  const transport = (deps.createTransport || createOfficial)({ ...config, log });
  const send = makeSender(transport, log);
  const assetBrowser = config.assetBrowser?.enabled === false || !config.assetBrowser?.assetRoot
    ? null : createAssetBrowser({ ...config.assetBrowser, log });

  const allowGroups = new Set((config.allowedGroupIds || []).map(String));
  const allowPrivate = config.allowPrivateChat !== false;

  // ── 指令层 ────────────────────────────────────────────────────────
  // loadConfig 已经强制校验过运行组件，所以生产路径上一定启用。这里是给
  // **嵌入式调用和测试**留的口子：配置不全就退化成纯聊天，但会**明确打一行日志**
  // —— 静默降级会让人以为「指令坏了」，那比直接报错更难查。
  const commandsEnabled = Boolean(
    String(config.corePath || "").trim() &&
    String(config.vaultPath || "").trim() &&
    String(config.vaultHelperPath || "").trim());
  if (!commandsEnabled) {
    log("美亚：指令未启用（缺 corePath / vaultPath / vaultHelperPath 之一），这一轮只跑聊天。");
  }

  // 「这条消息 @ 到美亚了吗」。传输层从 mentions[].is_you 读出来（见 official-transport.cjs
  // 里那段实测记录），这里再兜一层保守判断。
  //
  // botOpenid 是**旧方案**：想拿 READY 给的 botId 去比对 mentions 里的 id ——
  // 实测证明**两者不是一套 id 空间**（READY 是数字号，mentions 是 openid），永远对不上。
  // 现在只当兼容保留，正常情况下用不到。
  const botOpenid = String(config.botOpenid || "").trim();
  function mentionsSelf(event) {
    if (event.mentionsEveryone === true) return false; // @全体成员 包含机器人，但不是在单独叫美亚
    if (event.mentionsSelf === true) return true;   // 平台直说「@ 的就是你」，最可靠
    if (botOpenid && (event.mentionedOpenids || []).some((id) => String(id) === botOpenid)) return true;
    // 旧形态的 AT 事件**没有 mentions 字段**（实测），所以只能靠事件类型本身判。
    // 它只在没开全量群消息的群里出现；开了之后平台只推 GROUP_MESSAGE_CREATE。
    return event.mentioned === true;
  }
  // 「查别人」的查询对象：只认本条消息真的 @ 过的人，而且排除美亚自己。
  // 这是隐私边界 —— 别人存的账号密码不是拿来给群里公开放的。
  function pickTarget(event) {
    const list = (event.mentionedOpenids || []).map(String).filter((id) => id && id !== botOpenid);
    return list.length ? list[0] : null;
  }

  // 群里能不能执行这条指令。**光有 `/` 前缀不够**，得真 @ 到美亚。
  //
  // 判据必须是「@ 的是不是**我**」而不是「有没有 @ 人」：实测在全量群消息的群里
  // 收到过**另一个 bot** 被 @ 的 `/login`（那条的 is_you 是 false）。按「mentions 非空」
  // 判的话，美亚就会去抢答别人的指令 —— 那是明确的事故。
  function commandAllowedInGroup(event, eventName) {
    if (event.type !== "group") return true;                       // 私聊：没有 @ 这回事
    if (config.acceptBareGroupCommands === true) return true;      // 逃生阀，默认关
    return mentionsSelf(event);
  }

  let commands = null;
  if (commandsEnabled) {
    const senders = makeCommandSenders(transport, log);
    commands = createMiaCommands({
      config, transport, log,
      send: senders.send, sendImage: senders.sendImage,
      ...(deps.now ? { now: deps.now } : {}),
      ...(deps.random ? { random: deps.random } : {}),
      ...(deps.messageKey ? { messageKey: deps.messageKey } : {}),
    });
  }

  // 群上下文缓冲：只有平台推 GROUP_MESSAGE_CREATE（群主开了「接收所有消息」）时才有内容，
  // 否则里面只剩 @ 过它的那几条。有就用，没有就当空 —— chat.cjs 会跳过那段提示词。
  const contextBuf = new Map();
  function remember(openid, who, text) {
    const list = contextBuf.get(openid) || [];
    list.push({ who, text, at: Date.now() });
    while (list.length > CONTEXT_MAX) list.shift();
    contextBuf.set(openid, list);
  }
  function readContext(openid, skipLast) {
    const cut = Date.now() - CONTEXT_TTL_MS;
    let list = (contextBuf.get(openid) || []).filter((x) => x.at >= cut);
    if (skipLast) list = list.slice(0, -1);
    return list.map((x) => x.who + "：" + x.text.replace(/\s+/g, " ").slice(0, 120));
  }

  const chat = createChat(settings, {
    guildId: "qq-official",
    channelIds: [...allowGroups],   // chat.cjs 的频道白名单：放群 openid
    // 美亚不联网；本地音击曲库由 mia-chat 的 localKnowledge 单独开启。
  }, {
    log,
    // 透传注入点：测试用假 fetch 顶掉真实模型调用
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.webFetchImpl ? { webFetchImpl: deps.webFetchImpl } : {}),
    adapter: {
      // 能力说明。**接上指令层之后这句必须跟着改** —— 原先写的是「没有查分能力」，
      // 跟下面 actions 里的工具清单正面矛盾，模型会不知道该信哪一句。
      //
      // 公共曲目资料与个人成绩分开路由；角色语气不能取代真实检索。
      ability: () => commands
        ? "运行时实际能力：你正在 QQ 里回复消息。"
          + "你可以只读查询本地音击曲库中的曲名、谱面难度、等级、定数、艺术家、版本和对战相手；这不是联网搜索，不能查询其他游戏。"
          + "找歌、询问有没有某首歌、曲名开头或拼写不确定时调用 songsearch，无需绑定。只有明确要个人成绩或成绩图时才调用 song。查不到不等于歌曲不存在，不要凭记忆否认或猜曲名。"
          + "你可以调用工具替用户办这些事：生成 B50+N10+P50 分表、生成版本牌子完成度图、生成单曲全难度成绩图、"
          + "生成单张谱面分数线分析图、查定数表、生成等级成绩长图、算单曲 Rating、查看某首歌的全部别名、"
          + "按别名反查曲目、给歌曲加别名、开关「别人能不能查我的成绩」、看运行状态（只在用户明确问你在不在线、"
          + "是不是掉线了、队列排了多少时才调用，打招呼和寒暄时绝对不要调用）。"
          + "结果和图片由程序发送，你只写一句引出话，**绝不自己报数字或曲名结论**。"
          + "两件事你没有工具：删除别名（让用户用 /删除别名 指令，而且只有指定账号能用）、"
          + "读图片内容（别人的图你看不到，被问到就直说看不了）。"
          + "绑定账号只能把用户引到程序控制的 /绑定 流程：你不能索要、接收或转述邮箱和密码。"
          + "用户在群里提到绑定，就让他 @你 发 /绑定，并提醒邮箱和密码发出后立刻手动撤回。"
          // 缺关键信息时先问清楚，不要猜、不要用常见值、不要假设默认。
          //
          // 实测抓到过一条：用户只说「算一下 14.2 打 1000737」，模型自己把铃铛补成 fb、
          // 连击补成 fc 就去算了 —— 那是替用户编输入，算出来的 Rating 会被当成事实报出去，
          // 而那两个值用户压根没说过。
          //
          // ⚠ 这里曾经写过「用户只是随口问数据就别调工具，照实说记不住」，后来撤了：
          // ① 那是拿美亚的人设去覆盖引擎的调度规则（chat.cjs 的 actionRule 本来就写着
          //    「用户想查定数…时加 action」），两边打架；② 更实际的，「id870 的定数是多少」
          //    真正的问题不是「她在不在行」，而是**没说难度**——正确反应是问一句是哪个难度，
          //    不是把自己的活儿推掉。人设那句「她记不住」现在只用来解释她**不凭空报数**，
          //    不用来拒绝干活。
          + "用户要办的事**缺了关键信息**时，先问清楚再动手，**绝对不要替他填**——"
          + "不要猜、不要用常见值、不要假设默认。比如「id870 的定数是多少」没说难度，"
          + "就先问一句是哪个难度，别自己挑一个；算 Rating 要的定数、技术分、铃铛、连击"
          + "四样少一样，就先问那一样。"
          // ⚠ 上面那条**很容易做过头**，实测吃过一次：美亚开始对什么都先反问一句，
          // 「帮我查一下 id870」被追问要哪个难度（单曲成绩图本来就不分难度），
          // 「出张 b110 分表」反过来质疑人家是不是想说 B50。追问只在**缺的那样真的补不上**
          // 时才有意义，否则就是把活儿推回给用户。
          + "⚠ 但**不要过度追问**。只有当缺的那一样真的没法用别的工具补上时才问："
          + "「帮我查一下 id870」先搜索公共歌曲资料，不要擅自变成查个人成绩；"
          + "用户说的指令叫法（比如 b110 就是 B50+N10+P50 的分表）照办就行，"
          + "不要质疑人家「是不是想说别的」。能办就办，别把活儿推回去。"
        : "运行时实际能力：你正在 QQ 里回复消息，可以查阅本地音击曲库，但没有联网、查分或读图能力。可以按语境发送你的表情图。",
      // 工具清单与执行入口。模型只负责「挑哪个工具、参数是什么」，执行权在程序侧：
      // 能力名、参数、权限、绑定状态、冷却、队列、@ 名单，六道校验全在 mia-commands 里。
      ...(commands ? {
        actions: [...core.CAPABILITY_SPECS, songSearch.SEARCH_SPEC],
        routeIntent: ({ messages, message, signal, dispatcher }) => routeIntent({
          settings, messages, signal, dispatcher, log,
          specs: [...core.CAPABILITY_SPECS, songSearch.SEARCH_SPEC],
          targets: (message.__event?.mentionedOpenids || []).map(String).filter(id => id !== botOpenid),
          validateAction: (action, userText) => action.name === "calculate" && commands.hasInventedEnum(action.query, userText).length
            ? "铃铛和连击还没说完整呢。告诉我铃铛是 none 还是 fb、连击是 none / fc / ab / ab-plus 吧。" : "",
          ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        }),
        runAction: async (action, message, result) => {
          const e = message.__event;
          if (!e) return { handled: false };
          // ⚠ 绑定**绝不能经过模型**：那是一条要收邮箱密码的多轮私聊流程，
          // 让它经模型的手，明文密码就会作为 action 参数进到 DeepSeek 的请求体
          // 和本地会话历史里。这里只把人引到原流程上，连模型那句引出语都不带。
          if (action.name === "bind") {
            await commands.handleBind(e);
            return { handled: true };
          }
          // 模型替用户编参数的兜底闸。
          //
          // 实测抓到过：用户只说「算一下 14.2 打 1000737」，模型自己把铃铛补成 fb、
          // 连击补成 fc 就送去算了 —— 回复里还写成「铃铛 fb、连击 fc」，像是用户说过一样。
          // 算出来的 Rating 会被当成事实报出去，正是「不编数字」那条红线要防的东西。
          // 提示词里写了「缺参数只能问，不能猜」，但那是模型判断、不稳（三次里跑出来两次）。
          //
          // 所以在这里再兜一道：铃铛和连击是**枚举**，用户真说过就会在原话里留下
          // fb / fc / ab / none 这些字样。拿模型给的标记去用户原话里找，
          // 找不到就是它自己补的 —— 拦下，让它回去问。
          //
          // 只查这两个枚举，**不查数值**：定数和分数用户可能写成全角逗号、千分位、
          // 「一万分」之类，逐字比对会误伤；而枚举用户几乎总是原样打出来。
          // 代价不对称：多问一句只是烦，拿编来的参数算出一个像真的数才是错。
          const invented = action.name === "calculate"
            ? commands.hasInventedEnum(action.query, result?.validationText || message.content) : [];
          if (invented.length) {
            // 日志带上「编的是哪几个」和用户原话 —— 误拦的时候，没有这两样根本看不出
            // 是模型真编了，还是判据把它正常写的值当成了编的。
            log("模型给 calculate 补了用户没说过的东西，已拦下｜查的=" + action.query +
              "｜判为编的=" + invented.join(",") + "｜用户原话=" + String(message.content || "").slice(0, 60));
            await send(e, "诶——？铃铛和连击你还没说呢，美亚不能替你猜呀。\n" +
              "告诉美亚铃铛是 none 还是 fb、连击是 none / fc / ab / ab-plus，美亚马上给你算。");
            return { handled: true };
          }
          // 只认本条消息真的 @ 过的人：模型给别的编号一律作废、退回查自己。
          const mentioned = new Set((e.mentionedOpenids || []).map(String));
          const target = action.target && mentioned.has(String(action.target)) ? String(action.target) : null;
          if (action.target && !target) log("忽略模型给的陌生查询对象：" + action.target);
          await commands.runCapability(e, action.name, action.query, result?.text || "", target);
          return { handled: true, ...(action.name === "songsearch" ? { historyText: songSearch.reply(action.query) } : {}) };
        },
        // 正式别名前置解析交给宿主，聊天侧不实现第二套规则。
        //
        // ⚠ **刻意不接 `propose`**：那是「引擎自己猜出来的叫法先记成候选、人工复核后
        // 才进正式库」的复核流程。美亚这边不做这一层（2026-09-19 定的）——
        // 加别名就加上了、删就删掉了。少了 propose，chat.cjs 的 recordCandidate
        // 会在第一行就返回（`if(!word||!options.alias?.propose)return`），
        // 于是**不会再往候选库写任何东西**，而不是写了没人看。
        // resolve/titles 留着：它们负责在闲聊里认出「电管」这类叫法，是不可少的。
        alias: {
          resolve: (word, game) => {
            const alias=core.resolveAliasTitle(word, game || "");
            if(alias)return alias;
            // 本地事实层使用正式曲名，用户常用的 id870 是另一套面向 Bot 的 Song ID。
            // 先交给核心的唯一 ID/曲名解析，再把正式曲名送进只读曲库。
            if(game&&game!=="ongeki")return null;
            const matches=core.searchSongs(word);
            return matches.length===1?{title:matches[0].name,game:"ongeki",source:"local-song-index"}:null;
          },
          titles: () => core.getAliasStore().titleIndex(),
        },
        // 个人成绩门槛：公共曲库证明不了玩家的成绩，这道闸在模型之外。
        // 不接的话会漏出引擎里的中性提示（「还没有接入按个人成绩筛选」），不是美亚的口吻。
        personalRecommendationNotice: (message) => require("../chat-core/personal-recommendation.cjs").bindingNotice(
          (id) => core.getBinding(config, id), String(message.author.id),
          (message.__event?.mentionedOpenids || []).map(String),
          "先私聊美亚发一句话，再发 /绑定。"),
      } : {}),
      accepts: (message) => {
        const e = message.__event;
        if (!e) return false;
        if (e.type === "group") return allowGroups.has(String(e.openid));
        return allowPrivate;
      },
      extractText: (message) => message.content,
      typing: async () => {},
      send: async (message, text, file) => {
        const e = message.__event;
        // QQ 把 \n\n 渲染成空行，模型爱用空行分段，出来就是一条被拆得七零八落的回复。
        // 折叠成单个换行（保留分段感，但不留空行）。
        const cleaned = String(text).replace(/\n{2,}/g, "\n").trim();
        // 截断取证：模型偶尔给出以半句话结尾的回复。没有稳定复现前不改共享代码，
        // 先把原始结尾记下来 —— 下次发生时能看出是模型本身就写到一半，还是被谁切了。
        if (cleaned && !/[。！？…♪」）\)\?\!]$/.test(cleaned)) {
          log("⚠ 回复疑似未写完（结尾：" + JSON.stringify(cleaned.slice(-14)) + "，全长 " + cleaned.length + "）");
        }
        const sent = await send(e, cleaned, file);
        if (e.type === "group") remember(e.openid, settings.characterName, cleaned + (file ? "（图片）" : ""));
        return sent;
      },
      context: (message) => {
        const e = message.__event;
        return e.type === "group" ? readContext(e.openid, true) : [];
      },
      quoted: () => "",   // 官方接口没有 get_msg，读不到被引用那条的内容
    },
  });

  async function handleEvent(eventName, d) {
    const event = transport.normalize(eventName, d);
    if (!event) return;

    // ── 1. 白名单 ───────────────────────────────────────────────────
    // 放在幂等闸**之前**：不在名单里的群整条忽略，连去重表都不该占一格。
    if (event.type === "group" && !allowGroups.has(event.openid)) return;
    if (event.type === "c2c" && !allowPrivate) return;
    if (event.type === "channel") return;   // 频道白名单还没做（allowedChannelIds 未实装）

    // @全体成员 不是在叫美亚。部分客户端会把它作为 AT 事件投递，旧的事件名兜底
    // 因而会误判成 @ 到自己；在去重、上下文和绑定会话之前整条忽略。
    if (event.type === "group" && event.mentionsEveryone) {
      log("忽略 @全体成员 消息：" + String(event.content || "").slice(0, 40));
      return;
    }

    // ── 2. 幂等闸 ───────────────────────────────────────────────────
    // 同一条消息可能以 GROUP_MESSAGE_CREATE 和 GROUP_AT_MESSAGE_CREATE 两种事件名
    // 各来一次，而传输层的去重键是「事件名:消息id」，两种事件名互相挡不住。
    // 这里把第二次整条丢掉，**包括群上下文** —— 否则模型看到的上下文里
    // 同一句话出现两遍，「上面那首」这类指代就被污染了。
    if (commands && !commands.claimEvent(event)) {
      log("忽略重复投递（" + eventName + "）：" + String(event.content || "").slice(0, 40));
      return;
    }

    const text = String(event.content || "").trim();
    if (!text) return;

    const isDirect = event.type === "c2c";
    let command = commands ? commands.parseCommand(text) : null;

    // 群绑定的邮箱/密码必须在进入上下文缓冲、日志或模型之前截走。
    // 会话已经按 user + group 绑定，不会吞掉别人的话或同一用户在别群的消息。
    if (commands && event.type === "group") {
      const groupSession = commands.getSession(event.userId);
      if (commands.sessionMatches(event, groupSession)) {
        if (command?.name === "cancel") await commands.handleCommand(event, command);
        else await commands.continueSession(event, text);
        return;
      }
    }

    // ── 3. 群上下文 ─────────────────────────────────────────────────
    // 全量群消息也记（模型要靠它接上「他刚才说的」这类指代），但**不进聊天**。
    // 群绑定凭据已在上面提前截走，所以绝不会进入这里。
    if (event.type === "group") remember(event.openid, "群友", String(event.content || ""));

    // ── 4~7. 会话与指令 ─────────────────────────────────────────────
    // 顺序照抄 qq/qq-entry.cjs:785-798，那里的注释解释了为什么必须这样排：
    // 解绑确认期间收到的私聊文本如果落进绑定流程，末尾会回一句「正在验证，请稍候……」，
    // 用户明明是来确认解绑的，只会一头雾水。
    if (commands) {
      const session = commands.getSession(event.userId);

      if (!command && isDirect && session?.state === "confirmUnbind") {
        // 「解绑」本身也算确认：用户刚被告知「再发一次」，不一定记得带前缀。
        if (commands.LOOKUP.get(text.normalize("NFKC").toLowerCase()) === "unbind") {
          await commands.handleUnbind(event);
          return;
        }
        await send(event, T.unbindConfirmPending);
        return;
      }
      if (!command && isDirect && session) {
        await commands.continueSession(event, text);
        return;
      }
      // 私聊里裸关键字也认（群里不认 —— 群里必须带前缀，而且得 @ 到美亚）
      if (!command && isDirect) {
        const bare = text.normalize("NFKC").match(/^([^\s]+)\s*([\s\S]*)$/);
        const name = bare && commands.LOOKUP.get(bare[1].toLowerCase());
        if (name) command = { name, rest: bare[2].trim() };
      }

      if (command) {
        // 群里光有前缀不够：全量模式下别的 bot 打的 /help 也会送到这儿。
        if (!commandAllowedInGroup(event, eventName)) {
          log("群里没 @ 美亚，指令不执行：" + text.slice(0, 40));
          return;
        }
        if (!command.name) return send(event, T.unknownCommand);
        event.__target = pickTarget(event);
        log("收到指令 " + (commands.ALIASES[command.name]?.[0] || command.name) +
          "（" + event.type + " user=" + String(event.userId).slice(0, 12) + "…）");
        mark("MIA_BUSY:正在处理指令…");
        try { await commands.handleCommand(event, command); }
        catch (error) { log("⚠ 指令处理失败：" + core.safeError(error)); }
        finally { mark("MIA_BUSY:0"); }
        return;
      }
    }

    // ── 8. 聊天 ─────────────────────────────────────────────────────
    // 开了全量群消息之后**每条群消息都会送到这儿**，所以必须判「@ 到美亚了吗」——
    // 不判的话群里每句话它都要搭腔。判据与指令路径同源（mentionsSelf）。
    //
    // 不能用「事件名是不是 GROUP_AT_MESSAGE_CREATE」判：实测开了全量消息之后
    // 平台**不再推 AT 事件**，@ 消息只以 GROUP_MESSAGE_CREATE 到达，
    // 那样写在那种群里会让她对任何 @ 都不吭声。
    if (event.type === "group" && !mentionsSelf(event)) return;

    log("收到" + (event.type === "group" ? "群" : "私聊") + "消息（引用 id " +
      (event.refId ? "有 " + event.refId.slice(0, 16) + "…" : "无") + "）：" + text.slice(0, 60));
    mark("MIA_BUSY:正在回复…");
    try {
      // 下面 finally 里统一收尾
      await chat.handle({
        id: event.msgId,
        guildId: "qq-official",
        channelId: event.openid,
        author: { id: event.userId, bot: false },
        content: text,
        __event: event,
        __replyTo: event.msgId,
      });
    } catch (error) {
      log("⚠ 处理失败：" + (error?.message || error));
      // 模型偶发返回空白（实测约十次一次），chat.cjs 重画加降级都没拿到内容时会抛错。
      // 不给任何回应的话，群里看起来就是「@ 了它但没反应」—— 比说错话更像坏了。
      // 发一句兜底至少有个交代；传输层的相同内容抑制顺便挡掉了持续故障时的刷屏。
      await send(event, "呜喵……美亚刚才走神了，你再说一遍好不好？").catch((e2) => log("兜底也发不出去：" + (e2?.message || e2)));
    } finally {
      mark("MIA_BUSY:0");   // 成功、失败、兜底都要回到空闲，否则界面会一直卡在「正在回复…」
    }
  }

  // 网关连接状态：图形界面据此点灯。连接是在 transport.start 之后异步建立的，
  // 所以要轮询而不能只看返回值。
  let gatewayTimer = null, gatewayOn = false;
  function watchGateway() {
    gatewayTimer = setInterval(() => {
      const up = transport.state.connected && transport.healthy();
      if (up === gatewayOn) return;
      gatewayOn = up;
      mark("MIA_GATEWAY:" + (up ? "1" : "0"));
      if (up) mark("MIA_READY");     // 第一次连上才算就绪，和 BOT_READY 语义一致
    }, 1500);
    gatewayTimer.unref?.();
  }

  return {
    chat, transport, settings, allowGroups, readContext, commands,
    handleEvent,
    mentionsSelf, pickTarget, commandAllowedInGroup,
    async start() {
      // 目录必须先建：凭据库、出图、别名库都落在这些路径下。
      // aliasDir 在共用梨绪那份时要指到人家已经在用的目录（可能还没建）。
      // ⚠ 每一项都要判存在再建 —— 纯聊天模式（嵌入式调用、测试）这些键可能压根没有。
      if (config.workDir) fs.mkdirSync(config.workDir, { recursive: true });
      if (config.outputDir) fs.mkdirSync(config.outputDir, { recursive: true });
      if (commands) {
        const aliasDir = String(config.aliasDir || "").trim() || path.dirname(config.vaultPath);
        fs.mkdirSync(aliasDir, { recursive: true });
      }

      // 别名库 / 格式化 / 提示文案 / 状态提供者都是 mia-core 的模块级单例。
      // 放在 start() 而不是工厂体里，是为了让 createMiaBot 保持无副作用 ——
      // 配置有问题就在启动时炸，而不是构造对象的时候（跟梨绪那边一致）。
      if (commands) commands.registerCore();
      if (assetBrowser) await assetBrowser.start();

      log("美亚启动：" + settings.characterName +
        "｜环境 " + (config.sandbox ? "沙箱" : "正式") +
        "｜表情 " + settings.manifest.entries.length + " 个" +
        "｜允许群 " + allowGroups.size + " 个" +
        "｜私聊 " + (allowPrivate ? "开" : "关") +
        "｜指令 " + (commands ? "开" : "关") +
        (commands?.aliasDeleteOpenids.size ? "｜删别名白名单 " + commands.aliasDeleteOpenids.size + " 人" : ""));
      if (commands && !commands.aliasDeleteOpenids.size) {
        log("提示：config.local.json 里没配 aliasDeleteOpenids，所以谁都不能用 /删除别名。");
      }
      if (commands && botOpenid) {
        log("提示：配置里还留着 botOpenid —— 它已经用不上了（实测 mention 的 id 跟 READY 的 botId 不是一套 id 空间）。现在靠平台给的 is_you 判，可以删掉这个键。");
      }
      await transport.start((name, d) => { void handleEvent(name, d).catch((e) => log("处理事件出错：" + (e?.message || e))); });
      log("已就绪，等待消息。");
      watchGateway();
    },
    stop() {
      if (gatewayTimer) { clearInterval(gatewayTimer); gatewayTimer = null; }
      chat.close();
      transport.stop();
      if (assetBrowser) void assetBrowser.stop();
    },
  };
}

async function main() {
  const config = loadConfig();
  const bot = createMiaBot(config, { log: makeFileLog(path.join(HERE, "mia.log")) });
  await bot.start();
  const shutdown = () => { bot.stop(); setTimeout(() => process.exit(0), 300); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (require.main === module) {
  main().catch((error) => {
    // 报错时抹掉可能混进来的密钥
    const msg = String(error?.message || error).replace(/R4hLze[A-Za-z0-9]*/g, "***").replace(/QQBot [\w.-]+/g, "QQBot ***");
    console.error("启动失败：" + msg);
    process.exit(1);
  });
}

module.exports = { loadConfig, createMiaBot, makeSender, makeCommandSenders, makeFileLog };
