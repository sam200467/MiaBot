"use strict";
// 本地图源发送成功响应头后停止传输；用真实浏览器验证大饼分表仍能出图。
const fs = require("node:fs"), path = require("node:path"), http = require("node:http");
const os = require("node:os"), Module = require("node:module"), assert = require("node:assert/strict");
const root = path.resolve(__dirname, ".."), output = path.join(root, "output");
fs.mkdirSync(output, { recursive: true });
const cache = fs.mkdtempSync(path.join(output, "render-network-smoke-"));
process.env.ONGEKI_APP_DIR = cache;
const themeHash = path.basename(cache), themeDir = path.join(os.tmpdir(), "ongeki-local-theme", themeHash);
const bundle = {};
function collect(dir, prefix) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "preview-data.js") continue;
    const full = path.join(dir, entry.name), name = prefix + "/" + entry.name;
    if (entry.isDirectory()) collect(full, name);
    else bundle[name] = fs.readFileSync(full).toString("base64");
  }
}
for (const folder of ["rating-chart/renderer", "rating-chart/assets", "shared/fonts"]) collect(path.join(root, "themes", folder), folder);
let requests = 0;
const server = http.createServer((_request, response) => {
  requests++;
  response.writeHead(200, { "Content-Type": "image/webp", "Content-Length": "4096" });
  response.flushHeaders(); response.write("x");
});
function cleanup(dir, parent) {
  if (!fs.existsSync(dir)) return;
  assert.ok(fs.realpathSync(dir).startsWith(fs.realpathSync(parent) + path.sep));
  fs.rmSync(dir, { recursive: true, force: true });
}
(async () => {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const host = "http://127.0.0.1:" + server.address().port;
    const file = path.join(root, "app-template.js");
    let source = fs.readFileSync(file, "utf8");
    for (const [marker, filename] of [["SONG_CATALOG", "ongeki-song-catalog.json"], ["INTERNAL_SONG_CATALOG", "ongeki-music-internal.json"], ["SDDT_EXTRAS", "ongeki-sddt-extras.json"]]) {
      source = source.replace('"__' + marker + '_JSON__"', () => JSON.stringify(fs.readFileSync(path.join(root, filename), "utf8")));
    }
    source = source.replace('"__THEME_BUNDLE_JSON__"', () => JSON.stringify(bundle));
    source = source.replace('"__THEME_BUNDLE_HASH__"', () => JSON.stringify(themeHash));
    assert.ok(source.includes('const OTG_CDN_URL = "https://oss-hd1.bemanicn.com";'));
    source = source.replace('const OTG_CDN_URL = "https://oss-hd1.bemanicn.com";', "const OTG_CDN_URL = " + JSON.stringify(host) + ";");
    // 缩短同一下载预算以加速故障测试；生产环境仍为 20 秒。
    assert.ok(source.includes("const JACKET_DOWNLOAD_BUDGET_MS = 20000;"));
    source = source.replace("const JACKET_DOWNLOAD_BUDGET_MS = 20000;", "const JACKET_DOWNLOAD_BUDGET_MS = 250;");
    const loaded = new Module(file, module); loaded.filename = file; loaded.paths = module.paths;
    loaded._compile(source.slice(0, source.lastIndexOf("\nmain().catch")) + "\nmodule.exports={renderLocalTheme,fakeRatingJson,VERSION};", file);
    const started = Date.now();
    const image = await loaded.exports.renderLocalTheme(loaded.exports.fakeRatingJson(), { playerName: "下载超时验证", level: 50, avatarUrl: host + "/avatar" });
    assert.ok(requests > 0, "故障图源必须收到请求");
    assert.ok(image.length > 100000);
    assert.equal(image.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    const imagePath = path.join(output, "render-network-verification.png"); fs.writeFileSync(imagePath, image);
    const result = { passed: true, version: loaded.exports.VERSION, simulatedBodyStall: true, testDownloadBudgetMs: 250, productionDownloadBudgetMs: 20000, elapsedMs: Date.now() - started, requests, bytes: image.length, image: imagePath, liveAccountVerified: false };
    fs.writeFileSync(path.join(output, "render-network-verification.json"), JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify(result));
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    cleanup(cache, output); cleanup(themeDir, path.join(os.tmpdir(), "ongeki-local-theme"));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
