"use strict";
// 昵称恢复的落盘门槛与自动核对。夹具用 loadKnowledge 真读一遍临时目录，走真实的曲名索引。
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {loadKnowledge}=require("./knowledge.cjs");
const {recoveryHint,recheckFromQuery,gamesWithTitle,candidateGate,distinctSongs}=require("./alias-recovery.cjs");

const CHARTS=[
  {title:"Dengeki Tube",difficulty:"EXP",level:"12+",constant:12.5},
  {title:"Dengeki Tube",difficulty:"MAS",level:"15",constant:15.2},
  {title:"Air",difficulty:"MAS","level":"14+",constant:14.5},
];
function fixture(extra={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"alias-"));
  fs.mkdirSync(path.join(dir,"knowledge"));
  for(const [game,charts] of Object.entries({chunithm:CHARTS,...extra})){
    fs.writeFileSync(path.join(dir,"knowledge",game+".json"),JSON.stringify({source:"fixture",scope:"fixture",charts}));
  }
  const knowledge=loadKnowledge(dir);
  fs.rmSync(dir,{recursive:true,force:true});
  return knowledge;
}

test("自动核对只认检索词，不认资料来源正文",()=>{
  const k=fixture();
  // 检索词里出现真曲名 → 核到
  assert.deepEqual(recheckFromQuery(k,"CHUNITHM Dengeki Tube 定数","chunithm").facts.map(h=>h.title),["Dengeki Tube"]);
  // 检索词里没有、只是正文里顺带提到 → 不核。资料来源正文里一堆曲名，全去核一遍
  // 等于把额度随机花掉：实测「电管」那条被核成了正文里先出现的 Love & Justice。
  assert.deepEqual(recheckFromQuery(k,"CHUNITHM 14+ 水 谱面","chunithm").facts,[]);
  // 没有任何真曲名 → 空
  assert.deepEqual(recheckFromQuery(k,"阿巴阿巴大冒险","chunithm").facts,[]);
});

test("点名了游戏就不会拿另一款的数据顶上，只给消歧提示",()=>{
  const k=fixture({
    chunithm:[...CHARTS,{title:"Love & Justice",difficulty:"MAS",level:"15",constant:15.2}],
    ongeki:[{title:"Love & Justice",difficulty:"MAS",level:"14+",constant:14.7}],
  });
  // 点名音击 → 只查音击。索引里 Love & Justice 记的是 chunithm（先到的那款），不越界
  const scoped=recheckFromQuery(k,"Love & Justice 定数","ongeki");
  assert.deepEqual(scoped.facts.map(f=>({title:f.title,game:f.game,constant:f.charts[0].constant})),
    [{title:"Love & Justice",game:"ongeki",constant:14.7}]);
  assert.deepEqual(scoped.hints,[]);
  // 点名的游戏里没有这首 → 一条事实都不给，最多给一句消歧提示
  const missing=recheckFromQuery(k,"Dengeki Tube 定数","ongeki");
  assert.deepEqual(missing.facts,[],"点名了音击、音击里没有这首歌，就不能拿中二的定数当事实");
  assert.equal(missing.hints.length,1);
  assert.match(missing.hints[0].note,/chunithm/);
  assert.equal(JSON.stringify(missing.hints).includes("15.2"),false,"消歧提示里不能带任何定数");
  // 压根没提游戏 → 索引那款可以当恢复线索
  const free=recheckFromQuery(k,"Dengeki Tube 定数","");
  assert.deepEqual(free.facts.map(f=>f.game),["chunithm"]);
  assert.deepEqual(free.hints,[]);
});

test("gamesWithTitle 按规范化曲名判断哪些游戏收录了它",()=>{
  const k=fixture({
    chunithm:[...CHARTS,{title:"Love & Justice",difficulty:"MAS",level:"15",constant:15.2}],
    ongeki:[{title:"Love & Justice",difficulty:"MAS",level:"14+",constant:14.7}],
  });
  assert.deepEqual(gamesWithTitle(k,"love & justice").sort(),["chunithm","ongeki"]);
  assert.deepEqual(gamesWithTitle(k,"Dengeki Tube"),["chunithm"]);
  assert.deepEqual(gamesWithTitle(k,"查无此曲"),[]);
});

test("落盘门槛：唯一命中、游戏不冲突、曲名确实存在",()=>{
  const k=fixture();
  const charts=(title)=>recheckFromQuery(k,title,"chunithm").facts[0].charts;
  // 全过
  assert.equal(candidateGate({charts:charts("Dengeki Tube"),game:"chunithm",conversation:"中二的 Dengeki Tube 是什么"}),"");
  // 对话没说游戏 → 不冲突，照记
  assert.equal(candidateGate({charts:charts("Dengeki Tube"),game:"chunithm",conversation:"Dengeki Tube 是什么"}),"");
  // 游戏上下文冲突 → 不记。否则「音击的电管」会被记成中二的歌
  assert.match(candidateGate({charts:charts("Dengeki Tube"),game:"chunithm",conversation:"音击的电管是什么"}),/游戏上下文冲突/);
  // 曲库里没有 → 不记（模型编的名字）
  assert.match(candidateGate({charts:[],game:"chunithm",conversation:"中二的 X 是什么"}),/没有这首歌/);
  // 命中不唯一 → 不记
  const two=[{title:"A",difficulty:"MAS",constant:14.5},{title:"B",difficulty:"MAS",constant:14.6}];
  assert.equal(distinctSongs(two),2);
  assert.match(candidateGate({charts:two,game:"chunithm",conversation:"中二的 X 是什么"}),/不唯一/);
});

test("恢复提示给出三级顺序，并写明中文简称用圈内通用写法",()=>{
  const hint=recoveryHint("电管");
  assert.match(hint,/「电管」/);
  assert.match(hint,/换一个 game/);
  assert.match(hint,/aliasGuess/);
  assert.match(hint,/不确定/);
  assert.match(hint,/电管/,"要明确 Dengeki Tube 的中文简称写作「电管」，免得模型自创");
});

// 检索词规范化：联网前把中文简称换成正式曲名（第十一组）。搜索引擎不认得「电管」，
// 换过之后紧接着的自动核对才接得住。
const {applyAliases}=require("./alias-recovery.cjs");
const ALIASES=[{alias:"电管",title:"Dengeki Tube",game:"chunithm"},{alias:"管管",title:"Dengeki Tube",game:""}];
test("检索词里的中文简称换成正式曲名",()=>{
  const r=applyAliases("电管 定数 水吗",ALIASES,"chunithm");
  assert.equal(r.query,"Dengeki Tube 定数 水吗");
  assert.deepEqual(r.applied,["电管→Dengeki Tube"]);
  // 没命中就别动它：检索词是模型写的，程序只做认识的替换
  assert.deepEqual(applyAliases("随便什么曲子",ALIASES,"chunithm"),{query:"随便什么曲子",applied:[]});
  assert.equal(applyAliases("",ALIASES,"chunithm").query,"");
});
test("游戏专属别名只在它那款游戏下替换",()=>{
  // 聊中二时不替换音击专属别名：那多半不是同一首歌
  assert.equal(applyAliases("电管 怎么样",ALIASES,"chunithm").applied.length,1);
  assert.equal(applyAliases("电管 怎么样",ALIASES,"maimai").query,"电管 怎么样");
  // 没给游戏线索时照替（通用别名和专属别名都算）
  assert.equal(applyAliases("管管 怎么样",ALIASES,"").query,"Dengeki Tube 怎么样");
});
test("长别名先替，短别名不会把长别名切坏",()=>{
  const entries=[{alias:"电管",title:"Dengeki Tube"},{alias:"电管改",title:"Dengeki Tube (改)",game:"chunithm"}];
  assert.equal(applyAliases("电管改 的定数",entries,"chunithm").query,"Dengeki Tube (改) 的定数");
});
