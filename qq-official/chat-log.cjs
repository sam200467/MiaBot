"use strict";
// 美亚的聊天记录：她每回一轮群聊，就把这一轮记成一行 JSON，
// 存到 <workDir>/chatlog/<本地日期>.jsonl（按默认配置就是 qq-official/data/chatlog/）。
//
// 为什么要有：群里报「美亚刚才答错了」时，单拿那一句重放往往复现不出来 ——
// 模型那一轮还看着群里最近的消息。mia.log 只记 @ 她的那句话的前 60 个字，
// 既没有当时的群上下文，也没有她回了什么。这里把这几样一起存下来：
//   · 用户那句话（全文）
//   · 她这一轮**实际看到的**群上下文（mia-entry 交给模型的那最多 12 条）
//   · 她的回复、调用的工具、联网判断的结果
// 这位用户前几轮说了什么不重复存（只记轮数），往前翻同一个人的记录就有。
//
// 只记群聊里她回复了的那几轮：
//   · 没 @ 她的群消息不单独记，只在被她看到时作为上下文出现；私聊不记。
//   · 指令和绑定流程在进聊天之前就分走了，邮箱、密码、验证码碰不到这里；
//     群上下文本身也已经把 /绑定 那条排除在外（见 mia-entry 的 remember）。
//
// 默认关（qq-official/config.local.json 的 chatLog.mode）。关着时 mia-entry 连钩子都不挂，
// chat.cjs 走的还是原来那条路。

const fs = require("node:fs");
const path = require("node:path");

const MODES = ["off", "replies"];
const DEFAULT_KEEP_DAYS = 14;
const DAY_FILE = /^(\d{4})-(\d{2})-(\d{2})\.jsonl$/;

// 配错了按关闭处理并带上原因，由启动日志报出来 —— 记录是排障用的，不该因为它起不来。
function chatLogSettings(raw) {
  const off = (error) => ({ mode: "off", keepDays: DEFAULT_KEEP_DAYS, ...(error ? { error: error + "，聊天记录先按关闭处理" } : {}) });
  if (raw === undefined || raw === null) return off();
  if (typeof raw !== "object" || Array.isArray(raw)) return off("chatLog 应当是一个对象");
  const mode = raw.mode === undefined ? "off" : String(raw.mode);
  if (!MODES.includes(mode)) return off("chatLog.mode 只能是 " + MODES.join(" / "));
  const keepDays = raw.keepDays === undefined ? DEFAULT_KEEP_DAYS : Number(raw.keepDays);
  if (!Number.isInteger(keepDays) || keepDays < 1 || keepDays > 365) return off("chatLog.keepDays 应当是 1～365 的整数");
  return { mode, keepDays };
}

// 一律按服务器本地时间：文件按本地日期切，记录里的时间也是本地时间。
// （mia.log 行首的时间是 UTC，国内的服务器上两边差 8 小时。）
const pad = (n) => String(n).padStart(2, "0");
function localDate(ms) {
  const d = new Date(ms);
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}
function localTime(ms) {
  const d = new Date(ms);
  return localDate(ms) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
}

// chat.cjs 交过来的一轮（见那边的 recordTurn）→ 一行记录。
// 字段少而稳：以后写重放脚本、攒梗库候选都按这个形状读。
function turnRecord(turn, finishedAt = Date.now()) {
  const message = turn.message || {};
  const event = message.__event || {};
  const media = message.__media || {};
  const result = turn.result || null;
  const record = {
    time: localTime(turn.at),
    group: String(event.openid || ""),
    user: String(event.userId || message.author?.id || ""),
    msgId: String(event.msgId || message.id || ""),
    text: String(turn.text ?? ""),
    ...(media.hasImage ? { image: true } : {}),
    // 用户点了「回复」某条消息。读引用（quotedMessage）关着时她是缺着这块答的，排查时要知道；
    // 开着时把她看到的那条一起记下（就是交给模型的那一行，图只记看没看到）。
    ...(media.hasReference ? { quote: true } : {}),
    ...(message.__quoted ? { quoted: String(message.__quoted) } : {}),
    context: (turn.context || []).map(String),
    historyTurns: Number(turn.historyTurns) || 0,
  };
  if (result) {
    record.reply = String(result.text ?? "");
    if (turn.file?.id) record.sticker = String(turn.file.id);
    if (result.action) {
      const { name, query, target } = result.action;
      record.action = { name, ...(query ? { query: String(query) } : {}), ...(target ? { target: String(target) } : {}) };
    }
    if (turn.routed) record.routed = true;   // 语义路由接走的（查曲库、点工具），没进聊天模型
    if (result.research) record.research = result.research;
    if (result.searchGate) record.searchGate = result.searchGate;
  }
  if (turn.error) record.error = String(turn.error);
  record.ms = Math.max(0, finishedAt - (Number(turn.at) || finishedAt));
  return record;
}

function createChatLog({ dir, keepDays = DEFAULT_KEEP_DAYS, now = Date.now, log = () => {} }) {
  let day = "";          // 上次写入的本地日期：跨天时顺手清一次过期文件
  let failing = false;   // 写不进去只报第一次，恢复了再报一声，免得刷屏

  // 只删本目录里「日期.jsonl」这种名字、而且超出保留期的文件；别的文件一概不碰。
  function prune() {
    let names;
    try { names = fs.readdirSync(dir); } catch { return 0; }
    const today = new Date(now());
    today.setHours(0, 0, 0, 0);
    let removed = 0;
    for (const name of names) {
      const m = DAY_FILE.exec(name);
      if (!m) continue;
      const fileDay = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      if (localDate(fileDay.getTime()) !== name.slice(0, 10)) continue;   // 2026-02-30 这种不认
      if (Math.round((today - fileDay) / 86400000) < keepDays) continue;
      try { fs.unlinkSync(path.join(dir, name)); removed++; }
      catch (error) { log("⚠ 过期的聊天记录删不掉：" + name + "（" + (error?.code || error?.message || error) + "）"); }
    }
    return removed;
  }

  function write(record) {
    const today = localDate(now());
    try {
      if (today !== day) {
        fs.mkdirSync(dir, { recursive: true });
        prune();
        day = today;
      }
      fs.appendFileSync(path.join(dir, today + ".jsonl"), JSON.stringify(record) + "\n");
      if (failing) log("聊天记录恢复写入");
      failing = false;
    } catch (error) {
      if (!failing) log("⚠ 聊天记录写不进去：" + (error?.code || error?.message || error) + "（回复不受影响）");
      failing = true;
    }
  }

  // 启动时建目录、清一次过期文件，返回清掉了几个。建不了也不拦启动，写的时候还会再试。
  function start() {
    try { fs.mkdirSync(dir, { recursive: true }); }
    catch (error) { log("⚠ 聊天记录目录建不了：" + (error?.code || error?.message || error)); return 0; }
    day = localDate(now());
    return prune();
  }

  return { dir, keepDays, write, prune, start };
}

module.exports = { MODES, chatLogSettings, localDate, localTime, turnRecord, createChatLog };
