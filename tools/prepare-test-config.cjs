"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const target = path.join(root, "mia-chat", "config.local.json");
const marker = path.join(root, ".test-config-created");
const created = [];

if (!fs.existsSync(target)) {
  const source = path.join(root, "mia-chat", "config.example.json");
  const config = JSON.parse(fs.readFileSync(source, "utf8"));
  config.enabled = true;
  config.provider.apiKey = "test-only-not-a-real-key";
  config.limits.userCooldownSeconds = 0;
  fs.writeFileSync(target, JSON.stringify(config, null, 2) + "\n");
  created.push(target);
}

// 1×1 透明 PNG，只用于让表情路径校验和 mock 发送测试在干净克隆中运行。
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "mia-chat", "expressions.json"), "utf8"));
for (const entry of manifest.entries || []) {
  const file = path.resolve(root, "mia-chat", entry.file);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, png);
    created.push(file);
  }
}

if (created.length) fs.writeFileSync(marker, JSON.stringify(created, null, 2) + "\n");
