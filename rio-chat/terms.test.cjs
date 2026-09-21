"use strict";
// 术语层测试。数据用仓库里的真实文件（和其它层一样），另外用临时目录测坏数据的报错。
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {loadKnowledge}=require("./knowledge.cjs");
const {loadTerms,matchTerms,versionFilterFor,termsPayload,termsRule,
 extractGlossary,sessionEntries,validateTarget,TYPES}=require("./terms.cjs");

const knowledge=loadKnowledge(__dirname);
const terms=loadTerms(__dirname);

test("术语库载入：索引非空、类型合法、机制条目必须带来源",()=>{
 assert.ok(terms.index.length>50,"真实术语库应该有足够多的条目："+terms.index.length);
 for(const [game,entries] of Object.entries(terms.games)){
  for(const entry of entries){
   assert.ok(TYPES.includes(entry.type),game+" 里有类型不合法的条目："+entry.type);
   assert.ok(entry.name,entry.id+" 缺 name");
   if(entry.type==="mechanic")
    assert.ok(Array.isArray(entry.sources)&&entry.sources.length,"机制条目必须带来源（写错比查不到更糟）："+entry.id);
  }
 }
});
test("版本条目对得上曲库快照：catalogVersions 必须真是快照里的 version 值",()=>{
 for(const [game,entries] of Object.entries(terms.games)){
  const inSnapshot=new Set((knowledge.catalogs[game]?.charts||[]).map(chart=>chart.version).filter(Boolean));
  if(!inSnapshot.size)continue;
  for(const entry of entries){
   for(const name of entry.catalogVersions||[])
    assert.ok(inSnapshot.has(name),game+" 的 "+entry.id+" 写了快照里没有的版本名："+name);
  }
 }
});
test("精确命中才算数：版本俗称、组合称呼、机制都认；子串和裸单字不抢",()=>{
 const hit=(text,game)=>matchTerms(terms,{text,game}).map(item=>item.entry.id);
 assert.deepEqual(hit("真超檄有什么版本的歌","maimai"),["maimai-version-group-shinchoukyoku"]);
 assert.deepEqual(hit("堇代是第几代","maimai"),["maimai-version-maimai-murasaki-plus"],"社区查证过的俗称要认");
 assert.deepEqual(hit("超檄是什么意思","maimai"),[],"子串不算精确命中，不能抢占");
 // 裸单字一律不收：「紫」不能命中紫代（它跟难度叫法「紫谱」同源，收了必误命中）
 assert.deepEqual(hit("紫好听吗","maimai"),[]);
 assert.deepEqual(hit("这个白不错的","maimai"),[]);
 assert.deepEqual(hit("绿代是哪一代","maimai"),[],"没查证过的俗称不能靠猜命中");
 assert.ok(hit("DX Rating 怎么算","maimai").includes("maimai-mechanic-rating"));
 assert.ok(hit("音击的 RATING 是几榜","ongeki").includes("ongeki-mechanic-rating"));
 assert.ok(hit("紫谱是什么难度","maimai").includes("maimai-difficulty-mas"));
});
test("ASCII 别名卡词边界，不会命中更长的词",()=>{
 assert.deepEqual(matchTerms(terms,{text:"B5000 分是什么水平",game:"maimai"}).filter(item=>item.alias==="B50"),[]);
 assert.ok(matchTerms(terms,{text:"B50 怎么算",game:"maimai"}).some(item=>item.alias==="B50"));
});
test("组合称呼摊平成一组曲库版本，供查询过滤",()=>{
 const hits=matchTerms(terms,{text:"真超檄有哪些水的谱",game:"maimai"});
 const {versions}=versionFilterFor(hits,"maimai");
 assert.deepEqual(versions.sort(),["maimai","maimai GreeN","maimai GreeN PLUS","maimai PLUS"].sort());
 // 真代是个组合（maimai 与 maimai PLUS 共用），不是挂在两个版本上的同一个 alias
 const zhen=versionFilterFor(matchTerms(terms,{text:"真代有哪些歌",game:"maimai"}),"maimai");
 assert.deepEqual(zhen.versions.sort(),["maimai","maimai PLUS"].sort());
 // 别的游戏的术语不进这一轮的过滤
 assert.deepEqual(versionFilterFor(matchTerms(terms,{text:"真超檄",game:"maimai"}),"ongeki").versions,[],"点名了别的游戏就不该带上这款的版本");
});
test("快照里没有的版本：认得、但必须说清没数据，不能静默忽略",()=>{
 // 单独点一个快照里没有的版本：过滤条件为空 + 明确报「没有数据」
 const hua=versionFilterFor(matchTerms(terms,{text:"华代有哪些水谱",game:"maimai"}),"maimai");
 assert.deepEqual(hua.versions,[],"没有数据就没得筛");
 assert.equal(hua.unavailable.length,1);
 assert.match(hua.unavailable[0].missing.join("、"),/でらっくす PLUS/);
 // 国服合并代：有一半数据 → 按有的那半筛，同时报缺的那半
 const xiong=versionFilterFor(matchTerms(terms,{text:"熊华里有哪些歌",game:"maimai"}),"maimai");
 assert.deepEqual(xiong.versions,["maimai でらっくす"]);
 assert.equal(xiong.unavailable.length,1);
 // 单说「熊代」就只指 でらっくす 那一代，不自动扩成熊华（用户定死的）
 const bear=versionFilterFor(matchTerms(terms,{text:"熊代有哪些歌",game:"maimai"}),"maimai");
 assert.deepEqual(bear.versions,["maimai でらっくす"]);
 assert.deepEqual(bear.unavailable,[]);
});
test("事实块只给命中的条目，并带上成员/来源",()=>{
 const hits=matchTerms(terms,{text:"真超檄到底指哪些版本",game:"maimai"});
 const payload=termsPayload(hits);
 assert.equal(payload.entries.length,1);
 assert.equal(payload.entries[0].type,"version_group");
 assert.equal(payload.entries[0].catalogVersions.length,4);
});
test("提示词口径写死了三条边界",()=>{
 const rule=termsRule(terms);
 assert.match(rule,/不要把版本名当成曲名/);
 assert.match(rule,/版本\/组合的当前收录以本地曲库的 version 字段为准/);
 assert.match(rule,/机制.*以本地机制资料为准/);
});
test("会话 glossary 只从明确定义句学，且目标必须本地验证得到",()=>{
 const learn=text=>extractGlossary(text,{terms,knowledge,game:"maimai"});
 // 用一个正式库里没有的俗称：库里有的（堇代、真超檄…）不必再学
 assert.deepEqual(learn("小绿代指的是 maimai GreeN").map(item=>[item.alias,item.type,item.members]),
  [["小绿代","version",["maimai GreeN"]]]);
 assert.deepEqual(learn("maimai、maimai PLUS、maimai GreeN、maimai GreeN PLUS 合称老四代").map(item=>[item.alias,item.type,item.members.length]),
  [["老四代","version_group",4]]);
 assert.deepEqual(learn("八爪鱼指的是 VIIIbit Explorer").map(item=>[item.alias,item.type,item.target]),
  [["八爪鱼","song","VIIIbit Explorer"]]);
 // 普通提及不学
 assert.deepEqual(learn("真超檄这首挺好听的"),[]);
 assert.deepEqual(learn("堇代是哪一代啊"),[]);
 // 目标本地验证不通过就不学（宁可漏学）
 assert.deepEqual(learn("堇代指的是某个不存在的版本"),[]);
 // 礼貌尾巴不能被学成别名
 assert.deepEqual(learn("maimai、maimai PLUS 合称双雄版本，你可以记一下？").map(item=>item.alias),["双雄版本"]);
 // 正式库里已有的术语不必再学
 assert.deepEqual(learn("真超檄指的是 maimai、maimai PLUS、maimai GreeN 和 maimai GreeN PLUS 这几个版本的统称"),[]);
});
test("会话条目与正式库同形状，且优先级更高",()=>{
 const session=sessionEntries([{alias:"小绿代",type:"version",members:["maimai GreeN"],game:"maimai"}]);
 const hits=matchTerms(terms,{text:"小绿代有哪些 BPM200 的谱",game:"maimai",session});
 assert.equal(hits.length,1);
 assert.equal(hits[0].source,"session");
 assert.deepEqual(versionFilterFor(hits,"maimai").versions,["maimai GreeN"]);
 // 正式库里也有的写法：会话里定义过就以会话那条为准
 const shadow=sessionEntries([{alias:"堇代",type:"version",members:["maimai でらっくす Splash"],game:"maimai"}]);
 const both=matchTerms(terms,{text:"堇代有哪些谱",game:"maimai",session:shadow});
 assert.equal(both.length,1);
 assert.equal(both[0].source,"session","会话里当场纠正过的写法优先于正式库");
 assert.deepEqual(versionFilterFor(both,"maimai").versions,["maimai でらっくす Splash"]);
});
// ── CHUNITHM：requiresGame 与复合名（第十五组）────────────────────────
const chuni = (text, game) => matchTerms(terms, { text, game }).filter(item => item.entry.game === "chunithm");
test("requiresGame：没有游戏上下文的短副标题不命中，有上下文才认",()=>{
 // AIR 同时是曲名，NEW/SUN 是普通英文词——裸收必然误命中，所以它们只在点名了游戏时才生效
 assert.deepEqual(chuni("AIR 这张谱好打吗"),[]);
 assert.deepEqual(chuni("NEW 里有哪些谱"),[]);
 assert.deepEqual(chuni("SUN 好听吗"),[]);
 assert.deepEqual(chuni("AIR 那张谱","chunithm").map(item=>item.entry.name),["CHUNITHM AIR"]);
 assert.deepEqual(chuni("中二 NEW 里有哪些谱","chunithm").map(item=>item.entry.name),["CHUNITHM NEW"]);
 // 别的游戏的上下文不算：聊音击时说 AIR 不该命中中二的版本
 assert.deepEqual(chuni("AIR 是什么","ongeki"),[]);
});
test("复合名与裸词分开：「NEW+」「SUN+」不会退化成 NEW / SUN",()=>{
 assert.deepEqual(chuni("NEW+ 是什么","chunithm").map(item=>item.entry.name),["CHUNITHM NEW PLUS"]);
 assert.deepEqual(chuni("SUN+ 有哪些谱","chunithm").map(item=>item.entry.name),["CHUNITHM SUN PLUS"]);
 assert.deepEqual(chuni("SUN 有哪些谱","chunithm").map(item=>item.entry.name),["CHUNITHM SUN"]);
 assert.deepEqual(chuni("LUMINOUS PLUS 是什么","chunithm").map(item=>item.entry.name),["CHUNITHM LUMINOUS PLUS"]);
 // 单独的 PLUS 不是任何版本的别名
 assert.deepEqual(chuni("PLUS 是什么","chunithm"),[]);
});
test("CHUNITHM 数据口径：黑谱、WE、国服年份版、框体、争议条目",()=>{
 const byId = name => terms.games.chunithm.find(entry => entry.name === name);
 assert.ok(byId("ULTIMA").aliases.includes("黑谱"),"ULTIMA 的中文俗称是黑谱，已查证");
 assert.ok(byId("WORLD'S END").body.includes("不参与 Rating"));
 // 国服年份版：登记了，但明确标「与日版对应未确认」
 for(const name of ["中二节奏 2024","中二节奏 2025"]){
  assert.equal(byId(name).mappingConfirmed,false,name+" 要标 mappingConfirmed:false");
  assert.match(byId(name).body,/没有权威对照/);
 }
 // 框体两个组合把版本分完，不重不漏
 const silver = new Set(byId("银框体").catalogVersions);
 const gold = new Set(byId("金框体").catalogVersions);
 const overlap = [...silver].filter(name => gold.has(name));
 assert.deepEqual(overlap,[]);
 assert.ok(silver.size >= 12 && gold.size >= 8, "银/金框体应该覆盖全部版本：" + silver.size + "/" + gold.size);
});
test("有争议的机制按 disputed claims 存，不单选一个当定论",()=>{
 const disputed = terms.games.chunithm.filter(entry => entry.disputed);
 assert.ok(disputed.length >= 2,"解禁与课题曲库存两处资料互相矛盾，都该标 disputed：" + disputed.length);
 for(const entry of disputed){
  assert.ok(Array.isArray(entry.claims) && entry.claims.length >= 2,entry.name + " 标了 disputed 就该有至少两条 claims");
  for(const claim of entry.claims)assert.ok(claim.text && claim.sources?.length,entry.name + " 的 claims 每条都要有说法和来源");
 }
 // 会变的数据带适用版本或时点
 const constant=terms.games.chunithm.find(entry=>entry.name==="定数");
 assert.ok(constant.asOf||constant.claims?.length,"定数这类会变的数据要带 asOf 或适用版本");
 const payload = termsPayload(matchTerms(terms,{text:"银框体里有哪些 14 的谱",game:"chunithm"}));
 assert.equal(payload.entries[0].type,"version_group");
});
test("坏数据直接报错，不静默跳过",()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"terms-"));
 fs.mkdirSync(path.join(dir,"knowledge"));
 try{
  fs.writeFileSync(path.join(dir,"knowledge","maimai-terms.json"),JSON.stringify({entries:[{id:"x",type:"not-a-type",name:"X"}]}));
  assert.throws(()=>loadTerms(dir),/type 不在清单里/);
  fs.writeFileSync(path.join(dir,"knowledge","maimai-terms.json"),JSON.stringify({entries:[{id:"x",type:"version",name:"X"},{id:"x",type:"version",name:"Y"}]}));
  assert.throws(()=>loadTerms(dir),/id 重复/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test("没有术语文件时安全退化",()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"terms-empty-"));
 try{
  const empty=loadTerms(dir);
  assert.deepEqual(empty.index,[]);
  assert.deepEqual(matchTerms(empty,{text:"真超檄"}),[]);
  assert.deepEqual(versionFilterFor([],"maimai"),{versions:[],unavailable:[]});
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
