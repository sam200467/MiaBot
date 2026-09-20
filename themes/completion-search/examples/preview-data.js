"use strict";

(() => {
  const coverBase = "https://oss-hd1.bemanicn.com/SDDT/cover/";
  const covers = [
    "df125ffa2e454dd0d602070815405ffc",
    "35488864d5d9d74877209b25633f8f75",
    "86a7c03ff4bff62ebbe4a7da64c9f23b",
    "2cdbe6a8b2683c8c2e1089f7be09efaf",
    "924bdb59ce7597c197c4b970f0ef636a",
    "5dddfd9bfb28a8b0adfba77eee2dc4d6",
    "4040e4a77857a9b5aae98b7ce0b12af4",
    "f89c2b96b33d2e112812095409ec7312",
    "d3542632d3fe75b192a7c9dbad52f3fd",
    "586097325aaa8a56c2190b79f75e049a",
    "ee6a3e8ba76d01e11bbc9106dbca0d41",
    "d3a4a93d0cc73f84d8fcf0b4b64e063f",
    "2371abe446860412f9c27c8d45d07b3f",
    "32896692fdc57298bbbe076e91f2c250",
    "d5c720ec2006ca2f916939e8b93a8163",
    "2a26edbeaf85e21da56213c6a6929883",
    "f40279fc691b65f366447646b1e92105",
    "1db4dbe00220f2fc4550cacabf5eb244",
    "b6c0ca43997f5c72fa4ad9a31a37a8a9",
    "66f20baaf08e48fd6c51778975249d39",
    "c0ca4a29f0b6d3b19d11d6247941de23",
    "658183652e77a7c9e3340241b38d7e2f",
    "833dd2ae8d74974fa828b95905678674",
    "92b8889e8d501e5bca0cc6508cf68a38",
    "8877866c12828e7c49625adfed87f0e9",
  ];
  const titles = [
    "蜘蛛の糸", "初音ミクの激唱", "FREEDOM DiVE", "Rainbow Rush Story",
    "初音ミクの消失", "Falsum Atlantis.", "まっすぐ→→→ストリーム！", "Death Doll",
    "the EmpErroR", "Tempestissimo", "Good bye, Merry-Go-Round.", "サドマミホリック",
    "VIIIbit Explorer", "Event Horizon", "felys -final remix-", "宿星審判",
    "QZKago Requiem", "TiamaT:F minor", "Diamond Dust", "オンソクデイズ!!",
    "Apollo", "Iudicium “Apocalypsis Mix”", "Viyella's Tears", "larva", "Xevel",
  ];
  const pattern = [
    ["15", 1],
    ["14+", 2],
    ["14", 10],
    ["13", 12],
  ];
  const songs = [];
  let index = 0;
  for (const [masterLevel, count] of pattern) {
    for (let position = 0; position < count; position += 1) {
      songs.push({
        songId: index + 1,
        title: titles[index % titles.length],
        masterLevel,
        masterConstant: Number(masterLevel.replace("+", ".7")) || 0,
        jacketUrl: `${coverBase}${covers[index % covers.length]}.webp-thumbnail`,
        isAllBreak: index === 0 || index === 3,
        isFullCombo: index === 1,
        isFullBell: index === 0 || index === 1 || index === 2,
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
      id: "040100",
      nameJa: "桜撃",
      version: "ONGEKI",
      layoutUrl: "../assets/ui_userplate_040100.png",
    },
    levelRange: { max: "15", min: "11+" },
    songs,
    summary: {
      basic: { allBreak: 58, fullBell: 78, total: 89 },
      advanced: { allBreak: 52, fullBell: 70, total: 89 },
      expert: { allBreak: 37, fullBell: 64, total: 89 },
      master: { allBreak: 12, fullBell: 49, total: 89 },
    },
  };
})();
