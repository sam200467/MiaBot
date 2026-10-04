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
loaded._compile(source.slice(0,source.lastIndexOf("\nmain().catch"))+"\nmodule.exports={downloadJacket,localizeJackets,fetchWithTimeout,CDP};",file);
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
