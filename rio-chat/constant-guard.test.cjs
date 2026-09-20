"use strict";
// 定数裁决层测试。夹具用 loadKnowledge 从临时目录真读一遍，好让曲名索引走真实的
// 构造路径（按长度从长到短排序、按规范化名去重），而不是测试里另写一份。
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {loadKnowledge}=require("./knowledge.cjs");
const {verifyConstants,findTitles}=require("./constant-guard.cjs");

// 定数取真实快照：Dengeki Tube / Love & Justice 的 MAS 是 15.2（VERSE 版本后的新值），
// 社区老帖里写的 14.9 是旧值——这正是本层要拦下的那一类。
const CHARTS=[
  ["Dengeki Tube","BAS","4",4],["Dengeki Tube","ADV","7+",7.5],["Dengeki Tube","EXP","12+",12.5],["Dengeki Tube","MAS","15",15.2],
  ["Love & Justice","EXP","12+",12.7],["Love & Justice","MAS","15",15.2],
  ["Air","MAS","14+",14.5],["Air","ULT","15",15.2],
  ["Angel dust","MAS","15",15.0],
  ["Fairytale","MAS","13",13.4],
];
// 音击也收了 Love & Justice，而且那张（MAS 14.7）离老帖写的 14.9 比中二那张
// （MAS 15.2）更近——正是「按数值最近跨游戏挑」会挑错的那一类，所以要单独夹具。
const ONGEKI=[["Love & Justice","EXP","12",12.6],["Love & Justice","MAS","14+",14.7]];
const rows=list=>list.map(([title,difficulty,level,constant])=>({title,difficulty,level,constant,bpm:null,version:null,id:title}));
function fixture(games=["chunithm"]){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"guard-"));
  fs.mkdirSync(path.join(dir,"knowledge"));
  for(const game of games){
    const charts=game==="ongeki"?ONGEKI:CHARTS;
    fs.writeFileSync(path.join(dir,"knowledge",game+".json"),JSON.stringify({source:"fixture",scope:"fixture",charts:rows(charts)}));
  }
  const knowledge=loadKnowledge(dir);
  fs.rmSync(dir,{recursive:true,force:true});
  return knowledge;
}
const guard=(text,game)=>verifyConstants(fixture(),text,game);

test("社区老帖里的旧定数会被曲库当前值改掉",()=>{
  const r=guard("Dengeki Tube 在 14.9 那一档里算是水的。");
  assert.match(r.text,/Dengeki Tube 在 15\.2 那一档/);
  assert.equal(r.fixes.length,1);
  assert.deepEqual({from:r.fixes[0].from,to:r.fixes[0].to},{from:14.9,to:15.2});
});

test("引用旧值来否定它的句子一个字都不动",()=>{
  const text="网上有篇 2023 年的老帖把它写成 14.9，那是旧数据，别拿它当现在的定数。";
  const r=guard(text);
  assert.equal(r.text,text,"「老帖写成 14.9」是正确的话，改了它就成了胡话");
  assert.equal(r.fixes.length,0);
});

test("本来就对的定数不会被改",()=>{
  const text="Air 的紫谱是 14.5，ULT 是 15.2。";
  const r=guard(text);
  assert.equal(r.text,text);
  assert.equal(r.fixes.length,0);
});

test("按数值就近挑难度：报 14.9 落到 MAS 的 15.2，不落到 EXP 的 12.7",()=>{
  const r=guard("Love & Justice（14.9）键盘向。");
  assert.match(r.text,/Love & Justice（15\.2）/);
  assert.equal(r.fixes[0].difficulty,"MAS");
  // EXP 本来就报对了的，不动
  const ok=guard("Love & Justice 的 EXP 是 12.7。");
  assert.equal(ok.text,"Love & Justice 的 EXP 是 12.7。");
  assert.equal(ok.fixes.length,0);
});

test("曲库里存整数定数时补成一位小数，免得被读成等级",()=>{
  // Angel dust 的 MAS 在快照里是 15（不是 15.0）。直接替进去会得到「Angel dust 15」，
  // 而「15」在音游语境里读起来是等级，不是定数。
  const r=guard("Angel dust 14.8 推荐。","chunithm");
  assert.equal(r.text,"Angel dust 15.0 推荐。");
});

test("曲名附近的其它数字不碰：BPM、年份、分数都不改动",()=>{
  for(const text of ["Dengeki Tube 是 BACO 的曲子，BPM 155，2018 年收录。","Air 打到了 15.2 万分。","Angel dust 的物量是 1200。"]){
    const r=guard(text);
    assert.equal(r.fixes.length,0,text);
  }
});

test("短曲名不会命中更长的英文单词",()=>{
  // Air 是曲库里的真曲名，但 Fairytale 里也含 'air'
  const r=guard("Fairytale 这首我没打过。");
  assert.equal(r.fixes.length,0);
  const hits=findTitles(fixture(),"Fairytale 这首我没打过。");
  assert.deepEqual(hits.map(h=>h.title),["Fairytale"],"只该命中 Fairytale 本身");
});

test("差得太远的数字当成别的东西，不硬改",()=>{
  const r=guard("Air 我打到 12.0 的分数了。");
  assert.equal(r.fixes.length,0,"12.0 离 Air 最近的定数也差 2.5，不该当成定数改");
});

test("一句里提到两首歌就两处都核",()=>{
  const r=guard("Dengeki Tube 14.9、Love & Justice 14.9，这两首都能上分。");
  assert.equal(r.fixes.length,2);
  assert.equal(r.text.includes("14.9"),false);
  assert.equal((r.text.match(/15\.2/g)||[]).length,2);
});

test("数字写在曲名前面的放过：那多半是在说某一档，不是在报这首歌的定数",()=>{
  // 实测里出现过「14.9 一档里 Love & Justice 算水」——14.9 指的是档位，不是它的定数。
  // 宁可漏改，也不把档位说明改成一个具体数字。
  const r=guard("14.9 一档里 Dengeki Tube 算水的。");
  assert.equal(r.fixes.length,0);
});

test("裁决结果里带上改了哪几首，日志才回看得清",()=>{
  const r=guard("Dengeki Tube 14.9，Air 14.5。");
  assert.deepEqual(r.fixes.map(f=>({title:f.title,difficulty:f.difficulty,from:f.from,to:f.to})),
    [{title:"Dengeki Tube",difficulty:"MAS",from:14.9,to:15.2}]);
});

test("同一首歌收录在多款游戏时按对话里点名的游戏裁决",()=>{
  const both=fixture(["chunithm","ongeki"]);
  const text="Love & Justice 14.9 很水。";
  // 说的是中二：改成中二那张的 15.2，不能因为音击的 14.7 更近就改到音击去
  const zh=verifyConstants(both,text,"chunithm");
  assert.equal(zh.text,"Love & Justice 15.2 很水。");
  assert.equal(zh.fixes[0].to,15.2);
  // 说的是音击：改成音击那张的 14.7
  assert.equal(verifyConstants(both,text,"ongeki").text,"Love & Justice 14.7 很水。");
});

test("游戏线索不明、两款候选一样近时放弃修改，绝不猜",()=>{
  const both=fixture(["chunithm","ongeki"]);
  const text="Love & Justice 14.9 很水。";
  const r=verifyConstants(both,text,null);
  assert.equal(r.text,text,"挑错游戏比漏改糟得多：改完就变成用音击的定数说中二的谱");
  assert.equal(r.fixes.length,0);
});

test("没有曲名、没有曲库、空文本都安全返回",()=>{
  assert.equal(guard("哼哼，今天天气不错。").fixes.length,0);
  assert.equal(verifyConstants(null,"Dengeki Tube 14.9").text,"Dengeki Tube 14.9");
  assert.deepEqual(verifyConstants(fixture(),"").fixes,[]);
});

// ── 线上形状（第九组）────────────────────────────────────────────────
// 用户报的「连续两条消息，上一条老定数、这一条新定数」：旧版只核曲名之后**第一个**
// 定数，列表里第一个数字本来是对的，后面的旧值就整条溜过去了。
test("曲名后面跟着一整串难度时，每一个定数都要核",()=>{
  const r=guard("DENGEKI Tube：BAS 4、ADV 7+、EXP 12+（12.5）、MASTER 15（定数14.9）。");
  assert.equal(r.text,"DENGEKI Tube：BAS 4、ADV 7+、EXP 12+（12.5）、MASTER 15（定数15.2）。");
  assert.deepEqual(r.fixes.map(f=>[f.difficulty,f.from,f.to]),[["MAS",14.9,15.2]],"改的该是 MAS 那处，不是 EXP 的 12.5");
});

test("曲名在上一句、数字全在下一句，照样要核",()=>{
  // 线上那条回答就是这个形状：「DENGEKI Tube啊，早说拼写不就好了！BACO那首，我翻到的是：…」
  const r=guard("喔，DENGEKI Tube啊，早说拼写不就好了！BACO那首，我翻到的是：BAS 4、ADV 7+、EXP 12+（12.5）、MASTER 15（定数14.9）。");
  assert.equal(r.text.includes("定数15.2"),true);
  assert.equal(r.text.includes("14.9"),false);
});

test("时效句里的旧值不硬改，但在数字后面补一句当前值",()=>{
  // 「老帖写成 14.9」这句本身没错，改了是胡话；可模型也会在标注「这是老帖的说法」
  // 之后照样把旧值当现状报出去。所以数字留着，补的当前值跟着它走。
  const r=guard("DENGEKI Tube 的紫谱老帖写 14.9，那时候还没调。");
  assert.equal(r.text,"DENGEKI Tube 的紫谱老帖写 14.9（当前定数 15.2），那时候还没调。");
  assert.equal(r.fixes[0].kind,"annotate");
  assert.equal(r.fixes[0].to,15.2);
});

test("同一条回复里已经写了当前值，就不再补注",()=>{
  const text="DENGEKI Tube 老帖写 14.9，现在已经是 15.2 了。";
  assert.equal(guard(text).text,text);
  assert.equal(guard(text).fixes.length,0);
});

test("跟「万／分」的数字是分数，不是定数",()=>{
  // 13.4 万分离 EXP 的 12.5 只差 0.9，光靠 MAX_JUMP 拦不住
  for(const text of ["Dengeki Tube 这首我打了 13.4 万分。","Dengeki Tube 打到 13.4万分。"]){
    const r=guard(text);
    assert.equal(r.fixes.length,0,text);
    assert.equal(r.text,text);
  }
});

test("同一段里别的数字不会被当成这首歌的定数",()=>{
  // 段放宽到 180 字符后，靠 MAX_JUMP 兜底：离这首歌任何一个定数都超过 1.0 的放过
  const r=guard("Dengeki Tube 这首我打到 13.4 万分，顺手练了 Love & Justice。");
  assert.equal(r.text,"Dengeki Tube 这首我打到 13.4 万分，顺手练了 Love & Justice。");
});

// ── 正式别名（第九组）────────────────────────────────────────────────
// 模型会照着用户的话写「电管」这种中文简称，曲名索引里只有正式曲名 Dengeki Tube。
// 宿主把正式别名表（SongAliasStore.titleIndex）喂进来，正文里那处旧定数才核得到。
const ALIASES=[{alias:"电管",title:"Dengeki Tube",game:"chunithm"}];
test("正文里写的是正式别名时也认得出那首歌",()=>{
  const knowledge=fixture();
  const r=verifyConstants(knowledge,"电管的紫谱 14.9，偏水。","chunithm",ALIASES);
  assert.equal(r.text,"电管的紫谱 15.2，偏水。");
  assert.equal(r.fixes[0].title,"Dengeki Tube");
  // 没给别名表就认不出来：宁可漏改，也不能拿近似词去猜是哪首歌
  assert.equal(verifyConstants(knowledge,"电管的紫谱 14.9，偏水。","chunithm").fixes.length,0);
});
