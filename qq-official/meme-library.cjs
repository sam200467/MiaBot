"use strict";
// 梗库的第一块：/入典 收文案，/典来 原样抽一篇（2026-10-13）。
//
// 用户的点子：群友看到好笑的文案，发「/入典 原文」，或者回复那条消息再发 /入典，就收进典里；
// 谁发 /典来，美亚就随机抽一篇原样贴出来——**一个字不加**：不经过模型，也不套她的口吻。
//
// 群友入的要先审（用户定的）：/典来 是用美亚的名义原样发的，文案里的脏话、擦边、广告链接都算在
// 机器人头上，也挡不住有人故意往里塞垃圾。所以：
//   · 审核人（默认就是能用 /删除别名 的那几位）入的直接生效；
//   · 别人入的先进待审，审核人在私聊里用 /待审典 看、/看典 看全文、/过典 /删典 处理。
//     审核只在私聊：待审的内容不在群里摊开念。/删典 例外，群里也能用——审核人回复那篇典
//     再发 /删典 就行，什么都不会念出来。
// 在哪儿入的就在哪儿抽：群里入的只在那个群抽得到，私聊里入的只在私聊抽得到。回复入典收的是
// 群友的原话，不能让私聊里的陌生人抽走。
//
// 原文要从 mia-entry 的 text 取，**不能用 parseCommand 的 rest**：那边先做了 NFKC，「，！？」会变成
// 「,!?」，「……」会变成「......」，全角空格变成半角——入典要的是一字不差。
//
// 以后梗库还要接两样（都还没做）：从 @ 美亚的整段文案里自动收候选；聊天时认出「这是本群入过典的
// 那篇」。存储照那时候也用得上的样子定：一篇一条，带出处和审核状态。
//
// 默认关（qq-official/config.local.json 的 memes.mode）。关着时 mia-entry 连这个模块都不建：
// /入典、/典来 跟以前一样是「不认识的指令」，私聊里裸发「典来」照旧去聊天。

const fs = require("node:fs");
const path = require("node:path");
const { localTime } = require("./chat-log.cjs");
const { MIA_TEMPLATES: T } = require("./mia-voice.cjs");

const MODES = ["off", "on"];
const DEFAULT_COOLDOWN_SECONDS = 10;
// 跟聊天的 maxInputChars 一样。QQ 单条消息的长度上限官方没写，八九百字以上的要上线实测。
const DEFAULT_MAX_CHARS = 1500;
// 待审的上限：一个人最多压 10 篇、总共 100 篇。挡的是一口气往里塞垃圾，正常用碰不到。
const USER_PENDING_MAX = 10;
const PENDING_MAX = 100;
// /待审典 一次列几篇、每篇给开头几个字：整条控制在指令层分块的 900 字以内。
const LIST_MAX = 8;
const PREVIEW_CHARS = 40;
const STATES = ["pending", "approved", "removed"];
const STATE_LABEL = { pending: "待审", approved: "已入典", removed: "已删" };

// 开着时给聊天那条路补的三样。前面两步（语义路由、联网判断）都不知道美亚有这个功能，2026-10-13 真模型抽查：
// 「怎么把一段话入典呀」3 次里，路由有 1 次当成加别名去追问，联网判断有 1 次当成不认识的词要去搜。
//   · MEME_ABILITY：回复模型的能力说明里补一句，不说的话有人 @ 她问「怎么入典」，她只能瞎编；
//   · MEME_ROUTER_NOTE：语义路由的提示里补一句，这两个词不是工具、也不是别名，交给聊天；
//   · MEME_WORDS：交给联网判断的「机器人自己的功能」，提到它们的句子不自动搜（明说「搜一下」照搜）。
const MEME_ABILITY = "群里收集的梗文案（典）由程序管：用户发 /入典 加上文案原文，或者回复那条消息再发 /入典，"
  + "就交给审核，审过了才算入典；发 /典来 由程序随机抽一篇原样贴出来。这两件事只能用指令办，"
  + "你不能替用户入典或抽典，被问到就告诉他发哪条指令。";
const MEME_ROUTER_NOTE = "「入典」「典来」说的是群里的梗库：收文案、抽文案只能由用户自己发 /入典、/典来 指令，"
  + "工具清单里没有对应的工具，也不是添加别名。提到入典、典来的句子一律 route=chat，由聊天那边告诉用户怎么用。";
const MEME_WORDS = Object.freeze(["入典", "典来", "典來"]);

// ── 配置 ────────────────────────────────────────────────────────────
// 配错了按关闭处理并带上原因，由启动日志报出来（跟聊天记录、读引用一个脾气）。
// 审核人不填就用 aliasDeleteOpenids（用户定的「跟 /删除别名 同一个做法」）；填了空数组就是谁都审不了，
// 群友入的会一直等着——失败往安全的方向倒。
function memeSettings(raw, { aliasDeleteOpenids = [] } = {}) {
  const off = (error) => ({ mode: "off", ...(error ? { error: error + "，梗库先按关闭处理" } : {}) });
  if (raw === undefined || raw === null) return off();
  if (typeof raw !== "object" || Array.isArray(raw)) return off("memes 应当是一个对象");
  const mode = raw.mode === undefined ? "off" : String(raw.mode);
  if (!MODES.includes(mode)) return off("memes.mode 只能是 " + MODES.join(" / "));
  const int = (value, fallback, min, max) => {
    const n = value === undefined ? fallback : value;
    return Number.isInteger(n) && n >= min && n <= max ? n : null;
  };
  const cooldownSeconds = int(raw.cooldownSeconds, DEFAULT_COOLDOWN_SECONDS, 0, 600);
  if (cooldownSeconds === null) return off("memes.cooldownSeconds 应当是 0～600 的整数");
  const maxChars = int(raw.maxChars, DEFAULT_MAX_CHARS, 20, 3000);
  if (maxChars === null) return off("memes.maxChars 应当是 20～3000 的整数");
  const own = raw.reviewers !== undefined;
  if (own && (!Array.isArray(raw.reviewers) || raw.reviewers.some((id) => !String(id ?? "").trim()))) {
    return off("memes.reviewers 应当是 openid 数组，不能有空值");
  }
  const reviewers = new Set((own ? raw.reviewers : aliasDeleteOpenids || []).map((id) => String(id).trim()).filter(Boolean));
  return { mode, cooldownSeconds, maxChars, reviewers, reviewersFrom: own ? "memes.reviewers" : "aliasDeleteOpenids" };
}

// ── 指令 ────────────────────────────────────────────────────────────
const WORDS = [
  ["add", "入典", ["入典"]],
  ["draw", "典来", ["典来", "典來"]],
  ["pending", "待审典", ["待审典", "待審典"]],
  ["view", "看典", ["看典"]],
  ["approve", "过典", ["过典", "過典"]],
  ["remove", "删典", ["删典", "刪典"]],
];
const NAME_OF = new Map(WORDS.flatMap(([name, , words]) => words.map((word) => [word, name])));
const LABEL_OF = Object.fromEntries(WORDS.map(([name, label]) => [name, label]));
const WORD_ALT = [...NAME_OF.keys()].sort((a, b) => b.length - a.length).join("|");
// 前缀跟 parseCommand 一样认斜杠、半角井号、全角井号，外加全角斜杠（那边是靠 NFKC 认出它的）。
const PREFIXED = new RegExp("^[#＃/／]\\s*(" + WORD_ALT + ")([\\s\\S]*)$");
// 私聊里裸关键字也认（跟别的指令一样），但后面得是空白或结尾：「入典了属于是」是在聊天。
const BARE = new RegExp("^(" + WORD_ALT + ")(?=\\s|$)([\\s\\S]*)$");
function matchCommand(text, { direct = false } = {}) {
  const raw = String(text ?? "").trim();
  const m = PREFIXED.exec(raw) || (direct ? BARE.exec(raw) : null);
  if (!m) return null;
  const name = NAME_OF.get(m[1]);
  // 入典后面直接跟原文也认（「/入典【水鸡筹】……」）。别的后面只能是空白、编号或结尾：
  // 「/典来了」不是在叫指令，照旧交给原来的指令解析。
  if (name !== "add" && m[2] && !/^[\s#＃\d]/.test(m[2])) return null;
  return { name, label: LABEL_OF[name], rest: m[2].trim() };
}

// ── 文本工具 ────────────────────────────────────────────────────────
// 判重的键：NFKC 之后只留字母和数字。标点、空格、全半角不一样的同一篇算一篇。
const keyOf = (text) => String(text ?? "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const charCount = (text) => [...String(text ?? "")].length;
const idsIn = (text) => [...new Set((String(text ?? "").match(/\d+/g) || []).map(Number))].slice(0, 20);
const idList = (ids) => ids.map((id) => "#" + id).join("、");
function preview(text) {
  const chars = [...String(text).replace(/\s+/g, " ").trim()];
  return chars.length > PREVIEW_CHARS ? chars.slice(0, PREVIEW_CHARS).join("") + "…（共 " + charCount(text) + " 字）" : chars.join("");
}

// ── 存储 ────────────────────────────────────────────────────────────
// 一个 JSON 文件，放在 workDir 下（默认 qq-official/data/meme-library.json，跟别名库、绑定一样
// 只在服务器上，不进仓库）。只有美亚这一个进程写，每次改动都整个重写一遍。
function createMemeStore({ file, now = Date.now }) {
  let data = { version: 1, nextId: 1, entries: [] };

  // 文件不在就是还没入过典；在但读不懂就抛出去，由上层按关闭处理——**绝不拿空库把它盖掉**。
  function load() {
    let raw;
    try { raw = fs.readFileSync(file, "utf8"); }
    catch (error) { if (error?.code === "ENOENT") return; throw error; }
    const parsed = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
    if (parsed?.version !== 1 || !Number.isInteger(parsed.nextId) || !Array.isArray(parsed.entries)
      || parsed.entries.some((e) => !Number.isInteger(e?.id) || !STATES.includes(e.state) || typeof e.text !== "string" || typeof e.scope !== "string")) {
      throw new Error("格式不对");
    }
    data = parsed;
  }
  // 先写临时文件再改名：写到一半断电，旧文件还是完整的。
  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1) + "\n");
    fs.renameSync(tmp, file);
  }
  // 一次改动要么整个存上，要么整个不算：写文件失败就把内存里的也退回去，免得回了「收进去啦」，
  // 重启之后却没有。
  function commit(change) {
    const before = JSON.stringify(data);
    try {
      const result = change();
      save();
      return result;
    } catch (error) {
      data = JSON.parse(before);
      throw error;
    }
  }

  const entries = () => data.entries;
  const get = (id) => data.entries.find((e) => e.id === id) || null;
  const find = (scope, key) => data.entries.find((e) => e.scope === scope && keyOf(e.text) === key) || null;
  const counts = () => ({
    approved: data.entries.filter((e) => e.state === "approved").length,
    pending: data.entries.filter((e) => e.state === "pending").length,
  });
  function add({ scope, text, source, by, approved }) {
    return commit(() => {
      const at = localTime(now());
      const entry = { id: data.nextId, state: approved ? "approved" : "pending", scope, text, source, by, at,
        ...(approved ? { reviewedBy: by, reviewedAt: at } : {}) };
      data.nextId += 1;
      data.entries.push(entry);
      return entry;
    });
  }
  function setState(ids, state, by) {
    return commit(() => {
      const at = localTime(now());
      return ids.map((id) => Object.assign(get(id), { state, reviewedBy: by, reviewedAt: at }));
    });
  }
  return { file, load, entries, get, find, counts, add, setState };
}

// ── 指令处理 ────────────────────────────────────────────────────────
// send(event, text) 是指令层的发送器：回原地、原样发，不折叠空行（见 mia-entry 的 makeCommandSenders）。
function createMemeLibrary({ settings, file, send, log = () => {}, now = Date.now, random = Math.random }) {
  const store = createMemeStore({ file, now });
  let ready = false;
  const cycles = new Map();      // 范围 → 这一轮已经抽过的编号：一轮抽完才会重复
  const lastPicked = new Map();  // 范围 → 上一篇：新一轮的第一篇不跟它撞
  const lastDrawAt = new Map();  // 冷却：群按群算，私聊按人算
  const isReviewer = (event) => settings.reviewers.has(String(event.userId));
  const scopeOf = (event) => (event.type === "group" ? "group:" + event.openid : "c2c");
  // 只有一个群时写「群」就够了；不止一个群才带上 openid 开头几位，审的时候分得清。
  function where(scope) {
    if (scope === "c2c") return "私聊";
    const groups = new Set(store.entries().map((e) => e.scope).filter((s) => s.startsWith("group:")));
    return groups.size > 1 ? "群 " + scope.slice(6, 12) : "群";
  }
  const reason = (error) => error?.code || error?.message || String(error);

  // 读不了库就整个不接活（回一句打不开），不拿空库顶上——顶上了，下一次入典就会把原文件盖掉。
  function start() {
    try {
      store.load();
      ready = true;
      return { ok: true, ...store.counts() };
    } catch (error) {
      ready = false;
      return { ok: false, error: "梗库文件读不了（" + reason(error) + "），先按关闭处理，文件没动：" + file };
    }
  }

  async function handle(event, command) {
    if (!ready) return send(event, T.memeUnavailable);
    if (command.name === "add") return add(event, command.rest);
    if (command.name === "draw") return draw(event);
    if (command.name === "remove") return remove(event, command.rest);
    // 剩下三个是审核：只认审核人，而且只在私聊——待审的内容不在群里念。
    if (!isReviewer(event)) return send(event, T.memeReviewDenied);
    if (event.type !== "c2c") return send(event, T.memeReviewPrivate);
    if (command.name === "pending") return listPending(event);
    if (command.name === "view") return view(event, command.rest);
    return approve(event, command.rest);
  }

  // ── /入典 ──
  // 原文优先用指令后面贴的；后面没写字，就收被回复（引用）的那条。两样都有时按贴的算：
  // 「回复某条 + /入典 典中典」多半是贴错了地方，但收贴出来的字至少不会收错人。
  async function add(event, rest) {
    let text = rest, source = "typed";
    if (!text) {
      const quote = event.quote;
      if (quote?.content?.trim()) { text = quote.content.trim(); source = "quote"; }
      else if (quote) return send(event, T.memeQuoteNoText);
      else if (Number(event.raw?.message_type) === 103) return send(event, T.memeQuoteUnreadable);
      else return send(event, T.memeUsage);
    }
    const length = charCount(text);
    if (keyOf(text).length < 2) return send(event, T.memeTooShort);
    if (length > settings.maxChars) return send(event, T.memeTooLong(settings.maxChars, length));

    const scope = scopeOf(event), by = String(event.userId), reviewer = isReviewer(event);
    const same = store.find(scope, keyOf(text));
    if (same) {
      if (same.state === "approved") return send(event, T.memeAlreadyIn(same.id));
      // 删掉过的，别人再交也不进待审：不然删掉的垃圾能一遍遍塞回来。
      if (!reviewer) return send(event, same.state === "pending" ? T.memeAlreadyPending(same.id) : T.memeRejectedBefore);
      // 审核人再入一次：待审的就是过了，删掉过的就是放回来。
      const was = same.state;
      try { store.setState([same.id], "approved", by); }
      catch (error) { log("⚠ 梗库写不进去：" + reason(error)); return send(event, T.memeSaveFailed); }
      log("梗库：#" + same.id + (was === "removed" ? " 放回典里" : " 过典") + "（审核人再入一次｜" + where(scope) + "）");
      return send(event, was === "removed" ? T.memeRestored(same.id) : T.memeAdded(same.id));
    }
    if (!reviewer) {
      const pending = store.entries().filter((e) => e.state === "pending");
      if (pending.filter((e) => e.by === by).length >= USER_PENDING_MAX) return send(event, T.memeUserQueueFull(USER_PENDING_MAX));
      if (pending.length >= PENDING_MAX) return send(event, T.memeQueueFull);
    }
    let entry;
    try { entry = store.add({ scope, text, source, by, approved: reviewer }); }
    catch (error) { log("⚠ 梗库写不进去：" + reason(error)); return send(event, T.memeSaveFailed); }
    log("梗库：#" + entry.id + " 入典（" + (reviewer ? "审核人入的，直接生效" : "待审") + "｜" + where(scope) + "｜" + length + " 字"
      + (source === "quote" ? "｜回复入的" : "") + "）");
    return send(event, reviewer ? T.memeAdded(entry.id) : T.memePending(entry.id));
  }

  // ── /典来 ──
  // 同一个范围里一轮抽完才重复；新一轮的第一篇不跟上一轮最后一篇撞。中途新过审的，这一轮就抽得到。
  function pick(scope) {
    const pool = store.entries().filter((e) => e.state === "approved" && e.scope === scope);
    if (!pool.length) return null;
    let used = cycles.get(scope) || new Set();
    let fresh = pool.filter((e) => !used.has(e.id));
    if (!fresh.length) {
      used = new Set();
      fresh = pool.length > 1 ? pool.filter((e) => e.id !== lastPicked.get(scope)) : pool;
    }
    const entry = fresh[Math.min(fresh.length - 1, Math.floor(random() * fresh.length))];
    used.add(entry.id);
    cycles.set(scope, used);
    lastPicked.set(scope, entry.id);
    return entry;
  }
  async function draw(event) {
    const key = event.type === "group" ? "group:" + event.openid : "c2c:" + event.userId;
    const wait = settings.cooldownSeconds * 1000 - (now() - (lastDrawAt.get(key) ?? -Infinity));
    if (wait > 0) return send(event, T.memeCooldown(Math.ceil(wait / 1000)));
    const entry = pick(scopeOf(event));
    if (!entry) return send(event, T.memeEmpty);
    lastDrawAt.set(key, now());
    log("梗库：典来 #" + entry.id + "（" + where(entry.scope) + "，" + charCount(entry.text) + " 字）");
    try {
      return await send(event, entry.text);
    } catch (error) {
      // 被动回复窗口过期：补一句也一样发不出去，只记日志（出图那边也是这么做的）。
      if (error?.code === 40034128) { log("典来 #" + entry.id + " 没发出去：被动回复窗口已过期"); return null; }
      log("⚠ 典来 #" + entry.id + " 没发出去（" + charCount(entry.text) + " 字）：" + reason(error));
      return send(event, T.memeSendFailed).catch((again) => log("说明也没发出去：" + reason(again)));
    }
  }

  // ── 审核（私聊）──
  async function listPending(event) {
    const pending = store.entries().filter((e) => e.state === "pending");   // 编号小的在前，就是先交的在前
    const { approved } = store.counts();
    if (!pending.length) return send(event, T.memeNoPending(approved));
    const shown = pending.slice(0, LIST_MAX), more = pending.length - shown.length;
    return send(event, [
      "待审 " + pending.length + " 篇（典里已有 " + approved + " 篇）：",
      ...shown.map((e) => "#" + e.id + "｜" + where(e.scope) + "｜" + e.at.slice(5, 16) + (e.source === "quote" ? "｜回复入的" : "") + "\n" + preview(e.text)),
      (more ? "还有 " + more + " 篇，审完这些再发 /待审典。\n" : "") + "看全文 /看典 12｜通过 /过典 12｜删掉 /删典 12；一次可以写好几个号。",
    ].join("\n\n"));
  }
  async function view(event, rest) {
    const [id] = idsIn(rest);
    if (!id) return send(event, T.memeViewUsage);
    const e = store.get(id);
    if (!e) return send(event, T.memeNotFound("#" + id));
    return send(event, "#" + e.id + "｜" + STATE_LABEL[e.state] + "｜" + where(e.scope) + "｜" + e.at.slice(0, 16)
      + (e.source === "quote" ? "｜回复入的" : "") + "｜" + charCount(e.text) + " 字\n" + e.text);
  }
  // 过典和删典是同一个动作换个目标状态：没找到的、本来就是那个状态的分开说。
  async function settle(event, ids, state) {
    const missing = ids.filter((id) => !store.get(id));
    const already = ids.filter((id) => store.get(id)?.state === state);
    const todo = ids.filter((id) => store.get(id) && store.get(id).state !== state);
    if (todo.length) {
      try { store.setState(todo, state, String(event.userId)); }
      catch (error) { log("⚠ 梗库写不进去：" + reason(error)); return send(event, T.memeSaveFailed); }
      log("梗库：" + (state === "approved" ? "过典 " : "删典 ") + idList(todo));
    }
    return send(event, [
      todo.length ? (state === "approved" ? T.memeApproved(idList(todo)) : T.memeRemoved(idList(todo))) : "",
      already.length ? (state === "approved" ? T.memeAlreadyApproved(idList(already)) : T.memeAlreadyRemoved(idList(already))) : "",
      missing.length ? T.memeNotFound(idList(missing)) : "",
    ].filter(Boolean).join("\n"));
  }
  async function approve(event, rest) {
    const ids = idsIn(rest);
    if (!ids.length) return send(event, T.memeApproveUsage);
    return settle(event, ids, "approved");
  }
  // /删典 群里也能用（只认审核人）：删东西不会念出任何内容。不写编号时，删被回复的那篇——
  // 审核人看到 /典来 抽出来一篇不该在的，直接回复它发 /删典 就行，/典来 那条本来就不带编号。
  async function remove(event, rest) {
    if (!isReviewer(event)) return send(event, T.memeReviewDenied);
    let ids = idsIn(rest);
    if (!ids.length) {
      const quoted = event.quote?.content?.trim();
      if (!quoted) return send(event, T.memeRemoveUsage);
      const key = keyOf(quoted), scope = scopeOf(event);
      const live = store.entries().filter((e) => e.state !== "removed" && e.scope === scope);
      // 平台给的被回复正文要是不全（长文没实测过），就按「包含」认；太短的片段不认，免得删错。
      let hits = live.filter((e) => keyOf(e.text) === key);
      if (!hits.length && key.length >= 8) hits = live.filter((e) => keyOf(e.text).includes(key));
      if (!hits.length) return send(event, T.memeQuoteNotFound);
      if (hits.length > 1) return send(event, T.memeQuoteAmbiguous(idList(hits.map((e) => e.id))));
      ids = [hits[0].id];
    }
    return settle(event, ids, "removed");
  }

  return { settings, store, file, start, handle, match: matchCommand, isReviewer, get ready() { return ready; } };
}

module.exports = {
  MODES, MEME_ABILITY, MEME_ROUTER_NOTE, MEME_WORDS, USER_PENDING_MAX, PENDING_MAX,
  memeSettings, matchCommand, keyOf, createMemeStore, createMemeLibrary,
};
