"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const Module = require("node:module");
const { pathToFileURL } = require("node:url");
const { createClient, ratingData, normalizeScores, normalizeProfile } = require("./rinnet-client.cjs");

// 渲染核心按 ONGEKI_APP_DIR 定位曲绘缓存目录。测试必须把它指到临时目录，
// 否则用例会把 .miss 标记写进仓库里那份真缓存。
process.env.ONGEKI_APP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mia-jacket-cache-"));

// 编译 app-template（注入三份曲库 JSON 与主题包），并把它内部要测的函数导出来。
// 渲染函数换成桩：这里测的是数据映射与曲绘缓存，浏览器里的出图另有实机核对。
function compileApp() {
  const file = path.join(__dirname, "app-template.js");
  let source = fs.readFileSync(file, "utf8");
  for (const [marker, name] of [["SONG_CATALOG", "ongeki-song-catalog.json"], ["INTERNAL_SONG_CATALOG", "ongeki-music-internal.json"], ["SDDT_EXTRAS", "ongeki-sddt-extras.json"]]) {
    source = source.replace('"__' + marker + '_JSON__"', () => JSON.stringify(fs.readFileSync(path.join(__dirname, name), "utf8")));
  }
  const platePath = "completion-search/assets/special-plates.json";
  source = source.replace('"__THEME_BUNDLE_JSON__"', () => JSON.stringify({ [platePath]: fs.readFileSync(path.join(__dirname, "themes", platePath)).toString("base64") }));
  const loaded = new Module(file, module); loaded.filename = file; loaded.paths = module.paths;
  loaded._compile(source.slice(0, source.lastIndexOf("\nmain().catch")) + `
    const captured = {};
    loginWithJobCredentials = getRatingData = async () => { throw new Error("不应登录大饼"); };
    renderLocalTheme = async (json, profile) => { captured.chart = buildLocalThemeData(json, profile); return Buffer.from("test"); };
    renderSongDetailTheme = async (song, scores, name) => { captured.song = scores; return Buffer.from("test"); };
    renderCompletionTheme = async data => { captured.plate = data; return Buffer.from("test"); };
    renderLevelScoreTheme = async data => { captured.level = data; return Buffer.from("test"); };
    module.exports = { captured, runJobData, runSongDetailJobData, runCompletionJobData, runLevelScoreJobData, completionVersionSongs, getCompletionPlate,
      collectJacketItems, localizeJackets, findCachedJacket };
  `, file);
  return loaded.exports;
}

test("rinnet 快照贯穿分表、单曲、牌子、等级任务，不回退到大饼登录", async () => {
  const app = compileApp();
  const saveDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-render-data-"));
  try {
    const row = { musicId: 870, level: 3, techScoreMax: 1009000, isAllBreak: true, isFullBell: true, platinumScoreStar: 4 };
    const profile = normalizeProfile({ userName: "RinNET测试玩家", level: 12 });
    const playerData = { source: "rinnet", profile, rating: ratingData({ old50: [row], new10: [row], pScore: [row] }), song: { found: true, songNo: 870, scores: normalizeScores([row]) } };
    await app.runJobData({ saveDir, playerData });
    assert.equal(app.captured.chart.generatorName, "MiaBot · rinnet");
    assert.equal(app.captured.chart.best[0].score, row.techScoreMax);
    assert.ok(app.captured.chart.best[0].jacketUrl);
    await app.runSongDetailJobData({ saveDir, playerData, songId: 870, playerName: profile.playerName });
    assert.equal(app.captured.song.scores[0].techScoreMax, row.techScoreMax);
    let exportedSong = 870;
    const client = createClient({ fetchImpl: async url => ({ ok: true, status: 200, json: async () => String(url).includes("user/me")
      ? { cards: [{ luid: "00000000000000000001", extId: 7, default: true }] }
      : String(url).includes("/profile") ? { userName: profile.playerName }
      : { userMusicDetailList: [{ ...row, musicId: exportedSong }] } }) });
    const exported = async () => (await client.snapshot({ cardNumber: "00000000000000000001", aimeId: "7", account: { accessToken: "fake" } }, "level", null, async () => {})).records;
    playerData.records = await exported();
    await app.runLevelScoreJobData({ saveDir, playerData, level: "14.6" });
    assert.equal(app.captured.level.summary.played, 1);
    assert.equal(app.captured.level.charts[0].songId, 870);
    assert.equal(app.captured.level.charts[0].techScore, 1009000);
    const song = app.completionVersionSongs(app.getCompletionPlate("040100"))[0];
    exportedSong = song.id;
    playerData.records = await exported();
    await app.runCompletionJobData({ saveDir, playerData, plateId: "040100" });
    assert.equal(app.captured.plate.summary.master.allBreak, 1);
    assert.equal(app.captured.plate.summary.master.fullBell, 1);
    assert.equal(app.captured.plate.profile.playerName, profile.playerName);
  } finally { fs.rmSync(saveDir, { recursive: true, force: true }); }
});

// 曲绘是公网图，国内时通时不通。缓存逻辑决定了这件事的代价：
// 命中就用本地文件（不联网），没命中才去下，下不动的记一笔免得次次白等。
test("曲绘缓存：命中走本地文件，拉不动的记一笔并保留公网地址", async () => {
  const app = compileApp();
  const cacheDir = path.join(process.env.ONGEKI_APP_DIR, "jacket-cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  const cached = path.join(cacheDir, "870.webp");
  fs.writeFileSync(cached, Buffer.alloc(4096, 7));
  // 127.0.0.1:9（discard 端口）连不上，失败得很快，用例不会挂在网络上
  const dead = "http://127.0.0.1:9/none.png";
  const data = {
    best: [{ song_id: 870, jacketUrl: "https://norca0721.github.io/otoge-db/ongeki/jacket/aaa.png" }],
    new: [{ songId: 999, jacketUrl: dead }],
    profile: { playerName: "缓存测试", avatarUrl: dead },
  };
  const lines = [];
  const realLog = console.log;
  console.log = (...args) => lines.push(args.join(" "));
  try {
    await app.localizeJackets(data);
  } finally { console.log = realLog; }

  assert.equal(data.best[0].jacketUrl, pathToFileURL(cached).href, "命中缓存要换成 file:// 路径");
  assert.equal(data.new[0].jacketUrl, dead, "下不到就保持公网地址，交给主题降级");
  assert.equal(data.profile.avatarUrl, dead, "头像同理");
  assert.ok(fs.existsSync(path.join(cacheDir, "999.miss")), "拉不动的要留标记");
  assert.match(lines.join("\n"), /命中 1 张/);

  // 第二次：刚失败过的不再重试（否则每张图都要白等一轮超时）
  const second = [];
  console.log = (...args) => second.push(args.join(" "));
  try { await app.localizeJackets({ new: [{ songId: 999, jacketUrl: dead }], profile: { avatarUrl: dead } }); }
  finally { console.log = realLog; }
  assert.match(second.join("\n"), /两小时内不再重试/);

  fs.rmSync(process.env.ONGEKI_APP_DIR, { recursive: true, force: true });
});
