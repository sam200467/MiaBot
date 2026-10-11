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
  for (const cls of ["tap k-L", "tap crit k-C", "side k-WL", "hold-body k-C", "hold-body side k-WR", "flick", "flick crit", "bell", "bullet d-NML", "wall k-WL", "rail k-C", "sv sv-slow", "measure-no", "bpm-mark"]) {
    assert.ok(svg.includes(`class="${cls}"`), "缺少 " + cls);
  }
  assert.ok(!svg.includes("d-DNG"), "x=90 的子弹在显示范围外");
  assert.ok(!svg.includes("<x>"));
  for (const kind of ["tap", "critical", "hold", "side", "flick", "bell", "bullet", "damage", "beam", "soflan"]) {
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

// Event Horizon 第 48–56 单位的墙（同一 tick 两个点 = 瞬移）和墙封锁，简化自实际谱面
const JUMP_WALLS = [
  "[HEADER]", "TRESOLUTION\t1920", "[LANE]",
  "WLS\t82\t48\t0\t-24", "WLN\t82\t49\t0\t0", "WLN\t82\t49\t0\t48", "WLN\t82\t50\t240\t48", "WLN\t82\t50\t240\t24",
  "WLN\t82\t51\t240\t-4", "WLE\t82\t55\t0\t-24",
  "WLS\t83\t55\t0\t-24", "WLN\t83\t55\t240\t0", "WLN\t83\t55\t720\t36", "WLN\t83\t55\t1200\t0", "WLE\t83\t55\t1440\t-24",
  "WRS\t205\t48\t0\t24", "WRN\t205\t49\t0\t0", "WRN\t205\t49\t0\t48", "WRN\t205\t50\t240\t48", "WRN\t205\t50\t240\t24",
  "WRN\t205\t51\t240\t4", "WRE\t205\t55\t0\t24",
  "WRS\t207\t55\t0\t24", "WRN\t207\t55\t240\t0", "WRN\t207\t55\t720\t-36", "WRN\t207\t55\t1200\t0", "WRE\t207\t55\t1440\t24",
  "[COMPOSITION]", "LBK\t82\t48\t0\t-24\t0\t49\t0\t0\t0", "LBK\t205\t48\t0\t24\t0\t49\t0\t0\t0",
  "[NOTES]", "TAP\t0\t56\t0\t0\t0",
].join("\n");

test("墙线瞬移：墙封锁停在瞬移之前的位置，不会被拉到跳过去的地方", () => {
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
    assert.ok(Math.max(...xs) - Math.min(...xs) <= 24 * 2.5 + 0.5, "封锁线只在 ±24 到 0 之间走");
  }
});

test("左右反转：左墙越过右墙的区间两墙之间铺回场地底色，并标出", () => {
  const model = C.parseOgkr(JUMP_WALLS);
  const T = 1920;
  const runs = C.invertedRuns(model, 0, 60 * T);
  assert.equal(runs.length, 1);
  const run = runs[0];
  // 55:240 两墙都在 0，之后左墙往右、右墙往左，55:1200 又回到 0
  assert.equal(run[0].t, 55 * T + 240);
  assert.equal(run.at(-1).t, 55 * T + 1200);
  assert.ok(run.some((pt) => pt.wl === 36 && pt.wr === -36));
  // 49:0 瞬移到同一位置（两墙都在 48）不算反转
  const svg = C.renderSvg(model, C.layoutChart(model));
  assert.equal((svg.match(/class="inverted"/g) || []).length, 1);
  assert.match(svg, /class="invert-mark"[^>]*>反转</);
  assert.match(C.legendSvg("inverted"), /class="col-bg"/);
  assert.match(C.legendSvg("block"), /class="block"/);
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
