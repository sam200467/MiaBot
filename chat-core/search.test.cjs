"use strict";
const test=require('node:test'),assert=require('node:assert/strict');
const {runWeb,publicUrl,attachSources,uniqueSources,cacheTtlMs}=require('./search.cjs');
const {requestReply}=require('./chat.cjs');
const response=data=>({ok:true,text:async()=>JSON.stringify(data),json:async()=>data});
test('search selects documented endpoints; cache and video evidence boundaries',async()=>{
 const s={apiKey:'fixture-kimi-secret',cache:new Map()};let calls=0;
 const fetchImpl=async(url,o)=>{calls++;assert.ok(url.endsWith('/search'));assert.equal(JSON.parse(o.body).limit,5);return response({search_results:[{url:'https://www.bilibili.com/video/BV123',title:'手元示例',snippet:'仅简介',text:'不得当成看过视频'}]});};
 const a=await runWeb(s,{query:'音击 EXP 手元',kind:'video'},{fetchImpl});
 assert.equal(a.sources[0].kind,'video');assert.equal(a.sources[0].content,'');
 assert.equal((await runWeb(s,{query:'音击 EXP 手元',kind:'video'},{fetchImpl})).cached,true);assert.equal(calls,1);
});
test('fetch only observed public URLs; credentials never exported in search query',async()=>{
 const s={apiKey:'fixture-kimi-secret'};let calls=0;
 const fetchImpl=async(url,o)=>{calls++;assert.ok(url.endsWith('/fetch'));return response({url:JSON.parse(o.body).url,title:'指南',markdown:'正文'});};
 for(const url of ['http://127.0.0.1/a','http://localhost/a','file:///c:/key','https://u:p@example.com/'])assert.equal(publicUrl(url),null);
 assert.ok((await runWeb(s,{url:'https://example.com/a'},{fetchImpl,allowedUrls:new Set()})).error);
 assert.ok((await runWeb(s,{query:s.apiKey},{fetchImpl})).error);
 const result=await runWeb(s,{url:'https://example.com/a'},{fetchImpl,allowedUrls:new Set(['https://example.com/a'])});
 assert.equal(calls,1);assert.equal(result.sources[0].content,'正文');
});
test('provider errors are sanitized and no empty response is cached',async()=>{
 const s={apiKey:'hidden-secret'};
 assert.match((await runWeb(s,{query:'音击'},{fetchImpl:async()=>({ok:false,status:401,text:async()=>s.apiKey})})).error,/401/);
 assert.match((await runWeb(s,{query:'音击'},{fetchImpl:async()=>{throw Error(s.apiKey)}})).error,/网络/);
 const r=await runWeb(s,{query:'音击'},{fetchImpl:async()=>response({search_results:[{title:s.apiKey,url:'https://example.com/',chunks:[{text:s.apiKey}]}]})});
 assert.ok(!JSON.stringify(r).includes(s.apiKey));
});
test('chat search evidence and program-rendered sources survive fallback',async()=>{
 for(const fallback of [false,true]){
  const s={search:{apiKey:'kimi-secret'},persona:'test',examples:[],manifest:{entries:[]},c:{provider:{model:'test',timeoutMs:10000,baseUrl:'https://api.deepseek.com',endpoint:'/chat/completions',apiKey:'deepseek-secret'},limits:{maxReplyChars:600}}};
  let calls=0;const bodies=[];
  const r=await requestReply(s,[{role:'user',content:'音击手元视频'}],{
   fetchImpl:async(u,o)=>{bodies.push(JSON.parse(o.body));calls++;return response({choices:[{message:{content:calls===1?JSON.stringify({webQuery:{query:'音击 手元 视频',kind:'video'}}):calls===2&&fallback?'':JSON.stringify({text:'找到手元视频，供你参考。',sourceIds:['S1']})}}]});},
   webFetchImpl:async()=>response({search_results:[{title:'真实视频标题',url:'https://www.bilibili.com/video/BV123',snippet:'介绍'}]})
  });
  assert.ok(!JSON.stringify(bodies).includes('kimi-secret'));
  assert.match(r.text,/真实视频标题/);assert.match(r.text,/https:\/\/www.bilibili.com\/video\/BV123/);
  assert.equal(r.action,undefined);assert.equal(r.scene,'explanation');
 }
});
test('unknown source IDs cannot manufacture links and title remains intact',()=>{
 const r=attachSources({text:'x'.repeat(1800)+'https://fake.example/',sourceIds:['made-up']},[{id:'S1',title:'真实标题',url:'https://example.com/guide'}],1200);
 assert.ok(r.text.length<=1200);assert.ok(!r.text.includes('fake.example'));assert.match(r.text,/真实标题\nhttps:\/\/example.com\/guide/);
});
test('cache lifetime follows how fast the material actually changes',()=>{
 const hour=3600000,article={query:'音击 13 交互 练习 谱面',kind:'article'};
 // 攻略、手法、運指这类内容几年不变，缓存要长；版本、收录、活动随时会变，必须短。
 assert.equal(cacheTtlMs('search_pro',article),24*hour);
 assert.equal(cacheTtlMs('search_pro',{query:'CHUNITHM 運指 解説',kind:'article'}),24*hour);
 assert.equal(cacheTtlMs('search_pro',{query:'音击 最新版本 追加曲目',kind:'article'}),1*hour);
 assert.equal(cacheTtlMs('search_pro',{query:'オンゲキ アップデート 新曲',kind:'article'}),1*hour);
 assert.equal(cacheTtlMs('search_pro',{query:'maimai 2026年 版本更新',kind:'article'}),1*hour);
 assert.equal(cacheTtlMs('search',{query:'音击 手元',kind:'video'}),12*hour);
 assert.equal(cacheTtlMs('fetch',{url:'https://example.com/a'}),6*hour);
 assert.ok(cacheTtlMs('search_pro',{query:'音击 最新 手元',kind:'video'})===1*hour,'时效性优先于视频类型');
});
test('the same page under different addresses is listed once, first one wins',()=>{
 const wiki=[{id:'S1',title:'CHUNITHM',url:'https://zh.wikipedia.org/zh-hk/CHUNITHM'},{id:'S2',title:'CHUNITHM - 維基百科，自由的百科全書',url:'https://zh.wikipedia.org/wiki/CHUNITHM'},{id:'S3',title:'官网',url:'https://chunithm.sega.jp/'}];
 // 2026-10-09 群里实测：同一篇维基百科的两个地址占满了两条，第二个真正不同的来源被挤掉
 assert.equal(attachSources({text:'正文',sourceIds:['S1','S2','S3']},wiki,1900).text,'正文\n\n参考资料：\nCHUNITHM\nhttps://zh.wikipedia.org/zh-hk/CHUNITHM\n官网\nhttps://chunithm.sega.jp/');
 assert.match(attachSources({text:'正文',sourceIds:['S2']},wiki,1900).text,/\nCHUNITHM - 維基百科，自由的百科全書\nhttps:\/\/zh\.wikipedia\.org\/wiki\/CHUNITHM$/,'只引用了后一个地址时就显示它');
 assert.equal(attachSources({text:'正文'},wiki.slice(0,2),1900,{citedOnly:false,title:'参考资料：'}).text,'正文\n\n参考资料：\nCHUNITHM\nhttps://zh.wikipedia.org/zh-hk/CHUNITHM');
 for(const url of ['https://zh.m.wikipedia.org/wiki/CHUNITHM','http://zh.wikipedia.org/wiki/CHUNITHM/','https://zh.wikipedia.org/zh-hans/CHUNITHM?variant=zh-cn','https://zh.wikipedia.org/wiki/CHUNITHM?utm_source=x','https://zh.wikipedia.org/wiki/%43HUNITHM'])
  assert.equal(uniqueSources([wiki[1],{title:'x',url}]).length,1,url);
 assert.equal(uniqueSources([wiki[1],{title:'x',url:'https://zh.wikipedia.org/wiki/Maimai'},{title:'y',url:'https://en.wikipedia.org/wiki/CHUNITHM'},{title:'z',url:'https://chunithm.sega.jp/news?id=2'},{title:'w',url:'https://chunithm.sega.jp/news?id=3'}]).length,5,'不同的页面都留着');
 assert.deepEqual(uniqueSources(['本地条目来源 A','本地条目来源  A','本地条目来源 B']),['本地条目来源 A','本地条目来源 B']);
});
