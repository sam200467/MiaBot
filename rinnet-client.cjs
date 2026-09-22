"use strict";
// RinNET portal adapter. Only the documented login flow and read-only game
// endpoints are used. Never relay backend messages (which may contain secrets).
const { randomUUID } = require("node:crypto");
const { fetch: httpFetch, ProxyAgent } = require("undici");
const songs = require("./ongeki-music-internal.json");
const byId = new Map(songs.map(song => [Number(song.id), song]));
const BASE = "https://portal.naominet.live/";
const OK = 92001;

class RinnetError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
function fail(code, message) { throw new RinnetError(code, message); }
// Allowlisted metadata only: never serialize URLs, headers, bodies or messages.
function diagnosticText(error) {
  const d = error instanceof RinnetError ? error.diagnostic : null;
  const codes = new Set(["NETWORK", "RATE_LIMIT", "FORMAT", "AUTH", "HTTP", "REJECTED", "TOTP_INVALID", "TOTP_LOCKED", "NO_PROFILE", "NO_CARD", "CARD_NOT_OWNED", "CARD_FORMAT", "LEGACY_RATING", "NO_RATING", "CATALOG", "DEFAULT_CARD", "CARD_CHANGED", "CREDENTIALS", "BANNED", "EULA", "SERVER"]);
  const routes = new Set(["api/auth/signin", "api/auth/signin/totp", "api/auth/refresh", "api/user/me", "api/game/ongeki/profile", "api/game/ongeki/newRating", "api/game/ongeki/export", "api/game/ongeki/song/:id"]);
  return "code=" + (error instanceof RinnetError && codes.has(error.code) ? error.code : "OTHER") +
    " route=" + (routes.has(d?.route) ? d.route : "unknown") +
    " http=" + (Number.isInteger(d?.http) ? d.http : "unknown") +
    " business=" + (Number.isInteger(d?.business) ? d.business : "unknown") +
    " response=" + (["json", "html", "other"].includes(d?.response) ? d.response : "unknown");
}
function normalizeCardNumber(input) {
  const value = String(input || "").normalize("NFKC").replace(/[\s-]/g, "");
  return /^\d{20}$/.test(value) ? value : "";
}
function validAccount(account) {
  return account && typeof account.accessToken === "string" && account.accessToken.length > 0 &&
    typeof account.refreshToken === "string" && account.refreshToken.length > 0;
}
function accountData(account) {
  if (!validAccount(account)) fail("FORMAT", "rinnet 没有返回完整的登录凭据，请重新 /绑定。");
  return { accessToken: account.accessToken, refreshToken: account.refreshToken, tokenType: "Bearer" };
}
// RinNET 门户业务码 → 用户该做什么。对照官方前端 StatusCode 枚举
// （RinNET_frontend/src/lib/models.ts@75861d22）；FATAL 只是给日志和分支看的。
// 这几个码过去一律报「没有接受这次请求」，用户没法分辨是密码打错、没同意 EULA，
// 还是账号被封 —— 明明是三种完全不同的下一步。
const BUSINESS_FAILURES = new Map([
  [34011, ["CREDENTIALS", "rinnet 说邮箱或密码不对，请核对后再发 /绑定。"]],
  [34016, ["CREDENTIALS", "rinnet 说密码不对，请核对后再发 /绑定。"]],
  [34031, ["BANNED", "这个 rinnet 账号被封禁了，美亚读不到它的数据。"]],
  [34032, ["BANNED", "这个 rinnet 账号被封禁了，美亚读不到它的数据。"]],
  [34033, ["EULA", "rinnet 要求先同意用户协议：在 portal.naominet.live 登录一次并同意 EULA，再回来 /绑定。"]],
  [34093, ["EULA", "rinnet 说同意的协议版本不对，请在 portal.naominet.live 重新确认一次 EULA。"]],
  [34044, ["NO_PROFILE", "这张卡还没有可读取的音击档案，请先在 rinnet 网站确认。"]],
  [95001, ["SERVER", "rinnet 服务器自己出错了，不是你的操作问题，过一会儿再叫美亚试一次。"]],
]);
function unwrap(body) {
  if (body?.status) {
    const code = body.status.code;
    if (code !== OK) {
      if (code === 94011) fail("AUTH", "rinnet 登录已失效，请发 /绑定 重新登录。");
      if (code === 34015) fail("TOTP_INVALID", "验证码没对上，换验证器里当前的六位数字再试一下吧。");
      if (code === 34292) fail("TOTP_LOCKED", "验证码试得太多啦，稍后再发 /绑定 重新来过吧。");
      const known = BUSINESS_FAILURES.get(code);
      if (known) fail(known[0], known[1]);
      fail("REJECTED", "rinnet 没有接受这次请求" +
        (Number.isInteger(code) ? "（业务码 " + code + "）" : "") + "，美亚这边暂时看不出原因，麻烦把这个号码告诉维护者。");
    }
    return body.data;
  }
  return body;
}
function cardsFrom(body) {
  const user = unwrap(body);
  if (!Array.isArray(user?.cards)) fail("FORMAT", "rinnet 的卡包格式变了，这次没法确认是哪张卡。");
  return user.cards.filter(card => Number.isSafeInteger(Number(card.extId)) && Number(card.extId) > 0 && normalizeCardNumber(card.luid));
}
function findCard(cards, number) {
  const code = normalizeCardNumber(number);
  if (!code) fail("CARD_FORMAT", "卡号要是完整的 20 位数字哦。");
  const card = cards.find(c => normalizeCardNumber(c.luid) === code ||
    c.cardExternalList?.some(alias => normalizeCardNumber(alias.luid) === code));
  if (!card) fail("CARD_NOT_OWNED", "这个卡号不在刚才登录的 rinnet 账号卡包里，请检查后再发一次。");
  return card;
}
function normalizeProfile(raw) {
  const p = unwrap(raw);
  if (!p || typeof p.userName !== "string" || !p.userName.trim()) fail("NO_PROFILE", "这张卡还没有可读取的音击档案，请先在 rinnet 网站确认。");
  return { playerName: p.userName, level: Number(p.level) || 0,
    playCount: Number(p.playCount) || 0, lastPlayTime: String(p.lastPlayDate || ""),
    avatarUrl: "", dataSource: "rinnet" };
}
function normalizeScores(raw, expectedSongId) {
  const rows = unwrap(raw);
  if (!Array.isArray(rows)) fail("FORMAT", "rinnet 的成绩格式变了，美亚这次先不出图，免得报错成绩。");
  return rows.map(row => {
    const musicId = Number(row.musicId ?? expectedSongId);
    const difficulty = Number(row.level);
    const score = Number(row.techScoreMax);
    if (!Number.isSafeInteger(musicId) || musicId <= 0 ||
        (expectedSongId != null && musicId !== Number(expectedSongId)) ||
        ![0, 1, 2, 3, 10].includes(difficulty) || row.techScoreMax == null ||
        !Number.isInteger(score) || score < 0 || score > 1010000) {
      fail("FORMAT", "rinnet 返回了无法核对的成绩，这次先不出图啦。");
    }
    const boolean = value => value === true || value === 1;
    return { musicId, difficulty, techScoreMax: score,
      isAllBreak: boolean(row.isAllBreak ?? row.isAllBreake),
      isFullCombo: boolean(row.isFullCombo), isFullBell: boolean(row.isFullBell),
      platinumScoreMax: Number(row.platinumScoreMax) || 0,
      platinumScoreStar: Math.min(5, Math.max(0, Number(row.platinumScoreStar) || 0)) };
  });
}
function recordRow(score) {
  const song = byId.get(score.musicId);
  // Completion/level charts are defined by the local catalog; historical or
  // removed records outside it cannot match a chart and are not displayed.
  if (!song) return null;
  return { song_id: score.musicId, music: { name: song.name, artist: song.artistName },
    levelInfo: { difficulty: score.difficulty }, score: { ...score } };
}
// Integer thousandths; N10 is truncated to multiples of .005 by RinNET.
function technicalRating(constant, item) {
  const c = Math.round(constant * 1000), s = item.techScoreMax;
  const bands = [[800000, -6000], [900000, -4000], [970000, 0], [990000, 750], [1000000, 1250], [1007500, 1750], [1010000, 2000]];
  if (s <= 800000) return Math.max(0, Math.floor((c - 6000) * (s - 500000) / 300000));
  const hi = bands.findIndex(([target]) => s <= target);
  const [loScore, loBonus] = bands[hi - 1], [hiScore, hiBonus] = bands[hi];
  const rankBonus = s >= 1007500 ? 300 : s >= 1000000 ? 200 : s >= 990000 ? 100 : 0;
  const combo = item.isAllBreak ? (s >= 1010000 ? 350 : 300) : item.isFullCombo ? 100 : 0;
  return Math.max(0, c + loBonus + Math.floor((hiBonus - loBonus) * (s - loScore) / (hiScore - loScore)) + rankBonus + combo + (item.isFullBell ? 50 : 0));
}
function ratingData(raw) {
  const value = unwrap(raw);
  if (!value || !Array.isArray(value.old50) || !Array.isArray(value.new10) || !Array.isArray(value.pScore)) fail("FORMAT", "rinnet 没有返回新版 B50、N10 和 P50 数据，请在网站确认音击版本。");
  function list(rows, kind, max) {
    if (rows.length > max) fail("FORMAT", "rinnet 的分表数量与预期不一致，这次先不出图啦。");
    return normalizeScores(rows).map(item => {
      const song = byId.get(item.musicId), pos = item.difficulty === 10 ? 4 : item.difficulty;
      const constant = Number(song?.const?.[pos]);
      if (!song || !(constant > 0)) fail("CATALOG", "这份 rinnet 分表的谱面定数还不在本地曲库里，需要更新曲库后再查。");
      let rating = technicalRating(constant, item);
      if (kind === "new") rating = Math.floor(rating / 5) * 5;
      if (kind === "platinum") rating = Math.floor(item.platinumScoreStar * constant * constant + 1e-9);
      return { song_id: item.musicId, dataSource: "rinnet", music: { name: song.name, artist: song.artistName, music_id: String(item.musicId) },
        difficulty_id: item.difficulty, score: item.techScoreMax, rating,
        is_all_break: item.isAllBreak, is_full_combo: item.isFullCombo, is_full_bell: item.isFullBell,
        platinum_score_star: item.platinumScoreStar, platinum_score_max: item.platinumScoreMax };
    });
  }
  const best = list(value.old50, "best", 50), newest = list(value.new10, "new", 10), platinum = list(value.pScore, "platinum", 50);
  const average = rows => Math.floor(rows.reduce((n, row) => n + row.rating, 0) / 50);
  return { best_rating_list: best, best_new_rating_list: newest, p_score_rating_list: platinum,
    best_rating: average(best), best_new_rating: average(newest), p_score_rating: average(platinum),
    rating: average(best) + average(newest) + average(platinum) };
}

function createClient({ fetchImpl = httpFetch, proxyUrl = "" } = {}) {
  const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
  const refreshes = new Map();
  async function request(route, { account, body } = {}) {
    let response;
    let parsed;
    try {
    try {
      response = await fetchImpl(BASE + route, { method: body === undefined ? "GET" : "POST",
        headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(account ? { Authorization: "Bearer " + account.accessToken } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error", signal: AbortSignal.timeout(25000), ...(dispatcher ? { dispatcher } : {}) });
    } catch { fail("NETWORK", "rinnet 暂时没连上，稍后再叫美亚试一次吧。"); }
    if (response.status === 429) fail("RATE_LIMIT", "rinnet 说请求太快啦，稍等一会儿再试。");
    try { parsed = await response.json(); } catch {
      if (response.status !== 401) {
        // 读档案这条路返回非 JSON，实测对应「这张卡还没有音击数据」：rinnet 网站上
        // 也看不到它的 Rating 界面。只说「没读懂」用户没法照做，所以把可能的原因
        // 和下一步一起说，并且留了前提（网站上也是空的才说明是没数据）。
        if (route.startsWith("api/game/ongeki/profile")) {
          fail("FORMAT", "rinnet 读不到这张卡的数据。如果网站上这张卡也看不到 Rating 界面，就是它还没有音击数据 —— 换一张卡，或者先在机台上玩一局再来。");
        }
        fail("FORMAT", "rinnet 返回的数据没读懂，稍后再试一下吧。");
      }
    }
    if ([34015, 34292].includes(parsed?.status?.code)) unwrap(parsed);
    if (response.status === 401 || parsed?.status?.code === 94011) fail("AUTH", "rinnet 登录已失效，请发 /绑定 重新登录；开启两步验证的话还需要当前验证码。");
    // The portal falls back to the legacy rating page for this exact endpoint
    // and business code. Do not misreport it as an account access problem.
    if (route === "api/game/ongeki/newRating" && parsed?.status?.code === 94001)
      fail("LEGACY_RATING", "rinnet 的新版分表接口返回了旧版分表回退状态（94001）。美亚目前只支持新版 B50/N10/P50，请在网站 Rating 页面确认这张卡的分表版本。");
    if (route === "api/game/ongeki/newRating" && parsed?.status?.code === 94041)
      fail("NO_RATING", "rinnet 没有找到这张卡的新版分表数据（94041），请先在网站 Rating 页面确认。");
    if (!response.ok) fail("HTTP", "rinnet 暂时没有提供这份数据，请在网站检查账号和游戏档案后重试。");
    // Preserve the login challenge, but classify all other business failures
    // while the request metadata is still available.
    if (!(route === "api/auth/signin" && parsed?.status?.code === 34014)) unwrap(parsed);
    return parsed;
    } catch (error) {
      if (error instanceof RinnetError) {
        const contentType = response?.headers?.get?.("content-type") || "";
        error.diagnostic = { route: route.split("?")[0].replace(/^api\/game\/ongeki\/song\/\d+$/, "api/game/ongeki/song/:id"), http: response?.status,
          business: parsed?.status?.code,
          response: /json/i.test(contentType) ? "json" : /html/i.test(contentType) ? "html" : "other" };
      }
      throw error;
    }
  }
  async function login(email, password) {
    const body = await request("api/auth/signin", { body: { usernameOrEmail: email, password } });
    if (body?.status?.code === 34014 && typeof body.data?.totpToken === "string") return { totpToken: body.data.totpToken };
    return { account: accountData(unwrap(body)) };
  }
  async function totp(totpToken, code) {
    if (!/^\d{6}$/.test(code)) fail("TOTP_INVALID", "要发验证器里当前的六位数字哦。");
    return accountData(unwrap(await request("api/auth/signin/totp", { body: { totpToken, code } })));
  }
  async function cards(account) { return cardsFrom(await request("api/user/me", { account })); }
  async function bind(account, email, cardNumber) {
    const owned = await cards(account);
    if (!owned.length) fail("NO_CARD", "这个 rinnet 账号还没有卡片，先去网站绑定自己的卡再来吧。");
    if (!cardNumber && owned.length !== 1) return { cards: owned };
    const card = cardNumber ? findCard(owned, cardNumber) : owned[0];
    const profile = normalizeProfile(await request("api/game/ongeki/profile?aimeId=" + encodeURIComponent(card.extId), { account }));
    return { dataSource: "rinnet", email, account: accountData(account),
      cardNumber: normalizeCardNumber(card.luid), aimeId: String(card.extId),
      playerName: profile.playerName, boundAt: new Date().toISOString(), sessionId: randomUUID() };
  }
  async function authenticated(binding, route, saveAccount) {
    try { return await request(route, { account: binding.account }); }
    catch (error) {
      if (error.code !== "AUTH") throw error;
      const key = binding.sessionId;
      if (!refreshes.has(key)) {
        const pending = (async () => {
          const result = unwrap(await request("api/auth/refresh", { body: { refreshToken: binding.account.refreshToken } }));
          if (typeof result?.accessToken !== "string" || !result.accessToken) fail("AUTH", "rinnet 登录续期没成功，请发 /绑定 重新登录。");
          const account = accountData({ ...binding.account, ...result });
          await saveAccount(account);
          return account;
        })();
        refreshes.set(key, pending);
        pending.finally(() => refreshes.delete(key)).catch(() => {});
      }
      binding.account = await refreshes.get(key);
      return request(route, { account: binding.account });
    }
  }
  async function snapshot(binding, kind, songId, saveAccount) {
    const get = route => authenticated(binding, route, saveAccount);
    async function checkCard() {
      const owned = cardsFrom(await get("api/user/me"));
      const card = findCard(owned, binding.cardNumber);
      if (String(card.extId) !== String(binding.aimeId)) fail("CARD_CHANGED", "这张卡的档案对应关系变了，请发 /绑定 重新确认。");
      if (kind !== "song" && card.default !== true) fail("DEFAULT_CARD", "先去 rinnet 网站的卡包，把美亚绑定的这张卡设为默认，再来查分表、牌子或等级成绩吧～单曲可以直接查哦。");
      return card;
    }
    await checkCard();
    const profile = normalizeProfile(await get("api/game/ongeki/profile?aimeId=" + encodeURIComponent(binding.aimeId)));
    const result = { source: "rinnet", profile };
    if (kind === "song") {
      const scores = normalizeScores(await get("api/game/ongeki/song/" + Number(songId) + "?aimeId=" + encodeURIComponent(binding.aimeId)), songId);
      result.song = { found: scores.some(s => s.techScoreMax > 0), songNo: Number(songId), scores };
    } else if (kind === "chart") {
      result.rating = ratingData(await get("api/game/ongeki/newRating"));
    } else {
      const exported = unwrap(await get("api/game/ongeki/export"));
      if (!Array.isArray(exported?.userMusicDetailList)) fail("FORMAT", "rinnet 的全量成绩导出格式与预期不同，这次先不出图，需要适配后再试。");
      const accessCode = exported.userData?.accessCode;
      if (accessCode != null && normalizeCardNumber(accessCode) !== binding.cardNumber) fail("CARD_CHANGED", "导出的成绩与绑定卡不一致，请确认 rinnet 默认卡后再试。");
      result.records = normalizeScores(exported.userMusicDetailList).map(recordRow).filter(Boolean);
    }
    // Do not silently use a different default card if it changed during fetching.
    await checkCard();
    return result;
  }
  return { login, totp, cards, bind, snapshot, close: () => dispatcher?.close() };
}
module.exports = { createClient, RinnetError, diagnosticText, normalizeCardNumber, findCard, cardsFrom, normalizeProfile, normalizeScores, ratingData, technicalRating };
