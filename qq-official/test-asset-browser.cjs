"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { loadIndex, parseCsv, normalize } = require("./asset-browser.cjs");

test("CSV 解析支持逗号、引号和 BOM", () => {
  const rows = parseCsv('\uFEFFid,name,output_file\r\n1,"A, ""B""",images\\full\\1.png\r\n');
  assert.deepEqual(rows, [{ id: "1", name: 'A, "B"', output_file: "images\\full\\1.png" }]);
});

test("真实导出目录可建立完整卡图与真实表情索引", () => {
  const root = path.resolve(__dirname, "../extracted-ongeki-assets");
  const items = loadIndex(root);
  assert.ok(items.filter((x) => x.kind === "cards").length > 13000);
  assert.equal(items.filter((x) => x.kind === "expressions").length, 390);
  assert.deepEqual(new Set(items.filter((x) => x.kind === "cards").map((x) => x.visual)),
    new Set(["full", "full_small", "character", "character_portrait", "icon", "icon_small"]));
  assert.ok(items.every((x) => x.width > 2 && x.height > 2));
  assert.ok(items.some((x) => x.search.includes(normalize("藍原 椿"))));
  assert.ok(items.every((x) => !x.media.includes("\\")));
  assert.ok(items.filter((x) => x.kind === "expressions").every((x) => /\?v=[a-z0-9]+-[a-z0-9]+$/.test(x.media)));
});
