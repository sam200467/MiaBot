"use strict";

// The public song snapshot leaves many lower-difficulty constants unverified.
// Enrich only missing values from the project's internal song snapshot, using
// the same title/artist/chart matching as the Bot's public song ID mapping.
const fs = require("node:fs");
const path = require("node:path");
const { botSongId } = require("../qq-official/song-id.cjs");

const root = path.resolve(__dirname, "..");
const catalogPath = path.join(root, "ongeki-song-catalog.json");
const internalPath = path.join(root, "ongeki-music-internal.json");
const difficulties = ["BAS", "ADV", "EXP", "MAS", "LUN"];

function enrich(catalog, internalSongs) {
  const byId = new Map(internalSongs.map(song => [song.id, song]));
  let verifiedKnown = 0;
  const conflicts = [];
  for (const song of catalog.songs) {
    const internal = byId.get(botSongId(song));
    for (const [index, difficulty] of difficulties.entries()) {
      const chart = song[difficulty];
      if (!internal || !chart?.has_chart || chart.const_status !== "known" ||
          String(chart.level) !== String(internal.level?.[index])) continue;
      verifiedKnown++;
      if (Number(chart.const) !== Number(internal.const?.[index])) {
        conflicts.push(`${song.meta.name} ${difficulty}: catalog=${chart.const}, internal=${internal.const?.[index]}`);
      }
    }
  }
  if (conflicts.length) throw new Error(`Internal snapshot conflicts with ${conflicts.length} known constants:\n${conflicts.slice(0, 10).join("\n")}`);
  const result = { filled: 0, verifiedKnown, noteCountDifferences: 0, unresolved: [] };
  for (const song of catalog.songs) {
    const internal = byId.get(botSongId(song));
    for (const [index, difficulty] of difficulties.entries()) {
      const chart = song[difficulty];
      if (!chart?.has_chart || chart.const_status !== "unknown") continue;
      const value = Number(internal?.const?.[index]);
      if (!internal || String(chart.level) !== String(internal.level?.[index]) ||
          !Number.isFinite(value) || value < 0) {
        result.unresolved.push({ name: song.meta.name, difficulty, level: chart.level });
        continue;
      }
      const catalogNotes = Number(chart.notes_all);
      const internalNotes = Number(internal.noteTotal?.[index]);
      if (catalogNotes > 0 && internalNotes > 0 && catalogNotes !== internalNotes) {
        result.noteCountDifferences++;
      }
      chart.const = value;
      chart.const_status = "known";
      chart.const_source = "ongeki-music-internal.json";
      result.filled++;
    }
  }
  return result;
}

if (require.main === module) {
  const write = process.argv.includes("--write");
  const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
  const internal = JSON.parse(fs.readFileSync(internalPath, "utf8"));
  const result = enrich(catalog, internal);
  if (write && result.filled) {
    catalog.meta.local_constant_source = "ongeki-music-internal.json";
    const temp = `${catalogPath}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(catalog));
    fs.renameSync(temp, catalogPath);
  }
  console.log(JSON.stringify({ mode: write ? "write" : "check", ...result }, null, 2));
}

module.exports = { enrich };
