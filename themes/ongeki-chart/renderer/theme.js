"use strict";

// 数据契约见 ../README.md。核心读取 window.__THEME_SIZE__ 决定截图尺寸。
(async () => {
  const data = window.__THEME_DATA__;
  if (!data || typeof data.ogkr !== "string") throw new Error("谱面图缺少 ogkr 数据");
  const C = window.OngekiChart;
  const $ = (id) => {
    const node = document.getElementById(id);
    if (!node) throw new Error(`谱面图模板缺少元素：#${id}`);
    return node;
  };
  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const DIFFICULTIES = {
    0: { name: "BASIC", color: "#35c980" },
    1: { name: "ADVANCED", color: "#efb72c" },
    2: { name: "EXPERT", color: "#ee5e73" },
    3: { name: "MASTER", color: "#9b63ea" },
    10: { name: "LUNATIC", color: "#e4e7ef", light: true },
  };

  const song = data.song || {};
  const chart = data.chart || {};
  const model = C.parseOgkr(data.ogkr);
  const layout = C.layoutChart(model, data.layout || {});
  if (!layout.columns.length) throw new Error("谱面里没有可显示的内容");

  const diff = DIFFICULTIES[chart.difficultyId] || { name: chart.difficulty || "", color: "#9b63ea" };
  document.documentElement.style.setProperty("--diff", diff.color);

  const badge = $("difficulty");
  badge.append(el("span", "", diff.name));
  if (chart.level) badge.append(el("b", "", chart.level));
  if (Number.isFinite(Number(chart.constant)) && Number(chart.constant) > 0) badge.append(el("small", "", Number(chart.constant).toFixed(1)));
  if (diff.light) badge.classList.add("light");
  $("song-id").textContent = song.songId ? `ID ${song.songId}` : "";
  $("title").textContent = song.title || "";
  $("artist").textContent = song.artist || "";

  const facts = [
    ["BPM", C.bpmText(model)],
    ["时长", C.formatDuration(model.durationSeconds)],
    ["物量", chart.noteCount ? String(chart.noteCount) : ""],
    ["谱师", chart.designer || model.header.creator || ""],
  ];
  for (const [label, value] of facts) {
    if (!value) continue;
    const item = el("div");
    item.append(el("dt", "", label), el("dd", "", value));
    $("facts").append(item);
  }

  const s = model.stats;
  const counts = [
    ["TAP", s.tap], ["HOLD", s.hold], ["SIDE", s.side + s.sideHold], ["FLICK", s.flick],
    ["BELL", chart.bellCount || s.bell], ["BULLET", s.bullet],
  ];
  for (const [label, value] of counts) {
    const item = el("li");
    item.append(el("strong", "", String(value)), el("span", "", label));
    $("counts").append(item);
  }

  const legend = [
    ["tap", "TAP（红/绿/蓝）"], ["critical", "金框＝CRITICAL"], ["hold", "HOLD"],
    ["side", "SIDE"], ["flick", "FLICK"], ["bell", "BELL"],
    ["bullet", "子弹 针/圆/方"], ["damage", "粉（普通）紫（硬）橙（危险）"], ["beam", "激光"], ["soflan", "变速 慢/快"],
    ["block", "墙封锁"], ["inverted", "左右反转"],
  ];
  for (const [kind, label] of legend) {
    const item = el("li");
    item.innerHTML = C.legendSvg(kind);
    item.append(el("span", "", label));
    $("legend").append(item);
  }

  $("chart").innerHTML = C.renderSvg(model, layout);

  const jacket = $("jacket");
  if (song.jacketUrl) {
    const ok = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 15000);
      jacket.onload = () => { clearTimeout(timer); resolve(jacket.naturalWidth > 0); };
      jacket.onerror = () => { clearTimeout(timer); resolve(false); };
      jacket.src = song.jacketUrl;
    });
    if (!ok) jacket.hidden = true;
  } else {
    jacket.hidden = true;
  }

  await document.fonts.ready;
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const sheet = $("sheet");
  window.__THEME_SIZE__ = { width: Math.ceil(sheet.offsetWidth), height: Math.ceil(sheet.offsetHeight) };
  window.__THEME_READY__ = true;
})().catch((error) => { window.__THEME_ERROR__ = error?.message || String(error); });
