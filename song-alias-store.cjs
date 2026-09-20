"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

// 别名映射到**正式曲名**，不绑任何一份曲库的 songId。
// 理由：同一首歌可能同时收录在舞萌、音击、中二，各游戏的 songId、定数、收录版本完全
// 独立。把别名钉在某个 songId 上，就等于让它只对那一份数据成立——换款游戏就变成错答案。
// 条目形状（version 2）：
//   {alias, title, game}   game 非空＝那款游戏专属；game 空＝跨游戏通用
// version 1 的旧文件（按 songId 存）照样读得进来：用调用方给的 resolveSong 回调把
// songId 换回曲名和游戏，写回时统一成 version 2。
//
// 解析的不变量：同一 alias 在同一 scope 下指向不同曲名＝歧义，必须返回 null，
// 绝不能任选一个——那正是「同一首歌在多款游戏里数据互相污染」的入口。
const VERSION = 2;

// 别名格式校验提到模块级：正式库和候选库必须用**同一套**规则，否则一条合法别名
// 可能在一边收下、另一边被拒。SongAliasStore.validateAlias 保留成薄委托，调用方不变。
function validateAlias(value) {
  const alias = String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!alias || alias.length > 80 || /[\p{Cc}\p{Cf}]/u.test(alias)) throw Error("别名需为 1–80 个字符，不能包含控制字符。");
  if (/^(?:id\s*)?\d+$/i.test(alias)) throw Error("别名不能是纯数字或 Song ID，请使用文字昵称。");
  return alias;
}

// ── 跨进程写入的共用管道（正式库与候选库都走这一份）─────────────────
// 梨绪（qq/qq-entry.cjs）和美亚（qq-official/）是两个独立进程，现在共用同一份别名
// 文件，而两边的 entries 都只在启动时 load 一次。以前每次改动都是拿这份过期副本整个
// 覆盖回去：
//   梨绪内存 [A]       美亚内存 [A]
//   梨绪加 B → 文件 [A, B]
//   美亚加 C → 文件 [A, C]   ← B 没了
// 原来的 save() 已经是「唯一临时文件 + rename」的原子写，那防的是写坏文件，防不了
// 丢更新——写回去的数组本身就是过期的。
// 所以写入只留 transaction 一个入口：加锁 → 重新读盘 → 拿**盘上的** entries 应用改动
// → 原子写 → 才更新内存。
// ⚠ 不能改成「重新读盘再跟内存合并」：那会让删掉的条目复活——梨绪删了 X，美亚拿着还
// 含 X 的旧副本一合并，X 就回来了。只有把整个操作放进锁里串行化才天然免疫。
const LOCK_TTL_MS = 30000;      // 临界区只有读+写一个小 JSON，这么久还没走完只可能是崩了
const LOCK_TIMEOUT_MS = 3000;   // 抢不到锁等多久就放弃（要比 TTL 短得多，否则命令会卡住）
const LOCK_RETRY_MS = 25;
// 读侧刷新的节流窗口。刷新要先 statSync 一下文件，单次约 0.03ms 看着不多，但「这个别名
// 还对应哪几首歌」那条路是**按曲库逐首**调 matches 的（QQ 的 #添加别名、闲聊里的 aliasadd
// 能力、Discord 的 /aliasadd 都这么写，一次就是 4000+ 次），每首 stat 一下就是一百多
// 毫秒——实测 4163 次 matches 从 2ms 涨到 104ms，直接把回复盖过了等待窗口。
// 别名文件是人工维护的，读侧晚一个窗口（250ms）看到别的进程的改动毫无影响；写入不受这个
// 窗口约束——transaction 永远先读盘，本进程自己写的东西当场就在 entries 里。
const REFRESH_THROTTLE_MS = 250;

// 同步睡一会儿。store 的调用方全是同步代码，用不了 setTimeout；Atomics.wait 是 Node
// 主线程上唯一像样的同步睡眠。
function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

// 读侧刷新的判据：另一个进程写完之后，本进程内存里的 entries 就是过期的了。
// mtimeMs 是主判据，size 是兜底——时间戳粒度粗的文件系统上，同一毫秒里的两次写
// mtimeMs 一模一样，但一条删一条增时 size 未必相同。
// ⚠ 取值必须在 readFile **之前**：反过来会把并发写入后的新戳配在旧内容上记下来，
// 之后刷新永远看不出变化，等于没刷新。
function fileStamp(filePath) {
  try { const info = fs.statSync(filePath); return info.mtimeMs + ":" + info.size; }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

// 原子写：唯一临时文件 + wx + rename。rename 之前原文件一个字节都不动，失败时清掉
// 临时文件。返回写完之后的文件戳，调用方拿它更新内存里的刷新判据。
function atomicWrite(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = filePath + "." + randomUUID() + ".tmp";
  try {
    fs.writeFileSync(temporary, JSON.stringify(payload, null, 2) + "\n", { flag: "wx" });
    fs.renameSync(temporary, filePath);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
  return fileStamp(filePath);
}

// 锁是 <别名文件>.lock，wx 独占创建，内容 {pid, createdAt}。
// 崩溃残留是最要命的：进程异常退出后锁会永远留在盘上，之后每一次别名写入都失败，
// 现场症状是「别名功能莫名其妙不能用了」——所以过期的锁要能自愈。
// 摘锁用 rename 而不是 unlink：同一个源文件只会有一次 rename 成功，两个进程同时判定
// 它过期时只有一个能把锁文件搬走，另一个拿到 ENOENT 就老实回重试循环，不会两边都以为
// 自己清干净了、然后一起去写。rename 也正是原子写在用的那把手术刀。
function breakStaleLock(lockPath) {
  let raw;
  // 读不到就是别人先放掉了，当作已清干净，直接重抢
  try { raw = fs.readFileSync(lockPath, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return true; throw error; }
  let createdAt = NaN;
  try { createdAt = Number(JSON.parse(raw).createdAt); } catch {}
  // 读不出内容（空文件、半个 JSON、被别的东西占了名字）一律按崩溃残留处理：留着它就是
  // 永久锁死，而临界区只有几毫秒，误删的代价远小于锁死。
  if (Number.isFinite(createdAt) && Date.now() - createdAt <= LOCK_TTL_MS) return false;
  const grave = lockPath + "." + randomUUID() + ".stale";
  try { fs.renameSync(lockPath, grave); }
  catch (error) { if (error.code === "ENOENT") return true; throw error; }
  try { fs.unlinkSync(grave); } catch {}
  return true;
}

function acquireLock(lockPath, token) {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try { fs.writeFileSync(lockPath, token, { flag: "wx" }); return; }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (breakStaleLock(lockPath)) continue;
      if (Date.now() >= deadline) {
        throw Error("别名文件正被另一个进程写入（" + lockPath + "），等待超时。确认没有别的 Bot 在写，可删掉这个 .lock 文件后重试。");
      }
      sleep(LOCK_RETRY_MS);
    }
  }
}

// 放锁前先确认这一把还是自己的：万一它中途被谁当成陈旧锁搬走、别人又新加了一把，直接
// unlink 就等于删掉**别人的**锁，两个进程从此同时写。对不上就什么都不做。
// （读完到 unlink 之间仍有极小的窗口，但比无条件删强得多。）
function releaseLock(lockPath, token) {
  try { if (fs.readFileSync(lockPath, "utf8") !== token) return; } catch { return; }
  try { fs.unlinkSync(lockPath); } catch {}
}

function withLock(filePath, fn) {
  const lockPath = filePath + ".lock";
  const token = JSON.stringify({ pid: process.pid, createdAt: Date.now() });
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  acquireLock(lockPath, token);
  try { return fn(); } finally { releaseLock(lockPath, token); }
}

class SongAliasStore {
  constructor(filePath, normalize, options = {}) {
    this.filePath = filePath;
    this.normalize = normalize;
    // 只给迁移用：把 version 1 的 songId 换回 {title, game}。没有它就只能读 version 2。
    this.resolveSong = typeof options.resolveSong === "function" ? options.resolveSong : null;
    this.entries = [];   // [{alias, title, game, addedBy, addedAt}]
    this.stamp = null;   // 上次读盘时的文件戳，读方法靠它发现别的进程改过文件
    this.checkedAt = 0;  // 上次真的 stat 过的时间，见 REFRESH_THROTTLE_MS
  }
  validateAlias(value) {
    return validateAlias(value);
  }
  // 读盘与写入的唯一形状：所有字段都从原始对象显式挑出来，songId 之类不认识的字段
  // 不会跟着写回去。
  entry(raw) {
    return {
      alias: validateAlias(raw.alias),
      title: String(raw.title || "").trim(),
      game: String(raw.game || "").trim(),
      addedBy: String(raw.addedBy || ""),
      addedAt: String(raw.addedAt || ""),
    };
  }
  load() {
    if (!this.filePath) return;
    const stamp = fileStamp(this.filePath);
    let text;
    try { text = fs.readFileSync(this.filePath, "utf8"); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    try {
      const data = JSON.parse(text);
      if (!Array.isArray(data.entries)) throw Error("格式错误");
      const entries = [];
      for (const raw of data.entries) {
        const migrated = Number(data.version) === 1 || raw.songId !== undefined ? this.migrate(raw) : raw;
        const normalized = this.entry(migrated);
        if (!normalized.title) throw Error("记录缺少曲名");
        entries.push(normalized);
      }
      const seen = new Set();
      for (const item of entries) {
        const key = item.game + "\u0000" + this.normalize(item.title) + "\u0000" + this.normalize(item.alias);
        if (seen.has(key)) throw Error("重复记录");
        seen.add(key);
      }
      this.entries = entries;
      this.stamp = stamp;
      this.checkedAt = Date.now();   // 刚和盘对齐过，不必马上再 stat 一次
    } catch (error) {
      throw Error("歌曲别名文件读取失败，请检查或恢复备份（原文件未修改）：" + error.message);
    }
  }
  // 别的进程写完之后这里要重新读盘——否则本进程会一直拿启动时的旧副本回答，
  // 现场症状是「另一个 Bot 刚加的别名这边查不到」。所有读方法都先过这一道。
  // 带节流：一个窗口内的连续读共用一次 stat，理由见 REFRESH_THROTTLE_MS。
  refresh() {
    if (!this.filePath) return;
    const now = Date.now();
    if (now - this.checkedAt < REFRESH_THROTTLE_MS) return;
    this.checkedAt = now;
    const stamp = fileStamp(this.filePath);
    if (stamp === null || stamp === this.stamp) return;
    this.load();
  }
  // 写入的唯一入口。mutator 拿到的是**刚从盘上读回来的** entries，返回新数组；
  // 返回 null / undefined 表示不改动，那就连盘都不写（判重、没删到东西这类空操作）。
  // 结果用闭包带回给调用方，add / remove 的返回形状一个字都没变。
  transaction(mutator) {
    if (!this.filePath) throw Error("别名文件未配置，无法写入。");
    return withLock(this.filePath, () => {
      this.load();   // 只认盘上的内容，绝不用本进程可能已经过期的 entries
      const next = mutator(this.entries);
      if (!next) return false;
      this.stamp = atomicWrite(this.filePath, { version: VERSION, entries: next });
      this.entries = next;
      return true;
    });
  }
  migrate(raw) {
    const song = this.resolveSong ? this.resolveSong(raw.songId) : null;
    if (!song) throw Error("旧记录里的 songId 在本地曲库里找不到，无法还原曲名");
    return { ...raw, title: song.title, game: song.game };
  }
  // 作用域：通用别名（game 为空）在任何游戏下都成立；游戏专属别名只在自己那款下成立。
  // 请求没给游戏时（比如 #查看别名 这种只认曲名的场合）不按作用域过滤。
  inScope(item, game) { return !item.game || !game || item.game === game; }
  // 只给定数裁决层用：别名 → 正式曲名。模型会照着用户的话写「电管」这种中文简称，
  // 而曲名索引里只有正式曲名，正文里那处的旧定数就核不到。
  // **歧义别名整条丢掉**：同一个叫法落到两首不同的曲子（正是 #别名候选 要人来确认的那种），
  // 拿它去正文里认曲名，会把定数改到另一首歌上。作用域不在这里判——裁决层还会用对话里
  // 点名的游戏去消歧，曲名本身是唯一的就够了。
  titleIndex() {
    this.refresh();
    const byAlias = new Map();
    for (const item of this.entries) {
      const key = this.normalize(item.alias);
      if (!key) continue;
      if (!byAlias.has(key)) byAlias.set(key, []);
      byAlias.get(key).push(item);
    }
    const out = [];
    for (const list of byAlias.values()) {
      const titles = new Set(list.map((item) => this.normalize(item.title)));
      if (titles.size !== 1) continue;
      out.push({ alias: list[0].alias, title: list[0].title, game: list[0].game || "" });
    }
    return out;
  }
  // 过滤规则只有这一处：读方法喂内存（已 refresh），写入判重时喂进来的是刚读回来的
  // 盘上那一份，免得两边各写一套「什么算同一条别名」。
  listIn(entries, title, game) {
    const key = this.normalize(title);
    if (!key) return [];
    return entries.filter((item) => this.normalize(item.title) === key && this.inScope(item, game)).map((item) => item.alias);
  }
  list(title, game = "") {
    this.refresh();
    return this.listIn(this.entries, title, game);
  }
  matches(title, needle, game = "", exact = false) {
    return this.list(title, game).some((alias) => exact ? this.normalize(alias) === needle : this.normalize(alias).includes(needle));
  }
  // 反查候选：这个叫法在作用域内对应的**所有**名字（按曲名去重）。和解析刻意分开——
  // #是什么歌 这类反查是给人看的，候选就该都列出来；而解析（lookup）撞上多个结果
  // 必须什么都不选。两者共用这里的匹配逻辑，规则只有一套。
  names(needle, game = "") {
    this.refresh();
    const key = this.normalize(needle);
    if (!key) return [];
    const by = (exact) => this.entries.filter((item) => exact ? this.normalize(item.alias) === key : this.normalize(item.alias).includes(key));
    let pool = by(true);
    if (!pool.length) pool = by(false);
    if (game) pool = pool.filter((item) => this.inScope(item, game));
    const seen = new Set();
    return pool.filter((item) => {
      const title = this.normalize(item.title);
      if (seen.has(title)) return false;
      seen.add(title);
      return true;
    }).map((item) => ({ title: item.title, game: game || item.game || "", alias: item.alias }));
  }
  // 解析：用户叫法 → {title, game, alias}。0 条＝没收录，多条＝歧义，两种都返回 null，
  // 绝不任选一个——同一首歌在多款游戏里数据互相污染就是从「随手挑一个」开始的。
  lookup(needle, game = "") {
    const pool = this.names(needle, game);
    return pool.length === 1 ? pool[0] : null;
  }
  add(raw) {
    const item = this.entry({ ...raw, addedAt: new Date().toISOString() });
    if (!item.title) throw Error("别名要挂在曲名上。");
    let duplicate = false;
    this.transaction((entries) => {
      // 判重拿盘上的那份来判：本进程内存里可能还没有另一个 Bot 刚加进去的同名别名。
      // 走的仍是 listIn 那一条规则（等价于 matches(..., exact = true)）。
      const key = this.normalize(item.alias);
      duplicate = this.listIn(entries, item.title, item.game).some((alias) => this.normalize(alias) === key);
      return duplicate ? null : [...entries, item];
    });
    return { added: !duplicate, alias: item.alias };
  }
  remove(value, title = "") {
    const alias = validateAlias(value);
    const key = this.normalize(alias), titleKey = this.normalize(title);
    let removed = false;
    this.transaction((entries) => {
      const next = entries.filter((item) => !(this.normalize(item.alias) === key && (!titleKey || this.normalize(item.title) === titleKey)));
      removed = next.length !== entries.length;
      return removed ? next : null;
    });
    return { removed, alias };
  }
}

// 候选别名：Agent 认出来的「用户的叫法 → 正式曲名」，**只记不生效**。它不参与解析，
// 只有人工用 #添加别名 确认后才进正式库。存盘纪律与正式库一致：原子写、读坏不覆盖、
// 别名走同一套校验。上限是为了这个文件不会自己长成垃圾场，到顶后新的候选直接拒收，
// 由 #驳回别名候选 清位。
const MAX_CANDIDATES = 200;
class SongAliasCandidateStore {
  constructor(filePath, normalize) {
    this.filePath = filePath;
    this.normalize = normalize;
    this.entries = [];   // [{alias, title, game, proposedBy, proposedAt, evidence}]
    this.stamp = null;   // 同正式库：读方法靠它发现别的进程改过文件
    this.checkedAt = 0;
  }
  // 判重按「别名 + 曲名」：同一个叫法落到两首不同的曲子会各留一行——那正是复核时要看的
  // 冲突，不该合并掉。
  key(item) { return this.normalize(item.alias) + "\u0000" + this.normalize(item.title); }
  load() {
    if (!this.filePath) return;
    const stamp = fileStamp(this.filePath);
    let text;
    try { text = fs.readFileSync(this.filePath, "utf8"); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    try {
      const data = JSON.parse(text);
      if (data.version !== 1 || !Array.isArray(data.entries)) throw Error("格式错误");
      for (const item of data.entries) {
        if (validateAlias(item.alias) !== item.alias) throw Error("记录格式错误");
        if (typeof item.title !== "string" || !item.title) throw Error("记录格式错误");
      }
      this.entries = data.entries;
      this.stamp = stamp;
      this.checkedAt = Date.now();
    } catch (error) {
      throw Error("别名候选文件读取失败，请检查或恢复备份（原文件未修改）：" + error.message);
    }
  }
  // 同正式库：另一个 Bot 也可能在写这份候选库（两边共用同一个目录、同一个 scope）
  refresh() {
    if (!this.filePath) return;
    const now = Date.now();
    if (now - this.checkedAt < REFRESH_THROTTLE_MS) return;
    this.checkedAt = now;
    const stamp = fileStamp(this.filePath);
    if (stamp === null || stamp === this.stamp) return;
    this.load();
  }
  // 与 SongAliasStore.transaction 同一套：加锁 → 读盘 → 改 → 原子写 → 更新内存。
  // mutator 返回 null 表示不改，连盘都不写。
  transaction(mutator) {
    if (!this.filePath) throw Error("别名文件未配置，无法写入。");
    return withLock(this.filePath, () => {
      this.load();
      const next = mutator(this.entries);
      if (!next) return false;
      this.stamp = atomicWrite(this.filePath, { version: 1, entries: next });
      this.entries = next;
      return true;
    });
  }
  list() { this.refresh(); return this.entries; }
  add(raw) {
    if (!this.filePath) return { added: false, reason: "候选库未配置" };
    let alias;
    try { alias = validateAlias(raw.alias); }
    catch (error) { return { added: false, reason: error.message }; }
    const next = {
      alias, title: String(raw.title || "").trim(), game: String(raw.game || "").trim(),
      proposedBy: String(raw.proposedBy || ""), proposedAt: new Date().toISOString(),
      evidence: String(raw.evidence || "").slice(0, 200),
    };
    if (!next.title) return { added: false, reason: "缺少正式曲名" };
    // 判重和上限都拿盘上的那份来判：本进程内存里可能还没有另一个 Bot 刚提的候选，
    // 不然同一条候选会在两个进程里各记一遍、或者两边都以为还没到上限。
    let rejected = "";
    this.transaction((entries) => {
      if (entries.some((item) => this.key(item) === this.key(next))) { rejected = "已有同样的候选"; return null; }
      if (entries.length >= MAX_CANDIDATES) { rejected = "候选已达上限 " + MAX_CANDIDATES + " 条，请先驳回过期的"; return null; }
      return [...entries, next];
    });
    if (rejected) return { added: false, reason: rejected };
    return { added: true, alias, title: next.title };
  }
  // 定位方式两种都收：列表里的序号（1 起），或别名原样。驳回一条别名下所有候选，
  // 免得同一个叫法在库里留好几行。
  // 序号也按**盘上刚读回来的**那份数——人看到的列表可能已经因为另一个 Bot 写盘而变了，
  // 用过期序号会误删别人的行。
  remove(reference) {
    if (!this.filePath) return { removed: 0 };
    const text = String(reference || "").trim();
    const index = /^\d+$/.test(text) ? (Number(text) - 1) : -1;
    const key = this.normalize(text);
    let doomed = [];
    this.transaction((entries) => {
      const byIndex = index >= 0 && index < entries.length ? entries[index] : null;
      doomed = byIndex ? [byIndex] : entries.filter((item) => this.normalize(item.alias) === key);
      if (!doomed.length) return null;
      const drop = new Set(doomed);
      return entries.filter((item) => !drop.has(item));
    });
    if (!doomed.length) return { removed: 0 };
    return { removed: doomed.length, alias: doomed[0].alias };
  }
}
module.exports = { SongAliasStore, SongAliasCandidateStore, validateAlias };
