"use strict";

// 音击谱面图：.ogkr 解析 → 分栏排版 → SVG。
// 浏览器（theme.js）和 Node（测试、预览工具）共用这一份，不碰 DOM。
//
// 坐标约定
//   时间：tick = 小节单位 × TRESOLUTION + grid。纵轴按 tick 线性排（乐谱时间，不按秒），
//         变速只影响 BPM 标注，不拉伸版面，这样同一种节奏在哪儿看都一样密。
//   横向：XGrid 单位，0 是场地正中，墙一般在 ±24。显示范围 X_MIN～X_MAX，之外的裁掉。
//   每一栏自下而上读，栏与栏从左往右、行与行从上往下接。
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.OngekiChart = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const LANE_KINDS = {
    LL: "L", LC: "C", LR: "R", WL: "WL", WR: "WR", EN: "EN", CL: "CL",
  };
  const LANE_COMMAND = /^(LL|LC|LR|WL|WR|EN|CL)([SNE])$/;
  const BEAM_COMMAND = /^(BM|OB)([SNE])$/;
  // WidthId → 显示宽度（X 单位）
  const BEAM_WIDTH = { 1: 4, 2: 6, 3: 8, 4: 16, 5: 24 };

  const num = (value, fallback = 0) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  };

  function parseOgkr(text) {
    const header = { tResolution: 1920, xResolution: 4096, bpm: 0, meter: [4, 4], creator: "", totals: {} };
    const lanes = new Map();
    const beams = new Map();
    const palettes = new Map();
    const raw = { taps: [], holds: [], flicks: [], bells: [], bullets: [], blocks: [], soflans: [], bpms: [], meters: [], events: [] };

    for (const line of String(text || "").split(/\r?\n/)) {
      if (!line || line[0] === "[" || line[0] === "#") continue;
      const p = line.split("\t").map((s) => s.trim());
      const cmd = p[0];
      switch (cmd) {
        case "TRESOLUTION": header.tResolution = num(p[1], 1920) || 1920; continue;
        case "XRESOLUTION": header.xResolution = num(p[1], 4096) || 4096; continue;
        case "BPM_DEF": header.bpm = num(p[1]); continue;
        case "MET_DEF": header.meter = [num(p[1], 4) || 4, num(p[2], 4) || 4]; continue;
        case "CREATOR": header.creator = p.slice(1).join(" "); continue;
      }
      if (/^T_[A-Z]+$/.test(cmd)) { header.totals[cmd.slice(2)] = num(p[1]); continue; }

      let m = LANE_COMMAND.exec(cmd);
      if (m) {
        const id = p[1];
        if (!lanes.has(id)) lanes.set(id, { id, kind: LANE_KINDS[m[1]], points: [] });
        lanes.get(id).points.push({ u: num(p[2]), g: num(p[3]), x: num(p[4]) });
        continue;
      }
      m = BEAM_COMMAND.exec(cmd);
      if (m) {
        const id = p[1];
        if (!beams.has(id)) beams.set(id, { id, width: BEAM_WIDTH[num(p[5], 2)] || 6, points: [] });
        beams.get(id).points.push({ u: num(p[2]), g: num(p[3]), x: num(p[4]) });
        continue;
      }
      switch (cmd) {
        case "TAP": case "CTP": case "XTP":
          raw.taps.push({ lane: p[1], u: num(p[2]), g: num(p[3]), x: num(p[4]), xg: num(p[5]), critical: cmd !== "TAP" });
          break;
        case "HLD": case "CHD": case "XHD":
          raw.holds.push({
            lane: p[1], u: num(p[2]), g: num(p[3]), x: num(p[4]), xg: num(p[5]),
            eu: num(p[6]), eg: num(p[7]), ex: num(p[8]), exg: num(p[9]), critical: cmd !== "HLD",
          });
          break;
        case "FLK": case "CFK":
          raw.flicks.push({ u: num(p[1]), g: num(p[2]), x: num(p[3]), dir: p[4] === "L" ? -1 : 1, critical: cmd === "CFK" });
          break;
        case "BEL": raw.bells.push({ u: num(p[1]), g: num(p[2]), x: num(p[3]) }); break;
        case "BLT": raw.bullets.push({ palette: p[1], u: num(p[2]), g: num(p[3]), x: num(p[4]), damage: String(p[5] || "NML").toUpperCase() }); break;
        // BPL 编号 发射源 偏移 目标 速度 大小(N/L) 形状(CIR/NDL/SQR) 随机偏移
        case "BPL": palettes.set(p[1], { shape: String(p[7] || "CIR").toUpperCase(), large: String(p[6] || "N").toUpperCase() === "L" }); break;
        case "LBK": raw.blocks.push({ lane: p[1], u: num(p[2]), g: num(p[3]), eu: num(p[6]), eg: num(p[7]) }); break;
        case "SFL": raw.soflans.push({ u: num(p[1]), g: num(p[2]), length: num(p[3]), speed: num(p[4], 1) }); break;
        case "BPM": raw.bpms.push({ u: num(p[1]), g: num(p[2]), bpm: num(p[3]) }); break;
        case "MET": raw.meters.push({ u: num(p[1]), g: num(p[2]), n: num(p[3], 4) || 4, d: num(p[4], 4) || 4 }); break;
        case "EST": raw.events.push({ u: num(p[1]), g: num(p[2]), label: p.slice(3).join(" ") }); break;
      }
    }

    const TR = header.tResolution;
    const XR = header.xResolution;
    const tick = (u, g) => Math.round(u * TR + g);
    const byTick = (a, b) => a.t - b.t;

    const laneList = [...lanes.values()].map((lane) => ({
      id: lane.id, kind: lane.kind,
      points: lane.points.map((pt) => ({ t: tick(pt.u, pt.g), x: pt.x })).sort(byTick),
    })).filter((lane) => lane.points.length);
    const laneById = new Map(laneList.map((lane) => [lane.id, lane]));
    const laneKind = (id) => laneById.get(id)?.kind || "C";

    const taps = raw.taps.map((n) => ({ t: tick(n.u, n.g), x: n.x + n.xg / XR, lane: n.lane, kind: laneKind(n.lane), critical: n.critical }));
    const holds = raw.holds.map((n) => ({
      t: tick(n.u, n.g), x: n.x + n.xg / XR, end: tick(n.eu, n.eg), endX: n.ex + n.exg / XR,
      lane: n.lane, kind: laneKind(n.lane), critical: n.critical,
    }));
    for (const hold of holds) if (hold.end < hold.t) hold.end = hold.t;

    const model = {
      header,
      lanes: laneList,
      laneById,
      taps: taps.sort(byTick),
      holds: holds.sort(byTick),
      flicks: raw.flicks.map((n) => ({ t: tick(n.u, n.g), x: n.x, dir: n.dir, critical: n.critical })).sort(byTick),
      bells: raw.bells.map((n) => ({ t: tick(n.u, n.g), x: n.x })).sort(byTick),
      bullets: raw.bullets.map((n) => {
        const palette = palettes.get(n.palette) || { shape: "CIR", large: false };
        return { t: tick(n.u, n.g), x: n.x, damage: n.damage, shape: palette.shape, large: palette.large };
      }).sort(byTick),
      beams: [...beams.values()].map((beam) => ({
        width: beam.width, points: beam.points.map((pt) => ({ t: tick(pt.u, pt.g), x: pt.x })).sort(byTick),
      })).filter((beam) => beam.points.length > 1),
      blocks: raw.blocks.map((b) => ({ lane: b.lane, t: tick(b.u, b.g), end: tick(b.eu, b.eg) })),
      soflans: raw.soflans.map((s) => ({ t: tick(s.u, s.g), end: tick(s.u, s.g) + Math.max(0, s.length), speed: s.speed })).sort(byTick),
      bpms: dedupeBy(raw.bpms.map((b) => ({ t: tick(b.u, b.g), bpm: b.bpm })).sort(byTick), (a, b) => a.bpm === b.bpm),
      meters: raw.meters.map((m2) => ({ t: tick(m2.u, m2.g), n: m2.n, d: m2.d })).sort(byTick),
      events: raw.events.map((e) => ({ t: tick(e.u, e.g), label: e.label })).sort(byTick),
    };
    if (!model.bpms.length || model.bpms[0].t > 0) model.bpms.unshift({ t: 0, bpm: header.bpm || model.bpms[0]?.bpm || 120 });
    model.lastTick = lastTick(model);
    model.stats = chartStats(model);
    model.durationSeconds = durationSeconds(model, model.lastTick);
    return model;
  }

  function dedupeBy(list, same) {
    const out = [];
    for (const item of list) {
      const prev = out[out.length - 1];
      if (prev && prev.t === item.t) out[out.length - 1] = item;
      else if (!prev || !same(prev, item)) out.push(item);
    }
    return out;
  }

  function lastTick(model) {
    let last = 0;
    const see = (t) => { if (t > last) last = t; };
    for (const n of model.taps) see(n.t);
    for (const n of model.holds) see(n.end);
    for (const n of model.flicks) see(n.t);
    for (const n of model.bells) see(n.t);
    for (const n of model.bullets) see(n.t);
    return last;
  }

  function chartStats(model) {
    const wall = (kind) => kind === "WL" || kind === "WR";
    const stats = { tap: 0, hold: 0, side: 0, sideHold: 0, flick: model.flicks.length, bell: model.bells.length, bullet: model.bullets.length, critical: 0 };
    for (const n of model.taps) { if (wall(n.kind)) stats.side++; else stats.tap++; if (n.critical) stats.critical++; }
    for (const n of model.holds) { if (wall(n.kind)) stats.sideHold++; else stats.hold++; if (n.critical) stats.critical++; }
    for (const n of model.flicks) if (n.critical) stats.critical++;
    return stats;
  }

  // 一拍 = TRESOLUTION / 4 tick（四分音符）
  function durationSeconds(model, endTick) {
    const beatTicks = model.header.tResolution / 4;
    let seconds = 0;
    for (let i = 0; i < model.bpms.length; i++) {
      const from = model.bpms[i].t;
      const to = Math.min(endTick, i + 1 < model.bpms.length ? model.bpms[i + 1].t : endTick);
      const bpm = model.bpms[i].bpm;
      if (to > from && bpm > 0) seconds += (to - from) / beatTicks * 60 / bpm;
    }
    return seconds;
  }

  /* ---------------------------------------------------------------- */
  /* 小节与分栏                                                         */
  /* ---------------------------------------------------------------- */

  function measuresOf(model, endTick) {
    const TR = model.header.tResolution;
    const changes = model.meters.slice();
    let [n, d] = model.header.meter;
    const list = [];
    let t = 0;
    let ci = 0;
    while (t < endTick && list.length < 5000) {
      while (ci < changes.length && changes[ci].t <= t) { [n, d] = [changes[ci].n, changes[ci].d]; ci++; }
      let len = Math.max(1, Math.round(n * TR / d));
      // 拍号在小节中途变：本小节截到变化点，从变化点起重新数小节
      if (ci < changes.length && changes[ci].t < t + len) len = changes[ci].t - t;
      list.push({ index: list.length, t, len, n, d });
      t += len;
    }
    // 短于半拍的小节是演出用的（拍号 1/32 之类），只画淡线，不占小节号
    let no = 0;
    for (const m of list) {
      m.minor = m.len < TR / 8;
      if (!m.minor) m.no = ++no;
    }
    return list;
  }

  // 拍号标注：只标持续了完整小节、且与上一次标注不同的拍号
  function meterMarks(model, measures) {
    const marks = [];
    let [n, d] = model.header.meter;
    for (const m of measures) {
      if (m.minor || (m.n === n && m.d === d)) continue;
      [n, d] = [m.n, m.d];
      marks.push({ t: m.t, n, d });
    }
    return marks;
  }

  // 分音：每个击打时刻（TAP、侧键、HOLD 头尾、FLICK）与上一个击打时刻的间隔，
  // 按全音符（TRESOLUTION）约分写成 1/16、3/16 这样；不规则的时值也照实写（19/384、5/96）。
  // 超过一整小节的不写（只留刻度）。
  function gcd(a, b) { while (b) [a, b] = [b, a % b]; return a; }

  function rhythmLabel(gap, TR) {
    if (!(gap > 0) || gap >= TR) return "";
    const g = gcd(gap, TR);
    return `${gap / g}/${TR / g}`;
  }

  function rhythmMarks(model) {
    const times = new Set();
    for (const n of model.taps) times.add(n.t);
    for (const n of model.holds) { times.add(n.t); times.add(n.end); }
    for (const n of model.flicks) times.add(n.t);
    const sorted = [...times].sort((a, b) => a - b);
    const marks = [];
    let previous = "";
    for (let i = 0; i < sorted.length; i++) {
      const label = i ? rhythmLabel(sorted[i] - sorted[i - 1], model.header.tResolution) : "";
      marks.push({ t: sorted[i], label, changed: label !== previous });
      previous = label;
    }
    return marks;
  }

  const DEFAULTS = {
    measurePx: 288,         // 一个 4/4 小节的高度
    columnMeasures: 4,      // 一栏约放几个 4/4 小节
    xMin: -30, xMax: 30,    // 显示的横向范围
    unitPx: 2.5,            // 每个 X 单位的像素
    gutter: 30,             // 栏左侧小节号宽度
    rightGutter: 34,        // 栏右侧分音标注宽度（放得下 19/384 这种）
    gap: 8,                 // 栏与栏之间的空白
    rowGap: 34,
    maxWidth: 1840,
    maxWidthLimit: 2800,    // 长谱面放宽每行栏数，避免图片过长
    targetRows: 4,
    maxHeight: 8400,        // 谱面区最高多少像素（核心截图上限 9000，留给头部和页脚）；超长谱面整体压矮小节
    minMeasurePx: 150,
    overlapTicks: 240,      // 栏首尾多画一点前后栏内容，便于衔接（1/8 小节）
  };

  function layoutChart(model, options = {}) {
    let layout = layoutOnce(model, { ...DEFAULTS, ...options });
    // 放宽到最宽还是太长的谱面：按比例压矮小节，免得截图被截断（行间距不随之缩放，所以最多再试两次）
    for (let i = 0; i < 2 && layout.height > layout.options.maxHeight; i++) {
      const o = layout.options;
      if (o.measurePx <= o.minMeasurePx) break;
      const rows = Math.round((layout.height + o.rowGap) / (layout.rowHeight + o.rowGap)) || 1;
      const scale = (o.maxHeight - (rows - 1) * o.rowGap) / (layout.height - (rows - 1) * o.rowGap);
      layout = layoutOnce(model, { ...o, measurePx: Math.max(o.minMeasurePx, Math.floor(o.measurePx * scale)) });
    }
    return layout;
  }

  function layoutOnce(model, o) {
    const TR = model.header.tResolution;
    const end = Math.max(model.lastTick + 1, TR);
    const measures = measuresOf(model, end);
    const capacity = o.columnMeasures * TR;
    const beatTicks = TR / 4;

    // 超过一栏容量的长小节按拍切开
    const pieces = [];
    for (const m of measures) {
      if (m.len <= capacity * 1.02) { pieces.push({ t: m.t, len: m.len }); continue; }
      const step = Math.max(beatTicks, Math.floor(capacity / beatTicks) * beatTicks);
      for (let s = 0; s < m.len; s += step) pieces.push({ t: m.t + s, len: Math.min(step, m.len - s) });
    }

    const columns = [];
    let current = null;
    for (const piece of pieces) {
      if (current && current.end - current.start + piece.len > capacity * 1.02) { columns.push(current); current = null; }
      if (!current) current = { start: piece.t, end: piece.t };
      current.end = piece.t + piece.len;
    }
    if (current) columns.push(current);

    const pxPerTick = o.measurePx / TR;
    const fieldWidth = (o.xMax - o.xMin) * o.unitPx;
    const pitch = o.gutter + fieldWidth + o.rightGutter + o.gap;
    const fit = (width) => Math.max(1, Math.floor((width + o.gap) / pitch));
    let perRow = fit(o.maxWidth);
    if (Math.ceil(columns.length / perRow) > o.targetRows) {
      perRow = Math.min(fit(o.maxWidthLimit), Math.ceil(columns.length / o.targetRows));
    }
    const rows = [];
    for (let i = 0; i < columns.length; i += perRow) rows.push(columns.slice(i, i + perRow));
    const columnHeight = (c) => (c.end - c.start + 2 * o.overlapTicks) * pxPerTick;

    let y = 0, maxRowHeight = 0;
    const placed = [];
    for (const row of rows) {
      const rowHeight = Math.max(...row.map(columnHeight));
      maxRowHeight = Math.max(maxRowHeight, rowHeight);
      row.forEach((c, i) => {
        const h = columnHeight(c);
        placed.push({ ...c, x: i * pitch, y: y + rowHeight - h, width: fieldWidth, height: h, index: placed.length });
      });
      y += rowHeight + o.rowGap;
    }
    const usedColumns = Math.min(perRow, columns.length);
    return {
      options: o, measures, meterMarks: meterMarks(model, measures), columns: placed, pxPerTick, fieldWidth,
      width: Math.max(0, usedColumns * pitch - o.gap),
      rhythm: rhythmMarks(model),
      height: Math.max(0, y - o.rowGap),
      rowHeight: maxRowHeight,
    };
  }

  /* ---------------------------------------------------------------- */
  /* SVG                                                               */
  /* ---------------------------------------------------------------- */

  const COLORS = {
    L: "#ff4f6e", C: "#35d68f", R: "#3fa0ff", WL: "#ff6fb5", WR: "#a98bff",
    critical: "#ffd447", bell: "#ffc93d", flick: "#eef2ff",
    bullet: { NML: "#ff3fae", STR: "#8f46e6", DNG: "#ff8a2a" },
  };

  const f1 = (v) => Math.round(v * 10) / 10;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c]));

  function interpolate(points, t) {
    if (!points.length) return 0;
    if (t <= points[0].t) return points[0].x;
    let lo = 0, hi = points.length - 1;
    if (t >= points[hi].t) return points[hi].x;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (points[mid].t <= t) lo = mid; else hi = mid;
    }
    const a = points[lo], b = points[hi];
    return b.t === a.t ? b.x : a.x + (b.x - a.x) * (t - a.t) / (b.t - a.t);
  }

  // 折线在 [from, to] 内的部分（端点插值补齐）
  function clipPath(points, from, to) {
    if (points.length < 2 || points[points.length - 1].t < from || points[0].t > to) return [];
    const out = [];
    const a = Math.max(from, points[0].t), b = Math.min(to, points[points.length - 1].t);
    out.push({ t: a, x: interpolate(points, a) });
    for (const pt of points) if (pt.t > a && pt.t < b) out.push(pt);
    out.push({ t: b, x: interpolate(points, b) });
    return out;
  }

  function inRange(list, from, to) {
    // list 按 t 排好序
    let lo = 0, hi = list.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid].t < from) lo = mid + 1; else hi = mid; }
    const out = [];
    for (let i = lo; i < list.length && list[i].t <= to; i++) out.push(list[i]);
    return out;
  }

  function renderSvg(model, layout) {
    const o = layout.options;
    const parts = [];
    const defs = [];
    for (const col of layout.columns) {
      defs.push(`<clipPath id="c${col.index}"><rect x="${f1(col.x + o.gutter)}" y="${f1(col.y)}" width="${f1(col.width)}" height="${f1(col.height)}" rx="6"/></clipPath>`);
      parts.push(renderColumn(model, layout, col));
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(layout.width)}" height="${Math.ceil(layout.height)}" viewBox="0 0 ${Math.ceil(layout.width)} ${Math.ceil(layout.height)}" class="chart-svg">`
      + `<defs>${defs.join("")}</defs>${parts.join("")}</svg>`;
  }

  function renderColumn(model, layout, col) {
    const o = layout.options;
    const TR = model.header.tResolution;
    const from = col.start - o.overlapTicks;
    const to = col.end + o.overlapTicks;
    const left = col.x + o.gutter;
    const bottom = col.y + col.height;
    const Y = (t) => f1(bottom - (t - from) * layout.pxPerTick);
    const X = (x) => f1(left + (x - o.xMin) * o.unitPx);
    const out = [];
    const body = [];

    out.push(`<rect class="col-bg" x="${f1(left)}" y="${f1(col.y)}" width="${f1(col.width)}" height="${f1(col.height)}" rx="6"/>`);

    // 墙外阴影：每条墙从墙线一直涂到栏边，场地形状自然显出来
    for (const lane of model.lanes) {
      if (lane.kind !== "WL" && lane.kind !== "WR") continue;
      const pts = clipPath(lane.points, from, to);
      if (pts.length < 2) continue;
      const edge = lane.kind === "WL" ? X(o.xMin - 2) : X(o.xMax + 2);
      const line = pts.map((pt) => `${X(pt.x)},${Y(pt.t)}`);
      body.push(`<polygon class="outside" points="${edge},${Y(pts[0].t)} ${line.join(" ")} ${edge},${Y(pts[pts.length - 1].t)}"/>`);
    }

    // 拍线与小节线
    for (const m of layout.measures) {
      if (m.t > to) break;
      if (m.t + m.len < from) continue;
      const beat = m.minor ? Infinity : TR / m.d;
      for (let t = m.t + beat; t < m.t + m.len - 1; t += beat) if (t >= from && t <= to) body.push(`<line class="beat" x1="${X(o.xMin)}" x2="${X(o.xMax)}" y1="${Y(t)}" y2="${Y(t)}"/>`);
      if (m.t >= from) body.push(`<line class="${m.minor ? "beat" : "bar"}" x1="${X(o.xMin)}" x2="${X(o.xMax)}" y1="${Y(m.t)}" y2="${Y(m.t)}"/>`);
    }

    // 激光
    for (const beam of model.beams) {
      const pts = clipPath(beam.points, from, to);
      if (pts.length < 2) continue;
      const half = beam.width / 2;
      const l = pts.map((pt) => `${X(pt.x - half)},${Y(pt.t)}`);
      const r = pts.slice().reverse().map((pt) => `${X(pt.x + half)},${Y(pt.t)}`);
      body.push(`<polygon class="beam" points="${l.join(" ")} ${r.join(" ")}"/>`);
      body.push(`<polyline class="beam-core" points="${pts.map((pt) => `${X(pt.x)},${Y(pt.t)}`).join(" ")}"/>`);
    }

    // 轨道和墙线
    for (const lane of model.lanes) {
      if (!COLORS[lane.kind]) continue;
      const pts = clipPath(lane.points, from, to);
      if (pts.length < 2) continue;
      const cls = lane.kind === "WL" || lane.kind === "WR" ? "wall" : "rail";
      body.push(`<polyline class="${cls} k-${lane.kind}" points="${pts.map((pt) => `${X(pt.x)},${Y(pt.t)}`).join(" ")}"/>`);
    }

    // 墙封锁（LBK）：墙线加粗成虚线
    for (const block of model.blocks) {
      const lane = model.laneById.get(block.lane);
      if (!lane || block.end < from || block.t > to) continue;
      const pts = clipPath(lane.points, Math.max(from, block.t), Math.min(to, block.end));
      if (pts.length >= 2) body.push(`<polyline class="block" points="${pts.map((pt) => `${X(pt.x)},${Y(pt.t)}`).join(" ")}"/>`);
    }

    // 长按：身子沿所属轨道走，与轨道的偏移从头到尾线性过渡
    for (const hold of model.holds) {
      if (hold.end < from || hold.t > to) continue;
      const lane = model.laneById.get(hold.lane);
      const path = holdPath(hold, lane);
      const pts = clipPath(path, from, to);
      if (pts.length < 2) continue;
      const side = hold.kind === "WL" || hold.kind === "WR";
      body.push(`<polyline class="hold-body${side ? " side" : ""} k-${hold.kind}" points="${pts.map((pt) => `${X(pt.x)},${Y(pt.t)}`).join(" ")}"/>`);
      if (hold.end <= to && hold.end >= from) body.push(`<rect class="hold-end k-${hold.kind}" x="${f1(X(hold.endX) - 5)}" y="${f1(Y(hold.end) - 1.5)}" width="10" height="3" rx="1.5"/>`);
    }

    // 子弹放在最下层的音符之下，避免盖住音符
    for (const b of inRange(model.bullets, from, to)) {
      if (b.x < o.xMin - 1 || b.x > o.xMax + 1) continue;
      body.push(bulletShape(b, X(b.x), Y(b.t)));
    }

    const heads = [];
    for (const hold of model.holds) if (hold.t >= from && hold.t <= to) heads.push(hold);
    for (const n of [...inRange(model.taps, from, to), ...heads].sort((a, b) => a.t - b.t)) {
      body.push(tapShape(n, X(n.x), Y(n.t)));
    }
    for (const run of flickRuns(inRange(model.flicks, from, to))) {
      body.push(flickShape(run, X(run.x1 - FLICK_HALF_UNITS), X(run.x2 + FLICK_HALF_UNITS), Y(run.t)));
    }
    for (const n of inRange(model.bells, from, to)) {
      if (n.x < o.xMin - 2 || n.x > o.xMax + 2) continue;
      body.push(bellShape(X(n.x), Y(n.t)));
    }

    // 首尾重叠区：盖一层半透明，提示这是前后栏的内容
    const fade = o.overlapTicks * layout.pxPerTick;
    body.push(`<rect class="overlap" x="${f1(left)}" y="${f1(col.y)}" width="${f1(col.width)}" height="${f1(fade)}"/>`);
    body.push(`<rect class="overlap" x="${f1(left)}" y="${f1(bottom - fade)}" width="${f1(col.width)}" height="${f1(fade)}"/>`);
    body.push(`<line class="seam" x1="${f1(left)}" x2="${f1(left + col.width)}" y1="${f1(col.y + fade)}" y2="${f1(col.y + fade)}"/>`);
    body.push(`<line class="seam" x1="${f1(left)}" x2="${f1(left + col.width)}" y1="${f1(bottom - fade)}" y2="${f1(bottom - fade)}"/>`);

    out.push(`<g clip-path="url(#c${col.index})">${body.join("")}</g>`);

    // 变速条：栏右缘一条细带，慢＝青、快＝橙、停/倒退＝白
    for (const s of model.soflans) {
      if (s.end < from || s.t > to || Math.abs(s.speed - 1) < 0.001) continue;
      const a = Math.max(s.t, from), b = Math.min(s.end, to);
      if (b <= a) continue;
      const cls = s.speed <= 0.001 ? "sv-stop" : s.speed < 1 ? "sv-slow" : "sv-fast";
      out.push(`<rect class="sv ${cls}" x="${f1(left - 4.5)}" y="${Y(b)}" width="3" height="${f1(Y(a) - Y(b))}"/>`);
    }

    // 左侧刻度：小节号、BPM、拍号、事件
    const labels = [];
    for (const m of layout.measures) {
      if (m.minor || m.t < col.start || m.t >= col.end) continue;
      labels.push({ y: Y(m.t), text: String(m.no), cls: "measure-no" });
    }
    for (const b of model.bpms) {
      if (b.t < col.start || b.t >= col.end) continue;
      labels.push({ y: Y(b.t) - 11, text: trimNumber(b.bpm), cls: "bpm-mark" });
    }
    for (const m of layout.meterMarks) {
      if (m.t < col.start || m.t >= col.end) continue;
      labels.push({ y: Y(m.t) - 22, text: `${m.n}/${m.d}`, cls: "meter-mark" });
    }
    for (const e of model.events) {
      if (e.t < col.start || e.t >= col.end || !/BOSS/i.test(e.label)) continue;
      labels.push({ y: Y(e.t), text: "BOSS", cls: "event-mark" });
    }
    // 挨得太近的标签只留优先级高的（小节号 > BPM > 拍号 > 事件），连续变速时不会叠成一摞
    const kept = [];
    for (const label of labels) {
      const y = Number(label.y);
      if (kept.some((other) => Math.abs(other.y - y) < 11)) continue;
      kept.push({ ...label, y });
    }
    for (const label of kept) {
      out.push(`<text class="${label.cls}" x="${f1(left - 7)}" y="${f1(Number(label.y) + 3.5)}" text-anchor="end">${esc(label.text)}</text>`);
    }
    out.push(renderRhythm(layout, col, left + col.width, Y));
    return `<g class="column">${out.join("")}</g>`;
  }

  // 栏右侧：每个击打时刻一道短刻度，旁边写与上一个的间隔。
  // 字放不下时先保证节奏变化处的数字，再在空隙里补上连续相同的数字。
  function renderRhythm(layout, col, right, Y) {
    const marks = layout.rhythm.filter((m) => m.t >= col.start && m.t < col.end);
    const out = [];
    for (const m of marks) out.push(`<line class="rhythm-tick" x1="${f1(right + 1)}" x2="${f1(right + 4)}" y1="${Y(m.t)}" y2="${Y(m.t)}"/>`);
    const placed = [];
    const fits = (y) => placed.every((other) => Math.abs(other - y) >= 9.5);
    const labelled = marks.filter((m) => m.label);
    for (const pass of [true, false]) {
      for (const m of labelled) {
        if (m.changed !== pass) continue;
        const y = Number(Y(m.t));
        if (!fits(y)) continue;
        placed.push(y);
        // 533/1920 这种特别长的横向压到窄边以内，不压到隔壁栏
        const squeeze = m.label.length > 6 ? ` textLength="${layout.options.rightGutter - 7}" lengthAdjust="spacingAndGlyphs"` : "";
        out.push(`<text class="rhythm" x="${f1(right + 6)}" y="${f1(y + 3.3)}"${squeeze}>${m.label}</text>`);
      }
    }
    return out.join("");
  }

  function holdPath(hold, lane) {
    if (!lane || lane.points.length < 2) return [{ t: hold.t, x: hold.x }, { t: hold.end, x: hold.endX }];
    const span = Math.max(1, hold.end - hold.t);
    const startOffset = hold.x - interpolate(lane.points, hold.t);
    const endOffset = hold.endX - interpolate(lane.points, hold.end);
    const at = (t) => interpolate(lane.points, t) + startOffset + (endOffset - startOffset) * (t - hold.t) / span;
    const pts = [{ t: hold.t, x: hold.x }];
    for (const pt of lane.points) if (pt.t > hold.t && pt.t < hold.end) pts.push({ t: pt.t, x: at(pt.t) });
    pts.push({ t: hold.end, x: hold.endX });
    return pts;
  }

  // 尺寸比例参照游戏/编辑器贴图：TAP 40×16、侧键 40×40、子弹 40×40（针形 30×80）。
  // 这里 TAP 宽 12px，其余按同一比例缩放，子弹略缩小以免满屏遮挡音符。
  function tapShape(n, x, y) {
    const crit = n.critical ? " crit" : "";
    if (n.kind === "WL" || n.kind === "WR") {
      // 侧键：五边形箭头，尖端指向场内，中间一道白线
      const d = n.kind === "WL" ? 1 : -1, w = 13, h = 11;
      const back = x - d * w / 2, shoulder = x + d * 1.5, tip = x + d * w / 2;
      const pts = `${f1(back)},${f1(y - h / 2)} ${f1(shoulder)},${f1(y - h / 2)} ${f1(tip)},${f1(y)} ${f1(shoulder)},${f1(y + h / 2)} ${f1(back)},${f1(y + h / 2)}`;
      return `<polygon class="side${crit} k-${n.kind}" points="${pts}"/>`
        + `<line class="side-mark" x1="${f1(back + d * 2)}" x2="${f1(tip - d * 2.5)}" y1="${f1(y)}" y2="${f1(y)}"/>`;
    }
    const w = 12, h = 5;
    return `<rect class="tap${crit} k-${n.kind}" x="${f1(x - w / 2)}" y="${f1(y - h / 2)}" width="${w}" height="${h}" rx="2"/>`
      + `<rect class="tap-shine" x="${f1(x - w / 2 + 2.5)}" y="${f1(y - h / 2 + 1)}" width="${w - 5}" height="1.2" rx=".6"/>`;
  }

  // FLICK 文件里没有长度：同一拍横向挨着的几个 FLICK 在游戏里连成一根长条，这里也合并画。
  // 细条压在判定那一拍上（和 TAP 差不多粗），箭头画在条的上方，不挡时间位置。
  const FLICK_HALF_UNITS = 4;       // 单个 FLICK 半宽（X 单位）
  const FLICK_JOIN_UNITS = 12.5;    // 中心相距不超过这个就算挨着

  function flickRuns(flicks) {
    const groups = new Map();
    for (const n of flicks) {
      const key = `${n.t}|${n.dir}|${n.critical ? 1 : 0}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(n);
    }
    const runs = [];
    for (const list of groups.values()) {
      list.sort((a, b) => a.x - b.x);
      let run = null;
      for (const n of list) {
        if (run && n.x - run.x2 <= FLICK_JOIN_UNITS) { run.x2 = n.x; run.count++; continue; }
        run = { t: n.t, dir: n.dir, critical: n.critical, x1: n.x, x2: n.x, count: 1 };
        runs.push(run);
      }
    }
    return runs;
  }

  // left / right 是像素坐标
  function flickShape(run, left, right, y) {
    const crit = run.critical ? " crit" : "";
    const d = run.dir, h = 4;
    const out = [`<rect class="flick${crit}" x="${f1(left)}" y="${f1(y - h / 2)}" width="${f1(right - left)}" height="${h}" rx="1.5"/>`];
    const step = 5, count = Math.max(2, Math.floor((right - left - 3) / step));
    const start = (left + right) / 2 - (count - 1) * step / 2;
    for (let i = 0; i < count; i++) {
      const cx = start + i * step;
      // 尖端朝 dir 那边：左 ≪、右 ≫
      out.push(`<polyline class="flick-arrow${crit}" points="${f1(cx - d * 1.5)},${f1(y - 11)} ${f1(cx + d * 1.5)},${f1(y - 7.5)} ${f1(cx - d * 1.5)},${f1(y - 4)}"/>`);
    }
    return out.join("");
  }

  function bulletShape(b, x, y) {
    // 弹幕常常很密，整体按 0.75 缩小，免得相邻的叠成一片
    const s = (b.large ? 1.4 : 1) * 0.75;
    const cls = `bullet d-${COLORS.bullet[b.damage] ? b.damage : "NML"}`;
    if (b.shape === "NDL") {
      // 针形：上端平、下端尖，尖端是落点；下半截泛白
      const w = 3.6 * s, top = y - 17 * s, shoulder = y - 6 * s, tip = y + 2 * s;
      return `<polygon class="${cls}" points="${f1(x - w)},${f1(top)} ${f1(x + w)},${f1(top)} ${f1(x + w)},${f1(shoulder)} ${f1(x)},${f1(tip)} ${f1(x - w)},${f1(shoulder)}"/>`
        + `<polygon class="bullet-glow" points="${f1(x - w * .55)},${f1(shoulder - 3 * s)} ${f1(x + w * .55)},${f1(shoulder - 3 * s)} ${f1(x)},${f1(tip - 2 * s)}"/>`;
    }
    if (b.shape === "SQR") {
      // 方形：竖长圆角块
      const w = 3.6 * s, top = y - 14 * s, bottom = y + 2 * s;
      return `<rect class="${cls}" x="${f1(x - w)}" y="${f1(top)}" width="${f1(2 * w)}" height="${f1(bottom - top)}" rx="${f1(1.6 * s)}"/>`
        + `<rect class="bullet-glow" x="${f1(x - w * .45)}" y="${f1(top + 2 * s)}" width="${f1(w * .9)}" height="${f1(bottom - top - 4 * s)}" rx="${f1(.8 * s)}"/>`;
    }
    // 圆形：圆环
    return `<circle class="${cls} ring" cx="${x}" cy="${y}" r="${f1(4.4 * s)}"/>`;
  }

  function bellShape(x, y) {
    return `<circle class="bell" cx="${x}" cy="${y}" r="3.6"/><circle class="bell-core" cx="${x}" cy="${y}" r="1.3"/>`;
  }

  function trimNumber(value) {
    const n = Number(value);
    return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
  }

  // 图例用的小样（同一套形状，保证和谱面里看到的一致）
  function legendSvg(kind) {
    const W = 36, H = 24, x = W / 2, y = H / 2;
    let inner = "";
    switch (kind) {
      case "tap": inner = tapShape({ kind: "L" }, x - 7, y) + tapShape({ kind: "R" }, x + 7, y); break;
      case "critical": inner = tapShape({ kind: "C", critical: true }, x, y); break;
      case "hold": inner = `<polyline class="hold-body k-C" points="${x},${H - 2} ${x},2"/>` + tapShape({ kind: "C" }, x, H - 4); break;
      case "side": inner = tapShape({ kind: "WL" }, x - 8, y) + tapShape({ kind: "WR" }, x + 8, y); break;
      case "flick": inner = flickShape({ dir: -1 }, x - 12, x + 12, y + 5); break;
      case "bell": inner = bellShape(x, y); break;
      case "bullet": inner = bulletShape({ shape: "NDL", damage: "NML" }, x - 10, y + 7) + bulletShape({ shape: "CIR", damage: "NML" }, x, y + 1) + bulletShape({ shape: "SQR", damage: "NML" }, x + 10, y + 6); break;
      case "damage": inner = bulletShape({ shape: "CIR", damage: "NML" }, x - 10, y) + bulletShape({ shape: "CIR", damage: "STR" }, x, y) + bulletShape({ shape: "CIR", damage: "DNG" }, x + 10, y); break;
      case "beam": inner = `<rect class="beam" x="${x - 6}" y="1" width="12" height="${H - 2}"/><line class="beam-core" x1="${x}" x2="${x}" y1="1" y2="${H - 1}"/>`; break;
      case "soflan": inner = `<rect class="sv sv-slow" x="${x - 6}" y="2" width="4" height="${H - 4}"/><rect class="sv sv-fast" x="${x + 2}" y="2" width="4" height="${H - 4}"/>`; break;
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${inner}</svg>`;
  }

  function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return "";
    const s = Math.round(seconds);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }

  function bpmText(model) {
    const values = model.bpms.map((b) => b.bpm).filter((v) => v > 0 && v < 2000);
    if (!values.length) return "";
    const lo = Math.min(...values), hi = Math.max(...values);
    return lo === hi ? trimNumber(lo) : `${trimNumber(lo)}–${trimNumber(hi)}`;
  }

  return { parseOgkr, layoutChart, renderSvg, legendSvg, measuresOf, interpolate, flickRuns, rhythmMarks, rhythmLabel, formatDuration, bpmText, DEFAULTS, COLORS };
});
