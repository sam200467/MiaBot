"use strict";
// 等级资格校验测试。夹具同样走 loadKnowledge 真读一遍，曲名索引和曲库形状都是真的。
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs"),os=require("node:os"),path=require("node:path");
const {loadKnowledge}=require("./knowledge.cjs");
const {levelCondition,checkLevels,levelNote,dropRecommendations}=require("./level-guard.cjs");

// 三首歌正好覆盖三种情况：
//   Dengeki Tube：四张谱里一张 14+ 都没有（老帖推荐它的时候还是 14+）——要拦的典型。
//   Air：MAS 14+ 和 ULT 15 并存——按主谱面判会误伤，按「有没有这一档」判才对。
//   Titania：MAS 14+，正常合格。
const CHARTS=[
  ["Dengeki Tube","BAS","4",4],["Dengeki Tube","ADV","7+",7.5],["Dengeki Tube","EXP","12+",12.5],["Dengeki Tube","MAS","15",15.2],
  ["Air","MAS","14+",14.5],["Air","ULT","15",15.2],
  ["Titania","EXP","13+",13.8],["Titania","MAS","14+",14.9],
];
// 同一首歌在音击是 14+（中二是 15）：跨游戏时不能拿另一款的数据判资格。
const ONGEKI=[["Dengeki Tube","MAS","14+",14.7]];
const rows=list=>list.map(([title,difficulty,level,constant])=>({title,difficulty,level,constant}));
function fixture(games=["chunithm"]){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"level-"));
  fs.mkdirSync(path.join(dir,"knowledge"));
  for(const game of games){
    fs.writeFileSync(path.join(dir,"knowledge",game+".json"),
      JSON.stringify({source:"fixture",scope:"fixture",charts:rows(game==="ongeki"?ONGEKI:CHARTS)}));
  }
  const knowledge=loadKnowledge(dir);
  fs.rmSync(dir,{recursive:true,force:true});
  return knowledge;
}
const k=fixture();
const both=fixture(["chunithm","ongeki"]);
const ask=text=>[{role:"user",content:"<@123> "+text}];

test("「当前简单的14+」这类要求才立档位条件，问单曲不算",()=>{
  assert.deepEqual(levelCondition(ask("中二有没有比较简单一点的14+"),k),{level:"14+",game:"chunithm"});
  assert.equal(levelCondition(ask("帮我挑几首14+"),k).level,"14+");
  assert.equal(levelCondition(ask("来几首简单的14"),k).level,"14");
  assert.equal(levelCondition(ask("音击有没有水的14+"),k).game,"ongeki");
  // 问一首歌是不是这一档：提到它是对的，不能反过来要求它必须够这一档
  assert.equal(levelCondition(ask("DENGEKI Tube 是14+吗"),k),null);
  // 没有档位要求、没有要名单的口气：一律不立条件
  assert.equal(levelCondition(ask("这首歌怎么打"),k),null);
  assert.equal(levelCondition(ask("推荐几首好听的"),k),null);
  assert.equal(levelCondition(ask("帮我查 id870 的成绩"),k),null);
});

test("老资料推荐的曲目现在已经不在这一档：判不合格",()=>{
  const text="Dengeki Tube 14.9 挺水的，第一首就推它；Titania 也可以试试。";
  const bad=checkLevels(k,text,{level:"14+",game:"chunithm"});
  assert.deepEqual(bad.map(item=>item.title),["Dengeki Tube"]);
  assert.deepEqual(bad[0].levels,["4","7+","12+","15"]);
  assert.equal(bad[0].top,"15","最高那张是 15，纠正提示里要能说「已经升到 15」");
});

test("同曲同时有 14+ 和 15 的谱不算不合格",()=>{
  // Air 的 MAS 是 14+、ULT 是 15。按「主谱面」判会把它误判成不合格。
  assert.deepEqual(checkLevels(k,"Air 的紫谱 14.5 很适合练。",{level:"14+",game:"chunithm"}),[]);
});

test("要求 15 时就反过来：只有 14+ 的歌不合格",()=>{
  const bad=checkLevels(k,"Titania 14.9 是首选。",{level:"15",game:"chunithm"});
  assert.deepEqual(bad.map(item=>item.title),["Titania"]);
});

test("游戏不明又跨多款收录时不判，点名了游戏才按那一款判",()=>{
  const text="Dengeki Tube 14.7 很水。";
  assert.deepEqual(checkLevels(both,text,{level:"14+"}),[],"跨游戏又没点名：挑错游戏比漏判糟");
  assert.deepEqual(checkLevels(both,text,{level:"14+",game:"ongeki"}),[],"音击那张就是 14+");
  assert.equal(checkLevels(both,text,{level:"14+",game:"chunithm"}).length,1,"中二那张是 15");
});

test("正式别名写法的曲目同样要过等级资格",()=>{
  const aliases=[{alias:"电管",title:"Dengeki Tube",game:"chunithm"}];
  assert.deepEqual(checkLevels(k,"电管 14.9 挺水。",{level:"14+",game:"chunithm"}),[],"没有别名表就认不出这首歌，宁可不判");
  assert.deepEqual(checkLevels(k,"电管 14.9 挺水。",{level:"14+",game:"chunithm",aliases}).map(i=>i.title),["Dengeki Tube"]);
});

test("歧义别名（同一叫法落到两首歌）不进表，也就不会被误判",()=>{
  const aliases=[{alias:"叫法",title:"Dengeki Tube",game:"chunithm"}];
  // 曲库里没有「叫法」这首曲子时，别名解析出来的正式曲名照样要能在曲库里查到才算
  assert.deepEqual(checkLevels(k,"叫法 14.9 挺水。",{level:"14+",game:"chunithm",aliases}).map(i=>i.title),["Dengeki Tube"]);
});

test("纠正提示要说清哪些曲目不合格、为什么、可以怎么改",()=>{
  const bad=checkLevels(k,"Dengeki Tube 14.9 挺水。",{level:"14+",game:"chunithm"});
  const note=levelNote(bad,{level:"14+"});
  assert.match(note,/Dengeki Tube/);
  assert.match(note,/没有 14\+ 的谱面/);
  assert.match(note,/只能明确说明它是历史资料/);
  assert.match(note,/如果你本来就是在说明它们不符合条件，那保持原样/,"一句正确的「它现在是15」不该被删掉");
});

test("句子里已经写出真实档位的是说明，不是推荐",()=>{
  // 「它的紫谱是 15，比你要的高一档」——这句是对的，不该再多要一轮重写。
  assert.deepEqual(checkLevels(k,"Dengeki Tube 的紫谱是 15，比你问的高一档。",{level:"14+",game:"chunithm"}),[]);
  // 但只写定数不算：15.2 是定数，读者不一定把它读成「15 级」，所以照样要拦
  assert.equal(checkLevels(k,"Dengeki Tube 15.2 挺水，推荐。",{level:"14+",game:"chunithm"}).length,1);
});

test("曲库为空、没有条件、空文本都安全返回",()=>{
  assert.deepEqual(checkLevels(null,"Dengeki Tube 14.9",{level:"14+"}),[]);
  assert.deepEqual(checkLevels(k,"Dengeki Tube 14.9",{level:""}),[]);
  assert.deepEqual(checkLevels(k,"",{level:"14+"}),[]);
  assert.deepEqual(checkLevels(k,"哼哼，今天天气不错。",{level:"14+"}),[]);
});

// ── 兜底删除 ──────────────────────────────────────────────────────
// 重写没成功时，程序先把不合格的那条推荐拿掉，而不是留着它只在末尾纠错。
const drop=(text,knowledge=k)=>dropRecommendations(text,checkLevels(knowledge,text,{level:"14+",game:"chunithm"}),{knowledge});
test("列表里的一整行会被拿掉，别的候选留下",()=>{
  const r=drop("中二水的14+有这几首：\n1. Dengeki Tube 15.2 挺水\n2. Titania 14.9 也可以\n挑着打吧。");
  assert.deepEqual(r.dropped,["Dengeki Tube"]);
  assert.deepEqual(r.kept,[]);
  assert.equal(r.text.includes("Dengeki Tube"),false,"不合格的那条不能留在正文里");
  assert.match(r.text,/Titania 14\.9 也可以/,"别的候选要留着");
});
test("句子中间的推荐会被拿掉，接缝不留孤零零的标点",()=>{
  const r=drop("中二比较水的14+，我推荐 Dengeki Tube 15.2，另外 Titania 也不错。");
  assert.deepEqual(r.dropped,["Dengeki Tube"]);
  assert.equal(r.text,"中二比较水的14+，另外 Titania 也不错。");
});
test("整句就是那条推荐：连句子一起拿掉",()=>{
  const r=drop("Dengeki Tube 15.2 挺水。Titania 14.9 也可以。");
  assert.deepEqual(r.dropped,["Dengeki Tube"]);
  assert.equal(r.text,"Titania 14.9 也可以。");
});
test("那一小块里还讲着别的歌就不删——逐字抠会抠出断句",()=>{
  const text="Dengeki Tube 和 Titania 都能上分。";
  const r=drop(text);
  assert.deepEqual(r.dropped,[]);
  assert.deepEqual(r.kept.map(i=>i.title),["Dengeki Tube"]);
  assert.equal(r.text,text,"宁可退到末尾说明，也不能留下「和 都能上分」");
});
test("删完就没内容了也不删：整条回复就是那条推荐",()=>{
  const text="中二水的14+，我觉得 Dengeki Tube 15.2 挺合适。";
  const r=drop(text);
  assert.deepEqual(r.dropped,[]);
  assert.equal(r.text,text);
  assert.equal(r.kept.length,1,"拿掉了就没有内容可发，只能保留原文再说明");
});
test("程序自己说的话按快照口径，不讲成国服实时",()=>{
  const note=levelNote(checkLevels(k,"Dengeki Tube 15.2 挺水。",{level:"14+",game:"chunithm"}),{level:"14+",game:"chunithm"},k);
  assert.match(note,/本地曲库快照/);
  assert.match(note,/不代表国服\/日服实时收录/);
  assert.equal(/国服(?:现在|实时)就是/.test(note),false);
});
