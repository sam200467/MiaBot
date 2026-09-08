#!/usr/bin/env node
"use strict";
/**
 * macOS 版 Takase Discord Bot 多用户凭据库
 *
 * 与 Windows 版 takase-discord-vault.cs 的 CLI 契约逐字节对齐（entry 零改动）：
 *   get    <vaultPath> <userId>  命中 → stdout 输出 entry JSON（无尾换行）exit 0；未命中 → 无输出 exit 4
 *   set    <vaultPath>            从 stdin 读 entry JSON，校验 userId/email/password 非空后 upsert，输出 "OK"
 *   delete <vaultPath> <userId>  幂等删除，输出 "OK"
 *   clear  <vaultPath>           清空全部，输出 "OK"
 *   count  <vaultPath>           输出纯数字
 *   --selftest                   自测（无网络、无弹窗、不碰生产数据）
 * 任何异常：stderr 输出 "VAULT_ERROR:<消息>"，exit 1
 *
 * 存储：
 *   - Keychain generic password：service=TakaseDiscordBotBindingsV1，account=Discord userId，
 *     password 字段 = 该用户完整 entry 的 UTF-8 JSON（每条用户一条 item，无长度限制）
 *   - vaultPath 指向的 JSON 文件仅存 userId 明文索引（用于 count/clear/存在性判断），
 *     真实凭据全部在钥匙串中
 *   - <vaultPath>.lock 原子锁（wx 创建 + 10 秒超时 + 陈旧锁 pid 探活恢复）
 */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");

const SECURITY = "/usr/bin/security";
const SERVICE = "TakaseDiscordBotBindingsV1";
const LOCK_TIMEOUT_MS = 10000;
const RETRY_MS = 200;

/* ------------------------------------------------------------------ */
/* security 命令封装（数组参数，禁止 shell 拼接，密码可能含引号/空格/emoji）   */
/* ------------------------------------------------------------------ */
function sec(args, timeoutMs = 15000) {
  return new Promise((resolve) => {
    execFile(SECURITY, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024, encoding: "utf8" },
      (error, stdout, stderr) => {
        resolve({ code: error ? (error.code || 1) : 0, stdout: String(stdout || ""), stderr: String(stderr || "") });
      });
  });
}

function stripNewline(s) { return s.replace(/\r?\n$/, ""); }

// 未找到不能只信退出码 44（各 macOS 版本不一致），stderr 文本匹配兜底
function isNotFound(result) {
  return result.code === 44 ||
    /could not be found|not found in the keychain|item not found/i.test(result.stderr);
}

async function addItem(service, account, json) {
  const r = await sec(["add-generic-password", "-a", account, "-s", service, "-w", json, "-U"]);
  if (r.code !== 0) throw new Error(stripNewline(r.stderr) || "钥匙串写入失败");
}

async function findItem(service, account) {
  const r = await sec(["find-generic-password", "-a", account, "-s", service, "-w"]);
  if (isNotFound(r)) return null;
  if (r.code !== 0) throw new Error(stripNewline(r.stderr) || "钥匙串读取失败");
  return stripNewline(r.stdout); // -w 输出末尾带换行，去掉与 C# Console.Write 对齐
}

async function deleteItem(service, account) {
  const r = await sec(["delete-generic-password", "-a", account, "-s", service]);
  if (r.code !== 0 && !isNotFound(r)) throw new Error(stripNewline(r.stderr) || "钥匙串删除失败");
}

/* ------------------------------------------------------------------ */
/* 索引文件（vaultPath）                                                */
/* ------------------------------------------------------------------ */
function readIndex(vaultPath) {
  try {
    const list = JSON.parse(fs.readFileSync(vaultPath, "utf8"));
    return Array.isArray(list) ? list.filter((x) => typeof x === "string") : [];
  } catch { return []; }
}

function writeIndex(vaultPath, list) {
  fs.mkdirSync(path.dirname(path.resolve(vaultPath)), { recursive: true });
  const tmp = vaultPath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(list), "utf8");
  fs.renameSync(tmp, vaultPath); // 原子替换
}

/* ------------------------------------------------------------------ */
/* 并发锁                                                              */
/* ------------------------------------------------------------------ */
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function withLock(vaultPath, fn) {
  const lockPath = vaultPath + ".lock";
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let fd = null;
  while (Date.now() < deadline) {
    try {
      fd = fs.openSync(lockPath, "wx");
      fs.writeSync(fd, String(process.pid));
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw new Error("凭据库锁创建失败：" + e.message);
      // 陈旧锁恢复：锁内 pid 已不存在则删除重试
      try {
        const oldPid = parseInt(fs.readFileSync(lockPath, "utf8").trim(), 10);
        if (Number.isInteger(oldPid) && oldPid > 0) {
          try { process.kill(oldPid, 0); }
          catch (err) { if (err.code === "ESRCH") { fs.unlinkSync(lockPath); continue; } }
        }
      } catch { /* 锁文件损坏视为可删除 */ }
      await sleep(RETRY_MS);
    }
  }
  if (!fd) throw new Error("凭据库正忙");
  try { return await fn(); }
  finally {
    try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(lockPath); } catch {}
  }
}

/* ------------------------------------------------------------------ */
/* 命令分发                                                            */
/* ------------------------------------------------------------------ */
async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function run(argv) {
  if (argv[0] === "--selftest") return runSelftest();
  if (argv.length < 2) throw new Error("缺少凭据库命令或路径");
  const [command, vaultPath] = argv;
  return withLock(vaultPath, async () => {
    if (command === "get") {
      if (argv.length !== 3) throw new Error("get 参数无效");
      if (!readIndex(vaultPath).includes(argv[2])) return 4;
      const json = await findItem(SERVICE, argv[2]);
      if (json == null) return 4;
      process.stdout.write(json);
      return 0;
    }
    if (command === "set") {
      const text = (await readStdin()).replace(/^﻿/, "").trim();
      const incoming = text ? JSON.parse(text) : null;
      if (!incoming || typeof incoming !== "object" ||
          !incoming.userId || !incoming.email || !incoming.password) throw new Error("绑定数据不完整");
      // 先写钥匙串成功，再更新索引，保证一致性
      await addItem(SERVICE, String(incoming.userId), JSON.stringify(incoming));
      const list = readIndex(vaultPath);
      if (!list.includes(String(incoming.userId))) list.push(String(incoming.userId));
      writeIndex(vaultPath, list);
      process.stdout.write("OK");
      return 0;
    }
    if (command === "delete") {
      if (argv.length !== 3) throw new Error("delete 参数无效");
      await deleteItem(SERVICE, argv[2]);
      writeIndex(vaultPath, readIndex(vaultPath).filter((id) => id !== argv[2]));
      process.stdout.write("OK");
      return 0;
    }
    if (command === "clear") {
      for (const id of readIndex(vaultPath)) await deleteItem(SERVICE, id);
      writeIndex(vaultPath, []);
      process.stdout.write("OK");
      return 0;
    }
    if (command === "count") {
      process.stdout.write(String(readIndex(vaultPath).length));
      return 0;
    }
    throw new Error("未知凭据库命令");
  });
}

/* ------------------------------------------------------------------ */
/* 自测：独立临时 service，无网络、无弹窗、不碰生产数据                      */
/* ------------------------------------------------------------------ */
async function runSelftest() {
  const svc = "TakaseDiscordBotSelftestV1";
  const account = "u-" + crypto.randomBytes(6).toString("hex");
  const tmpPath = path.join(os.tmpdir(), "takase-vault-selftest-" + crypto.randomBytes(8).toString("hex") + ".json");
  const payload = JSON.stringify({
    userId: account,
    email: "test@example.com",
    password: "密码♪DEMO",
    playerName: "测试玩家",
    boundAt: "2026-08-27T00:00:00.000Z",
  });
  try {
    // 1. Keychain roundtrip
    await addItem(svc, account, payload);
    const got = await findItem(svc, account);
    if (got !== payload) throw new Error("Keychain roundtrip 不一致");
    // 2. 未找到映射（exit 4 路径）
    if ((await findItem(svc, "no-such-" + account)) !== null) throw new Error("未找到映射错误");
    // 3. 索引文件 roundtrip
    writeIndex(tmpPath, [account]);
    if (readIndex(tmpPath).length !== 1) throw new Error("索引写入失败");
    writeIndex(tmpPath, []);
    // 4. 删除后不可见
    await deleteItem(svc, account);
    if ((await findItem(svc, account)) !== null) throw new Error("删除后仍存在");
    console.log("TAKASE_VAULT_SELFTEST_OK");
    return 0;
  } finally {
    try { await deleteItem(svc, account); } catch {}
    try { fs.unlinkSync(tmpPath); } catch {}
    try { fs.unlinkSync(tmpPath + ".lock"); } catch {}
  }
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */
run(process.argv.slice(1)) // SEA 中 argv[0] 是二进制自身
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    process.stderr.write("VAULT_ERROR:" + String(error && error.message ? error.message : error));
    process.exitCode = 1;
  });
