"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { search, reply } = require("./song-search.cjs");
const { botSongId, botChartId } = require("./song-id.cjs");
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

test("纯数字曲名搜得到；照着封面连作者一起抄进来时给候选，短曲名不乱命中", () => {
  // 群里实测：问「2112410403927243233368253215是什么歌」回 0 首。前 22 位是曲名，后面的 253215 是作者，
  // 封面上印在一起；原来整串数字只当 ID 找，曲名本身是数字的歌怎么都搜不到。
  for (const q of ["2112410", "2112410403927243233368"]) {
    const r = search(q);
    assert.deepEqual(r.matches.map(s => s.meta.name), ["2112410403927243233368"], q);
    assert.equal(r.fuzzy, false, q);
  }
  const pasted = search("2112410403927243233368253215");
  assert.deepEqual(pasted.matches.map(s => s.meta.name), ["2112410403927243233368"]);
  assert.equal(pasted.fuzzy, true, "多抄了作者，只能算候选");
  assert.match(reply("2112410403927243233368253215"), /id665   2112410403927243233368[\s\S]*比较接近的候选/);
  assert.deepEqual(search("39").matches.map(s => botSongId(s)).sort((a, b) => a - b), [39, 213], "ID 39 和曲名《39》都列出来");
  assert.equal(search("id39").total, 1, "写了 id 前缀就只认 ID");
  assert.equal(search("Ring of Fortune").total, 0, "长查询里碰巧含着《Ring》不算");
});

test("简体焰能找到标题写作焔的歌，符号曲名仍可检索", () => {
  const result = search("光焰");
  assert.equal(result.total, 1);
  assert.equal(result.matches[0].meta.name, "光焔のラテラルアーク");
  assert.match(reply("光焰"), /id728   光焔のラテラルアーク/);
  assert.equal(search("∀").matches[0].meta.name, "∀");
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
  assert.match(reply("Perfect Shining!!"), /（id8003：LUN 0）/, "特殊的 LUN 0 级不应显示成遗漏定数");
});

test("搜索列表按首数、空行、Bot ID 和曲名排版", () => {
  const blocks = reply("光").split("\n\n");
  assert.equal(blocks[0], "查到 6 首：");
  assert.equal(blocks.length, 7);
  // 《怒槌～光吉猛修一部謎～》只有白谱、公开曲库里没有，是从游戏数据补进来单独成条的。
  assert.deepEqual(blocks.slice(1).map(block => block.split("\n")[0]), [
    "id1145   電光刹歌",
    "id222   光線チューニング",
    "id728   光焔のラテラルアーク",
    "id1136   光の惑星",
    "id8025   怒槌～光吉猛修一部謎～（已删除）",
    "id708   キュアリアス光吉古牌　－祭－",
  ]);
  assert.ok(blocks.slice(1).every(block => block.split("\n").length === 2));
  assert.deepEqual(blocks.slice(1).map(block => block.split("\n")[1]), [
    "BAS 4 / ADV 9 / EXP 11.9 / MAS 13.9",
    "BAS 3 / ADV 6 / EXP 10.7 / MAS 12.8",
    "BAS 5 / ADV 10.4 / EXP 14.2 / MAS 15.3",
    "BAS 3 / ADV 6 / EXP 10.4 / MAS 12.7",
    "LUN 0",
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

test("白谱单列自己的 ID：游戏里白谱是单独一条曲目，跟本曲不同 ID", () => {
  // 群里实测：/搜索歌曲 gate of doom 把 LUN 跟在 id39 后面，照着打 /谱面分析 id39 白 就查不到 ——
  // 白谱在游戏数据里是 id8015。激唱的白谱是 id8021，也是这样被挂在 id56 下面。
  // 白谱跟在绿黄红紫后面，一张一对括号写它自己的 ID（用户定的格式）。
  assert.equal(reply("gate of doom"), "查到 1 首：\n\nid39   Gate of Doom\nBAS 4 / ADV 7.7 / EXP 10.7 / MAS 13.1（id8015：LUN 0）");
  assert.equal(reply("初音ミクの激唱"), "查到 1 首：\n\nid56   初音ミクの激唱\nBAS 4 / ADV 7.7 / EXP 11.3 / MAS 14.2（id8021：LUN 14.2）");
  assert.equal(reply("Perfect Shining!!"), "查到 1 首：\n\nid36   Perfect Shining!!\nBAS 3 / ADV 6 / EXP 8 / MAS 11.5（id8003：LUN 0）（id8091：LUN 13.8）",
    "两张白谱都列：曲库那格按物量认出是 0 级的 8003，曲库漏收的 13+ 那张 8091 从游戏数据补上");
  // 公开曲库里只有白谱的歌，整首的 ID 本来就是白谱的，不用另起一行。
  assert.equal(reply("Red and Blue and Green"), "查到 1 首：\n\nid8051   Red and Blue and Green\nLUN 0");
  // 白谱的 ID 也要搜得到这首歌。
  assert.deepEqual(search("id8015").matches.map(s => s.meta.name), ["Gate of Doom"]);
  assert.deepEqual(search("8021").matches.map(s => s.meta.name), ["初音ミクの激唱"]);
});

test("LUN 0 级一律显示「LUN 0」，不写「无定数」也不写「定数未知」", () => {
  // 曲库给 19 张 0 级白谱里的 18 张记的是「已知定数 0」，《Perfect Shining!!》那张记的却是「定数未知」。
  const zero = catalogSongs.filter(song => song.LUN?.has_chart && String(song.LUN.level) === "0");
  assert.ok(zero.length >= 19);
  for (const song of zero) {
    const text = reply(`id${botChartId(song, "LUN")}`);
    assert.match(text, /LUN 0(）|$)/m, song.meta.name);
    assert.doesNotMatch(text, /无定数|LUN 定数未知/, song.meta.name);
  }
});

test("游戏数据里的每一条都搜得到：曲库漏收的挂在那首歌下面，连歌都没有的整首补上", () => {
  // 公开曲库漏收了 13 张白谱和 86 首已删歌的本曲。用户的要求：搜索要全部囊括进去。
  const internal = require("../ongeki-music-internal.json");
  assert.ok(internal.length >= 1294);
  for (const song of internal) {
    assert.match(reply(`id${song.id}`), new RegExp(`(^|（)id${song.id}[ ：]`, "m"), `${song.id} ${song.name}`);
  }
  // 本曲和白谱都不在曲库里的已删歌，合成一首：本曲领头，白谱单列。
  assert.equal(reply("ジャパリパーク"), "查到 1 首：\n\nid37   ようこそジャパリパークへ（已删除）\nBAS 3 / ADV 6 / EXP 8 / MAS 11.7（id8022：LUN 13.2）");
  // 曲库里只剩白谱（8058）的已删歌，本曲 id25 挂上来领头。
  assert.equal(reply("回レ！雪月花"), "查到 1 首：\n\nid25   回レ！雪月花（已删除）\nBAS 3 / ADV 6 / EXP 8.4 / MAS 11.8（id8058：LUN 14）");
  // 同名不同曲：ユーフィリア那首（id212）单独一条，不会挂到 livetune 那首（id380）下面。
  assert.equal(reply("Hand in Hand"), "查到 2 首：\n\nid380   Hand in Hand\nBAS 2 / ADV 5 / EXP 8.4 / MAS 11.7\n\nid212   Hand in Hand（已删除）\nBAS 2 / ADV 7 / EXP 8.7 / MAS 12.6");
  assert.equal(search("ジャパリパーク").total, 0, "查曲绘用的 search() 照旧只认公开曲库");
  assert.equal(reply("Titania"), "查到 1 首：\n\nid98   Titania\nBAS 5 / ADV 9.7 / EXP 13.2 / MAS 14.9（id8158：LUN 0）");
  assert.equal(reply("No Remorse"), "查到 1 首：\n\nid8001   No Remorse（已删除）\nLUN 14");
  assert.equal(reply("ブリキノダンス"), "查到 1 首：\n\nid150   ブリキノダンス（已删除）\nBAS 2 / ADV 5 / EXP 9 / MAS 11.7（id8067：LUN 13.8）",
    "歌已经标了已删除，白谱那行就不再重复标");
  // 单独成条的只进 /搜索歌曲 的回复：查曲绘拿 search() 去对公开曲库，曲库里没有的要让它走游戏数据那条路。
  assert.equal(search("No Remorse").total, 0);
  assert.equal(search("No Remorse", { uncataloged: true }).total, 1);
  assert.deepEqual(search("id8091").matches.map(s => s.meta.name), ["Perfect Shining!!"], "挂上去的白谱 ID 照样搜得到那首歌");
});

test("换了新条目重新上架的歌只列在线那条，旧的已删除条目不再单独出现", () => {
  // 群里问搜出来的已删除曲是不是都会标出来：会，但 TiamaT:F minor 和 Cogito ergo sum 各多出一条已删除。
  // 公开曲库留着它们 2024 年删掉的旧条目，跟在线那条是同一个游戏 ID，于是同一个 ID 既在线又已删除。
  assert.equal(reply("TiamaT"), "查到 1 首：\n\nid574   TiamaT:F minor\nBAS 5 / ADV 9.7 / EXP 13.1 / MAS 14.8");
  assert.equal(reply("Cogit"), "查到 1 首：\n\nid1003   Cogito ergo sum\nBAS 3 / ADV 9.7 / EXP 13 / MAS 14.5", "旧条目的 MAS 14.7 是旧定数");
  assert.equal(search("id574").total, 1);
  assert.equal(search("id1003").total, 1);
  // 只去掉跟在线条目同一个 ID 的旧条目，别的已删除曲照常列、照常标。
  assert.match(reply("ブリキノダンス"), /id150   ブリキノダンス（已删除）/);
});

test("每张公开曲库的白谱都对得上内部曲库里真有这张谱面的那条", () => {
  const internal = new Map(require("../ongeki-music-internal.json").map(song => [song.id, song]));
  for (const song of catalogSongs.filter(song => song.LUN?.has_chart)) {
    const id = botChartId(song, "LUN");
    assert.ok(Number.isInteger(id), song.meta.name);
    assert.equal(String(internal.get(id).level[4]), String(song.LUN.level), song.meta.name);
  }
  assert.equal(botChartId(catalogSongs.find(song => song.meta.name === "Gate of Doom"), "MAS"), 39, "其他难度照旧是本曲的 ID");
});

test("Markdown 版：「id36 曲名」整段填到「/谱面分析 id36 」，白谱整条填好，绿黄红紫不做链接，提示只在最后一行出现一次", () => {
  const { replyChunks } = require("./song-search.cjs");
  const chunks = replyChunks("Perfect Shining!!", 900);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].text, reply("Perfect Shining!!"), "纯文本补发的内容跟以前逐字一样");
  assert.equal(chunks[0].markdown, [
    "查到 1 首：",
    "",
    '<qqbot-cmd-input text="/谱面分析 id36 " show="id36   Perfect Shining!!" reference="false" />',
    'BAS 3 / ADV 6 / EXP 8 / MAS 11.5<qqbot-cmd-input text="/谱面分析 id8003 白" show="（id8003：LUN 0）" reference="false" /><qqbot-cmd-input text="/谱面分析 id8091 白" show="（id8091：LUN 13.8）" reference="false" />',
    "",
    "（点曲名会填入 /谱面分析 和曲目 ID，再补一个难度字：绿/黄/红/紫；点括号里的白谱，回车即可）",
  ].join("\n"));
  const many = replyChunks("光", 900).map(c => c.markdown).join("\n");
  assert.equal(many.match(/点曲名会填入/g).length, 1, "搜到多首也只提示一次");
  assert.doesNotMatch(reply("光"), /点曲名/, "纯文本没有链接，不写提示");
  assert.match(many, /text="\/谱面分析 id8025 白" show="id8025   怒槌～光吉猛修一部謎～"/, "只有白谱的歌没得挑，直接填白");
});

test("Markdown 版：曲名里有半角引号放不进属性值，照原样显示不做链接；按钮被拒时翻页的下一页也可点", () => {
  const { replyChunks } = require("./song-search.cjs");
  const snow = replyChunks("Snow in", 900).map(c => c.markdown).join("\n");
  assert.match(snow, /Snow in "I love you"/);
  assert.doesNotMatch(snow, /show="id\d+   Snow in/);
  const paged = replyChunks("a", 900).at(-1);
  assert.match(paged.markdownWithoutKeyboard, /<qqbot-cmd-input text="\/搜索歌曲 a --page 2" show="\/搜索歌曲 a --page 2" reference="false" \/>/);
  assert.doesNotMatch(paged.markdown, /--page 2/, "带按钮时正文不再写下一页指令");
  assert.match(paged.markdown, /第 1\/\d+ 页，点下面的按钮翻页/);
});

test("翻页按钮：翻页是回调按钮，页码只填输入框；到头的方向不放按钮；只有一页不带按钮", () => {
  const { replyChunks, search } = require("./song-search.cjs");
  const { pages } = search("a", { uncataloged: true });
  assert.ok(pages >= 3, "测试需要至少三页");
  const rowsOf = query => replyChunks(query, 900).at(-1).keyboard.rows.map(row => row.buttons);
  const buttonsOf = query => rowsOf(query).flat();
  const summary = buttons => buttons.map(b => [b.id, b.action.type, b.action.data]);
  const layout = query => rowsOf(query).map(row => row.map(b => b.id));

  assert.deepEqual(summary(buttonsOf("a")), [
    ["page", 2, "/搜索歌曲 a --page "],
    ["next", 1, "/搜索歌曲 a --page 2"],
    ["last", 1, `/搜索歌曲 a --page ${pages}`],
  ]);
  assert.equal(buttonsOf("a")[0].action.enter, false, "页码只填输入框，页数让用户补");
  assert.equal(buttonsOf("a")[0].render_data.label, `第1/${pages}页`);
  assert.deepEqual(layout("a"), [["page", "next"], ["last"]]);
  assert.deepEqual(layout("a --page 2"), [["prev", "page", "next"], ["first", "last"]], "一行最多三个，窄气泡里也放得下");
  assert.equal(buttonsOf("a --page 2")[0].action.data, "/搜索歌曲 a --page 1");
  assert.deepEqual(layout(`a --page ${pages}`), [["prev", "page"], ["first"]]);
  for (const b of buttonsOf("a --page 2")) assert.equal(b.action.permission.type, 2, "公开曲库，谁都能点");

  const single = replyChunks("Perfect Shining!!", 900);
  assert.ok(single.every(c => !c.keyboard && !c.markdownWithoutKeyboard));
  const split = replyChunks("a", 200);
  assert.ok(split.slice(0, -1).every(c => !c.keyboard), "按钮只跟着最后一块");
  assert.ok(split.at(-1).keyboard);
});

test("Markdown 版按纯文本长度切块，每块的纯文本拼起来就是原来的回复", () => {
  const { replyChunks } = require("./song-search.cjs");
  const chunks = replyChunks("a", 200);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.text.length <= 200, c.text);
  assert.equal(chunks.map(c => c.text).join("\n\n"), reply("a"));
});

test("翻页按钮绑发起人：data 前面带上 openid，拆得回来；没绑的原样", () => {
  const { ownedData, parseOwnedData, pagerKeyboard } = require("./pager-buttons.cjs");
  assert.equal(ownedData("U1abc", "/等级 14+ 2"), "mia:U1abc:/等级 14+ 2");
  assert.deepEqual(parseOwnedData("mia:U1abc:/等级 14+ 2"), { owner: "U1abc", data: "/等级 14+ 2" });
  assert.deepEqual(parseOwnedData("/搜索歌曲 a --page 2"), { owner: null, data: "/搜索歌曲 a --page 2" });
  assert.deepEqual(parseOwnedData("mia:U1:第2页:还有冒号"), { owner: "U1", data: "第2页:还有冒号" });
  const keyboard = pagerKeyboard({ page: 1, pages: 2, jump: (p) => `第${p}页`, owner: "U1" });
  assert.deepEqual(keyboard.rows.map((r) => r.buttons.map((b) => b.action.data)), [["mia:U1:第2页"], ["mia:U1:第2页"]]);
});
