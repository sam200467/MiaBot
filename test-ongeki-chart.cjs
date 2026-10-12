"use strict";

// 谱面图：ogkr 解析、分栏排版、SVG 输出、本地谱面文件索引和 /谱面图 能力。
// 用的是手写的小谱面，不依赖任何游戏数据。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const C = require("./themes/ongeki-chart/renderer/ongeki-chart.js");
const { createChartFileIndex } = require("./ongeki-chart-files.cjs");
const core = require("./mia-core.cjs");

const SAMPLE = [
  "[HEADER]",
  "VERSION\t1\t7\t0",
  "CREATOR\tTester",
  "BPM_DEF\t150\t150\t150\t150",
  "MET_DEF\t4\t4",
  "TRESOLUTION\t1920",
  "XRESOLUTION\t4096",
  "",
  "[B_PALETTE]",
  "BPL\tA0\tUPS\t0\tFIX\t1\tN\tNDL\t0",
  "",
  "[COMPOSITION]",
  "BPM\t0\t0\t150",
  "BPM\t4\t0\t300",
  "MET\t2\t0\t1\t32",
  "MET\t2\t60\t4\t4",
  "SFL\t3\t0\t960\t0.5\t0",
  "",
  "[LANE]",
  "LLS\t0\t0\t0\t-12\t0\t0\t0",
  "LLE\t0\t8\t0\t-12\t0\t0\t0",
  "LCS\t1\t0\t0\t0\t0\t0\t0",
  "LCN\t1\t4\t0\t8\t0\t0\t0",
  "LCE\t1\t8\t0\t0\t0\t0\t0",
  "WLS\t2\t0\t0\t-24\t0\t0\t0",
  "WLE\t2\t8\t0\t-24\t0\t0\t0",
  "WRS\t3\t0\t0\t24\t0\t0\t0",
  "WRE\t3\t8\t0\t24\t0\t0\t0",
  "",
  "[BULLET]",
  "BLT\tA0\t1\t0\t4\tNML",
  "BLT\tA0\t1\t480\t90\tDNG",
  "",
  "[BELL]",
  "BEL\t1\t960\t0\t--",
  "",
  "[FLICK]",
  "FLK\t2\t480\t0\tL",
  "CFK\t2\t960\t0\tR",
  "",
  "[NOTES]",
  "TAP\t0\t0\t960\t-12\t0",
  "CTP\t1\t1\t0\t0\t2048",
  "TAP\t2\t1\t0\t-24\t0",
  "HLD\t1\t3\t0\t6\t0\t5\t0\t6\t0",
  "CHD\t3\t5\t0\t24\t0\t6\t0\t24\t0",
].join("\r\n");

test("解析：时间、坐标、轨道归属与统计", () => {
  const model = C.parseOgkr(SAMPLE);
  assert.equal(model.header.tResolution, 1920);
  assert.equal(model.header.creator, "Tester");
  assert.equal(model.lanes.length, 4);

  const [tap, critical, side] = model.taps;
  assert.deepEqual([tap.t, tap.x, tap.kind, tap.critical], [960, -12, "L", false]);
  assert.equal(critical.t, 1920);
  assert.equal(critical.x, 0.5, "XGrid 的细分要按 XRESOLUTION 折算");
  assert.equal(critical.critical, true);
  assert.equal(side.kind, "WL", "挂在墙上的 TAP 是侧键");

  assert.equal(model.holds.length, 2);
  assert.deepEqual([model.holds[0].t, model.holds[0].end], [3 * 1920, 5 * 1920]);
  assert.equal(model.holds[1].kind, "WR");
  assert.equal(model.holds[1].critical, true);

  assert.deepEqual(model.flicks.map((f) => [f.dir, f.critical]), [[-1, false], [1, true]]);
  assert.equal(model.bells.length, 1);
  assert.equal(model.bullets[0].shape, "NDL", "子弹形状来自调色板");
  assert.equal(model.bullets[1].damage, "DNG");
  assert.deepEqual(model.stats, { tap: 2, hold: 1, side: 1, sideHold: 1, flick: 2, bell: 1, bullet: 2, critical: 3 });
  assert.equal(model.lastTick, 6 * 1920);
  assert.equal(C.bpmText(model), "150–300");
  // 前 4 小节 150 BPM（每小节 1.6 秒），后 2 小节 300 BPM（每小节 0.8 秒）
  assert.ok(Math.abs(model.durationSeconds - (4 * 1.6 + 2 * 0.8)) < 1e-9);
  assert.equal(C.formatDuration(model.durationSeconds), "0:08");
});

test("轨道插值：中间点之间线性过渡，两端外取端点", () => {
  const model = C.parseOgkr(SAMPLE);
  const center = model.laneById.get("1");
  assert.equal(C.interpolate(center.points, 2 * 1920), 4);
  assert.equal(C.interpolate(center.points, -100), 0);
  assert.equal(C.interpolate(center.points, 99999), 0);
});

test("小节：拍号变化切小节，演出用的极短小节不占小节号", () => {
  const model = C.parseOgkr(SAMPLE);
  const measures = C.measuresOf(model, model.lastTick + 1);
  const gimmick = measures.find((m) => m.t === 2 * 1920);
  assert.equal(gimmick.len, 60);
  assert.equal(gimmick.minor, true);
  assert.equal(gimmick.no, undefined);
  const after = measures.find((m) => m.t === 2 * 1920 + 60);
  assert.equal(after.no, 3, "极短小节之后的编号接着数，不跳号");
  assert.equal(after.len, 1920);
});

test("小节：连成一段的演出短拍号（1/8、1/16）按每 4 拍并成一小节编号", () => {
  // Apollo：50:0 起 1/8 拍号一直到 53:960 回到 4/4；参考站在这里按 unit 编号
  const lines = ["[HEADER]", "TRESOLUTION\t1920", "[COMPOSITION]", "MET\t2\t0\t1\t8", "MET\t4\t960\t4\t4",
    "MET\t6\t0\t1\t16", "MET\t6\t960\t4\t4", "[NOTES]", "TAP\t0\t0\t0\t0\t0", "TAP\t0\t9\t0\t0\t0"];
  const model = C.parseOgkr(lines.join("\n"));
  const numbered = C.measuresOf(model, model.lastTick + 1).filter((m) => m.no).map((m) => [m.no, m.t / 1920]);
  assert.deepEqual(numbered.slice(0, 9), [[1, 0], [2, 1], [3, 2], [4, 3], [5, 4], [6, 4.5], [7, 5.5], [8, 6], [9, 6.5]]);
});

test("分栏：每栏不超过容量，首尾相接、不漏不重", () => {
  const model = C.parseOgkr(SAMPLE);
  const layout = C.layoutChart(model, { columnMeasures: 2 });
  assert.ok(layout.columns.length >= 3);
  for (let i = 1; i < layout.columns.length; i++) {
    assert.equal(layout.columns[i].start, layout.columns[i - 1].end);
  }
  assert.equal(layout.columns[0].start, 0);
  assert.ok(layout.columns.at(-1).end > model.lastTick);
  for (const column of layout.columns) assert.ok(column.end - column.start <= 2 * 1920 * 1.02);
  // 拍号 4/4 → 1/32 → 4/4 绕一圈回到原样，不该标出任何拍号
  assert.deepEqual(layout.meterMarks, []);
});

test("长谱面放宽每行栏数，行数不超过目标", () => {
  const lines = ["[HEADER]", "TRESOLUTION\t1920", "[LANE]", "LCS\t0\t0\t0\t0\t0\t0\t0", "LCE\t0\t400\t0\t0\t0\t0\t0", "[NOTES]"];
  for (let m = 0; m < 400; m++) lines.push(`TAP\t0\t${m}\t0\t0\t0`);
  const model = C.parseOgkr(lines.join("\n"));
  const layout = C.layoutChart(model);
  const rows = new Set(layout.columns.map((c) => c.y + c.height)).size;
  assert.ok(layout.width <= layout.options.maxWidthLimit);
  assert.ok(layout.width > layout.options.maxWidth, "超长谱面要放宽");
  assert.ok(rows >= layout.options.targetRows);
  // 400 小节放宽到最宽还是太长：小节整体压矮，谱面区不超过截图上限
  assert.ok(layout.height <= layout.options.maxHeight, `高度 ${layout.height}`);
  assert.ok(layout.options.measurePx < C.DEFAULTS.measurePx && layout.options.measurePx >= C.DEFAULTS.minMeasurePx);
  // 普通长度的谱面不压
  const short = C.layoutChart(C.parseOgkr(lines.join("\n").replace(/^TAP\t0\t(\d{3})\t.*$/gm, "")));
  assert.equal(short.options.measurePx, C.DEFAULTS.measurePx);
});

test("SVG：各类物件都画出来，场外子弹裁掉，文字转义", () => {
  const model = C.parseOgkr(SAMPLE.replace("CREATOR\tTester", "CREATOR\t<x>"));
  const svg = C.renderSvg(model, C.layoutChart(model));
  for (const cls of ["tap k-L", "tap crit k-C", "side k-WL", "hold-body k-C", "hold-body side k-WR", "flick", "flick crit", "bell", "wall k-WL", "rail k-C", "sv sv-slow", "measure-no", "bpm-mark"]) {
    assert.ok(svg.includes(`class="${cls}"`), "缺少 " + cls);
  }
  // 样例里这发普通子弹正好压在 1:0 的 CTP 上，画成套住音符的虚线圈
  assert.ok(svg.includes('class="bullet-ring d-NML"'), "缺少压在音符上的子弹圈");
  assert.ok(!svg.includes("d-DNG"), "x=90 的子弹在显示范围外");
  assert.ok(!svg.includes("<x>"));
  for (const kind of ["tap", "critical", "hold", "side", "flick", "bell", "bullet", "damage", "aimed", "onnote", "beam", "soflan", "block", "floorless"]) {
    assert.match(C.legendSvg(kind), /^<svg[^>]*>.+<\/svg>$/);
  }
});

test("FLICK：同一拍、同方向、相邻的合并成一根长条", () => {
  const runs = C.flickRuns([
    { t: 0, x: -18, dir: -1, critical: false }, { t: 0, x: -6, dir: -1, critical: false },
    { t: 0, x: 6, dir: -1, critical: false }, { t: 0, x: 18, dir: -1, critical: false },
    { t: 0, x: 0, dir: 1, critical: false },        // 方向不同
    { t: 0, x: 30, dir: -1, critical: true },       // CRITICAL 单独一条
    { t: 480, x: -24, dir: 1, critical: false }, { t: 480, x: 24, dir: 1, critical: false }, // 隔太远
  ]);
  const key = (r) => `${r.t}|${r.dir}|${r.critical}|${r.x1}..${r.x2}|${r.count}`;
  assert.deepEqual(runs.map(key).sort(), [
    "0|-1|false|-18..18|4", "0|-1|true|30..30|1", "0|1|false|0..0|1",
    "480|1|false|-24..-24|1", "480|1|false|24..24|1",
  ]);
});

test("分音：按全音符约分，HOLD 尾也算击打时刻，超过一小节不标", () => {
  assert.equal(C.rhythmLabel(120, 1920), "1/16");
  assert.equal(C.rhythmLabel(360, 1920), "3/16");
  assert.equal(C.rhythmLabel(80, 1920), "1/24");
  assert.equal(C.rhythmLabel(1920, 1920), "");
  assert.equal(C.rhythmLabel(95, 1920), "19/384", "不规则时值照实约分");
  assert.equal(C.rhythmLabel(7, 1920), "7/1920");

  const model = C.parseOgkr(SAMPLE);
  const marks = C.rhythmMarks(model);
  // 击打时刻：960(TAP) 1920(CTP 与侧键同拍) 4320(FLK) 4800(CFK) 5760(HLD 头) 9600(HLD 尾/CHD 头) 11520(CHD 尾)
  assert.deepEqual(marks.map((m) => m.t), [960, 1920, 4320, 4800, 5760, 9600, 11520]);
  assert.deepEqual(marks.map((m) => m.label), ["", "1/2", "", "1/4", "1/2", "", ""]);
  assert.deepEqual(marks.map((m) => m.changed), [false, true, true, true, true, true, false]);

  const svg = C.renderSvg(model, C.layoutChart(model));
  assert.ok(svg.includes(">1/4</text>"));
  assert.ok(svg.includes('class="rhythm-tick"'));
});

test("空谱面和坏行不会抛错", () => {
  const model = C.parseOgkr("[HEADER]\nTRESOLUTION\tabc\nTAP\t9\nHLD\nBLT\n[NOTES]\n");
  assert.equal(model.header.tResolution, 1920);
  const layout = C.layoutChart(model);
  assert.equal(layout.columns.length, 1);
  assert.match(C.renderSvg(model, layout), /^<svg/);
});

test("FLICK 箭头朝向：L 画 ≪，R 画 ≫（尖端在拍点那一侧）", () => {
  const model = C.parseOgkr(SAMPLE);
  const svg = C.renderSvg(model, C.layoutChart(model));
  const apex = (cls) => {
    const m = new RegExp(`<polyline class="${cls}" points="([^"]+)"`).exec(svg);
    const [[x1], [x2]] = m[1].split(" ").map((p) => p.split(",").map(Number));
    return Math.sign(x2 - x1);   // 中点在两端左边 = ≪
  };
  assert.equal(apex("flick-arrow"), -1);        // FLK … L
  assert.equal(apex("flick-arrow crit"), 1);    // CFK … R
});

// Event Horizon 第 48–56 单位的墙（同一 tick 两个点 = 瞬移）和保护墙，简化自实际谱面
const JUMP_WALLS = [
  "[HEADER]", "TRESOLUTION\t1920", "[LANE]",
  "WLS\t82\t48\t0\t-24", "WLN\t82\t49\t0\t0", "WLN\t82\t49\t0\t48", "WLN\t82\t50\t240\t48", "WLN\t82\t50\t240\t24",
  "WLN\t82\t51\t240\t-4", "WLE\t82\t55\t0\t-24",
  "WLS\t83\t55\t0\t-24", "WLN\t83\t55\t240\t0", "WLN\t83\t55\t720\t36", "WLN\t83\t55\t1200\t0", "WLE\t83\t55\t1440\t-24",
  "WRS\t205\t48\t0\t24", "WRN\t205\t49\t0\t0", "WRN\t205\t49\t0\t48", "WRN\t205\t50\t240\t48", "WRN\t205\t50\t240\t24",
  "WRN\t205\t51\t240\t4", "WRE\t205\t55\t0\t24",
  "WRS\t207\t55\t0\t24", "WRN\t207\t55\t240\t0", "WRN\t207\t55\t720\t-36", "WRN\t207\t55\t1200\t0", "WRE\t207\t55\t1440\t24",
  "[COMPOSITION]", "LBK\t82\t48\t0\t-24\t0\t49\t0\t0\t0", "LBK\t205\t48\t0\t24\t0\t49\t0\t0\t0",
  "[NOTES]", "TAP\t0\t47\t0\t0\t0", "TAP\t0\t56\t0\t0\t0",
].join("\n");

test("开头的空白小节不画，第一个有物件的小节记为第 1 小节，开头的 BPM 照样标出", () => {
  const lines = ["[HEADER]", "TRESOLUTION\t1920", "BPM_DEF\t135\t135\t135\t135", "[COMPOSITION]", "BPM\t0\t0\t135", "BPM\t3\t0\t270",
    "[LANE]", "LCS\t0\t0\t0\t0", "LCE\t0\t6\t0\t0", "[NOTES]", "TAP\t0\t2\t960\t0\t0", "TAP\t0\t5\t0\t0\t0"];
  const model = C.parseOgkr(lines.join("\n"));
  const layout = C.layoutChart(model);
  assert.equal(layout.chartStart, 2 * 1920);
  assert.equal(layout.columns[0].start, 2 * 1920);
  assert.deepEqual(layout.measures.slice(0, 2).map((m) => [m.t, m.no]), [[2 * 1920, 1], [3 * 1920, 2]]);
  assert.deepEqual(layout.bpmMarks.map((b) => [b.t, b.bpm]), [[2 * 1920, 135], [3 * 1920, 270]]);
  const svg = C.renderSvg(model, layout);
  assert.match(svg, /class="bpm-mark"[^>]*>135</);
  // 第一个物件就在第 0 小节：不跳
  const plain = C.layoutChart(C.parseOgkr(SAMPLE));
  assert.equal(plain.chartStart, 0);
  assert.equal(plain.measures[0].no, 1);
});

test("装饰轨道（CL）按颜色号画成淡色细线", () => {
  const lines = ["[HEADER]", "TRESOLUTION\t1920", "[LANE]", "CLS\t7\t0\t0\t-10\t19\t0", "CLE\t7\t1\t0\t10\t19\t0",
    "CLS\t8\t0\t0\t5\t42\t0", "CLE\t8\t1\t0\t5\t42\t0", "[NOTES]", "TAP\t0\t0\t0\t0\t0"];
  const model = C.parseOgkr(lines.join("\n"));
  assert.deepEqual(model.lanes.map((l) => [l.kind, l.color]), [["CL", 19], ["CL", 42]]);
  const svg = C.renderSvg(model, C.layoutChart(model));
  assert.equal((svg.match(/class="deco"/g) || []).length, 2);
  assert.match(svg, /class="deco" stroke="#5aa8ff"/);
  assert.match(svg, /class="deco" stroke="#b9a6ff"/);
});

test("墙线瞬移：保护墙停在瞬移之前的位置，不会被拉到跳过去的地方", () => {
  const model = C.parseOgkr(JUMP_WALLS);
  const wl = model.laneById.get("82").points;
  const T = 49 * 1920;
  assert.equal(C.interpolate(wl, T), 48);          // 默认取瞬移之后
  assert.equal(C.interpolate(wl, T, true), 0);     // before：瞬移之前
  const clipped = C.clipPath(wl, 48 * 1920, T);
  assert.deepEqual([clipped[0].x, clipped.at(-1).x], [-24, 0]);
  const svg = C.renderSvg(model, C.layoutChart(model));
  for (const m of svg.matchAll(/<polyline class="block" points="([^"]+)"/g)) {
    const xs = m[1].split(" ").map((p) => Number(p.split(",")[0]));
    assert.ok(Math.max(...xs) - Math.min(...xs) <= 24 * 2.5 + 0.5, "保护墙虚线只在 ±24 到 0 之间走");
  }
});

test("地板消失：两墙一起跳到场外、左右反转的区间整栏铺青色并标出；两墙贴住不算", () => {
  const model = C.parseOgkr(JUMP_WALLS);
  const T = 1920;
  const runs = C.floorlessRuns(model, 0, 60 * T);
  // 49:0 两墙收成一点并一起跳到 x=48，50:240 回到 24 后才重新张开
  // 55:240 收成一点后左右反转，55:1200 收回同一点后再张开
  assert.deepEqual(runs.map((r) => [r.start, r.end, r.inverted]), [
    [49 * T, 50 * T + 240, false],
    [55 * T + 240, 55 * T + 1200, true],
  ]);
  const svg = C.renderSvg(model, C.layoutChart(model));
  assert.ok((svg.match(/class="floorless"/g) || []).length >= 2);
  assert.match(svg, /class="floorless-mark"[^>]*>悬空</);
  assert.match(svg, /class="floorless-mark"[^>]*>反转</);
  assert.match(C.legendSvg("floorless"), /class="floorless"/);
  assert.match(C.legendSvg("block"), /class="block"/);
  // 正常张开的墙没有悬空区间
  assert.deepEqual(C.floorlessRuns(C.parseOgkr(SAMPLE), 0, 20 * T), []);
  // 两墙贴在一起（左墙扫到右墙上，宽度正好为 0）：角色还能站在那条线上，不算悬空（Event Horizon 第 29 小节后）
  const touch = C.parseOgkr(["[HEADER]", "TRESOLUTION\t1920", "[LANE]",
    "WLS\t40\t29\t1280\t-24", "WLN\t40\t30\t0\t-24", "WLN\t40\t30\t555\t24", "WLN\t40\t30\t960\t24", "WLN\t40\t30\t960\t-24", "WLE\t40\t30\t1680\t-24",
    "WRS\t167\t29\t1280\t24", "WRE\t167\t30\t1680\t24", "[NOTES]", "TAP\t0\t29\t0\t0\t0"].join("\n"));
  assert.deepEqual(C.floorlessRuns(touch, 0, 40 * T), []);
  // 扫墙：两墙一起被推到 x=36 贴住片刻（场外一点点），角色被推着走，不算悬空（Event Horizon unit 68）
  const sweep = C.parseOgkr(["[HEADER]", "TRESOLUTION\t1920", "[LANE]",
    "WLS\t90\t68\t0\t-24", "WLN\t90\t68\t145\t36", "WLN\t90\t68\t200\t36", "WLE\t90\t68\t480\t-24",
    "WRS\t214\t68\t0\t24", "WRN\t214\t68\t130\t36", "WRN\t214\t68\t260\t36", "WRE\t214\t68\t480\t24", "[NOTES]", "TAP\t0\t68\t0\t0\t0"].join("\n"));
  assert.deepEqual(C.floorlessRuns(sweep, 0, 70 * T), []);
});

test("子弹 / BELL 落点 = X + 调色板偏移的 1/8；追踪弹按估计的玩家位置画；隐藏轨道不画；倒退变速单独上色", () => {
  const lines = [
    "[HEADER]", "TRESOLUTION\t1920",
    "[B_PALETTE]",
    "BPL\tK1\tUPS\t12\tFIX\t1.0\tN\tNDL\t0",
    "BPL\tK2\tUPS\t-6\tFIX\t1.0\tN\tCIR\t0",
    "BPL\tP1\tUPS\t4\tPLR\t1.0\tN\tCIR\t0",
    "[COMPOSITION]", "SFL\t1\t0\t480\t-1.0", "SFL\t1\t960\t480\t0",
    "[LANE]",
    "LCS\t1\t0\t0\t0\t0\t0\t1", "LCE\t1\t2\t0\t0",
    "LLS\t2\t0\t0\t-12", "LLE\t2\t2\t0\t-12",
    "[BULLET]", "BLT\tK1\t0\t960\t-18\tNML", "BLT\tK2\t0\t960\t-18\tNML", "BLT\tP1\t0\t960\t10\tNML", "BLT\tZZ\t0\t960\t5\tNML",
    "[BELL]", "BEL\t1\t0\t0\t--", "BEL\t1\t480\t0\tK2",
    "[NOTES]", "TAP\t2\t0\t0\t-12\t0",
  ];
  const model = C.parseOgkr(lines.join("\n"));
  // 偏移到判定线上只剩 1/8：-18 + 12/8、-18 - 6/8
  // 追踪弹：附近一拍内没有音符、也没有墙 → 估计玩家在 0，再加偏移 4/8
  assert.deepEqual(model.bullets.map((b) => [b.x, b.aimed]), [[-16.5, false], [-18.75, false], [0.5, true], [5, false]]);
  assert.deepEqual(model.bells.map((b) => [b.x, b.aimed]), [[0, false], [-0.75, false]]);
  assert.deepEqual(model.lanes.map((l) => [l.id, l.hidden]), [["1", true], ["2", false]]);
  const svg = C.renderSvg(model, C.layoutChart(model));
  assert.equal((svg.match(/class="rail k-C"/g) || []).length, 0, "隐藏的中轨不画");
  assert.ok((svg.match(/class="rail k-L"/g) || []).length >= 1);
  assert.equal((svg.match(/<g class="aimed">/g) || []).length, 1);
  assert.match(svg, /class="sv sv-reverse"/);
  assert.match(svg, /class="sv sv-stop"/);
  assert.equal((C.legendSvg("soflan").match(/class="sv /g) || []).length, 4);
});

test("追踪弹的玩家位置估计：正在按的 HOLD > 一拍内最近的音符 > 两墙中间", () => {
  const lines = [
    "[HEADER]", "TRESOLUTION\t1920",
    "[B_PALETTE]", "BPL\tP1\tUPS\t0\tPLR\t1.0\tN\tCIR\t0",
    "[LANE]", "LCS\t1\t0\t0\t0", "LCE\t1\t4\t0\t0",
    "WLS\t2\t0\t0\t-20", "WLE\t2\t4\t0\t-20", "WRS\t3\t0\t0\t10", "WRE\t3\t4\t0\t10",
    "[BULLET]",
    "BLT\tP1\t0\t960\t24\tNML",   // HOLD 0:480–1:0 进行中，HOLD 在 x=6
    "BLT\tP1\t1\t1700\t24\tNML",  // 2:0 的 TAP（x=-8）在一拍内
    "BLT\tP1\t3\t0\t24\tNML",     // 附近没东西 → 两墙中间 (-20+10)/2
    "[NOTES]", "HLD\t1\t0\t480\t6\t0\t1\t0\t6\t0", "TAP\t1\t2\t0\t-8\t0",
  ];
  const model = C.parseOgkr(lines.join("\n"));
  assert.deepEqual(model.bullets.map((b) => [b.x, b.estimated]), [[6, true], [-8, true], [-5, true]]);
  const svg = C.renderSvg(model, C.layoutChart(model));
  assert.equal((svg.match(/<g class="aimed">/g) || []).length, 3);
});

test("针形子弹按飞来的方向倾斜：从中间射出的朝外斜，竖直落下的不转", () => {
  const lines = ["[HEADER]", "TRESOLUTION\t1920",
    "[B_PALETTE]", "BPL\tC1\tCEN\t0\tFIX\t1.0\tN\tNDL\t0", "BPL\tU1\tUPS\t0\tFIX\t1.0\tN\tNDL\t0",
    "[BULLET]", "BLT\tC1\t0\t960\t20\tNML", "BLT\tC1\t0\t960\t-20\tNML", "BLT\tU1\t0\t960\t5\tNML",
    "[NOTES]", "TAP\t0\t0\t0\t0\t0"];
  const model = C.parseOgkr(lines.join("\n"));
  const svg = C.renderSvg(model, C.layoutChart(model));
  const angles = [...svg.matchAll(/<g transform="rotate\(([-\d.]+) /g)].map((m) => Number(m[1]));
  assert.equal(angles.length, 2, "竖直落下的那发不包 rotate");
  assert.ok(angles.some((a) => a < -10) && angles.some((a) => a > 10), "左右两发朝相反方向倾斜");
});

test("BELL / 子弹压在音符上时改成同样大小的空心圈，不盖住音符", () => {
  const lines = ["[HEADER]", "TRESOLUTION\t1920",
    "[B_PALETTE]", "BPL\tC\tUPS\t0\tFIX\t1.0\tN\tCIR\t0",
    "[LANE]", "LCS\t1\t0\t0\t0", "LCE\t1\t2\t0\t0",
    "[BULLET]", "BLT\tC\t0\t960\t0\tDNG", "BLT\tC\t0\t960\t20\tNML",
    "[BELL]", "BEL\t0\t960\t0\t--", "BEL\t0\t1440\t6\t--",
    "[NOTES]", "TAP\t1\t0\t960\t0\t0"];
  const model = C.parseOgkr(lines.join("\n"));
  const svg = C.renderSvg(model, C.layoutChart(model));
  assert.equal((svg.match(/class="bell-ring"/g) || []).length, 1, "压在 TAP 上的铃铛画成金圈");
  assert.equal((svg.match(/<circle class="bell" /g) || []).length, 1, "不在音符上的铃铛照常画");
  // 圈和原来的铃铛、圆形子弹一样大，不放大
  assert.match(svg, /class="bell-ring" [^>]*r="4.5"/);
  assert.match(svg, /class="bullet-ring d-DNG" [^>]*r="3.3"/);
  assert.equal((svg.match(/class="bullet d-NML ring"/g) || []).length, 1, "不在音符上的子弹照常画");
  // 圈画在音符之后，音符本身不被盖住
  assert.ok(svg.indexOf('class="bell-ring"') > svg.indexOf('class="tap k-C"'));
});

function tempTree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ogkr-index-"));
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, ...name.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return root;
}

test("谱面文件索引：递归找，ID 去前导零，后面的包覆盖前面的", () => {
  const root = tempTree({
    "A000/music/music0036/0036_03.ogkr": "old",
    "option/A001/music/music0036/0036_03.ogkr": "new",
    "A000/music/music8003/8003_10.ogkr": "lun",
    "A000/music/music0036/readme.txt": "",
  });
  try {
    let clock = 0;
    const index = createChartFileIndex([root], { now: () => clock });
    assert.equal(fs.readFileSync(index.find(36, 3), "utf8"), "new");
    assert.equal(fs.readFileSync(index.find("8003", 10), "utf8"), "lun");
    assert.equal(index.find(8003, 4), null);
    assert.equal(index.find(36, 2), null);
    // 新放进去的谱面：一分钟内不重扫，之后重扫能找到
    fs.writeFileSync(path.join(root, "A000/music/music0036/0036_02.ogkr"), "exp");
    clock = 1000;
    assert.equal(index.find(36, 2), null);
    clock = 61000;
    assert.ok(index.find(36, 2));
    assert.equal(createChartFileIndex([]).find(36, 3), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("谱面文件索引：option 包号大的优先，跟盘符和根目录顺序无关", () => {
  const { preferChartFile, chartFileName } = require("./ongeki-chart-files.cjs");
  // 本体 .vhd 挂载成 Z:，option 在 F: 上
  assert.equal(preferChartFile("F:\\SDDT\\option\\A037\\music\\music0036\\0036_03.ogkr", "Z:\\package\\A000\\music\\0036_03.ogkr"), false);
  assert.equal(preferChartFile("Z:\\A000\\0036_03.ogkr", "C:\\option\\A001\\0036_03.ogkr"), true);
  assert.equal(preferChartFile("/opt/A040/x/0036_03.ogkr", "/opt/A052/x/0036_03.ogkr"), true);
  assert.equal(preferChartFile(null, "/a/0036_03.ogkr"), true);
  assert.equal(chartFileName(8180, 10), "8180_10.ogkr");
  assert.equal(chartFileName("36", 3), "0036_03.ogkr");

  const base = tempTree({ "package/A000/music/0036_03.ogkr": "base" });
  const option = tempTree({ "option/A037/music/0036_03.ogkr": "opt" });
  try {
    for (const roots of [[base, option], [option, base]]) {
      assert.equal(fs.readFileSync(createChartFileIndex(roots).find(36, 3), "utf8"), "opt");
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(option, { recursive: true, force: true });
  }
});

test("/谱面图：没配目录、缺文件、找到文件三种结果", async () => {
  const plain = await core.resolveCapability({}, "u1", "chartview", "id36");
  assert.equal(plain.kind, "text");
  assert.match(plain.text, /ongekiChartRoots/);

  const root = tempTree({ "music/0036_03.ogkr": SAMPLE });
  const original = core.generateChartPreview;
  try {
    const config = { ongekiChartRoots: [root] };
    const usage = await core.resolveCapability(config, "u1", "chartview", "");
    assert.equal(usage.kind, "text");

    const missing = await core.resolveCapability(config, "u1", "chartview", "id36 expert");
    assert.equal(missing.kind, "text");
    assert.match(missing.text, /0036_02\.ogkr/);

    let call = null;
    core.generateChartPreview = async (...args) => { call = args; return { buffer: Buffer.from("x"), meta: null }; };
    const plan = await core.resolveCapability(config, "u1", "chartview", "id36");
    assert.equal(plan.kind, "image");
    assert.equal(plan.key, "chartview");
    assert.match(plan.caption, /id36 .* · MASTER/);
    await plan.run();
    assert.equal(call[1].song.id, 36);
    assert.equal(call[1].difficultyId, 3);
    assert.equal(call[2], path.join(root, "music", "0036_03.ogkr"));
  } finally {
    core.generateChartPreview = original;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
