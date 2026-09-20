"use strict";

(() => {
  const difficulties = [3, 3, 3, 2, 3, 10];
  const placeholder = (index) => {
    const hue = (index * 43) % 360;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="hsl(${hue} 76% 63%)"/><stop offset="1" stop-color="hsl(${(hue + 85) % 360} 70% 43%)"/></linearGradient></defs><rect width="300" height="300" fill="url(#g)"/><circle cx="150" cy="122" r="70" fill="none" stroke="white" stroke-width="12" opacity=".72"/><text x="150" y="245" text-anchor="middle" font-family="sans-serif" font-size="42" font-weight="700" fill="white">${index + 1}</text></svg>`;
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
  };
  const charts = Array.from({ length: 70 }, (_, index) => ({
    songId: index + 1,
    title: ["初音ミクの激唱", "Viyella's Tears", "YURUSHITE", "Good bye, Merry-Go-Round."][index % 4],
    difficultyId: difficulties[index % difficulties.length],
    level: "14+",
    constant: 14.7 + (index % 3) / 10,
    jacketUrl: placeholder(index),
    played: index < 60,
    techScore: index < 60 ? 1010000 - index * 347 : null,
    listPosition: index + 1,
    platinumScoreStar: index < 60 && index % 4 === 0 ? (index % 5) + 1 : 0,
    isAllBreak: index < 60 && index % 11 === 0,
    isFullCombo: index < 60 && index % 7 === 0,
    isFullBell: index < 60 && index % 5 === 0,
  }));
  window.__THEME_DATA__ = {
    generatedAt: new Date().toISOString(),
    targetLevel: "14+",
    canvas: { width: 1440, height: 285 + 10 * 250 + 9 * 14 + 70 },
    profile: { playerName: "DEMO PLAYER", level: 49, avatarUrl: placeholder(99) },
    charts,
    pagination: { page: 1, totalPages: 4, pageSize: 70, from: 1, to: 70, total: 221 },
    summary: {
      total: 221,
      played: 185,
      unplayed: 36,
      theory: 1,
      sssPlus: 18,
      sss: 47,
      allBreak: 6,
      fullBell: 26,
      allBreakFullBell: 11,
      star5: 6,
      star4: 8,
      star3: 11,
      star2: 15,
      star1: 23,
    },
  };
})();
