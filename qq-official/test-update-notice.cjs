"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createUpdateNotice } = require("./update-notice.cjs");
const release = { version: "test-v1", date: "2026-10-22", notes: ["修复谱面图"] };
const group = (openid = "G1") => ({ type: "group", openid, msgId: "message-1" });
function setup(t) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-notice-"));
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));
  return { workDir, appId: "test", sandbox: true };
}
test("发布说明版本与核心一致，更新正文不超过 1500 字", () => {
  const published = require("./update-notes.json");
  const source = fs.readFileSync(path.join(__dirname, "../app-template.js"), "utf8");
  assert.equal(published.version, source.match(/const VERSION\s*=\s*"([^"]+)"/)[1]);
  assert.ok(published.notes.length && published.notes.join("\n").length <= 1500);
});
test("主动通知每群一次；失败可被动补发，重启保留成功记录", async t => {
  const config = setup(t), sent = [];
  const notice = createUpdateNotice(config, { release });
  await notice.broadcast(["G1", "G2", "G1"], async (target, text, markdown) => {
    if (target.openid === "G2") throw new Error("无主动消息权限");
    sent.push({ target, text, markdown });
  });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].target, { kind: "group", openid: "G1" });
  assert.match(sent[0].text, /【美亚 更新日志】[\s\S]*test-v1[\s\S]*修复谱面图/);
  assert.ok(sent[0].markdown.startsWith("### **美亚 更新日志**\n"));
  await notice.send(group(), async () => sent.push("unexpected repeat"));
  await notice.send(group("G2"), async () => sent.push("fallback"));
  await createUpdateNotice(config, { release }).broadcast(["G1", "G2"], async () => sent.push("unexpected restart repeat"));
  assert.equal(sent.length, 2);
});
test("并发消息不重复通知；新版本和不同 App 的记录相互独立", async t => {
  const config = setup(t);
  let count = 0;
  const send = async () => { count++; };
  const notice = createUpdateNotice(config, { release });
  await Promise.all([notice.send(group(), send), notice.send(group(), send)]);
  assert.equal(count, 1);
  await createUpdateNotice(config, { release: { ...release, version: "test-v2" } }).send(group(), send);
  await createUpdateNotice({ ...config, appId: "other-app" }, { release }).send(group(), send);
  assert.equal(count, 3);
});
test("私聊、无凭据、按钮回调及没有发布说明的嵌入式调用不发公告", async t => {
  const config = setup(t);
  const notice = createUpdateNotice(config, { release });
  let unexpected = 0;
  const fail = async () => { unexpected++; };
  await notice.send({ ...group(), type: "c2c" }, fail);
  await notice.send({ ...group(), msgId: "" }, fail);
  await notice.send({ ...group(), interactionId: "button" }, fail);
  await createUpdateNotice(config).broadcast(["G1"], fail);
  assert.equal(unexpected, 0);
  await notice.send(group(), async () => { throw new Error("网络中断"); });
  let retried = false;
  await notice.send(group(), async () => { retried = true; });
  assert.ok(retried);
});
