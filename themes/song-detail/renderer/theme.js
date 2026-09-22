"use strict";

(() => {
  const DIFFICULTIES = [
    { id: 0, key: "BASIC", label: "Basic" },
    { id: 1, key: "ADVANCED", label: "Advanced" },
    { id: 2, key: "EXPERT", label: "Expert" },
    { id: 3, key: "MASTER", label: "Master" },
    { id: 10, key: "LUNATIC", label: "Lunatic" },
  ];

  const $ = (id) => document.getElementById(id);
  const dash = (value) => value === null || value === undefined || value === "" ? "-" : String(value);
  const comma = (value) => Number(value).toLocaleString("en-US");

  function div(className, text = "") {
    const element = document.createElement("div");
    element.className = className;
    element.textContent = text;
    return element;
  }

  function setLayeredText(element, text) {
    element.textContent = text;
    element.dataset.text = text;
  }

  function setBossText(element, label, value) {
  element.replaceChildren();

  const labelSpan = div("boss-label", label);
  const valueSpan = div("boss-value", dash(value));

  element.append(labelSpan, valueSpan);
}

  function normalizeCharts(charts) {
    const byId = new Map();
    for (const chart of charts || []) byId.set(Number(chart.difficultyId), chart);
    return DIFFICULTIES.map((difficulty) => ({ difficulty, chart: byId.get(difficulty.id) || null }));
  }

  function countCell(label, value) {
    const cell = div("count");
    cell.append(div("count-label", label));
    cell.append(div("count-value", dash(value)));
    return cell;
  }

  function rowClass(difficulty, extra = "") {
    return `chart-row difficulty-${difficulty.key.toLowerCase()}${extra ? ` ${extra}` : ""}`;
  }

  function unavailableRow(difficulty) {
    const row = div(rowClass(difficulty, "unavailable"));
    for (let index = 0; index < 9; index += 1) row.append(div("", "-"));
    return row;
  }

  function chartRow(difficulty, chart) {
    if (!chart || chart.hasChart === false) return unavailableRow(difficulty);

    const personal = chart.personal || {};
    const played = personal.played === true;
    const row = div(rowClass(difficulty));
    row.append(div("difficulty", difficulty.label));
    row.append(div("constant", chart.constant == null ? "-" : Number(chart.constant).toFixed(1)));
    row.append(div("technical-rank", played ? dash(personal.technicalRank) : "-"));
    row.append(div("mark", played && personal.isAllBreak ? "AB" : "-"));
    row.append(div("mark", played && personal.isFullBell ? "FB" : "-"));
    row.append(div("score", played && personal.techScore != null ? comma(personal.techScore) : "-"));
    row.append(div("designer", dash(chart.chartDesigner)));
    row.append(countCell("Chain", chart.noteCount));
    row.append(countCell("Bell", chart.bellCount));
    return row;
  }

  function fitSingleLine(element, minimumSize) {
    if (!element) return;
    // theme.css 是字号的唯一来源。每次重算前先移除上一次为防溢出
    // 写入的内联字号，再从当前 CSS 的计算值开始只缩不放大。
    element.style.removeProperty("font-size");
    let size = Number.parseFloat(getComputedStyle(element).fontSize);
    if (!Number.isFinite(size) || size <= 0) return;
    const floor = Math.min(size, Number(minimumSize) || 12);
    while (element.scrollWidth > element.clientWidth && size > floor) {
      size -= 1;
      element.style.fontSize = `${size}px`;
    }
  }

  function fitThemeText() {
    fitSingleLine($("status"), 48);
    document.querySelectorAll(".meta strong").forEach((element) => fitSingleLine(element, 24));
    fitSingleLine($("boss-name"), 18);
    fitSingleLine($("boss-card"), 18);
    fitSingleLine($("boss-level"), 18);
    fitSingleLine($("attribute"), 22);
    document.querySelectorAll(".difficulty").forEach((element) => fitSingleLine(element, 32));
    document.querySelectorAll(".designer").forEach((element) => fitSingleLine(element, 24));
  }

  window.__FIT_SONG_THEME_TEXT__ = fitThemeText;

  // 等图有预算。曲绘走公网（大饼是 CDN 哈希，rinnet 是曲库里的公网图），拉不动时
  // 用本地占位图顶上并记一条提示 —— 不能因为一张图挂住就报「渲染失败」。
  const IMAGE_BUDGET_MS = 30000;
  window.__THEME_WARNINGS__ = [];

  function settleImage(image) {
    return new Promise((resolve) => {
      const done = () => {
        image.removeEventListener("load", done);
        image.removeEventListener("error", done);
        resolve(image.naturalWidth > 0 && image.naturalHeight > 0);
      };
      if (image.complete) done();
      else {
        image.addEventListener("load", done);
        image.addEventListener("error", done);
      }
    });
  }

  async function waitForImages() {
    const images = [...document.images];
    const originSrc = new Map(images.map((image) => [image, image.currentSrc || image.src]));
    const outstanding = new Set(images);
    const label = (image) => image.dataset.loadLabel || "图片";
    const isRemote = (image) => /^https?:/i.test(originSrc.get(image) || "");
    const degrade = (image) => {
      if (!outstanding.delete(image)) return;
      const fallback = image.dataset.fallbackSrc;
      if (fallback) {
        image.src = fallback;
        delete image.dataset.fallbackSrc;
        window.__THEME_WARNINGS__.push(`${label(image)}没拉下来，图中已换成占位图：${originSrc.get(image)}`);
      } else {
        image.style.visibility = "hidden";
        window.__THEME_WARNINGS__.push(`${label(image)}没拉下来，图中已隐藏：${originSrc.get(image)}`);
      }
    };
    const settled = Promise.all(images.map(async (image) => {
      if (await settleImage(image)) return void outstanding.delete(image);
      // 本地主题资源（底图）缺了才算打包坏了；公网资源拉不动只降级。
      if (!isRemote(image)) throw new Error(`${label(image)}加载失败：${originSrc.get(image)}`);
      degrade(image);
    }));
    await Promise.race([settled, new Promise((resolve) => setTimeout(resolve, IMAGE_BUDGET_MS))]);
    for (const image of [...outstanding]) if (isRemote(image)) degrade(image);
  }

  async function render() {
    const data = window.__THEME_DATA__;
    if (!data) throw new Error("没有找到单曲主题数据 preview-data.js");
    const song = data.song || {};

    const jacket = $("jacket");
    jacket.dataset.loadLabel = "曲绘";
    if (song.jacketFallbackUrl) jacket.dataset.fallbackSrc = song.jacketFallbackUrl;
    jacket.src = song.jacketUrl;
    setLayeredText($("song-title"), dash(song.title));
    setLayeredText($("artist"), dash(song.artist));
    const status = song.status === "online" ? "online" : "unavailable";
    setLayeredText($("status"), `Status: ${status}`);
    $("version").textContent = dash(song.version);
    $("category").textContent = dash(song.category);
    $("bpm").textContent = dash(song.bpm);
    $("duration").textContent = dash(song.duration);
    $("song-id").textContent = dash(song.songId);
    $("release-date").textContent = dash(song.releaseDate);
    setBossText($("boss-name"), "Boss name:", song.bossName);
    setBossText($("boss-card"), "Boss card:", song.bossCardName);
    setBossText($("boss-level"), "Boss Lv:", song.bossLevel);
    setBossText($("attribute"), "属性：", song.attribute);

    const rows = $("chart-rows");
    for (const { difficulty, chart } of normalizeCharts(data.charts)) {
      rows.append(chartRow(difficulty, chart));
    }

    await document.fonts.ready;
    // 只在文字确实溢出时，从 CSS 设定字号向下收缩。
    fitThemeText();
    await waitForImages();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    window.__THEME_READY__ = true;
  }

  render().catch((error) => {
    window.__THEME_ERROR__ = error?.message || String(error);
    const element = $("render-error");
    element.textContent = window.__THEME_ERROR__;
    element.style.display = "block";
  });
})();
