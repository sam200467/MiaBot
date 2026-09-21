"use strict";
// 术语实体类型约束测试：已确认的版本名/版本组合不能被当成一首歌。
const test=require("node:test");
const assert=require("node:assert/strict");
const {loadTerms,matchTerms,sessionEntries}=require("./terms.cjs");
const {checkTermTypes,termNote}=require("./term-guard.cjs");

const terms=loadTerms(__dirname);
// 与 chat.cjs 同样的用法：对**回答正文**匹配（库 + 会话 glossary）
const guard=(text,session)=>checkTermTypes(text,{hits:matchTerms(terms,{text,session})});

test("把版本组合当成一首歌：判出来，并说清它是什么",()=>{
 const findings=guard("真超檄这首歌定数14.2，挺水的。");
 assert.equal(findings.length,1);
 assert.equal(findings[0].term,"真超檄");
 assert.equal(findings[0].type,"version_group");
 const note=termNote(findings);
 assert.match(note,/「真超檄」是版本组合称呼/);
 assert.match(note,/maimai GreeN PLUS/,"要把成员列出来，读者才知道它指什么");
 assert.match(note,/不是曲名/);
});
test("量词在术语前面的写法同样判得出",()=>{
 assert.equal(guard("这首真超檄我打过。").length,1);
 assert.equal(guard("推荐一首真超檄").length,1);
});
test("正常说法不误判：这是约束，不是见词就拦",()=>{
 for(const text of [
  "真超檄这几个版本的谱面偏简单。",
  "真超檄（maimai 到 GreeN PLUS）里的歌都是老框的。",
  "你说的真超檄是指四个版本吧？",
  "真超檄里有没有 BPM200 的曲子？",
 ])assert.deepEqual(guard(text),[],text);
 for(const text of [
  "这首的紫谱是 14.5。",
  "音击的 RATING 三榜怎么算？",
  "紫谱这首歌定数多少？",
 ])assert.deepEqual(guard(text),[],text+"（难度/机制术语不受这条约束）");
});
test("弱匹配不抢占：正文里没有精确命中就不判",()=>{
 // 「超檄」不是收录的别名，不靠猜命中
 assert.deepEqual(guard("超檄这首歌挺好听的"),[]);
 // 没给 hits 时什么都不判（调用方忘了传就退化成不拦，宁可漏判）
 assert.deepEqual(checkTermTypes("真超檄这首歌",{}),[]);
});
test("会话 glossary 里学到的术语同样受约束",()=>{
 const session=sessionEntries([{alias:"堇代",type:"version",members:["maimai でらっくす Splash"],game:"maimai"}]);
 const findings=checkTermTypes("堇代这首歌我打过。",{hits:matchTerms(terms,{text:"堇代这首歌我打过。",session})});
 assert.equal(findings.length,1);
 assert.equal(findings[0].type,"version");
});
test("同一条回复里重复提到只记一次",()=>{
 const findings=guard("真超檄这首歌很好，真超檄这首也推荐。");
 assert.equal(findings.length,1);
});
