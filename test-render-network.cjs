"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),http=require("node:http");
const fs=require("node:fs"),path=require("node:path"),Module=require("node:module");
const output=path.join(__dirname,"output");
fs.mkdirSync(output,{recursive:true});
const cache=fs.mkdtempSync(path.join(output,"render-network-test-"));
process.env.ONGEKI_APP_DIR=cache;
test.after(()=>{assert.ok(fs.realpathSync(cache).startsWith(fs.realpathSync(output)+path.sep));fs.rmSync(cache,{recursive:true,force:true});});
const file=path.join(__dirname,"app-template.js"),loaded=new Module(file,module);
loaded.filename=file;loaded.paths=module.paths;
let source=fs.readFileSync(file,"utf8").replace("const JACKET_DOWNLOAD_BUDGET_MS = 20000;","const JACKET_DOWNLOAD_BUDGET_MS = 250;");
loaded._compile(source.slice(0,source.lastIndexOf("\nmain().catch"))+"\nmodule.exports={downloadJacket,localizeJackets,fetchWithTimeout,CDP,captureChartPreview};",file);
const app=loaded.exports;
async function stalledServer() {
  let requests=0;
  const server=http.createServer((_req,res)=>{
    requests++;
    res.writeHead(200,{"Content-Type":"image/webp","Content-Length":"4096"});
    res.flushHeaders();res.write("x"); // 响应头成功，正文永远不发完。
  });
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  return {url:"http://127.0.0.1:"+server.address().port+"/stall",requests:()=>requests,
    close:async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
test("图片收到响应头后正文卡住，也必须在下载超时内结束",async()=>{
  const server=await stalledServer();
  let watchdog;
  try {
    const started=Date.now();
    const result=await Promise.race([app.downloadJacket("body-stall",server.url,80),new Promise(resolve=>{watchdog=setTimeout(()=>resolve("deadline-exceeded"),500);})]);
    assert.notEqual(result,"deadline-exceeded","响应正文没有受到下载超时保护");
    assert.equal(result,"");
    assert.ok(Date.now()-started<500);
  } finally {clearTimeout(watchdog);await server.close();}
});
test("API JSON 正文卡住也受整次请求超时保护",async()=>{
  const server=await stalledServer();
  try {await assert.rejects(()=>app.fetchWithTimeout(server.url,{},80,response=>response.json()),/超时/);}
  finally {await server.close();}
});
test("整批曲绘共享硬预算，失败与未开始项直接用占位图，重复查询不再等公网",async()=>{
  const server=await stalledServer();
  const data={best:Array.from({length:18},(_,i)=>({songId:5000+i,title:"预算测试",jacketUrl:server.url})),
    profile:{avatarUrl:server.url,avatarFallbackUrl:"data:image/svg+xml;base64,dGVzdA=="}};
  try {
    const started=Date.now();
    await app.localizeJackets(data);
    assert.ok(Date.now()-started<1000,"整批下载预算失效");
    assert.ok(data.best.every(row=>/^data:image\//.test(row.jacketUrl)),"失败曲绘不能再交给浏览器重试公网");
    assert.equal(data.profile.avatarUrl,data.profile.avatarFallbackUrl);
    const count=server.requests();
    const again={best:[{songId:5000,title:"预算测试",jacketUrl:server.url}]};
    await app.localizeJackets(again);
    assert.equal(server.requests(),count,"刚失败的曲绘不应重试");
    assert.match(again.best[0].jacketUrl,/^data:image\//);
  } finally {await server.close();}
});
test("浏览器无响应的 CDP 命令会超时，关闭连接会结束未完成命令",async()=>{
  const cdp=new app.CDP("ws://127.0.0.1/unused",{commandTimeoutMs:50});
  cdp.ws={send(){},close(){}};
  await assert.rejects(()=>cdp.send("Runtime.evaluate"),/超时/);
  assert.equal(cdp.pending.size,0);
  const pending=cdp.send("Page.captureScreenshot");
  cdp.close();
  await assert.rejects(()=>pending,/关闭/);
  assert.equal(cdp.pending.size,0);
});

function screenshotBrowser(capture) {
  const events=[];
  let scale;
  return {events,
    async send(method,params={}) {
      events.push({method,params,scale});
      if(method==="Emulation.setDeviceMetricsOverride") scale=params.deviceScaleFactor;
      if(method==="Page.captureScreenshot") return capture(params,scale);
      return {};
    },
    async evaluate(expression) {events.push({method:"paint",expression});},
  };
}
const smallScreenshot={data:Buffer.alloc(2048,1).toString("base64")};
test("谱面截图瞬时失败：同倍率重试成功，调整视口后先等待画面刷新",async()=>{
  let captures=0;
  const cdp=screenshotBrowser(()=>{
    if(++captures===1) throw new Error("CDP 错误: Unable to capture screenshot");
    return smallScreenshot;
  });
  assert.equal((await app.captureChartPreview(cdp,1800,1600)).length,2048);
  assert.equal(captures,2);
  assert.equal(cdp.events.filter(e=>e.method==="Emulation.setDeviceMetricsOverride").length,1);
  const paint=cdp.events.findIndex(e=>e.method==="paint");
  assert.ok(paint>0 && paint<cdp.events.findIndex(e=>e.method==="Page.captureScreenshot"));
  assert.ok(cdp.events.filter(e=>e.method==="Page.captureScreenshot").every(e=>e.params.captureBeyondViewport===false));
});
test("谱面截图高倍率连续失败：自动降倍率，保留完整谱面范围",async()=>{
  const cdp=screenshotBrowser((_params,scale)=>{
    if(scale>1) throw new Error("CDP 错误: Unable to capture screenshot");
    return smallScreenshot;
  });
  await app.captureChartPreview(cdp,1800,1600);
  const shots=cdp.events.filter(e=>e.method==="Page.captureScreenshot");
  assert.equal(shots.at(-1).scale,1);
  assert.ok(shots.every(e=>e.params.clip.width===1800 && e.params.clip.height===1600));
});
test("长谱面按总像素限制截图，短谱面仍可使用两倍像素",async()=>{
  for(const [width,height] of [[2800,8400],[1800,1600]]) {
    const cdp=screenshotBrowser(()=>smallScreenshot);
    await app.captureChartPreview(cdp,width,height);
    const scale=cdp.events.find(e=>e.method==="Emulation.setDeviceMetricsOverride").params.deviceScaleFactor;
    assert.ok(width*height*scale*scale<=32000001);
    if(height===1600) assert.equal(scale,2);
  }
});
test("截图文件过大时仍先降质量，再降倍率",async()=>{
  const large={data:Buffer.alloc(5*1024*1024,1).toString("base64")};
  const cdp=screenshotBrowser((_params,scale)=>scale===2 ? large : smallScreenshot);
  const buffer=await app.captureChartPreview(cdp,1800,1600);
  assert.equal(buffer.length,2048);
  const shots=cdp.events.filter(e=>e.method==="Page.captureScreenshot");
  assert.deepEqual(shots.slice(0,3).map(e=>e.params.quality),[92,85,78]);
  assert.ok(shots.at(-1).scale<2);
});
test("截图持续失败会有界结束，最低尝试 0.75 倍并报告尺寸",async()=>{
  const cdp=screenshotBrowser(()=>{throw new Error("CDP 错误: Unable to capture screenshot");});
  await assert.rejects(()=>app.captureChartPreview(cdp,4000,9000),/重试并降至 3000×6750 后仍失败.*Unable to capture screenshot/);
  assert.equal(cdp.events.filter(e=>e.method==="Page.captureScreenshot").length,4);
});
test("浏览器连接断开不应当成截图容量问题反复重试",async()=>{
  const cdp=screenshotBrowser(()=>{throw new Error("浏览器连接已关闭");});
  await assert.rejects(()=>app.captureChartPreview(cdp,1800,1600),/浏览器连接已关闭/);
  assert.equal(cdp.events.filter(e=>e.method==="Page.captureScreenshot").length,1);
});
