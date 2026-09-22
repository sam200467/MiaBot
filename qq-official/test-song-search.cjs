"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { search, reply } = require("./song-search.cjs");

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
  assert.equal(reply("∀"), "《∀》\nBAS 6 / ADV 9.7 / EXP 13 / MAS 14.9", "搜到就该报难度，而不是要线索");
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
test("单曲只显示曲名和定数，帮助不再宣传条件搜索", () => {
  assert.equal(reply("サド"), "《サドマミホリック》\nBAS 4 / ADV 定数未知 / EXP 11 / MAS 13.5");
  assert.doesNotMatch(reply(""), /开头|紫谱|条件/);
  assert.equal(search("开头:サド").total, 0);
  assert.equal(search("id999999999").total, 0, "不存在的 ID 不应模糊匹配到其他歌曲");
});
