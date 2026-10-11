"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { foldKana, romajiToKana, queryKana } = require("./song-kana.cjs");

test("折叠：平片假名、浊点、小字、长音都抹平，跟官方读音的写法一致", () => {
  assert.equal(foldKana("しゅがーそんぐ"), foldKana("シユカソンク"));
  assert.equal(foldKana("トウキョウ"), foldKana("トキヨ"));
  assert.equal(foldKana("ヴァンパイア"), "ウアンハイア");
  assert.equal(foldKana("千本桜"), "千本桜", "汉字原样留着");
});

test("罗马音：赫本式、训令式都收，拆不干净就不是罗马音", () => {
  assert.equal(romajiToKana("shinbun"), romajiToKana("sinbun"));
  assert.equal(romajiToKana("shimbun"), romajiToKana("shinbun"));
  assert.equal(romajiToKana("kitto"), "キット");
  assert.equal(romajiToKana("kon'ya"), "コンヤ");
  assert.equal(romajiToKana("love"), null);
  assert.equal(romajiToKana("16bit"), null);
});

test("查询词：太短的不比，假名和罗马音折到同一处", () => {
  assert.equal(queryKana("a"), "");
  assert.equal(queryKana("さど"), queryKana("sado"));
  assert.equal(queryKana("Sado"), queryKana("サド"));
});
