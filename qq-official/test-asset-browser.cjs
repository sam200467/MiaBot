"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createAssetBrowser, loadIndex, parseCsv, normalize, imageInfo } = require("./asset-browser.cjs");

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

test("临时图片：给出外网地址、按地址取得到；地址猜不到，过期和超量的作废", async () => {
  // 最小的卡面目录，只为让服务起得来
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mia-assets-"));
  fs.mkdirSync(path.join(root, "base-cards", "images"), { recursive: true });
  fs.writeFileSync(path.join(root, "base-cards", "images", "1.png"), "png");
  fs.writeFileSync(path.join(root, "base-cards", "cards.csv"), "id,name,output_file,width,height\n1,卡,images/1.png,10,10\n");
  let clock = 1000;
  const browser = createAssetBrowser({ assetRoot: root, port: 0, publicBaseUrl: "http://203.0.113.5:47831/", sharedMax: 2, sharedTtlMs: 60000, now: () => clock });
  await browser.start();
  const port = browser.port();
  const get = (url) => fetch(url.replace("http://203.0.113.5:47831", "http://127.0.0.1:" + port));
  try {
    const pngData = png(1200, 3400);
    const { url, width, height } = browser.publishImage(pngData);
    assert.match(url, /^http:\/\/203\.0\.113\.5:47831\/shared\/[0-9a-f]{32}\.png$/, "外网地址照 publicBaseUrl 拼");
    assert.deepEqual([width, height], [1200, 3400]);
    const ok = await get(url);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await ok.arrayBuffer()), pngData);

    const jpg = browser.publishImage(jpeg(1440, 2981));
    assert.match(jpg.url, /\.jpg$/, "JPG 照 JPG 给（/等级 出的是 JPG）");
    assert.deepEqual([jpg.width, jpg.height], [1440, 2981]);
    assert.equal((await get(jpg.url)).headers.get("content-type"), "image/jpeg");
    assert.equal(browser.publishImage(Buffer.from("不是图片，不是图片，不是图片")), null, "认不出的不给地址");
    assert.equal((await get(url.replace(/[0-9a-f]{32}/, "0".repeat(32)))).status, 404, "别的地址取不到");

    const second = browser.publishImage(png(1, 1)).url;
    assert.equal((await get(url)).status, 404, "超过上限先丢最旧的");
    clock += 60001;
    assert.equal((await get(second)).status, 404, "过期作废");
  } finally { await browser.stop(); }

  const noBase = createAssetBrowser({ assetRoot: root, port: 0 });
  assert.equal(noBase.publishImage(png(1, 1)), null, "没配 publicBaseUrl 给不出地址");
});

test("图片尺寸：PNG 读 IHDR，JPG 跳过前面的段找到 SOF", () => {
  assert.deepEqual(imageInfo(png(1200, 3400)), { type: "png", mime: "image/png", width: 1200, height: 3400 });
  assert.deepEqual(imageInfo(jpeg(1440, 2981)), { type: "jpg", mime: "image/jpeg", width: 1440, height: 2981 });
  assert.equal(imageInfo(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 4, 0, 0, ...new Array(30).fill(0)])), null, "没有 SOF 的 JPG");
  assert.equal(imageInfo(null), null);
});

// 只有 IHDR 的最小 PNG
function png(width, height) {
  const data = Buffer.alloc(24);
  data.writeUInt32BE(0x89504e47, 0); data.writeUInt32BE(0x0d0a1a0a, 4); data.write("IHDR", 12, "ascii");
  data.writeUInt32BE(width, 16); data.writeUInt32BE(height, 20);
  return data;
}
// 最小的 JPG 头：SOI、一个 APP0 段、SOF0（高在前、宽在后）
function jpeg(width, height) {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.alloc(19);
  sof.writeUInt16BE(0xffc0, 0); sof.writeUInt16BE(17, 2); sof[4] = 8;
  sof.writeUInt16BE(height, 5); sof.writeUInt16BE(width, 7); sof[9] = 3;
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}
