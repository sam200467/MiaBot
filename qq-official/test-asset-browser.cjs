"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadIndex, parseCsv, normalize } = require("./asset-browser.cjs");

// 卡图和表情的导出目录是部署者自己从游戏资源里抽的（见 ASSETS.md），仓库里没有。
// 缺了只跳过下面那条真实数据的断言，CSV 解析那条照跑 —— 否则新克隆上 `npm test` 必红。
const EXPORT_ROOT = path.resolve(__dirname, "../extracted-ongeki-assets");

test("CSV 解析支持逗号、引号和 BOM", () => {
  const rows = parseCsv('\uFEFFid,name,output_file\r\n1,"A, ""B""",images\\full\\1.png\r\n');
  assert.deepEqual(rows, [{ id: "1", name: 'A, "B"', output_file: "images\\full\\1.png" }]);
});

test("真实导出目录可建立完整卡图与真实表情索引", { skip: fs.existsSync(EXPORT_ROOT) ? false : "extracted-ongeki-assets/ 不在本仓库里" }, () => {
  const items = loadIndex(EXPORT_ROOT);
  assert.ok(items.filter((x) => x.kind === "cards").length > 13000);
  assert.equal(items.filter((x) => x.kind === "expressions").length, 390);
  assert.deepEqual(new Set(items.filter((x) => x.kind === "cards").map((x) => x.visual)),
    new Set(["full", "full_small", "character", "character_portrait", "icon", "icon_small"]));
  assert.ok(items.every((x) => x.width > 2 && x.height > 2));
  assert.ok(items.some((x) => x.search.includes(normalize("藍原 椿"))));
  assert.ok(items.every((x) => !x.media.includes("\\")));
  assert.ok(items.filter((x) => x.kind === "expressions").every((x) => /\?v=[a-z0-9]+-[a-z0-9]+$/.test(x.media)));
});
