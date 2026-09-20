"use strict";

(() => {
  const difficulties = [10, 3, 3, 3, 3, 3, 10];
  const placeholder = (index) => {
    const hue = (index * 37 + 210) % 360;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><defs><linearGradient id="g" x2="1" y2="1"><stop stop-color="hsl(${hue} 38% 72%)"/><stop offset="1" stop-color="hsl(${(hue + 65) % 360} 34% 52%)"/></linearGradient></defs><rect width="300" height="300" fill="url(#g)"/><circle cx="150" cy="122" r="70" fill="none" stroke="white" stroke-width="12" opacity=".62"/><text x="150" y="245" text-anchor="middle" font-family="sans-serif" font-size="38" font-weight="700" fill="white">${index + 211}</text></svg>`;
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
  };
  const charts = Array.from({ length: 11 }, (_, index) => ({
    songId: index + 211,
    title: ["六兆年と一夜物語", "Dazzle hop", "カナリア", "神々が恋した幻想郷"][index % 4],
    difficultyId: difficulties[index % difficulties.length],
    level: "14",
    constant: 14 + (index % 4) / 10,
    jacketUrl: placeholder(index),
    played: false,
    techScore: null,
    listPosition: index + 211,
    platinumScoreStar: 0,
    isAllBreak: false,
    isFullCombo: false,
    isFullBell: false,
  }));
  window.__THEME_DATA__ = {
    generatedAt: new Date().toISOString(),
    targetLevel: "14",
    canvas: { width: 1440, height: 1080 },
    profile: { playerName: "DEMO PLAYER", level: 49, avatarUrl: placeholder(99) },
    charts,
    pagination: { page: 4, totalPages: 4, pageSize: 70, from: 211, to: 221, total: 221 },
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
