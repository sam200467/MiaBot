"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { search, reply } = require("./song-search.cjs");
const { botSongId } = require("./song-id.cjs");
const { songs: catalogSongs } = require("../ongeki-song-catalog.json");

test("查询、假名归一化和拼写纠错", () => {
  for (const q of ["サド", "さど", "ｻﾄﾞ"]) {
    const r = search(q);
    assert.equal(r.total, 1);
    assert.equal(r.matches[0].meta.name, "サドマミホリック");
    assert.equal(r.matches[0].MAS.const, 13.5);
    assert.equal(r.fuzzy, false);
  }
  assert.equal(search("サドマミホリツク").fuzzy, true);
  assert.match(reply("サドマミホリツク"), /比较接近/);
});
test("曲名里的符号不被抹掉：整条就是符号的曲名也搜得到自己", () => {
  // 曲名《∀》整条就是一个符号，归一化时若把 \p{S} 一起删掉就只剩空串 ——
  // 查询词抹成空串会被判成「没给线索」，于是这首歌谁也搜不到。
  const exact = search("∀");
  assert.equal(exact.total, 1);
  assert.equal(exact.matches[0].meta.name, "∀");
  assert.equal(reply("∀"), "查到 1 首：\n\nid1070   ∀\nBAS 6 / ADV 9.7 / EXP 13 / MAS 14.9", "搜到就该报 Bot ID 和难度，而不是要线索");
  // 符号在查询词里也一样：不许再判成空线索
  assert.ok(search("☆").total > 1, "含 ☆ 的曲名要能一次搜出来");
  assert.doesNotMatch(reply("☆"), /给我一点曲名线索/);
  // 曲库里没有 ∇，要老实说没找到，而不是反过来问用户要线索
  assert.equal(search("∇").total, 0);
  assert.match(reply("∇"), /没有找到/);
});

test("去掉符号仍能搜到：用户通常不会照着打「!」「☆」", () => {
  // 保留符号那一级只解决「整条都是符号」；少打符号的写法还得靠第二级兜底。
  for (const [query, title] of [
    ["ウキウキCandy", "ウキウキ☆Candy!"],
    ["ポジティブダンスタイム", "ポジティブ☆ダンスタイム"],
    ["ネコ", "ネ！コ！"],
  ]) {
    const r = search(query);
    assert.equal(r.total, 1, `${query} 应该搜到 1 首`);
    assert.equal(r.matches[0].meta.name, title);
  }
  // 这首还有三个 -某某ソロver.-，所以只断言正式版在其中
  const histories = search("ヒストリーブレイカー");
  assert.ok(histories.matches.some(m => m.meta.name === "ヒストリー×ブレイカー"), "× 少打了也要搜到");
});

test("分页完整且没有重复，不把不合法页静默替换", () => {
  const first = search("a");
  assert.ok(first.total > 8);
  const names = [];
  // The snapshot includes same-name songs and reused IDs for deleted songs.
  for (let p = 1; p <= first.pages; p++) names.push(...search(`a --page ${p}`).matches.map(s => `${s.meta.official_id}:${s.meta.name}`));
  assert.equal(names.length, first.total);
  assert.equal(new Set(names).size, first.total);
  assert.match(reply("a"), /下一页/);
  assert.match(reply("a --page 999"), /只有/);
  assert.match(reply(""), /搜索歌曲/);
  assert.match(reply("zzzzzzzzzzzzzzzz"), /没有找到/);
});
test("单曲显示 Bot ID、曲名和定数，帮助不再宣传条件搜索", () => {
  assert.equal(reply("サド"), "查到 1 首：\n\nid252   サドマミホリック\nBAS 4 / ADV 7.4 / EXP 11 / MAS 13.5");
  assert.doesNotMatch(reply(""), /开头|紫谱|条件/);
  assert.equal(search("开头:サド").total, 0);
  assert.equal(search("id999999999").total, 0, "不存在的 ID 不应模糊匹配到其他歌曲");
  assert.equal(search("id728").matches[0].meta.name, "光焔のラテラルアーク");
  assert.equal(search("id380").matches[0].meta.name, "Hand in Hand");
  assert.equal(search("id212").total, 0, "同名但不在公共曲库的 ID 不应错指到另一首歌");
  assert.match(reply("Perfect Shining!!"), /LUN 无定数/, "特殊的 LUN 0 级不应显示成遗漏定数");
});

test("搜索列表按首数、空行、Bot ID 和曲名排版", () => {
  const blocks = reply("光").split("\n\n");
  assert.equal(blocks[0], "查到 5 首：");
  assert.equal(blocks.length, 6);
  assert.deepEqual(blocks.slice(1).map(block => block.split("\n")[0]), [
    "id1145   電光刹歌",
    "id222   光線チューニング",
    "id728   光焔のラテラルアーク",
    "id1136   光の惑星",
    "id708   キュアリアス光吉古牌　－祭－",
  ]);
  assert.ok(blocks.slice(1).every(block => block.split("\n").length === 2));
  assert.deepEqual(blocks.slice(1).map(block => block.split("\n")[1]), [
    "BAS 4 / ADV 9 / EXP 11.9 / MAS 13.9",
    "BAS 3 / ADV 6 / EXP 10.7 / MAS 12.8",
    "BAS 5 / ADV 10.4 / EXP 14.2 / MAS 15.3",
    "BAS 3 / ADV 6 / EXP 10.4 / MAS 12.7",
    "BAS 2 / ADV 7.7 / EXP 10.4 / MAS 13.5",
  ]);
});

test("官方曲目 ID 与 Bot ID 分开映射，同名和 LUNATIC 不串曲", () => {
  assert.ok(catalogSongs.every(song => Number.isInteger(botSongId(song)) && botSongId(song) <= 9999));
  const byOfficialId = id => catalogSongs.find(song => song.meta.official_id === id);
  assert.equal(botSongId(byOfficialId("601129")), 728);
  assert.equal(botSongId(byOfficialId("500130")), 35);
  assert.equal(botSongId(byOfficialId("910112")), 8057);
  assert.equal(botSongId(byOfficialId("200761")), 380);
  assert.equal(botSongId(byOfficialId("668300")), 1003);
});
