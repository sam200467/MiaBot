"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const marker = path.join(root, ".test-config-created");
if (fs.existsSync(marker)) {
  const created = JSON.parse(fs.readFileSync(marker, "utf8"));
  for (const file of created) fs.rmSync(file, { force: true });
  fs.rmSync(marker, { force: true });
  const emojiDir = path.join(root, "mia-chat", "emojis");
  try { fs.rmdirSync(emojiDir); } catch { /* 用户自己的素材仍在时保留目录 */ }
}
