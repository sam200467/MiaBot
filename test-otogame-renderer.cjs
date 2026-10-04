"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const Module = require("node:module");

const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mia-otogame-renderer-"));
process.env.ONGEKI_APP_DIR = cacheRoot;
test.after(() => fs.rmSync(cacheRoot, { recursive: true, force: true }));
const file = path.join(__dirname, "app-template.js");
let source = fs.readFileSync(file, "utf8");
const localSong = { id: 870, name: "本地测试曲", const: [1, 5, 10, 14.6, -1] };
const supplementSong = { name: "补充曲库测试曲", EXP: { const: 14.6 } };
for (const [marker, value] of [["SONG_CATALOG", [supplementSong]], ["INTERNAL_SONG_CATALOG", [localSong]], ["SDDT_EXTRAS", {}]]) {
  source = source.replace('"__' + marker + '_JSON__"', () => JSON.stringify(JSON.stringify(value)));
}
const loaded = new Module(file, module);
loaded.filename = file;
loaded.paths = module.paths;
loaded._compile(source.slice(0, source.lastIndexOf("\nmain().catch")) + `
  module.exports = { buildLocalThemeData, collectJacketItems, localizeJackets, fakeRatingJson };
`, file);
const app = loaded.exports;
const hash = "0123456789abcdef0123456789abcdef";
// 此处的定数与成绩是测试数据，不代表“零号車輛”的实际定数。
function row(overrides = {}) {
  return { music: { music_id: hash, name: "曲库外新歌测试", artist: "测试", level_info: { difficulty: 2, level: 17 } },
    difficulty_id: 2, score: 1009000, rating: 14700,
    is_all_break: false, is_full_combo: false, is_full_bell: false,
    platinum_score_star: 4, ...overrides };
}
function build(best = [], newest = [], platinum = []) {
  return app.buildLocalThemeData(JSON.stringify({ data: {
    best_rating_list: best, best_new_rating_list: newest, p_score_rating_list: platinum,
  } }), { playerName: "测试玩家" });
}

test("大饼曲库外歌曲：B50/N10/P50 分别还原定数，曲绘使用服务器哈希", () => {
  const data = build([row()], [row({ rating: 2940 })], [row({ rating: 625 })]);
  for (const item of [data.best[0], data.new[0], data.platinum[0]]) {
    assert.equal(item.constant, 12.5);
    assert.equal(item.songId, null);
    assert.equal(item.jacketCacheKey, "otogame-" + hash);
    assert.equal(item.jacketUrl, `https://oss-hd1.bemanicn.com/SDDT/cover/${hash}.webp-thumbnail`);
  }
  // 单榜也必须能独立推导，不能靠测试里的其它榜来掩盖口径错误。
  assert.equal(build([], [row({ rating: 2940 })]).new[0].constant, 12.5);
  assert.equal(build([], [], [row({ rating: 625 })]).platinum[0].constant, 12.5);
});

test("大饼真实旧快照片段：技术分插值、N10 除五截断、P50 星数平方", () => {
  const best = row({ score: 1003154, rating: 15910, difficulty_id: 3, is_full_bell: true,
    music: { music_id: "df125ffa2e454dd0d602070815405ffc", name: "エンドマークに希望と涙を添えて", level_info: { difficulty: 3, level: 21 } } });
  const newest = row({ score: 1004874, rating: 3084, difficulty_id: 3, is_full_bell: true,
    music: { music_id: "282e98d76018ba738f0f3ad54c58dec6", name: "耐冬花麗", level_info: { difficulty: 3, level: 19 } } });
  const platinum = row({ score: 1008320, rating: 312, platinum_score_star: 2,
    music: { music_id: "d6727b6d5c5512a4b91c905d7ad8d939", name: "Blows Up Everything", level_info: { difficulty: 2, level: 17 } } });
  assert.equal(build([best]).best[0].constant, 14.2);
  assert.equal(build([], [newest]).new[0].constant, 13.6);
  assert.equal(build([], [], [platinum]).platinum[0].constant, 12.5);
});

test("大饼定数：FC/AB/满分/FB 奖励与低分插值", () => {
  for (const input of [
    row({ is_full_combo: true, rating: 14800 }),
    row({ is_all_break: true, is_full_combo: true, is_full_bell: true, rating: 15050 }),
    row({ score: 1010000, is_all_break: true, is_full_combo: true, is_full_bell: true, rating: 15200 }),
    row({ score: 600000, rating: 2166 }),
    row({ score: 990000, rating: 13350 }),
  ]) assert.equal(build([input]).best[0].constant, 12.5);
});

test("大饼末位舍入：严格匹配优先，±1 兜底仍须唯一", () => {
  for (const offset of [-1, 1]) {
    assert.equal(build([row({ rating: 14700 + offset })]).best[0].constant, 12.5);
    assert.equal(build([], [row({ rating: 2940 + offset })]).new[0].constant, 12.5);
    assert.equal(build([], [], [row({ rating: 625 + offset })]).platinum[0].constant, 12.5);
    const data = build([row({ rating: 14700 + offset })], [row({ rating: 2940 - offset })], [row({ rating: 625 + offset })]);
    assert.equal(data.best[0].constant, 12.5);
    assert.equal(data.new[0].constant, 12.5);
    assert.equal(data.platinum[0].constant, 12.5);
  }
  // 星数 1 时：7.1 -> 50，7.2 -> 51，7.3 -> 53。
  // 51 有严格唯一解；52 的容差同时允许 7.2 和 7.3，不能任意选一个。
  const low = row({ rating: 51, platinum_score_star: 1,
    music: { music_id: hash, name: "舍入歧义测试", level_info: { difficulty: 2, level: 7 } } });
  assert.equal(build([], [], [low]).platinum[0].constant, 7.2);
  assert.throws(() => build([], [], [{ ...low, rating: 52 }]), /定数未找到/);
  for (const offset of [-2, 2]) {
    assert.throws(() => build([row({ rating: 14700 + offset })]), /定数未找到/);
    assert.throws(() => build([], [row({ rating: 2940 + offset })]), /定数未找到/);
    assert.throws(() => build([], [], [row({ rating: 625 + offset })]), /定数未找到/);
  }
  assert.throws(() => build([row({ rating: 14701 })], [row({ rating: 2960 })]), /定数未找到/);
});

test("大饼无法唯一确定、等级冲突或榜单冲突时不填猜测值", () => {
  const ambiguous = row({ rating: 1, platinum_score_star: 1,
    music: { music_id: hash, name: "低定数测试", level_info: { difficulty: 2, level: 1 } } });
  assert.throws(() => build([], [], [ambiguous]), /定数未找到/);
  assert.throws(() => build([row({ rating: 14800 })], [], [row({ rating: 625 })]), /定数未找到/);
  assert.throws(() => build([row({ music: { music_id: hash, name: "等级冲突", level_info: { difficulty: 2, level: 19 } } })]), /定数未找到/);
  assert.throws(() => build([row({ music: { music_id: hash, name: "未知等级", level_info: { difficulty: 2, level: 25 } } })]), /定数未找到/);
  assert.throws(() => build([row({ music: { music_id: hash, name: "难度冲突", level_info: { difficulty: 3, level: 17 } } })]), /定数未找到/);
  for (const input of [row({ rating: null }), row({ rating: "" }), row({ rating: true }), row({ score: 1010001 }),
    row({ is_full_bell: undefined }), row({ score: 500000, rating: 0 }), row({ dataSource: "rinnet" })]) {
    assert.throws(() => build([input]), /定数未找到/);
  }
  assert.throws(() => build([], [], [row({ platinum_score_star: 0, rating: 0 })]), /定数未找到/);
});

test("同资源不同难度、同名不同资源不互借定数", () => {
  const lunatic = row({ difficulty_id: 10, rating: 0, music: { music_id: hash, name: "曲库外新歌测试", level_info: { difficulty: 10, level: 17 } } });
  assert.throws(() => build([row()], [], [lunatic]), /lunatic 定数未找到/);
  const other = row({ rating: 0, music: { music_id: "ffffffffffffffffffffffffffffffff", name: "曲库外新歌测试", level_info: { difficulty: 2, level: 17 } } });
  assert.throws(() => build([row()], [], [other]), /定数未找到/);
});

test("大饼三榜一律反推，忽略内部及补充曲库中过旧的定数", () => {
  const local = row({ music_id: 870, difficulty_id: 3,
    music: { music_id: hash, name: localSong.name, level_info: { difficulty: 3, level: 17 } } });
  const data = build([local], [{...local, rating:2940}], [{...local, rating:625}]);
  for (const item of [data.best[0],data.new[0],data.platinum[0]]) {
    assert.equal(item.constant,12.5);
    assert.equal(item.songId,870,"本地歌曲 ID 仍可用于元数据和缓存");
  }
  const supplement = row({music:{music_id:hash,name:supplementSong.name,level_info:{difficulty:2,level:17}}});
  assert.equal(build([supplement]).best[0].constant,12.5);
  for (const input of [local, supplement]) {
    assert.throws(() => build([{...input,rating:null}]),/大饼数据无法唯一反推/);
    assert.throws(() => build([input],[],[{...input,rating:650}]),/大饼数据无法唯一反推/);
    assert.throws(() => build([],[],[{...input,rating:52,platinum_score_star:1,
      music:{...input.music,level_info:{...input.music.level_info,level:7}}}]),/大饼数据无法唯一反推/);
  }
});

test("rinnet 只采用服务器定数，不回退本地也不走大饼反推", () => {
  const local = row({dataSource:"rinnet",music_id:870,difficulty_id:3,rating:null,
    music:{music_id:hash,name:localSong.name,level_info:{difficulty:3,level:17}}});
  assert.throws(()=>build([local]),/缺少有效的 rinnet 服务器定数/);
  assert.equal(build([{...local,chart_constant:14.8,constant_source:"rinnet-server-catalog"}]).best[0].constant,14.8);
  assert.throws(()=>build([{...local,chart_constant:14.8,constant_source:"local"}]),/服务器定数/);
  assert.throws(()=>build([{...local,chart_constant:14.81,constant_source:"rinnet-server-catalog"}]),/服务器定数/);
  const unknown = {...local,song_id:99999999,music_id:99999999,music:{music_id:"99999999",name:"rinnet 新歌"},
    chart_constant:14.8,constant_source:"rinnet-server-catalog"};
  const mapped = build([unknown]).best[0];
  assert.equal(mapped.constant,14.8);
  assert.equal(mapped.songId,null);
  assert.match(mapped.jacketUrl,/^data:image\/svg\+xml;base64,/);
});

test("演示分表的技术 Rating、N10 贡献及白金星数可以独立反推", () => {
  const data = app.buildLocalThemeData(app.fakeRatingJson(),{playerName:"演示测试"});
  assert.deepEqual(data.best.map(item=>item.constant),[14.8,14.5]);
  assert.equal(data.new[0].constant,13.8);
  assert.equal(data.platinum[0].constant,15.7);
});

test("曲库外曲绘：按哈希下载一次，三榜共用缓存，拒绝不安全缓存键", async () => {
  const data = build([row()], [row({ rating: 2940 })], [row({ rating: 625 })]);
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async url => {
    requests.push(url);
    return { ok: true, headers: { get: () => "image/webp" }, arrayBuffer: async () => Buffer.alloc(2048, 7) };
  };
  try {
    await app.localizeJackets(data);
    assert.equal(requests.length, 1);
    assert.match(data.best[0].jacketUrl, /^file:\/\//);
    assert.equal(data.new[0].jacketUrl, data.best[0].jacketUrl);
    assert.equal(data.platinum[0].jacketUrl, data.best[0].jacketUrl);
    assert.ok(fs.existsSync(path.join(cacheRoot, "jacket-cache", `otogame-${hash}.webp`)));
    await app.localizeJackets(build([row()]));
    assert.equal(requests.length, 1);
    assert.equal(app.collectJacketItems({ jacketCacheKey: "otogame-../../escape", jacketUrl: "https://example.com/a" }).length, 0);
  } finally { global.fetch = originalFetch; }
});
