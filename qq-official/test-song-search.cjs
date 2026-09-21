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
