"use strict";
// mia-core.cjs 的冒烟测试：确认抽取后各函数行为与抽取前一致。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const core = require("./mia-core.cjs");

// 定数计算：与入口 selftest 里同样的样例
const bands = [
  [1010000, 16.2], [1007500, 15.95], [1000000, 15.45], [990000, 14.95],
  [970000, 14.2], [900000, 10.2], [800000, 8.2], [500000, 0], [499999, 0],
];
for (const [score, expected] of bands) {
  assert.ok(Math.abs(core.calculateBaseRating(14.2, score) - expected) < 1e-9, "Rating 分段 " + score);
}

const example = core.calculateSingleRating(14.2, 1000737, "fb", "none");
assert.equal(example.result, "15.74");
assert.equal(example.text, "基础分 15.49 + 成绩加成 0.2（SSS）+ 铃铛 0.05（FB）+ 连击 0（无）= 15.74");
assert.equal(core.calculateSingleRating(14.2, 1010000, "fb", "ab-plus").result, "16.90");
assert.throws(() => core.calculateSingleRating(14.25, 1000000, "none", "none"), /谱面定数/);

// 理论值锁死两盏灯：AB+ ⇔ 1010000，且 1010000 ⇒ FB。打不出来的组合不许硬算出一个数。
assert.throws(() => core.calculateSingleRating(14.2, 1000000, "fb", "ab-plus"), /AB\+ 只在技术分正好 1010000/, "AB+ 却只有 1000000");
assert.throws(() => core.calculateSingleRating(14.2, 1009990, "fb", "ab-plus"), /AB\+/, "差 10 分（被弹一次）就不是 AB+ 了");
for (const [bell, combo] of [["fb", "ab"], ["fb", "fc"], ["fb", "none"], ["none", "ab-plus"], ["none", "none"]]) {
  assert.throws(() => core.calculateSingleRating(14.2, 1010000, bell, combo), /是理论值/, "1010000 配 " + bell + "/" + combo);
}
// 除此之外不拦：灯和分数的其余约束都看谱面，而且灯和最高分不必出自同一局
assert.equal(core.calculateSingleRating(14.2, 1009990, "fb", "ab").result, "16.84", "被弹一次：AB + FB 照样成立");
assert.equal(core.calculateSingleRating(14.2, 950000, "fb", "none").result, "13.10", "FB 不看判定");
assert.equal(core.calculateSingleRating(14.2, 960000, "none", "ab").result, "13.92", "AB 不看铃铛");

// 推导只补理论值锁死的项，别的缺项原样留 null
assert.deepEqual(core.inferCalculateMarks({ score: 1010000 }), { score: 1010000, bell: "fb", combo: "ab-plus" });
assert.deepEqual(core.inferCalculateMarks({ combo: "ab-plus" }), { score: 1010000, bell: "fb", combo: "ab-plus" });
assert.deepEqual(core.inferCalculateMarks({ score: 1000737, combo: "ab" }), { score: 1000737, bell: null, combo: "ab" });
assert.deepEqual(core.inferCalculateMarks({ score: 1010000, bell: "none" }), { score: 1010000, bell: "none", combo: "ab-plus" },
  "说了的值不改，矛盾留给 calculateMarkConflict 报");
assert.equal(core.calculateMarkConflict(null, "fb", "ab-plus"), "", "分数没说就还判断不了");

// 简繁检索互通
assert.ok(core.searchSongs("愛").length > 0);
assert.deepEqual(core.searchSongs("愛"), core.searchSongs("爱"));
assert.equal(core.searchSongs("id870")[0].id, 870);
assert.deepEqual(core.searchSongs("冬花").map((song) => song.id), [1076], "部分曲名应能定位歌曲");
for (const query of ["光焔", "光焰", "光燄"]) {
  assert.deepEqual(core.searchSongs(query).map((song) => song.id), [728], query + " 应命中同一首歌");
  assert.deepEqual(core.searchChartInfo(query + " master").matches.map((match) => match.song.id), [728],
    query + " 的谱面分析也应命中同一首歌");
}

// 纯数字曲名。群里实测 /单曲 2112410 回「没有找到曲目」：原来整串数字只当 ID 找，
// 《2112410403927243233368》（id665）打曲名永远查不到，《39》（id213）也被 ID 39 挡着。
assert.deepEqual(core.searchSongs("2112410").map((song) => song.id), [665], "数字曲名的片段");
assert.deepEqual(core.searchSongs("2112410403927243233368").map((song) => song.id), [665], "完整的数字曲名");
assert.deepEqual(core.searchSongs("39").map((song) => song.id), [39, 213], "ID 39 和曲名《39》都列出来，让人用 id 挑");
assert.deepEqual(core.searchSongs("id39").map((song) => song.id), [39], "写了 id 前缀就只认 ID");
assert.deepEqual(core.searchSongs("id2112410").map((song) => song.id), [], "id 前缀不退回去找曲名");
assert.deepEqual(core.searchSongs("870").map((song) => song.id), [870], "普通的数字 ID 照旧");
assert.deepEqual(core.searchSongClues("2112410").map((song) => song.id), [665], "/是什么歌 也一样");

// 白谱在游戏数据里是单独一条曲目（8001 起），跟本曲各是各的 ID。群里照着 /搜索歌曲 打
// /谱面分析 id39 白，回「没有找到符合要求的谱面」—— id39 确实没有白谱，白谱是 id8015。
// 两条是独立的，查不到照旧，但要提示该查哪条。
const chartInfo = (query) => {
  const result = core.searchChartInfo(query);
  return { matches: result.matches.map((match) => match.song.id), suggestions: result.suggestions.map((song) => song.id) };
};
assert.deepEqual(chartInfo("id39 白"), { matches: [], suggestions: [8015] }, "拿本曲的 ID 要白谱：不换过去，提示白谱那条");
assert.deepEqual(chartInfo("id56 lunatic"), { matches: [], suggestions: [8021] }, "激唱也一样");
assert.deepEqual(chartInfo("id8015 紫"), { matches: [], suggestions: [39] }, "反过来拿白谱的 ID 要紫谱，提示本曲");
assert.deepEqual(chartInfo("id8015 白"), { matches: [8015], suggestions: [] }, "查到了就不提示");
assert.deepEqual(chartInfo("Gate of Doom 白"), { matches: [8015], suggestions: [] }, "按曲名查本来就查得到");
assert.deepEqual(chartInfo("id36 白"), { matches: [], suggestions: [8003, 8091] }, "《Perfect Shining!!》有两张白谱，两条都提示");
assert.deepEqual(chartInfo("id870 白"), { matches: [], suggestions: [] }, "真没有白谱的不乱提示");

// 自动补全
assert.equal(core.songAutocomplete("song", "id870")[0].value, "id870");
assert.equal(core.songAutocomplete("chartinfo", "id870 紫譜")[0].value, "id870 master");
assert.equal(core.songAutocomplete("chartinfo", "初音ミクの激唱 白谱")[0].value, "id8021 lunatic");
assert.equal(core.songAutocomplete("song", "zzzz_no_such_song").length, 0);

// 格式化：默认保持 Discord 转义不变
const sample = [{ id: 1, name: "a*b", artistName: "c_d" }];
core.configureFormatting();
assert.equal(core.songMatchLines(sample)[0], "id1　a\\*b　— c\\_d", "默认应为 Discord 转义");

// QQ 侧切成恒等转义：不渲染 markdown，不能出现裸反斜杠
const identity = (value) => String(value ?? "");
core.configureFormatting({ escapeText: identity });
assert.equal(core.songMatchLines(sample)[0], "id1　a*b　— c_d", "恒等转义应生效");
assert.equal(core.chartInfoMatchLines([{ song: sample[0], difficultyName: "MASTER" }])[0], "id1　a*b　[MASTER]　— c_d");
core.configureFormatting();
assert.equal(core.songMatchLines(sample)[0], "id1　a\\*b　— c\\_d", "应能切回 Discord 转义");

// 别名作用域校验
assert.throws(() => core.configureAliases({ vaultPath: "x/bindings.dat", aliasScope: "../坏" }), /别名作用域/);

// pngSize
const png = Buffer.alloc(24);
png.writeUInt32BE(0x89504e47, 0);
png.writeUInt32BE(0x0d0a1a0a, 4);
png.write("IHDR", 12, "ascii");
png.writeUInt32BE(1234, 16);
png.writeUInt32BE(56789, 20);
assert.deepEqual(core.pngSize(png), { width: 1234, height: 56789 });
assert.throws(() => core.pngSize(Buffer.alloc(4)), /不完整/);
assert.throws(() => core.pngSize(Buffer.alloc(24)), /不是有效的 PNG/);

// 分片：limit 收紧到 8，保证必然触发切分
const rows = Array.from({ length: 5 }, (_, i) => "行" + i);
assert.deepEqual(core.splitLines("头部", rows, "", 8), ["头部\n行0\n行1", "行2\n行3\n行4"]);
assert.deepEqual(core.splitLines("头部", rows, "", 100), ["头部\n" + rows.join("\n") + "\n"]);
const chunks = core.splitLines("头部", rows, "", 8);
assert.ok(chunks.every((chunk) => chunk.length <= 8));

// 错误脱敏
assert.match(core.safeError(new Error("密码 password=abc123 出错了")), /已隐藏/);
assert.match(core.safeError(new Error("联系 someone@example.com")), /邮箱已隐藏/);
assert.match(core.safeError(new Error("卡号 00000000000000004453 不对")), /卡号已隐藏/);

// 双数据源绑定挑选：两边分别存，按来源各取各的
const dualEntry = {
  userId: "U", dataSource: "rinnet",
  email: "o@example.com", password: "pw", playerName: "大饼玩家",
  rinnet: { email: "r@example.com", playerName: "rinnet玩家", aimeId: "44153",
    cardNumber: "00000000000000004453", sessionId: "s-1", account: { accessToken: "AT", refreshToken: "RT" } },
};
assert.equal(core.selectBinding(dualEntry, "otogame").playerName, "大饼玩家");
assert.equal(core.selectBinding(dualEntry, "otogame").dataSource, "otogame");
assert.equal(core.selectBinding(dualEntry).dataSource, "rinnet", "默认按当前来源挑");
assert.equal(core.selectBinding(dualEntry).aimeId, "44153");
assert.equal(core.selectBinding(dualEntry).userId, "U", "rinnet 绑定要带回 userId 供执行期复核");
assert.equal(core.selectBinding(dualEntry, "rinnet").email, "r@example.com");
assert.equal(core.selectBinding({ userId: "U", email: "o@x", password: "p" }, "rinnet"), null, "没绑 rinnet 就是没绑");
assert.equal(core.selectBinding(null), null);
assert.equal(core.selectBinding({ userId: "U" }), null, "没有邮箱密码的旧条目不算大饼绑定");
assert.equal(core.selectBinding({ email: "o@x", password: "p" }).dataSource, "otogame", "旧格式绑定默认大饼");

// 能力解析：自然语言查分与 #命令 共用的那一层。
// 经由 module.exports 取 getBinding，所以这里替换掉就能完全离线跑。
(async () => {
  const realGetBinding = core.getBinding;
  core.getBinding = async (_config, userId) => (String(userId) === "bound" ? { playerName: "测试玩家" } : null);

  const unbound = await core.resolveCapability({}, "free", "song", "id870");
  assert.equal(unbound.kind, "notice");
  assert.match(unbound.text, /\/bind/);   // 默认是 Discord 说法，每句都带 /bind
  // 同一句提示反复出现会像系统通知，所以提示支持多句说法轮换
  const notices = new Set();
  for (let i = 0; i < 40; i++) notices.add((await core.resolveCapability({}, "free", "song", "id870")).text);
  assert.ok(notices.size >= 2, "未绑定提示应该在多种说法间轮换，实际只有 " + notices.size + " 句");
  assert.throws(() => core.configureCapabilities({ bindNotice: [] }), /不能为空/);
  assert.throws(() => core.configureCapabilities({ bindNotice: ["够意思", "  "] }), /不能为空/);

  const song = await core.resolveCapability({}, "bound", "song", "id870");
  assert.equal(song.kind, "image");
  assert.equal(song.key, "song");
  assert.equal(song.caption, "测试玩家 的单曲全难度成绩：id870 VIIIbit Explorer");
  assert.equal(typeof song.run, "function");

  // 多首与找不到都给候选列表，不给图片
  assert.equal((await core.resolveCapability({}, "bound", "song", "viyella")).kind, "lines");
  const missing = await core.resolveCapability({}, "bound", "song", "zzzz_no_such_song");
  assert.equal(missing.kind, "lines");
  assert.equal(missing.lines.length, 0);

  const plate = await core.resolveCapability({}, "bound", "plate", "闪击");
  assert.equal(plate.kind, "image");
  assert.equal(plate.caption, "测试玩家 的 閃撃（闪击）完成度 · ONGEKI bright MEMORY Act.2");
  assert.match((await core.resolveCapability({}, "bound", "plate", "不存在的牌子")).text, /请选择版本牌子/);

  assert.equal((await core.resolveCapability({}, "free", "chartinfo", "id870 master")).kind, "image");
  assert.equal((await core.resolveCapability({}, "free", "chartinfo", "id870")).kind, "text");
  // 拿本曲的 ID 要白谱：不出图，提示白谱那条，命令照抄就能用、难度沿用用户自己的写法
  const otherEntry = await core.resolveCapability({}, "free", "chartinfo", "id39 白");
  assert.equal(otherEntry.kind, "lines");
  assert.equal(otherEntry.header, "没有找到符合要求的谱面。");
  assert.deepEqual(otherEntry.lines, [
    "是不是其实想查 id8015 的谱面？《Gate of Doom》的白谱单独编号，跟绿黄红紫谱不是同一个 ID。",
    "/chartinfo id8015 白",
  ]);
  assert.deepEqual((await core.resolveCapability({}, "free", "chartinfo", "id870 lunatic")).lines, [], "真没有白谱的照旧只说查不到");

  // 算 Rating 不吃位置，自然语序也认；两种写法必须算出同一个结果
  const positional = await core.resolveCapability({}, "free", "calculate", "14.2 1000737 fb ab");
  const natural = await core.resolveCapability({}, "free", "calculate", "定数14.2，技术分1000737，铃铛fb，连击ab");
  assert.equal(positional.text, "基础分 15.49 + 成绩加成 0.2（SSS）+ 铃铛 0.05（FB）+ 连击 0.3（AB）= 16.04");
  assert.equal(natural.text, positional.text);
  assert.equal((await core.resolveCapability({}, "free", "calculate", "14.2 1000737 fb none")).text,
    "基础分 15.49 + 成绩加成 0.2（SSS）+ 铃铛 0.05（FB）+ 连击 0（无）= 15.74");
  // ab-plus 是帮助文案和语义路由给的写法；曾被 \bab\b 抢先命中、按 AB 少算 0.05
  for (const spelling of ["ab-plus", "abplus", "ab plus", "AB+"]) {
    assert.match((await core.resolveCapability({}, "free", "calculate", "14.2 1010000 fb " + spelling)).text, /连击 0\.35（AB\+）= 16\.90$/, spelling);
  }
  assert.match((await core.resolveCapability({}, "free", "calculate", "定数14.2，技术分1,010,000，铃铛fb，连击ab+")).text, /= 16\.90$/);
  // 理论值自带 FB 和 AB+：只给 1010000、或只给 AB+，都是唯一结果
  const theoretical = "基础分 16.20 + 成绩加成 0.3（SSS+）+ 铃铛 0.05（FB）+ 连击 0.35（AB+）= 16.90";
  for (const query of ["14.2 1010000", "14.2 1010000 fb", "14.2 ab+", "定数 14.2，连击 AB+", "14.2 理论值", "14.2 理論値 fb"]) {
    assert.equal((await core.resolveCapability({}, "free", "calculate", query)).text, theoretical, query);
  }
  // 打不出来的组合要说清哪里不可能，不能硬算（群里实测：/计算 14.2 1000000 fb ab-plus 照样给了 16.05）
  for (const [query, reason] of [
    ["14.2 1000000 fb ab-plus", /AB\+ 只在技术分正好 1010000/],
    ["14.2 1010000 fb none", /是理论值/],
    ["14.2 1010000 none ab-plus", /是理论值/],
    ["14.2 1010000 fb ab", /是理论值/],
    ["14.2 none ab+", /是理论值/],
  ]) {
    const reply = (await core.resolveCapability({}, "free", "calculate", query)).text;
    assert.doesNotMatch(reply, /基础分/, query + " 不该算出 Rating");
    assert.match(reply, reason, query);
  }
  // 只说「这歌我打了 1000737 分」也能算：铃铛和连击按「无」算，结果里明写出来
  assert.equal((await core.resolveCapability({}, "free", "calculate", "14.2 这歌我打了 1000737 分")).text,
    "基础分 15.49 + 成绩加成 0.2（SSS）+ 铃铛 0（无）+ 连击 0（无）= 15.69");
  // 连分数都没有才给用法
  assert.match((await core.resolveCapability({}, "free", "calculate", "怎么算 rating")).text, /定数、技术分/);

  const constant = await core.resolveCapability({}, "free", "constant", "定数表 14.2");
  assert.equal(constant.kind, "image");
  assert.equal(constant.caption, "音击定数表 · 14.2");
  assert.equal((await core.resolveCapability({}, "free", "constant", "abc")).kind, "text");

  const level = await core.resolveCapability({}, "bound", "level", "14+ 第2页");
  assert.equal(level.kind, "image");
  assert.match(level.caption, /第 2 页/);

  // 查别人：取的是对方的数据，对方绑定过就能查（2026-09-22 起不再有单独开关）
  core.getBinding = async (_config, userId) => ({
    me: { playerName: "我自己" },
    closed: { playerName: "小红" },
    open: { playerName: "小明" },
  }[String(userId)] || null);
  assert.match((await core.resolveCapability({}, "me", "song", "id870", () => {}, "nobody")).text, /没绑过|还没绑定过/);
  const others = await core.resolveCapability({}, "me", "song", "id870", () => {}, "open");
  assert.equal(others.kind, "image");
  assert.equal(others.caption, "小明 的单曲全难度成绩：id870 VIIIbit Explorer");
  assert.match((await core.resolveCapability({}, "me", "song", "id870", () => {}, "me")).caption, /我自己/);
  // 不需要绑定的工具（定数表之类）跟 target 无关，不该被对方的状态拦住
  assert.equal((await core.resolveCapability({}, "me", "constant", "14.2", () => {}, "closed")).kind, "image");

  // 图上的数据摘要：聊天模型读不到图，但读得到这些数字 —— 这是「读懂图里是什么」的正路
  assert.equal(
    core.describeImage("song", { meta: { found: true, scores: [{ difficultyId: 3, techScore: 1008123, allBreak: true, fullCombo: true, fullBell: true }] } }, "X 的单曲成绩"),
    "X 的单曲成绩｜MASTER 1008123 AB · FC · FB");
  assert.equal(
    core.describeImage("chart", { meta: { rating: 16.749, counts: { best: 50, new: 10, platinum: 50 }, top: [{ title: "A", techScore: 1003154, allBreak: false, fullBell: true }] } }, "X 的分表"),
    "X 的分表｜RATING 16.749 · 三榜 50/10/50 曲 · 榜首 A 1003154 分 FB");
  assert.equal(core.describeImage("level", { meta: { total: 42, sssPlus: 3, sss: 10 } }, "X 的 LEVEL 14 成绩"),
    "X 的 LEVEL 14 成绩｜ALL 42 · SSS+ 3 · SSS 10");
  assert.equal(core.describeImage("plate", { meta: { summary: { master: { allBreak: 12, fullBell: 3, total: 50 } } } }, "X 的闪击完成度"),
    "X 的闪击完成度｜MASTER AB 12/50 · FB 3/50");
  assert.equal(core.describeImage("chartinfo", { meta: { difficulty: "MASTER", constant: 14.2, noteCount: 1234 } }, "谱面分析"),
    "谱面分析｜MASTER · 定数 14.2 · 音符 1234");
  // 没有摘要、摘要是空的、或该曲没记录，都只是退回原说明，不能抛
  assert.equal(core.describeImage("song", null, "X 的成绩"), "X 的成绩");
  assert.equal(core.describeImage("song", { meta: {} }, "X 的成绩"), "X 的成绩");
  assert.equal(core.describeImage("song", { meta: { found: false, scores: [] } }, "X 的成绩"), "X 的成绩｜没有该曲目的游玩记录");

  // 模型偶尔会编工具名：不能穿透到取数逻辑
  assert.equal((await core.resolveCapability({}, "free", "全部成绩", "")).kind, "notice");
  // 未绑定的能力不会去碰 vault 之外的东西
  core.getBinding = realGetBinding;

  core.configureCapabilities({ helpText: "自定义清单" });
  assert.equal((await core.resolveCapability({}, "free", "help", "")).text, "自定义清单");
  assert.throws(() => core.configureCapabilities({ helpText: " " }), /不能为空/);
  core.configureCapabilities({ helpText: core.CAPABILITY_SPECS.length + " 项功能" });

  // ── 别名 / 状态 / 隐私开关（闲聊路径新增的几条）────────────────────
  // 这几样以前只有 #命令 走得到。现在闲聊也要能解析，所以用**真实的存储**跑 ——
  // 免得出现「模型跟用户说加好了、其实一个字没写进去」这种从回复上完全看不出的错。
  const { SongAliasStore } = require("./song-alias-store.cjs");
  const aliasDir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-alias-"));
  core.setAliasStore(new SongAliasStore(path.join(aliasDir, "aliases.json"), core.normalizeSongQuery));
  const run = (name, query) => core.resolveCapability({}, "free", name, query, () => {}, null);

  // 两个参数靠空格分开；模型漏了别名要给用法，不能自己瞎猜哪半是曲名
  assert.match((await run("aliasadd", "八爪鱼")).text, /空格/);
  assert.match((await run("aliasadd", "id870 八爪鱼")).text, /^已添加别名：八爪鱼 → id870/);
  assert.equal(core.getAliasStore().list("VIIIbit Explorer", "ongeki").includes("八爪鱼"), true, "别名要真的落进存储");
  // 曲名自己带空格时，程序要按曲库认出完整曲名，而不是把第一个词当曲名
  assert.match((await run("aliasadd", "VIIIbit Explorer 八比特")).text, /^已添加别名：八比特 → id870/);
  // 重复添加不算错，但不能谎报「已添加」
  assert.match((await run("aliasadd", "id870 八爪鱼")).text, /^这首歌已有该别名/);
  // 旧竖线写法继续兼容
  assert.match((await run("aliasadd", "id870 | 旧写法")).text, /^已添加别名：旧写法 → id870/);
  // 存储层的校验错误要透出来，不能吞掉
  assert.match((await run("aliasadd", "id870 870")).text, /纯数字/);

  assert.match((await run("aliases", "id870")).lines.join("\n"), /八爪鱼/);
  assert.match((await run("whatis", "八爪鱼")).lines.join("\n"), /id870/);
  assert.match((await run("whatis", "冬花")).lines.join("\n"), /id1076/, "是什么歌应支持部分正式曲名");
  assert.match((await run("whatis", "光焰")).lines.join("\n"), /id728/, "是什么歌应支持焔/焰异体字");
  const whatisMulti = await run("whatis", "光");
  assert.match(whatisMulti.lines.join("\n"), /id222/);
  assert.match(whatisMulti.lines.join("\n"), /id728/, "多个曲名命中时应列出候选");
  assert.match((await run("whatis", "查无此别名")).header, /没有找到/);
  assert.match((await run("aliases", "zzz查无此曲")).header, /没有找到/);

  // 删除别名**不是**闲聊能力：它只认白名单里的那一个账号，而且只走 #删除别名 命令。
  // 模型连这个工具名都看不到，所以任何人都不可能用 @消息 删掉别名。
  assert.equal(core.CAPABILITY_SPECS.some((spec) => spec.name === "aliasdelete"), false,
    "aliasdelete 一旦进清单，闲聊就等于开了一个绕开白名单的删别名入口");
  assert.equal((await run("aliasdelete", "id870 八爪鱼")).kind, "notice");
  assert.deepEqual(core.getAliasStore().list("VIIIbit Explorer", "ongeki"), ["八爪鱼", "八比特", "旧写法"], "被拒的删除不能动存储");

  // ── 别名 → 正式曲名（聊天侧曲库查询的前置解析）────────────────────
  // 宿主曲库是 ongeki-music-internal.json 的小 id，聊天侧是 chat-core 的水鱼编号，
  // 两套 id 空间实测零重叠，所以衔接点只能是**曲名**。
  const resolved = core.resolveAliasTitle("八爪鱼");
  assert.equal(resolved.title, "VIIIbit Explorer", "别名映射到正式曲名，不绑 songId");
  assert.equal(resolved.game, "ongeki", "作用域要跟着返回，聊天侧才知道该去哪个曲库查");
  assert.equal(core.resolveAliasTitle("查无此别名"), null, "没收录的写法不能编一个曲名出来");

  // ── 候选别名库：只记不生效 ────────────────────────────────────────
  const { SongAliasCandidateStore } = require("./song-alias-store.cjs");
  const candidateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mia-candidate-")), "candidates.json");
  const candidates = new SongAliasCandidateStore(candidateFile, core.normalizeSongQuery);
  core.setAliasCandidateStore(candidates);
  assert.equal(candidates.add({ alias: "电管", title: "Dengeki Tube", game: "chunithm", proposedBy: "10002" }).added, true);
  assert.equal(candidates.add({ alias: "电管", title: "Dengeki Tube" }).added, false, "同一条候选不该重复落盘");
  assert.equal(candidates.add({ alias: "870", title: "X" }).added, false, "别名校验要和正式库同一套规则");
  assert.equal(candidates.add({ alias: "别的叫法" }).added, false, "没有正式曲名的候选不记");
  // 候选**不进解析链**：没经人工确认之前，它只是给人看的一行字
  assert.equal(core.resolveAliasTitle("电管"), null, "候选确认前不能参与解析");
  assert.equal(core.getAliasStore().list("VIIIbit Explorer", "ongeki").includes("电管"), false, "候选不能悄悄写进正式库");
  // 落盘要真的写文件，重启后才是同一条候选
  const reloaded = new SongAliasCandidateStore(candidateFile, core.normalizeSongQuery);
  reloaded.load();
  assert.equal(reloaded.list().length, 1);
  // 驳回：序号和别名两种定位都收，同一个别名下的多行一起清
  assert.equal(reloaded.remove("2").removed, 0, "越界序号不该误删");
  assert.equal(reloaded.remove("1").removed, 1);
  assert.equal(reloaded.list().length, 0);

  // status 的 argHint 里那句「寒暄时不要调用」是护栏：删掉它，模型会把「在吗」
  // 当成问运行状态，回一串运维数据，比人设答一句「好得很」差得多。
  assert.match(core.CAPABILITY_SPECS.find((spec) => spec.name === "status").argHint, /寒暄/);

  // 状态：宿主没注册提供者时当作没开放，注册后原样返回宿主那段文本
  core.setStatusProvider(null);
  assert.equal((await run("status", "")).kind, "notice");
  core.setStatusProvider(() => "NapCat：已连接");
  assert.equal((await run("status", "")).text, "NapCat：已连接");
  assert.throws(() => core.setStatusProvider("不是函数"), /必须是函数/);
  core.setStatusProvider(null);

  // 绑定：只回引导，绝不返回任何要用户填凭据的形状
  const bind = await run("bind", "");
  assert.equal(bind.kind, "notice");
  assert.match(bind.text, /bind/i);

  console.log("CORE_SMOKE_OK 导出项 " + Object.keys(core).length + " 个");
})().catch((error) => { console.error(error); process.exitCode = 1; });
