#!/usr/bin/env node
"use strict";
/**
 * macOS 构建辅助：从 ongeki-icon.ico 提取图标生成 AppIcon.iconset 与 app.icns。
 * ICO 帧优先取 PNG 帧；若为 BMP 帧则解析（32bpp BGRA，行倒置）转 RGBA 后手动编码 PNG。
 * 任何一步失败只打印警告并跳过（图标缺失不阻塞构建）。
 * 仅 macOS 使用（依赖 sips / iconutil）。
 */
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const ICO = path.join(ROOT, "ongeki-icon.ico");
const ASSETS = path.join(__dirname, "assets");
const ICONSET = path.join(ASSETS, "AppIcon.iconset");

/* ---------------- PNG 编码（纯内置模块，BMP 帧回退用） ---------------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const stride = 1 + width * 4;
  const raw = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter: none
    rgba.copy(raw, y * stride + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([sig, pngChunk("IHDR", ihdr), pngChunk("IDAT", zlib.deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]);
}

/* ---------------- ICO 解析 ---------------- */
function extractFrames() {
  const buf = fs.readFileSync(ICO);
  if (buf.length < 6 || buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) {
    throw new Error("不是有效的 ICO 文件");
  }
  const count = buf.readUInt16LE(4);
  const frames = [];
  for (let i = 0; i < count; i++) {
    const off = 6 + i * 16;
    if (off + 16 > buf.length) break;
    const width = buf[off] === 0 ? 256 : buf[off];
    const height = buf[off + 1] === 0 ? 256 : buf[off + 1];
    const size = buf.readUInt32LE(off + 8);
    const dataOff = buf.readUInt32LE(off + 12);
    if (dataOff + size > buf.length) continue;
    frames.push({ width, height, data: buf.subarray(dataOff, dataOff + size) });
  }
  if (frames.length === 0) throw new Error("ICO 无可用帧");
  return frames;
}

function isPng(data) {
  return data.length > 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e &&
    data[3] === 0x47 && data[4] === 0x0d && data[5] === 0x0a && data[6] === 0x1a && data[7] === 0x0a;
}

function bmpToRgba(frame) {
  const b = frame.data;
  if (b.length < 40) throw new Error("BMP 帧过短");
  const width = b.readInt32LE(4);
  const heightRaw = b.readInt32LE(8);
  const bpp = b.readUInt16LE(14);
  if (width <= 0 || bpp !== 32) throw new Error("不支持的 BMP 帧（" + width + "x" + heightRaw + " bpp=" + bpp + "）");
  const height = Math.abs(heightRaw); // ICO 中 BMP 高度 = 2×实际高度（XOR+AND），32bpp 通常无 AND mask
  const rowSize = Math.floor((width * bpp + 31) / 32) * 4;
  const px = Buffer.alloc(width * height * 4);
  const start = 40; // ICO 内 BMP 直接以 BITMAPINFOHEADER 开始（无 BITMAPFILEHEADER）
  for (let y = 0; y < height; y++) {
    const srcRow = start + (height - 1 - y) * rowSize; // 行倒置
    for (let x = 0; x < width; x++) {
      const si = srcRow + x * 4;
      const di = (y * width + x) * 4;
      px[di] = b[si + 2];     // R
      px[di + 1] = b[si + 1]; // G
      px[di + 2] = b[si];     // B
      px[di + 3] = b[si + 3]; // A
    }
  }
  return { width, height, rgba: px };
}

/* ---------------- 主流程 ---------------- */
function main() {
  if (process.platform !== "darwin") {
    console.log("（图标生成仅 macOS 构建使用，跳过）");
    return;
  }
  if (!fs.existsSync(ICO)) {
    console.log("（警告：未找到 ongeki-icon.ico，使用默认图标）");
    return;
  }
  let sourcePng;
  try {
    const frames = extractFrames();
    const pngFrame = frames.filter((f) => isPng(f.data)).sort((a, b) => b.width - a.width)[0];
    if (pngFrame) {
      sourcePng = pngFrame.data;
      console.log("已提取 ICO PNG 帧 " + pngFrame.width + "x" + pngFrame.height);
    } else {
      const bmpFrame = frames.slice().sort((a, b) => (b.width * b.height) - (a.width * a.height))[0];
      const { width, height, rgba } = bmpToRgba(bmpFrame);
      sourcePng = encodePng(width, height, rgba);
      console.log("已从 ICO BMP 帧转换 " + width + "x" + height);
    }
  } catch (e) {
    console.log("（警告：图标提取失败：" + e.message + "，使用默认图标）");
    return;
  }

  fs.mkdirSync(ICONSET, { recursive: true });
  const base = path.join(ASSETS, "icon-base.png");
  fs.writeFileSync(base, sourcePng);
  const sizes = [
    [16, "icon_16x16.png"], [32, "icon_16x16@2x.png"],
    [32, "icon_32x32.png"], [64, "icon_32x32@2x.png"],
    [128, "icon_128x128.png"], [256, "icon_128x128@2x.png"],
    [256, "icon_256x256.png"], [512, "icon_256x256@2x.png"],
    [512, "icon_512x512.png"], [1024, "icon_512x512@2x.png"],
  ];
  for (const [size, name] of sizes) {
    execFileSync("/usr/bin/sips", ["-z", String(size), String(size), base, "--out", path.join(ICONSET, name)], { stdio: "ignore" });
  }
  execFileSync("/usr/bin/iconutil", ["-c", "icns", ICONSET, "-o", path.join(ASSETS, "app.icns")], { stdio: "ignore" });
  console.log("已生成 mac/assets/app.icns");
}

main();
