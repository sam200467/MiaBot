"use strict";
// song-jacket.cjs：搜歌、候选、缓存与回退链路的单元测试。
// 网络一律用注入的 fetchImpl 假掉，测试本身不碰公网。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { createSongJacket } = require("./song-jacket.cjs");
const realSearch = require("./song-search.cjs").search;

// 最小合法 PNG：imageType 只认签名 + IHDR，后面内容不重要。
const PNG = (() => {
  const buffer = Buffer.alloc(64, 1);
  Buffer.from("89504e470d0a1a0a", "hex").copy(buffer, 0);
  buffer.write("IHDR", 12, "ascii");
  return buffer;
})();

const JACKET_BASE = "https://example.test/jacket/";
const INDEX_URL = "https://example.test/index.json";
const COVER_BASE = "https://example.test/cover/";

function fakeResponse(buffer, { status = 200, contentType = "image/png" } = {}) {
  return {
    ok: status >= 200 && status < 300, status,
    headers: { get: (key) => (String(key).toLowerCase() === "content-type" ? contentType : null) },
    arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length),
  };
}

// 路由表按 URL 前缀匹配；没安排到的地址直接抛错，让「偷偷联网」在测试里藏不住。
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url) => {
    calls.push(String(url));
    for (const [prefix, responder] of routes) {
      if (!String(url).startsWith(prefix)) continue;
      const value = typeof responder === "function" ? await responder(url) : responder;
      if (value instanceof Error) throw value;
      return value;
    }
    throw new Error("测试里没有安排这个地址：" + url);
  };
  fn.calls = calls;
  return fn;
}

const indexJson = (songs) => fakeResponse(Buffer.from(JSON.stringify({ songs })), { contentType: "application/json" });

function tempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), "song-jacket-test-")); }

const CATALOG_ROW = { meta: { official_id: "500520", name: "VIIIbit Explorer", artist: "Lime", image_url: "d9a711a807c5ab8c.png" } };

function createStub(overrides = {}) {
  return createSongJacket({
    catalogCoverBaseUrl: JACKET_BASE,
    remoteIndexUrl: INDEX_URL,
    coverBaseUrl: COVER_BASE,
    searchImpl: () => ({ matches: [], total: 0 }),
    coreSearchImpl: () => [],
    catalogSongs: [CATALOG_ROW],
    internalSongs: [],
    cacheDir: tempDir(),
    ...overrides,
  });
}

test("空查询和超长查询只提示用法，不随机抽图", async () => {
  const jacket = createStub({ fetchImpl: fakeFetch([]) });
  for (const query of ["", "   ", "x".repeat(101)]) {
    const result = await jacket.lookup(query);
    assert.equal(result.ok, false);
    assert.equal(result.code, "USAGE");
  }
});

test("曲库命中后按曲绘地址取图，并按 URL 哈希写缓存复用", async () => {
  const cacheDir = tempDir();
  const expectedUrl = JACKET_BASE + encodeURIComponent(CATALOG_ROW.meta.image_url);
  const fetchImpl = fakeFetch([[JACKET_BASE, fakeResponse(PNG)]]);
  const jacket = createStub({
    cacheDir,
    searchImpl: () => ({ matches: [CATALOG_ROW], total: 1 }),
    fetchImpl,
  });
  const first = await jacket.lookup("VIIIbit Explorer");
  assert.equal(first.ok, true);
  assert.equal(first.source, "catalog");
  assert.equal(first.song.name, "VIIIbit Explorer");
  assert.equal(first.song.officialId, "500520");
  assert.deepEqual(first.image.buffer, PNG);
  assert.equal(first.image.meta.mime, "image/png");
  assert.doesNotMatch(first.song.name, /[《》]/);
  // 缓存文件名是曲绘 URL 的 sha256，和歌曲 ID 无关 —— 不假设「ID = 文件名」。
  const stem = createHash("sha256").update(expectedUrl).digest("hex");
  assert.ok(fs.existsSync(path.join(cacheDir, stem + ".png")), "下载的曲绘要按 URL 哈希落盘");
  // 第二次即使网络全断也应命中缓存。
  const again = await jacket.lookup("VIIIbit Explorer");
  assert.equal(again.ok, true);
  assert.equal(again.source, "cache");
  assert.equal(fetchImpl.calls.length, 1, "命中缓存后不能再发请求");
});

test("别名命中走的是同一套搜歌：search 给什么就查什么", async () => {
  // 别名库本身是全局状态，测试里不真去改它；用桩模拟「别名已被 search 解析成正式曲名」。
  const jacket = createStub({
    searchImpl: (q) => (q === "八比特" ? { matches: [CATALOG_ROW], total: 1 } : { matches: [], total: 0 }),
    fetchImpl: fakeFetch([[JACKET_BASE, fakeResponse(PNG)]]),
  });
  const result = await jacket.lookup("八比特");
  assert.equal(result.ok, true);
  assert.equal(result.song.name, "VIIIbit Explorer");
});

test("数字 ID 查询命中现有 jacket-cache 的数字命名缓存，完全不联网", async () => {
  // 真实搜歌 + 真实曲库：id870 是 VIIIbit Explorer；缓存沿用渲染核心那套「内部ID.扩展名」。
  const jacketCacheDir = tempDir();
  fs.writeFileSync(path.join(jacketCacheDir, "870.png"), PNG);
  const fetchImpl = fakeFetch([]);
  const jacket = createSongJacket({
    jacketCacheDir, cacheDir: tempDir(), fetchImpl,
    catalogCoverBaseUrl: JACKET_BASE, remoteIndexUrl: INDEX_URL, coverBaseUrl: COVER_BASE,
  });
  const result = await jacket.lookup("id870");
  assert.equal(result.ok, true);
  assert.equal(result.source, "cache");
  assert.equal(result.song.name, "VIIIbit Explorer");
  assert.equal(result.song.internalId, 870);
  assert.equal(fetchImpl.calls.length, 0, "已有本地缓存时不许发任何请求");
});

test("曲库地址取不到时回退 arcade-songs，核对曲名与艺人后取图", async () => {
  const fetchImpl = fakeFetch([
    [JACKET_BASE, fakeResponse(Buffer.from("not found"), { status: 404, contentType: "text/plain" })],
    [INDEX_URL, indexJson([{ title: "VIIIbit Explorer", artist: "Lime", songId: "500520", imageName: "abcd.png" }])],
    [COVER_BASE, fakeResponse(PNG)],
  ]);
  const jacket = createStub({
    searchImpl: () => ({ matches: [CATALOG_ROW], total: 1 }),
    fetchImpl,
  });
  const result = await jacket.lookup("VIIIbit Explorer");
  assert.equal(result.ok, true);
  assert.equal(result.source, "arcade-songs");
  assert.equal(result.song.imageUrl, COVER_BASE + "abcd.png");
  assert.deepEqual(result.image.buffer, PNG);
});

test("本地曲库没有的歌，也能只靠远端曲库找到曲绘", async () => {
  const fetchImpl = fakeFetch([
    [INDEX_URL, indexJson([{ title: "遠い曲", artist: "誰か", songId: "x1", imageName: "far.png" }])],
    [COVER_BASE, fakeResponse(PNG)],
  ]);
  const jacket = createStub({ fetchImpl });
  const result = await jacket.lookup("遠い曲");
  assert.equal(result.ok, true);
  assert.equal(result.source, "arcade-songs");
  assert.equal(result.song.name, "遠い曲");
});

test("重名歌曲先给候选，--选 之后只取选定那首的图", async () => {
  const redoA = { meta: { official_id: "1", name: "Redo", artist: "艺人甲", image_url: "a.png" } };
  const redoB = { meta: { official_id: "2", name: "Redo", artist: "艺人乙", image_url: "b.png" } };
  const fetchImpl = fakeFetch([[JACKET_BASE, fakeResponse(PNG)]]);
  const jacket = createStub({
    searchImpl: () => ({ matches: [redoA, redoB], total: 2 }),
    catalogSongs: [redoA, redoB],
    fetchImpl,
  });
  const ambiguous = await jacket.lookup("Redo");
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.code, "AMBIGUOUS");
  assert.equal(ambiguous.candidates.length, 2);
  assert.equal(ambiguous.candidates[1].selector, "Redo --选 2");
  assert.match(ambiguous.text, /找到多首曲目/);
  assert.doesNotMatch(ambiguous.text, /[《》]/);
  assert.equal(fetchImpl.calls.length, 0, "候选阶段不许取图");

  const picked = await jacket.lookup("Redo --选 2");
  assert.equal(picked.ok, true);
  assert.equal(picked.song.artist, "艺人乙");
  assert.ok(fetchImpl.calls.some((url) => url.endsWith("/b.png")), "选定后要取的是第 2 首的图");
  assert.ok(!fetchImpl.calls.some((url) => url.endsWith("/a.png")));
  // 序号越界和没写序号一样，都回到候选列表。
  const outOfRange = await jacket.lookup("Redo --选 9");
  assert.equal(outOfRange.code, "AMBIGUOUS");
});

test("模糊命中只列相近候选，不直接发图", async () => {
  const jacket = createStub({
    searchImpl: () => ({ matches: [CATALOG_ROW], total: 1, fuzzy: true }),
    fetchImpl: fakeFetch([]),
  });
  const result = await jacket.lookup("VIIIbit Explorr");
  assert.equal(result.ok, false);
  assert.equal(result.code, "FUZZY");
  assert.match(result.text, /相近/);
  assert.equal(result.candidates.length, 1);
});

test("哪里都没有就老实说没找到", async () => {
  const jacket = createStub({ fetchImpl: fakeFetch([[INDEX_URL, indexJson([])]]) });
  const result = await jacket.lookup("不存在的歌");
  assert.equal(result.ok, false);
  assert.equal(result.code, "NOT_FOUND");
  assert.equal(result.image, undefined, "没找到歌不能带图");
});

test("图源和网络全挂时明确报失败，不发占位图", async () => {
  const fetchImpl = fakeFetch([
    [JACKET_BASE, new Error("connect reset")],
    [INDEX_URL, new Error("connect reset")],
  ]);
  const jacket = createStub({
    searchImpl: () => ({ matches: [CATALOG_ROW], total: 1 }),
    fetchImpl,
  });
  const result = await jacket.lookup("VIIIbit Explorer");
  assert.equal(result.ok, false);
  assert.equal(result.code, "FETCH_FAILED");
  assert.equal(result.image, undefined);
});

test("下载到的不是图片时拒绝，并继续走回退而不是把坏图发出去", async () => {
  const fetchImpl = fakeFetch([
    [JACKET_BASE, fakeResponse(Buffer.from("<html>404</html>"), { contentType: "text/html" })],
    [INDEX_URL, indexJson([])],
  ]);
  const jacket = createStub({
    searchImpl: () => ({ matches: [CATALOG_ROW], total: 1 }),
    fetchImpl,
  });
  const result = await jacket.lookup("VIIIbit Explorer");
  assert.equal(result.ok, false);
  assert.equal(result.image, undefined);
});

test("响应头与真实格式不符时以魔数为准（arcade-songs 实测：.png 壳装 JPEG）", async () => {
  const JPEG = (() => { const b = Buffer.alloc(64, 1); b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; return b; })();
  const fetchImpl = fakeFetch([
    [JACKET_BASE, fakeResponse(Buffer.from("gone"), { status: 404, contentType: "text/plain" })],
    [INDEX_URL, indexJson([{ title: "VIIIbit Explorer", artist: "Lime", songId: "500520", imageName: "abcd.png" }])],
    [COVER_BASE, fakeResponse(JPEG, { contentType: "image/png" })],
  ]);
  const jacket = createStub({
    searchImpl: () => ({ matches: [CATALOG_ROW], total: 1 }),
    fetchImpl,
  });
  const result = await jacket.lookup("VIIIbit Explorer");
  assert.equal(result.ok, true);
  assert.equal(result.image.meta.mime, "image/jpeg");
  assert.ok(result.image.name.endsWith(".jpg"), "落盘扩展名要按真实格式，不能按响应头");
});

test("远端同名同艺人有多张图时不乱猜，报无法确定", async () => {
  const row = (songId, imageName) => ({ title: "VIIIbit Explorer", artist: "Lime", songId, imageName });
  const fetchImpl = fakeFetch([
    [JACKET_BASE, fakeResponse(Buffer.from("gone"), { status: 404, contentType: "text/plain" })],
    [INDEX_URL, indexJson([row("500520", "a.png"), row("old-500520", "b.png")])],
  ]);
  const jacket = createStub({
    searchImpl: () => ({ matches: [CATALOG_ROW], total: 1 }),
    fetchImpl,
  });
  const result = await jacket.lookup("VIIIbit Explorer");
  assert.equal(result.ok, false);
  assert.equal(result.code, "AMBIGUOUS");
});

test("缓存路径必须是绝对路径，相对路径直接拒绝", () => {
  assert.throws(() => createSongJacket({ cacheDir: "relative/cache" }), /绝对路径/);
  assert.throws(() => createSongJacket({ jacketCacheDir: "relative/jackets" }), /绝对路径/);
});

test("真实搜歌链路：精确曲名命中本地曲库后取曲库曲绘", async () => {
  const fetchImpl = fakeFetch([[JACKET_BASE, fakeResponse(PNG)]]);
  const jacket = createSongJacket({
    cacheDir: tempDir(), fetchImpl,
    catalogCoverBaseUrl: JACKET_BASE, remoteIndexUrl: INDEX_URL, coverBaseUrl: COVER_BASE,
  });
  const found = realSearch("サド");
  assert.equal(found.total, 1, "前置条件：サド 在曲库里只有一首");
  const result = await jacket.lookup("サド");
  assert.equal(result.ok, true);
  assert.equal(result.song.name, "サドマミホリック");
  assert.ok(fetchImpl.calls.length >= 1);
  assert.ok(fetchImpl.calls[0].startsWith(JACKET_BASE));
});
