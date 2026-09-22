"use strict";
// rinnet-client.cjs 的离线测试。**不打真实服务器**：createClient 接受 fetchImpl，
// 这里全部用按路由分发的假 fetch。真实账号联调不在这层证明（见
// docs/rinnet-data-source-research.md）。
const test = require("node:test");
const assert = require("node:assert/strict");
const rinnet = require("./rinnet-client.cjs");

const BASE = "https://portal.naominet.live/";
const ok = (data) => ({ status: { code: 92001 }, data });
const ACCOUNT = { accessToken: "AT1", refreshToken: "RT1" };
const CARD = { id: 7, extId: 44153, luid: "00000000000000004453", default: true };
const PROFILE = { userName: "リネット玩家", level: 12, playCount: 34, lastPlayDate: "2026-09-21" };

// routes: 键是精确路由（含 query），值是 body 或 (opts) => body/{status, body}。
function fakeServer(routes) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const route = decodeURIComponent(String(url).replace(BASE, ""));
    calls.push({ route, opts });
    const handler = routes[route];
    if (!handler) throw new Error("未 mock 的路由：" + route);
    const result = typeof handler === "function" ? await handler(opts) : handler;
    // 响应信封自己就带 status 字段（业务码），HTTP 状态用 http 键区分。
    const status = result && result.http ? result.http : 200;
    const body = result && Object.hasOwn(result, "body") ? result.body : result;
    return { status, ok: status >= 200 && status < 300, json: async () => body };
  };
  return { fetchImpl, calls };
}
const authed = (opts) => opts.headers?.Authorization === "Bearer " + ACCOUNT.accessToken;

test("诊断日志区分非 JSON 和业务拒绝，且不泄露响应或凭据", async () => {
  const secret = "PRIVATE-CREDENTIAL";
  const html = rinnet.createClient({ fetchImpl: async () => ({
    status: 502, ok: false, headers: { get: () => "text/html; charset=utf-8" },
    json: async () => { throw new Error(secret); },
  }) });
  await assert.rejects(() => html.bind(ACCOUNT, secret), error => {
    assert.equal(rinnet.diagnosticText(error), "code=FORMAT route=api/user/me http=502 business=unknown response=html");
    assert.ok(!JSON.stringify(error).includes(secret));
    return true;
  });
  const rejected = rinnet.createClient({ fetchImpl: fakeServer({
    "api/auth/signin": { status: { code: 34099, message: secret }, data: { password: secret } },
  }).fetchImpl });
  await assert.rejects(() => rejected.login(secret, secret), error => {
    assert.match(rinnet.diagnosticText(error), /route=api\/auth\/signin http=200 business=34099/);
    assert.ok(!JSON.stringify(error).includes(secret));
    return true;
  });
  assert.equal(rinnet.diagnosticText(new Error(secret)), "code=OTHER route=unknown http=unknown business=unknown response=unknown");
});

// 读档案返回非 JSON 实测对应「这张卡还没有音击数据」（网站上同样看不到 Rating 界面）。
// 这句要给用户一条能照做的路，不能只说「没读懂」；前提写在句子里，不替 rinnet 下结论。
test("读档案返回非 JSON 时，说的是卡没有音击数据而不是「没读懂」", async () => {
  const html = rinnet.createClient({ fetchImpl: async () => ({
    status: 500, ok: false, headers: { get: () => "text/html; charset=utf-8" },
    json: async () => { throw new Error("not json"); },
  }) });
  await assert.rejects(() => html.cards(ACCOUNT), error => {
    assert.equal(error.message, "rinnet 返回的数据没读懂，稍后再试一下吧。");
    return true;
  });
  const profile = rinnet.createClient({ fetchImpl: async (url) => {
    const route = decodeURIComponent(String(url).replace(BASE, ""));
    if (route === "api/user/me") return { status: 200, ok: true, json: async () => ok({ cards: [CARD] }) };
    return { status: 500, ok: false, headers: { get: () => "text/html; charset=utf-8" }, json: async () => { throw new Error("not json"); } };
  } });
  await assert.rejects(() => profile.bind(ACCOUNT, "me@example.com"), error => {
    assert.equal(error.code, "FORMAT");
    assert.match(error.message, /如果网站上这张卡也看不到 Rating 界面/);
    assert.match(error.message, /换一张卡/);
    return true;
  });
});

test("选卡失败诊断只记录接口路径，去掉 aimeId 查询参数", async () => {
  const client = rinnet.createClient({ fetchImpl: fakeServer({
    "api/user/me": ok({ cards: [CARD] }),
    "api/game/ongeki/profile?aimeId=44153": { status: { code: 95555 } },
  }).fetchImpl });
  await assert.rejects(() => client.bind(ACCOUNT, "me@example.com"), error => {
    const line = rinnet.diagnosticText(error);
    assert.match(line, /route=api\/game\/ongeki\/profile http=200 business=95555/);
    assert.ok(!line.includes("44153"));
    return true;
  });
});

test("绑定流程将登录失败的脱敏诊断交给日志回调", async () => {
  const { continueRinnetBinding } = require("./qq-official/rinnet-binding.cjs");
  const client = rinnet.createClient({ fetchImpl: fakeServer({
    "api/auth/signin": { status: { code: 34099 } },
  }).fetchImpl });
  const session = { state: "awaitingPassword", email: "private@example.com" };
  const lines = [];
  let ended = false;
  await continueRinnetBinding({ event: { userId: "private-user" }, text: "secret-password",
    session, current: () => session, end: () => { ended = true; }, send: async () => {},
    core: { getRinnetClient: () => client, safeError: error => error.message }, config: {},
    T: { bindVerifying: "verifying", rinnetFailed: text => text }, log: line => lines.push(line) });
  assert.equal(ended, true);
  assert.deepEqual(lines, ["[rinnet-bind-v1] stage=login code=REJECTED route=api/auth/signin http=200 business=34099 response=other"]);
});

test("卡号规范化：去空格和横杠、全角转半角、保留前导零，长度不对就拒", () => {
  assert.equal(rinnet.normalizeCardNumber("0000-0000-0000-0000-4453"), "00000000000000004453");
  assert.equal(rinnet.normalizeCardNumber("００００００００００００００００４４５３"), "00000000000000004453");
  assert.equal(rinnet.normalizeCardNumber(" 00000000000000004453\n"), "00000000000000004453");
  assert.equal(rinnet.normalizeCardNumber("0000000000000004453"), "", "19 位不收");
  assert.equal(rinnet.normalizeCardNumber("0000000000000000445x"), "", "非数字不收");
  assert.equal(rinnet.normalizeCardNumber(""), "");
});

test("findCard：主卡号和关联卡号都能认，别人的卡号不行", () => {
  const cards = [
    { extId: 1, luid: "00000000000000000001" },
    { extId: 2, luid: "00000000000000000002", cardExternalList: [{ luid: "00000000000000000099" }] },
  ];
  assert.equal(rinnet.findCard(cards, "00000000000000000001").extId, 1);
  assert.equal(rinnet.findCard(cards, "0000 0000 0000 0000 0099").extId, 2, "关联卡号指向主卡");
  assert.throws(() => rinnet.findCard(cards, "00000000000000000003"), /不在刚才登录的 rinnet 账号卡包里/);
  assert.throws(() => rinnet.findCard(cards, "123"), /20 位/);
});

test("技术 Rating：分段、加成与大饼口径一致", () => {
  // 与 test-mia-core.cjs 里的大饼样例对齐：14.2 / 1000737 → 基础 15.49，SSS 加成 0.2
  assert.equal(rinnet.technicalRating(14.2, { techScoreMax: 1000737 }), 15499 + 200);
  assert.equal(rinnet.technicalRating(14.2, { techScoreMax: 1000737, isFullBell: true }), 15499 + 200 + 50);
  assert.equal(rinnet.technicalRating(14.2, { techScoreMax: 1000737, isFullCombo: true }), 15499 + 200 + 100);
  assert.equal(rinnet.technicalRating(14.2, { techScoreMax: 1010000, isAllBreak: true }), 16200 + 300 + 350);
  assert.equal(rinnet.technicalRating(14.2, { techScoreMax: 500000 }), 0);
  assert.equal(rinnet.technicalRating(10.0, { techScoreMax: 700000 }), Math.floor(4000 * 200000 / 300000));
});

test("ratingData：B50/N10/P50 归一化，定数取自本地曲库", () => {
  const row = { musicId: 870, level: 3, techScoreMax: 1009000, isAllBreak: true, isFullCombo: true, isFullBell: true, platinumScoreMax: 2000, platinumScoreStar: 4 };
  const data = rinnet.ratingData(ok({ old50: [row], new10: [row], pScore: [row] }));
  const expected = rinnet.technicalRating(14.6, { techScoreMax: 1009000, isAllBreak: true, isFullCombo: true, isFullBell: true });
  assert.equal(data.best_rating_list[0].rating, expected);
  assert.equal(data.best_new_rating_list[0].rating, Math.floor(expected / 5) * 5, "N10 截断到 0.005 的倍数");
  assert.equal(data.p_score_rating_list[0].rating, Math.floor(4 * 14.6 * 14.6 + 1e-9), "P 分按星数×定数²");
  assert.equal(data.best_rating_list[0].song_id, 870);
  assert.equal(data.best_rating_list[0].is_all_break, true);
  assert.equal(data.rating, data.best_rating + data.best_new_rating + data.p_score_rating);
  assert.throws(() => rinnet.ratingData(ok({ old50: [row] })), /新版 B50、N10 和 P50/);
  assert.throws(() => rinnet.ratingData(ok({ old50: [{ ...row, musicId: 99999999 }], new10: [row], pScore: [row] })), /不在本地曲库/);
});

test("成绩行校验：难度、分数区间、目标曲目不符都拒绝出图", () => {
  const rows = rinnet.normalizeScores(ok([{ musicId: 870, level: 10, techScoreMax: 990000 }]));
  assert.deepEqual(rows[0], { musicId: 870, difficulty: 10, techScoreMax: 990000,
    isAllBreak: false, isFullCombo: false, isFullBell: false, platinumScoreMax: 0, platinumScoreStar: 0 });
  assert.throws(() => rinnet.normalizeScores(ok([{ musicId: 870, level: 3, techScoreMax: 1010001 }])), /无法核对的成绩/);
  assert.throws(() => rinnet.normalizeScores(ok([{ musicId: 870, level: 4, techScoreMax: 990000 }])), /无法核对的成绩/, "难度 4 不是合法值");
  assert.throws(() => rinnet.normalizeScores(ok([{ musicId: 871, level: 3, techScoreMax: 990000 }]), 870), /无法核对的成绩/, "单曲快照混入别的歌");
  assert.throws(() => rinnet.normalizeScores(ok({ not: "array" })), /成绩格式变了/);
});

test("登录：密码直通、两步验证分流、凭据不全拒绝", async () => {
  const server = fakeServer({ "api/auth/signin": ok(ACCOUNT) });
  const client = rinnet.createClient({ fetchImpl: server.fetchImpl });
  const direct = await client.login("me@example.com", "pw");
  assert.deepEqual(direct.account, { ...ACCOUNT, tokenType: "Bearer" });
  assert.equal(server.calls[0].opts.method, "POST");
  assert.deepEqual(JSON.parse(server.calls[0].opts.body), { usernameOrEmail: "me@example.com", password: "pw" });

  const totpServer = fakeServer({
    "api/auth/signin": { status: { code: 34014 }, data: { totpToken: "tok-1" } },
    "api/auth/signin/totp": (opts) => {
      const body = JSON.parse(opts.body);
      return body.code === "123456" ? ok(ACCOUNT) : { http: 200, body: { status: { code: 34015 } } };
    },
  });
  const totpClient = rinnet.createClient({ fetchImpl: totpServer.fetchImpl });
  assert.deepEqual(await totpClient.login("me@example.com", "pw"), { totpToken: "tok-1" });
  await assert.rejects(() => totpClient.totp("tok-1", "12345"), /六位数字/, "格式不对不该发请求");
  assert.equal(totpServer.calls.filter((c) => c.route === "api/auth/signin/totp").length, 0);
  await assert.rejects(() => totpClient.totp("tok-1", "000000"), /没对上/);
  assert.deepEqual(await totpClient.totp("tok-1", "123456"), { ...ACCOUNT, tokenType: "Bearer" });

  const broken = rinnet.createClient({ fetchImpl: fakeServer({ "api/auth/signin": ok({ accessToken: "AT" }) }).fetchImpl });
  await assert.rejects(() => broken.login("me@example.com", "pw"), /没有返回完整的登录凭据/);
});

test("绑定：单卡自动选定，多卡报列表，卡号选定后取档案", async () => {
  const oneCard = fakeServer({
    "api/user/me": ok({ cards: [CARD] }),
    "api/game/ongeki/profile?aimeId=44153": ok(PROFILE),
  });
  const client = rinnet.createClient({ fetchImpl: oneCard.fetchImpl });
  const binding = await client.bind(ACCOUNT, "me@example.com");
  assert.equal(binding.dataSource, "rinnet");
  assert.equal(binding.cardNumber, "00000000000000004453");
  assert.equal(binding.aimeId, "44153");
  assert.equal(binding.playerName, "リネット玩家");
  assert.match(binding.sessionId, /^[0-9a-f-]{36}$/);
  assert.ok(oneCard.calls.every((c) => authed(c.opts)), "每个请求都要带登录令牌");

  const other = { id: 9, extId: 99001, luid: "00000000000000009901", default: false };
  const multi = fakeServer({
    "api/user/me": ok({ cards: [CARD, other] }),
    "api/game/ongeki/profile?aimeId=99001": ok({ ...PROFILE, userName: "二号卡玩家" }),
  });
  const multiClient = rinnet.createClient({ fetchImpl: multi.fetchImpl });
  const pending = await multiClient.bind(ACCOUNT, "me@example.com");
  assert.equal(pending.cards.length, 2, "多卡又没给卡号时要交还给用户挑");
  const picked = await multiClient.bind(ACCOUNT, "me@example.com", "00000000000000009901");
  assert.equal(picked.aimeId, "99001");
  assert.equal(picked.playerName, "二号卡玩家");
  await assert.rejects(() => multiClient.bind(ACCOUNT, "me@example.com", "00000000000000005555"), /不在刚才登录/);

  const noCard = rinnet.createClient({ fetchImpl: fakeServer({ "api/user/me": ok({ cards: [] }) }).fetchImpl });
  await assert.rejects(() => noCard.bind(ACCOUNT, "me@example.com"), /还没有卡片/);
});

function snapshotServer(overrides = {}) {
  const exportBody = ok({
    userData: { accessCode: CARD.luid },
    userMusicDetailList: [
      { musicId: 870, level: 3, techScoreMax: 1000737, isFullCombo: true, isFullBell: true },
      { musicId: 99999999, level: 3, techScoreMax: 900000 },
    ],
  });
  return fakeServer({
    "api/user/me": ok({ cards: [CARD] }),
    "api/game/ongeki/profile?aimeId=44153": ok(PROFILE),
    "api/game/ongeki/song/870?aimeId=44153": ok([{ musicId: 870, level: 3, techScoreMax: 1000737 }]),
    "api/game/ongeki/newRating": ok({ old50: [], new10: [], pScore: [] }),
    "api/game/ongeki/export": exportBody,
    ...overrides,
  });
}
const BINDING = { dataSource: "rinnet", userId: "U1", sessionId: "sess-1",
  cardNumber: CARD.luid, aimeId: "44153", account: { ...ACCOUNT, tokenType: "Bearer" } };

test("单曲快照：按绑定卡号的 aimeId 查，不要求默认卡", async () => {
  const nonDefault = { ...CARD, default: false };
  const server = snapshotServer({ "api/user/me": ok({ cards: [nonDefault] }) });
  const client = rinnet.createClient({ fetchImpl: server.fetchImpl });
  const result = await client.snapshot({ ...BINDING }, "song", 870, async () => {});
  assert.equal(result.source, "rinnet");
  assert.equal(result.profile.playerName, "リネット玩家");
  assert.equal(result.song.songNo, 870);
  assert.equal(result.song.scores[0].techScoreMax, 1000737);
  assert.ok(server.calls.some((c) => c.route === "api/game/ongeki/song/870?aimeId=44153"), "必须带绑定卡的 aimeId");
});

test("分表快照：绑定卡不是默认卡时拒绝，默认卡才读 newRating", async () => {
  const badClient = rinnet.createClient({ fetchImpl: snapshotServer({ "api/user/me": ok({ cards: [{ ...CARD, default: false }] }) }).fetchImpl });
  await assert.rejects(() => badClient.snapshot({ ...BINDING }, "chart", null, async () => {}), /设为默认/);

  const server = snapshotServer();
  const client = rinnet.createClient({ fetchImpl: server.fetchImpl });
  const result = await client.snapshot({ ...BINDING }, "chart", null, async () => {});
  assert.deepEqual(result.rating.best_rating_list, []);
  assert.ok(server.calls.some((c) => c.route === "api/game/ongeki/newRating"));
});

test("真实门户约定：新版分表 94001 走旧版提示，94041 提示分表缺失", async () => {
  for (const [business, code] of [[94001, "LEGACY_RATING"], [94041, "NO_RATING"], [95001, "SERVER"]]) {
    const client = rinnet.createClient({ fetchImpl: snapshotServer({
      "api/game/ongeki/newRating": { status: { code: business, message: "PRIVATE" } },
    }).fetchImpl });
    await assert.rejects(() => client.snapshot({ ...BINDING }, "chart", null, async () => {}), error => {
      assert.equal(error.code, code);
      assert.match(rinnet.diagnosticText(error), new RegExp("route=api/game/ongeki/newRating http=200 business=" + business));
      assert.ok(!error.message.includes("PRIVATE"));
      return true;
    });
  }
  const client = rinnet.createClient({ fetchImpl: fakeServer({ "api/user/me": { status: { code: 94001 } } }).fetchImpl });
  await assert.rejects(() => client.cards(ACCOUNT), error => error.code === "REJECTED");
});

// 业务码对照官方前端 StatusCode 枚举（RinNET_frontend/src/lib/models.ts@75861d22）。
// 这些码过去一律报「rinnet 没有接受这次请求」，用户没法分辨密码打错、没同意 EULA
// 还是账号被封 —— 三种完全不同的下一步。
test("账号状态类业务码各自给出可照做的提示，不回显后端原文", async () => {
  const signinCases = [[34011, "CREDENTIALS", /密码/], [34016, "CREDENTIALS", /密码/],
    [34033, "EULA", /用户协议/], [34031, "BANNED", /封禁/]];
  for (const [business, code, pattern] of signinCases) {
    const client = rinnet.createClient({ fetchImpl: fakeServer({
      "api/auth/signin": { status: { code: business, message: "PRIVATE-BACKEND-TEXT" } },
    }).fetchImpl });
    await assert.rejects(() => client.login("me@example.com", "pw"), error => {
      assert.equal(error.code, code, "业务码 " + business);
      assert.match(error.message, pattern);
      assert.match(rinnet.diagnosticText(error), new RegExp("business=" + business));
      assert.ok(!error.message.includes("PRIVATE-BACKEND-TEXT"));
      return true;
    });
  }
  // 34044 出现在读档案那一步：卡在门户里，但游戏侧没有音击档案。
  const noProfile = rinnet.createClient({ fetchImpl: fakeServer({
    "api/user/me": ok({ cards: [CARD] }),
    "api/game/ongeki/profile?aimeId=44153": { status: { code: 34044 } },
  }).fetchImpl });
  await assert.rejects(() => noProfile.bind(ACCOUNT, "me@example.com"), error => {
    assert.equal(error.code, "NO_PROFILE");
    assert.match(error.message, /音击档案/);
    return true;
  });
  // 没登记的码不能再装懂：带上号码，用户才能原样报给维护者。
  const unknown = rinnet.createClient({ fetchImpl: fakeServer({
    "api/auth/signin": { status: { code: 34099, message: "PRIVATE-BACKEND-TEXT" } },
  }).fetchImpl });
  await assert.rejects(() => unknown.login("me@example.com", "pw"), error => {
    assert.equal(error.code, "REJECTED");
    assert.match(error.message, /34099/);
    assert.ok(!error.message.includes("PRIVATE-BACKEND-TEXT"));
    return true;
  });
});

test("全量导出：卡号不一致拒绝，曲库外的记录被丢弃", async () => {
  const client = rinnet.createClient({ fetchImpl: snapshotServer().fetchImpl });
  const result = await client.snapshot({ ...BINDING }, "level", null, async () => {});
  assert.equal(result.records.length, 1, "本地曲库没有的历史记录不进图");
  assert.equal(result.records[0].song_id, 870);
  assert.equal(result.records[0].music.name, "VIIIbit Explorer");

  const mismatched = snapshotServer({
    "api/game/ongeki/export": ok({ userData: { accessCode: "00000000000000009999" }, userMusicDetailList: [] }),
  });
  const badClient = rinnet.createClient({ fetchImpl: mismatched.fetchImpl });
  await assert.rejects(() => badClient.snapshot({ ...BINDING }, "plate", null, async () => {}), /与绑定卡不一致/);
});

test("令牌过期：自动刷新、落盘一次、原请求重试；刷新失败不再重试", async () => {
  const saved = [];
  const refreshBodies = [];
  const server = fakeServer({
    // AT1 已过期，只有 AT2 能读；refresh 只应被调一次，且提交的是旧刷新令牌。
    "api/user/me": (opts) => (opts.headers.Authorization === "Bearer AT2" ? ok({ cards: [CARD] }) : { http: 401, body: {} }),
    "api/auth/refresh": (opts) => {
      refreshBodies.push(JSON.parse(opts.body));
      return ok({ accessToken: "AT2", refreshToken: "RT2" });
    },
    "api/game/ongeki/profile?aimeId=44153": (opts) => (opts.headers.Authorization === "Bearer AT2" ? ok(PROFILE) : { http: 401, body: {} }),
    "api/game/ongeki/song/870?aimeId=44153": (opts) => (opts.headers.Authorization === "Bearer AT2" ? ok([{ musicId: 870, level: 3, techScoreMax: 1 }]) : { http: 401, body: {} }),
  });
  const client = rinnet.createClient({ fetchImpl: server.fetchImpl });
  const binding = { ...BINDING, account: { ...ACCOUNT, tokenType: "Bearer" } };
  await client.snapshot(binding, "song", 870, async (account) => saved.push(account));
  assert.deepEqual(refreshBodies, [{ refreshToken: "RT1" }]);
  assert.equal(saved.length, 1, "新令牌要回写一次");
  assert.equal(saved[0].accessToken, "AT2");
  assert.equal(binding.account.accessToken, "AT2", "后续请求用新令牌");

  const dead = rinnet.createClient({ fetchImpl: fakeServer({
    "api/user/me": { http: 401, body: {} },
    "api/auth/refresh": { status: { code: 94011 } },
  }).fetchImpl });
  await assert.rejects(() => dead.snapshot({ ...BINDING }, "song", 870, async () => { throw new Error("不该落盘"); }), /重新登录|续期/);
});

test("错误映射：429、网络故障、未知拒绝码都转成能念给用户听的话", async () => {
  const limited = rinnet.createClient({ fetchImpl: fakeServer({ "api/user/me": { http: 429, body: {} } }).fetchImpl });
  await assert.rejects(() => limited.cards(ACCOUNT), /太快/);
  const offline = rinnet.createClient({ fetchImpl: async () => { throw new Error("ECONNRESET"); } });
  await assert.rejects(() => offline.cards(ACCOUNT), /没连上/);
  const rejected = rinnet.createClient({ fetchImpl: fakeServer({ "api/user/me": { status: { code: 95555 } } }).fetchImpl });
  await assert.rejects(() => rejected.cards(ACCOUNT), /没有接受这次请求/);
});

test("默认卡在读取途中改变时拒绝返回分表；查询前卡号映射也必须一致", async () => {
  let reads = 0;
  const changed = snapshotServer({ "api/user/me": () => ok({ cards: [{ ...CARD, default: ++reads === 1 }] }) });
  await assert.rejects(() => rinnet.createClient({ fetchImpl: changed.fetchImpl }).snapshot({ ...BINDING }, "chart", null, async () => {}), /设为默认/);
  assert.equal(reads, 2);
  const moved = snapshotServer({ "api/user/me": ok({ cards: [{ ...CARD, extId: 999 }] }) });
  await assert.rejects(() => rinnet.createClient({ fetchImpl: moved.fetchImpl }).snapshot({ ...BINDING }, "song", 870, async () => {}), /对应关系变了/);
  assert.equal(moved.calls.length, 1, "映射不符时不能继续读取成绩");
});
