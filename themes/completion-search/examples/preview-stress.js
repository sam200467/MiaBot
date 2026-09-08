"use strict";

(() => {
  const coverBase = "https://oss-hd1.bemanicn.com/SDDT/cover/";
  const covers = [
    "282e98d76018ba738f0f3ad54c58dec6", "7dc2bb3625ecd7c66e616de9ae2d1bed",
    "dfb99b1bf47c9dff9beab81bd46cdab8", "358a6c34df7176d77d42d0352eebb357",
    "a22a17a9ae87484abf85449ca41ac23a", "73aa114a7e62fa9706e8fba7322da705",
    "984076a655d7a5efe714bbec2ccd139d", "0d295e8cb62c53b106ee339a7d0a8829",
    "d8a2ff4bda93de2e9b85fa641606cd9b", "38acebac7e6230681a0f251a7054cfd2",
    "cc5c5907eb8e3155019b6e7c2769addd", "23fa8c0e972da8c09cbff92e3b1ba1aa",
  ];
  const distribution = [
    ["15", 2], ["14+", 5], ["14", 13], ["13+", 14], ["13", 18],
    ["12+", 18], ["12", 17], ["11+", 14], ["11", 11], ["10+", 8],
  ];
  const songs = [];
  let index = 0;
  for (const [masterLevel, count] of distribution) {
    for (let position = 0; position < count; position += 1) {
      songs.push({
        songId: 5000 + index,
        title: `爽撃布局压力测试曲目 ${String(index + 1).padStart(3, "0")}`,
        masterLevel,
        masterConstant: Number.parseInt(masterLevel, 10) + (masterLevel.endsWith("+") ? 0.7 : 0.2),
        jacketUrl: `${coverBase}${covers[index % covers.length]}.webp-thumbnail`,
        isAllBreak: index % 17 === 0,
        isFullCombo: index % 11 === 0,
        isFullBell: index % 7 === 0,
      });
      index += 1;
    }
  }

  window.__THEME_DATA__ = {
    profile: {
      playerName: "DEMO PLAYER",
      level: 49,
      avatarUrl: "https://u.otogame.net/img/ongeki/icon_proto_1.png",
    },
    plate: {
      id: "040150",
      nameJa: "爽撃",
      version: "ONGEKI Re:Fresh Act.1",
      layoutUrl: "../assets/ui_userplate_040150.png",
    },
    songs,
    summary: {
      basic: { allBreak: 91, fullBell: 116, total: 120 },
      advanced: { allBreak: 83, fullBell: 112, total: 120 },
      expert: { allBreak: 64, fullBell: 104, total: 120 },
      master: { allBreak: 8, fullBell: 18, total: 120 },
    },
  };
})();
