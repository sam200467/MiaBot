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

function botSongId(catalogSong) {
  const meta = catalogSong?.meta;
  if (!meta?.name) return null;
  const title = titleCorrections.get(String(meta.official_id)) || meta.name;
  const peers = (byTitle.get(key(title)) || []).filter(song => key(song.artistName) === key(meta.artist));
  if (!peers.length) return null;
  const ranked = peers.map(song => ({ song, matches: chartMatchCount(catalogSong, song) }))
    .sort((a, b) => b.matches - a.matches);
  if (ranked.length > 1 && ranked[0].matches === ranked[1].matches) return null;
  return ranked[0].song.id;
}

module.exports = { botSongId };
