"use strict";
const fs = require("node:fs");
const path = require("node:path");

// 发布说明随入口打包；成功记录放在 workDir，更新程序不会覆盖它。
// 主动消息权限不足时，等该群的下一条普通消息或 @ 消息补发。
function createUpdateNotice(config, { release, log = () => {} } = {}) {
  const noop = { send: async () => {}, broadcast: async () => {} };
  if (!config.workDir || !release?.version) return noop;
  const id = `${config.appId || ""}:${Boolean(config.sandbox)}:${release.version}`;
  const file = path.join(config.workDir, "update-notices.json");
  let sent = new Set();
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    if (saved.id === id && Array.isArray(saved.groups)) sent = new Set(saved.groups.map(String));
  } catch (error) {
    if (error.code !== "ENOENT") log("⚠ 读取更新通知记录失败：" + error.message);
  }
  const busy = new Set();
  const text = ["【美亚 更新日志】", "更新完成，美亚已重新上线喵♪", "",
    "版本：" + release.version + (release.date ? "（" + release.date + "）" : ""), "",
    ...(Array.isArray(release.notes) && release.notes.length
      ? release.notes.map(note => "· " + note) : ["· 程序已更新至最新安装包。"]),
  ].join("\n");
  const markdown = text.replace("【美亚 更新日志】", "### **美亚 更新日志**");
  async function deliver(group, send) {
    if (sent.has(group) || busy.has(group)) return;
    busy.add(group);
    try {
      await send(text, markdown);
      sent.add(group);
      fs.mkdirSync(config.workDir, { recursive: true });
      fs.writeFileSync(file + ".tmp", JSON.stringify({ id, groups: [...sent] }) + "\n");
      fs.renameSync(file + ".tmp", file);
      log("更新日志已发送（群 " + group.slice(0, 8) + "…）");
    } catch (error) {
      log("⚠ 更新日志发送或保存失败：" + error.message + (error.code ? "（错误码 " + error.code + "）" : "") +
        "；未发送成功的群等待下条可回复消息补发。主动发送需开启群内「机器人主动在群聊内发言」并具备平台权限。");
    } finally { busy.delete(group); }
  }
  return {
    async send(event, send) {
      if (event.type !== "group" || !event.msgId || event.interactionId) return;
      await deliver(String(event.openid), (text, markdown) => send(event, text, markdown));
    },
    async broadcast(groups, send) {
      for (const group of new Set(groups.map(String))) {
        await deliver(group, (text, markdown) => send({ kind: "group", openid: group }, text, markdown));
      }
    },
  };
}
module.exports = { createUpdateNotice };
