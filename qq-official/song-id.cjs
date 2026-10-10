"use strict";

// The public catalog uses official six-digit IDs; commands use the IDs from
// ongeki-music-internal.json. Match the snapshots by song metadata, never by ID.
const internalSongs = require("../ongeki-music-internal.json");

const DIFFICULTIES = ["BAS", "ADV", "EXP", "MAS", "LUN"];
const key = value => String(value || "").normalize("NFKC").toLowerCase().replace(/[\s\p{P}]/gu, "");
const titleCorrections = new Map([
  // The deleted catalog entry has a typo; the Bot catalog has the full title.
  ["668300", "Cogito ergo sum"],
]);

const internalById = new Map(internalSongs.map(song => [song.id, song]));
const byTitle = new Map();
for (const song of internalSongs) {
  const title = key(song.name);
  const peers = byTitle.get(title) || [];
  peers.push(song);
  byTitle.set(title, peers);
}

function chartMatchCount(catalogSong, internalSong) {
  let matches = 0;
  for (const [index, difficulty] of DIFFICULTIES.entries()) {
    const catalogNotes = Number(catalogSong[difficulty]?.notes_all);
    const internalNotes = Number(internalSong.noteTotal?.[index]);
    if (catalogNotes > 0 && internalNotes > 0 && catalogNotes === internalNotes) matches++;
  }
  return matches;
}

function peersOf(catalogSong) {
  const meta = catalogSong?.meta;
  if (!meta?.name) return [];
  const title = titleCorrections.get(String(meta.official_id)) || meta.name;
  return (byTitle.get(key(title)) || []).filter(song => key(song.artistName) === key(meta.artist));
}

function botSongId(catalogSong) {
  const peers = peersOf(catalogSong);
  if (!peers.length) return null;
  const ranked = peers.map(song => ({ song, matches: chartMatchCount(catalogSong, song) }))
    .sort((a, b) => b.matches - a.matches);
  if (ranked.length > 1 && ranked[0].matches === ranked[1].matches) return null;
  return ranked[0].song.id;
}

// 公开曲库里还留着几条「已删除」的旧条目，那首歌后来换了新条目重新上架：TiamaT:F minor（旧条目 2024-09-05 删）、
// Cogito ergo sum（旧条目 2024-06-06 删，曲名还拼成了 Cogit）。它们跟在线那条对上同一个游戏 ID，
// 再列一遍只会让同一个 ID 既在线又已删除，定数也是旧的（Cogit 那条 MAS 还是 14.7）。同一个 ID 有在线那条，就只留在线那条。
function currentCatalogSongs(catalogSongs) {
  const live = new Set(catalogSongs.filter(song => !song.meta?.is_deleted).map(botSongId).filter(id => id != null));
  return catalogSongs.filter(song => !song.meta?.is_deleted || !live.has(botSongId(song)));
}

// 同曲名同曲师、带白谱的那几条。一首歌可以有好几张白谱：《Perfect Shining!!》有 8003、8091 两张。
function lunaticHolders(catalogSong) {
  return peersOf(catalogSong).filter(song => song.level?.[4] != null && String(song.level[4]) !== "-");
}

// 游戏里的白谱都是单独一条曲目（8001 起），跟本曲不是同一个 ID：《Gate of Doom》本曲 39、白谱 8015。
// 公开曲库却把白谱并进本曲的 LUN 一格，整首按物量对上的是本曲，所以 LUN 不能沿用 botSongId，
// 要在同曲名同曲师里另找带白谱的那条。《Perfect Shining!!》有两张白谱，只能靠物量分。
function botChartId(catalogSong, difficulty) {
  if (difficulty !== "LUN") return botSongId(catalogSong);
  const chart = catalogSong?.LUN;
  if (!chart?.has_chart) return null;
  const holders = lunaticHolders(catalogSong);
  const notes = Number(chart.notes_all);
  const sameNotes = holders.filter(song => notes > 0 && Number(song.noteTotal?.[4]) === notes);
  const picks = sameNotes.length ? sameNotes : holders;
  return picks.length === 1 ? picks[0].id : null;
}

// 公开曲库只收了游戏数据的一部分：每首歌只有一格 LUN（白谱却是一张一条），已删的歌也只收了一半左右。
// 游戏数据里的每一条都要找得到。按同曲名同曲师算，每条只算一处：
//   - 曲库里有这首歌的，挂到那条曲库记录下面：漏收的白谱（extraLunatics，《Perfect Shining!!》的 8091），
//     以及曲库只剩白谱时的本曲（attachedBase，《回レ！雪月花》曲库里只剩 8058，本曲 id25 挂上去）；
//   - 连这首歌都没有的（No Remorse、ようこそジャパリパークへ、ユーフィリア的《Hand in Hand》……）整首单独列出
//     （uncataloged）：本曲带着它的白谱，没有本曲的由第一张白谱领头。
// 搜索和美亚查曲库共用这一份，两边才数得一样。
function catalogCoverage(catalogSongs) {
  const covered = new Set();
  for (const song of catalogSongs) {
    covered.add(botSongId(song));
    if (song.LUN?.has_chart) covered.add(botChartId(song, "LUN"));
  }
  const extraLunatics = new Map();
  const attachedBase = new Map();
  for (const song of catalogSongs) {
    const own = internalById.get(botSongId(song));
    const bases = own?.isLunatic ? peersOf(song).filter(other => !other.isLunatic && !covered.has(other.id)) : [];
    if (bases.length === 1) {
      attachedBase.set(song, bases[0]);
      covered.add(bases[0].id);
    }
    const extras = lunaticHolders(song).filter(other => !covered.has(other.id));
    for (const other of extras) covered.add(other.id);
    extraLunatics.set(song, extras);
  }
  const families = new Map();
  for (const song of internalSongs) {
    if (covered.has(song.id)) continue;
    const family = key(song.name) + "\0" + key(song.artistName);
    families.set(family, [...(families.get(family) || []), song]);
  }
  const byId = (a, b) => a.id - b.id;
  const uncataloged = [...families.values()].flatMap(members => {
    const bases = members.filter(song => !song.isLunatic).sort(byId);
    const lunatics = members.filter(song => song.isLunatic).sort(byId);
    return bases.length ? bases.map((base, k) => ({ base, lunatics: k ? [] : lunatics })) : [{ base: null, lunatics }];
  });
  return { extraLunatics, attachedBase, uncataloged };
}

module.exports = { botSongId, botChartId, lunaticHolders, catalogCoverage, currentCatalogSongs };
