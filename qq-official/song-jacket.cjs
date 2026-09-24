"use strict";

// Public song artwork. The QQ transport accepts a Buffer, so neither a URL nor
// a renderer placeholder is a successful lookup here.
const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { fetch: httpFetch, ProxyAgent } = require("undici");
const { songs: catalogSongs } = require("../ongeki-song-catalog.json");
const internalSongs = require("../ongeki-music-internal.json");
const core = require("../mia-core.cjs");
const songSearch = require("./song-search.cjs");

const JACKET_BASE = "https://norca0721.github.io/otoge-db/ongeki/jacket/";
const REMOTE_INDEX = "https://dp4p6x0xfi5o9.cloudfront.net/ongeki/data.json";
const REMOTE_COVERS = "https://dp4p6x0xfi5o9.cloudfront.net/ongeki/img/cover/";
const IMAGE_EXTENSIONS = [".webp", ".png", ".jpg", ".jpeg", ".gif"];
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_INDEX_BYTES = 8 * 1024 * 1024;
const REMOTE_INDEX_TTL_MS = 5 * 60 * 1000;

const normalize = (value) => String(value || "").normalize("NFKC").toLowerCase()
  .replace(/[ぁ-ゖ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0x60))
  .replace(/[\s\p{P}]/gu, "");

function parseQuery(value) {
  const raw = String(value || "").normalize("NFKC").trim();
  const match = raw.match(/^(.*?)\s+--选(?:\s+(\S+))?$/s);
  if (!match) return { query: raw, choice: null };
  const choice = Number(match[2]);
  return { query: match[1].trim(), choice: Number.isSafeInteger(choice) && choice > 0 ? choice : -1 };
}

function isLunatic(row) {
  if (typeof row?.isLunatic === "boolean") return row.isLunatic;
  if (row?.category === "LUNATIC" || /^\(LUN\)\s/i.test(String(row?.songId || ""))) return true;
  if (Array.isArray(row?.sheets)) return row.sheets.length > 0 && row.sheets.every((sheet) => sheet.type === "lun");
  return Boolean(row?.LUN?.has_chart && !row?.MAS?.has_chart);
}

function candidateList(items, query) {
  return items.map((item, i) => ({
    name: item.name, artist: item.artist, officialId: item.officialId || null,
    internalId: item.internalId || null, isLunatic: item.lunatic,
    selector: `${query} --选 ${i + 1}`,
  }));
}

function candidateText(code, candidates, total) {
  const lead = code === "FUZZY" ? "只找到相近的曲名，请确认序号：" : "找到多首曲目，请按序号选择：";
  const lines = candidates.map((item, i) => `${i + 1}. ${item.name}${item.artist ? " / " + item.artist : ""}${item.isLunatic ? " / LUNATIC" : ""}`);
  if (total > candidates.length) lines.push(`这里只列出前 ${candidates.length} 首，请把曲名线索写得更具体。`);
  return [lead, ...lines].join("\n");
}

function failure(code, text, more = {}) { return { ok: false, code, text, ...more }; }

function imageType(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) &&
      buffer.toString("ascii", 12, 16) === "IHDR") return { mime: "image/png", ext: ".png" };
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)
    return { mime: "image/jpeg", ext: ".jpg" };
  if (buffer.length >= 13 && ["GIF87a", "GIF89a"].includes(buffer.toString("ascii", 0, 6)))
    return { mime: "image/gif", ext: ".gif" };
  if (buffer.length >= 16 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP")
    return { mime: "image/webp", ext: ".webp" };
  return null;
}

function safeImageName(value) {
  const name = String(value || "").trim();
  return /^[A-Za-z0-9_-]+\.(?:png|webp|jpe?g|gif)$/i.test(name) ? name : "";
}

function imageUrl(base, name) {
  const safe = safeImageName(name);
  return safe ? new URL(encodeURIComponent(safe), base).href : "";
}

function cacheKey(url) { return createHash("sha256").update(url).digest("hex"); }

function readCachedFile(dir, stem, maxBytes = MAX_IMAGE_BYTES) {
  if (!dir || !stem) return null;
  for (const ext of IMAGE_EXTENSIONS) {
    const file = path.join(dir, stem + ext);
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size < 24 || stat.size > maxBytes) continue;
      const buffer = fs.readFileSync(file);
      const type = imageType(buffer);
      if (type) return { buffer, type };
    } catch (error) { if (error.code !== "ENOENT") continue; }
  }
  return null;
}

function writeCachedFile(dir, stem, buffer, type) {
  if (!dir) return;
  let temporary = "";
  try {
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, stem + type.ext);
    temporary = target + "." + randomUUID() + ".tmp";
    fs.writeFileSync(temporary, buffer, { flag: "wx" });
    fs.renameSync(temporary, target);
  } catch {
    if (temporary) try { fs.unlinkSync(temporary); } catch {}
    // Caching is optional; a valid fetched image can still be sent.
  }
}

function makeCandidateFromCatalog(row) {
  return { kind: "catalog", row, name: String(row?.meta?.name || ""),
    artist: String(row?.meta?.artist || ""), officialId: String(row?.meta?.official_id || ""),
    internalId: null, lunatic: isLunatic(row) };
}

function makeCandidateFromInternal(row) {
  return { kind: "internal", row, name: String(row?.name || ""), artist: String(row?.artistName || ""),
    officialId: "", internalId: Number(row?.id) || null, lunatic: Boolean(row?.isLunatic) };
}

function makeCandidateFromRemote(row) {
  return { kind: "remote", row, name: String(row?.title || ""), artist: String(row?.artist || ""),
    officialId: "", internalId: null, lunatic: isLunatic(row) };
}

function uniqueInternalForCatalog(candidate, query, catalog, internal, coreSearch) {
  const title = normalize(candidate.name), artist = normalize(candidate.artist);
  // Internal IDs and official IDs are unrelated. Never use one as the other.
  const catalogTwins = catalog.filter((row) => normalize(row?.meta?.name) === title && normalize(row?.meta?.artist) === artist);
  if (catalogTwins.length !== 1) return null;
  const peers = internal.filter((row) => normalize(row?.name) === title && normalize(row?.artistName) === artist);
  if (/^(?:id\s*)?\d+$/i.test(query)) {
    const specified = coreSearch(query).filter((row) => peers.includes(row));
    if (specified.length === 1) return specified[0];
  }
  const matchingVariant = peers.filter((row) => Boolean(row?.isLunatic) === candidate.lunatic);
  return matchingVariant.length === 1 ? matchingVariant[0] : null;
}

function matchingRemoteSongs(index, candidate) {
  const title = normalize(candidate.name), artist = normalize(candidate.artist);
  if (!title) return [];
  return index.filter((row) => normalize(row?.title) === title &&
    (!artist || normalize(row?.artist) === artist) && isLunatic(row) === candidate.lunatic);
}

function createSongJacket(options = {}) {
  const fetchImpl = options.fetchImpl || httpFetch;
  const searchImpl = options.searchImpl || songSearch.search;
  const coreSearchImpl = options.coreSearchImpl || core.searchSongs;
  const catalog = options.catalogSongs || catalogSongs;
  const internal = options.internalSongs || internalSongs;
  const cacheDir = options.cacheDir || "";
  const jacketCacheDir = options.jacketCacheDir || "";
  for (const dir of [cacheDir, jacketCacheDir]) if (dir && !path.isAbsolute(dir)) throw new Error("曲绘缓存路径必须是绝对路径");
  const remoteIndexUrl = options.remoteIndexUrl || REMOTE_INDEX;
  const coverBaseUrl = options.coverBaseUrl || REMOTE_COVERS;
  const catalogCoverBaseUrl = options.catalogCoverBaseUrl || JACKET_BASE;
  const timeoutMs = Math.max(1, Number(options.timeoutMs) || 15000);
  const maxImageBytes = Math.max(24, Number(options.maxImageBytes) || MAX_IMAGE_BYTES);
  const proxy = options.proxyUrl ? new ProxyAgent(String(options.proxyUrl)) : null;
  let remoteIndex = null, remoteIndexAt = 0, remoteIndexPending = null;

  async function withTimeout(work) {
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([
        work(controller.signal),
        new Promise((_, reject) => {
          timer = setTimeout(() => { controller.abort(); const error = new Error("曲绘下载超时"); error.reason = "TIMEOUT"; reject(error); }, timeoutMs);
        }),
      ]);
    } finally { clearTimeout(timer); }
  }

  async function fetchBytes(url, limit) {
    return withTimeout(async (signal) => {
      const response = await fetchImpl(url, { signal, redirect: "error", ...(proxy ? { dispatcher: proxy } : {}) });
      if (!response?.ok) throw new Error("HTTP " + response?.status);
      const length = Number(response.headers?.get?.("content-length"));
      if (Number.isFinite(length) && length > limit) throw new Error("响应超过大小上限");
      let buffer;
      if (response.body?.getReader) {
        const reader = response.body.getReader(), chunks = [];
        let size = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = Buffer.from(value);
            size += chunk.length;
            if (size > limit) throw new Error("响应超过大小上限");
            chunks.push(chunk);
          }
        } finally { reader.releaseLock(); }
        buffer = Buffer.concat(chunks, size);
      } else {
        buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length > limit) throw new Error("响应超过大小上限");
      }
      return { buffer, contentType: String(response.headers?.get?.("content-type") || "").split(";")[0].toLowerCase() };
    });
  }

  async function loadImage(url) {
    if (!url || !/^https:\/\//i.test(url)) throw new Error("曲绘地址无效");
    const stem = cacheKey(url);
    const cached = readCachedFile(cacheDir, stem, maxImageBytes);
    if (cached) return { ...cached, source: "cache" };
    const response = await fetchBytes(url, maxImageBytes);
    const type = imageType(response.buffer);
    if (!type) throw new Error("曲绘不是可发送的图片格式");
    // arcade-songs 实测存在「.png 文件名 + image/png 响应头、内容却是 JPEG」的曲绘，
    // 这种情况以魔数嗅探为准；只有响应头指向非图片类型（错误页之类）才拒绝。
    if (response.contentType && response.contentType !== "application/octet-stream" &&
        response.contentType !== type.mime && !response.contentType.startsWith("image/"))
      throw new Error("曲绘格式与响应类型不符");
    writeCachedFile(cacheDir, stem, response.buffer, type);
    return { buffer: response.buffer, type, source: "download" };
  }

  async function getRemoteIndex() {
    if (remoteIndex && Date.now() - remoteIndexAt < REMOTE_INDEX_TTL_MS) return remoteIndex;
    if (!remoteIndexPending) remoteIndexPending = (async () => {
      try {
        const { buffer } = await fetchBytes(remoteIndexUrl, MAX_INDEX_BYTES);
        const data = JSON.parse(buffer.toString("utf8"));
        if (!Array.isArray(data?.songs) || data.songs.length > 10000) throw new Error("远端曲库格式不正确");
        remoteIndex = data.songs.filter((row) => row && typeof row.title === "string" && typeof row.songId === "string");
        remoteIndexAt = Date.now();
        return remoteIndex;
      } catch (error) {
        if (remoteIndex) return remoteIndex;
        throw error;
      } finally { remoteIndexPending = null; }
    })();
    return remoteIndexPending;
  }

  function choose(items, query, choice, fuzzy = false, total = items.length) {
    const candidates = candidateList(items, query);
    if (choice === null && fuzzy) return failure("FUZZY", candidateText("FUZZY", candidates, total), { candidates });
    if ((choice !== null && (choice < 1 || choice > items.length)) || (choice === null && (items.length !== 1 || total !== 1)))
      return failure("AMBIGUOUS", candidateText("AMBIGUOUS", candidates, total), { candidates });
    return items[choice === null ? 0 : choice - 1];
  }

  async function lookup(rawQuery) {
    const { query, choice } = parseQuery(rawQuery);
    if (!query || query.length > 100) return failure("USAGE", "请给我曲名、别名或 Song ID，例如 /查曲绘 サド。也可以在候选后加 --选 2。");
    const local = searchImpl(query);
    if (local?.usage) return failure("USAGE", "请给我曲名、别名或 Song ID，例如 /查曲绘 サド。");
    let items = (local?.matches || []).map(makeCandidateFromCatalog);
    let total = Number(local?.total) || items.length;
    let fuzzy = Boolean(local?.fuzzy);
    if (!items.length) {
      const seen = new Set();
      items = coreSearchImpl(query).filter((row) => {
        const id = Number(row?.id);
        if (!Number.isSafeInteger(id) || seen.has(id)) return false;
        seen.add(id); return true;
      }).map(makeCandidateFromInternal);
      total = items.length;
      fuzzy = false;
    }
    if (!items.length) {
      let index;
      try { index = await getRemoteIndex(); }
      catch (error) { return failure("FETCH_FAILED", error.reason === "TIMEOUT" ? "远端曲库查询超时，请稍后再试。" : "远端曲库暂时取不到，请稍后再试。", { reason: error.reason || "NETWORK" }); }
      items = index.filter((row) => normalize(row.title) === normalize(query)).map(makeCandidateFromRemote);
      total = items.length;
    }
    if (!items.length) return failure("NOT_FOUND", "没有找到这首歌，换一段曲名试试？");
    const selected = choose(items, query, choice, fuzzy, total);
    if (selected.ok === false) return selected;

    const localInternal = selected.kind === "internal" ? selected.row
      : selected.kind === "catalog" ? uniqueInternalForCatalog(selected, query, catalog, internal, coreSearchImpl) : null;
    if (localInternal && jacketCacheDir) {
      const cached = readCachedFile(jacketCacheDir, String(localInternal.id), maxImageBytes);
      if (cached) return success({ ...selected, internalId: Number(localInternal.id) || selected.internalId }, cached, "cache", "");
    }

    const specialLunatic = localInternal?.isLunatic === true && selected.kind === "catalog" &&
      /^(?:id\s*)?\d+$/i.test(query);
    let primaryError = null;
    if (selected.kind === "catalog" && !specialLunatic) {
      const url = imageUrl(catalogCoverBaseUrl, selected.row.meta?.image_url);
      if (url) {
        try { return success(selected, await loadImage(url), "catalog", url); }
        catch (error) { primaryError = error; }
      }
    }

    let remoteRows;
    try {
      const index = await getRemoteIndex();
      remoteRows = selected.kind === "remote" ? [selected.row]
        : matchingRemoteSongs(index, { ...selected, lunatic: specialLunatic ? true : selected.lunatic });
    } catch (error) {
      const reason = error.reason || primaryError?.reason || "NETWORK";
      return failure("FETCH_FAILED", reason === "TIMEOUT" ? "曲绘下载超时，请稍后再试。" : "曲绘图源暂时取不到，请稍后再试。", { reason });
    }
    if (!remoteRows.length) {
      if (primaryError) return failure("FETCH_FAILED", primaryError.reason === "TIMEOUT" ? "曲绘下载超时，请稍后再试。" : "曲绘图源暂时取不到，请稍后再试。", { reason: primaryError.reason || "NETWORK" });
      return failure("NO_IMAGE", "找到了歌曲，但曲库里没有能确认的曲绘。");
    }
    if (remoteRows.length !== 1) {
      const candidates = remoteRows.map(makeCandidateFromRemote).map((item) => ({
        name: item.name, artist: item.artist, isLunatic: item.lunatic, selector: null,
      }));
      return failure("AMBIGUOUS", "远端曲库里有多张同名同艺人的曲绘，暂时无法安全确定哪一张。", { candidates });
    }
    const url = imageUrl(coverBaseUrl, remoteRows[0].imageName);
    if (!url) return failure("NO_IMAGE", "找到了歌曲，但曲库里没有可用的曲绘文件。");
    try { return success(selected, await loadImage(url), "arcade-songs", url); }
    catch (error) {
      const reason = error.reason || primaryError?.reason || "NETWORK";
      return failure("FETCH_FAILED", reason === "TIMEOUT" ? "曲绘下载超时，请稍后再试。" : "曲绘图源暂时取不到，请稍后再试。", { reason });
    }
  }

  function success(candidate, loaded, source, url) {
    const name = candidate.name;
    return { ok: true, song: { name, artist: candidate.artist, officialId: candidate.officialId || null,
      internalId: candidate.internalId || null, imageUrl: url || null, isLunatic: candidate.lunatic },
    image: { buffer: loaded.buffer, name: `${name.replace(/[\\/:*?"<>|\p{Cc}]/gu, "_").slice(0, 60) || "song-jacket"}${loaded.type.ext}`,
      meta: { mime: loaded.type.mime, source: loaded.source === "cache" || source === "cache" ? "cache" : source } },
    source: loaded.source === "cache" || source === "cache" ? "cache" : source };
  }

  return { lookup, close: () => proxy?.close() };
}

module.exports = { createSongJacket };
