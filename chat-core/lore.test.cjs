"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path"),os=require("node:os");
const {loadStories,lookupLore,loreDecision,lorePayload,storyAnswer,loreRule,trustLevel,mappingTrust,matcher}=require("./lore.cjs");
const {loadKnowledge,loadCharacters}=require("./knowledge.cjs");
const root=__dirname;
// 用真实的剧情库和真实的角色索引：这一层的价值全在「数据 + 别名」能不能接上，
// 换成合成的夹具就测不到「明里→星咲あかり」这类真正会出错的地方。
const stories=loadStories(root);
const knowledge=loadKnowledge(root);
const hit=text=>lookupLore({stories,characters:knowledge.characters,text});
// 合成夹具：只在需要构造「弱命中 / 低置信 / 假别名」这类真实数据里没有的形状时用。
function fixture(list){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"lore-"));
  fs.mkdirSync(path.join(dir,"knowledge"));
  fs.writeFileSync(path.join(dir,"knowledge","ongeki-story.json"),
    JSON.stringify({schemaVersion:1,game:"ongeki",stories:list}));
  return loadStories(dir);
}
const story=extra=>({id:"x",game:"ongeki",type:"event",chapter:"C",title:"T",titleCn:"题",date:null,version:null,
  characters:["高瀬 梨緒"],aliases:[],keywords:[],summary:"摘要",factConfidence:"confirmed",factSources:[],factReviewed:null,
  quoteRefs:[],notes:"",...extra});

test("同一段剧情的多种问法命中同一条",()=>{
  // 这条守的是「用户换一百种说法都能命中同一件事」——别名、中文说法、口语说法都在数据里，
  // 不在正则里。四种问法分别走别名（真人CS / 生存游戏 / 打枪 / 英文原名）。
  for(const text of ["小梨你之前是和akari打过真人cs吗","你们是不是玩过生存游戏",
    "你以前和明里去打枪了吗","ONE BULLET LEFT 是什么剧情","你和明里打过真人 CS 吧"]){
    const hits=hit(text);
    assert.equal(hits[0]?.story.id,"one-bullet-left","没命中："+text);
    assert.equal(hits[0].strength,"strong",text+" 应当算强命中");
  }
});

test("多词英文别名要连空格一起判，不能压平后去比带空格的正文",()=>{
  // 回归：别名 ONE BULLET LEFT 压平是 onebulletleft，正文里是 "one bullet left"，
  // 拿压平串去 includes 永远不中——实测就是这么漏掉「ONE BULLET LEFT 是什么剧情」的。
  const m=matcher("ONE BULLET LEFT");
  assert.ok(m.test("onebulletleft","one bullet left 是什么剧情"));
  // ASCII 别名仍要卡词边界：Air 不能命中 Fairytale 里的 air
  const short=matcher("AIR");
  assert.equal(short.test("fairytale","fairytale"),false);
});

test("无关的话不会被判成剧情问题",()=>{
  for(const text of ["你今天心情怎么样","音击 13 红谱推荐几首","帮我查一下我的B50","晚上吃什么好呢"])
    assert.equal(hit(text).length,0,"误命中："+text);
});

test("说话人自己不算「文本里点名了谁」",()=>{
  // 把说话人算进命中的话，任何一句话都会命中她出场的全部条目（问「心情怎么样」也会）。
  // 所以「只提到梨绪自己」和「提到梨绪+另一个角色但没话题」都不算命中。
  const known=stories.stories.filter(item=>(item.characters||[]).includes("高瀬 梨緒"));
  assert.ok(known.length>=10,"夹具前提：她在多数条目里都登场");
  assert.equal(hit("你今天心情怎么样").length,0);
  assert.equal(hit("你以前和明里做过什么").length,0,"一个角色加不出话题，是噪声不是答案");
});

test("两条置信度轴互不相通：事件被确认不代表台词映射也被确认",()=>{
  // 这正是用户指出的坑——ONE BULLET LEFT 由官方页+wiki 多源确认，但 B4 那批台词
  // 只是按内容推定归属于它。合成一个两级信任等级由两轴决定的层级：
  // human（人工过目）> source（多源确认）> inferred（单源或推断）。
  const o=stories.stories.find(s=>s.id==="one-bullet-left");
  assert.equal(trustLevel(o),"source","事实由多源确认");
  assert.equal(mappingTrust(o),"inferred","台词归属仍是推定，不能被事实的 confirmed 带上去");
  assert.equal(trustLevel(story({factConfidence:"confirmed",factReviewed:{at:"2026-09-18",by:"用户"}})),"human");
  assert.equal(trustLevel(story({factConfidence:"inferred"})),"inferred");
  assert.equal(mappingTrust(story({quoteRefs:[{ref:"B1-01",mappingConfidence:"confirmed"}]})),"source");
  assert.equal(mappingTrust(story({quoteRefs:[]})),"none");
});

test("本地强命中默认不联网，弱命中与无命中才放行",()=>{
  const strong=hit("你和明里打过真人CS吗");
  assert.equal(loreDecision(strong,"你和明里打过真人CS吗").useWeb,false,"本地已确认就该直接答，不必再搜一遍");
  // 弱命中：只中了关键词没中别名，资料不够确定，允许联网补查
  const weak=fixture([story({aliases:[],keywords:["决赛","体育祭"],characters:["高瀬 梨緒","星咲 あかり"]})]);
  const weakHits=lookupLore({stories:weak,characters:knowledge.characters,text:"你和明里的决赛"});
  assert.equal(weakHits[0]?.strength,"weak");
  assert.equal(loreDecision(weakHits,"你和明里的决赛").useWeb,true);
  assert.equal(loreDecision([],"随便问点什么").useWeb,true,"本地没有就得让拆分通道去查");
});

test("用户明说要来源时不重新检索，改写条目自带的 factSources",()=>{
  const text="你们打真人CS那事给我个来源";
  const hits=hit(text),verdict=loreDecision(hits,text);
  assert.equal(verdict.useWeb,false);
  assert.equal(verdict.preferLocalSources,true);
  const payload=lorePayload(hits,{preferLocalSources:verdict.preferLocalSources});
  assert.ok(payload.stories[0].sources.some(u=>u.includes("info-ongeki.sega.jp")));
});

test("注入 prompt 的只有摘要和出处，没有台词正文",()=>{
  const payload=lorePayload(hit("你和明里打过真人CS吗"),{});
  const item=payload.stories[0];
  assert.match(item.summary,/真人 CS/);
  assert.ok(!("quotes" in item)&&!("quoteRefs" in item),"台词不能进 prompt，只留 id");
  assert.ok(!item.sources,"平时不给 source 网址——列出来只会诱使模型念 URL");
  assert.equal(item.strength,"strong");
  assert.equal(item.trust,"source");
  assert.equal(item.mappingTrust,"inferred");
});

test("低置信条目在 payload 里被标出来，提示模型语气留余地",()=>{
  const low=fixture([story({aliases:["某个事件"],factConfidence:"inferred"})]);
  const payload=lorePayload(lookupLore({stories:low,text:"某个事件是什么"}),{});
  assert.equal(payload.stories[0].trust,"inferred");
  assert.match(payload.note,/inferred/);
});

test("只命中角色、没点明是哪一段时，提醒先问清楚而不是硬答",()=>{
  const weak=fixture([story({keywords:["决赛"],characters:["高瀬 梨緒","星咲 あかり"]})]);
  const payload=lorePayload(lookupLore({stories:weak,characters:knowledge.characters,text:"你和明里的决赛"}),{});
  assert.equal(payload.stories[0].strength,"weak");
  assert.match(payload.note,/不要挑一条硬答/);
});

test("storyAnswer 查不到时如实说，并列出已知条目",()=>{
  const answer=storyAnswer(stories,{text:"有没有关于做菜的活动剧情"});
  if(answer.error)assert.match(answer.error,/不要凭印象编剧情/);
  else assert.ok(answer.stories.length,"要么报错要么给条目，不能凭空编");
});

test("loreRule 写死了「事实要认、口吻可嘴硬」这条边界",()=>{
  const rule=loreRule(stories);
  assert.match(rule,/不能否认事实存在/);
  assert.match(rule,/嘴硬/);
  // 「平时不要念网址」和「用户要来源就给」必须同时在场：只写前者会把后者堵死
  // （实测用户明说「给我个来源」，回复里只给了活动名、一个链接都没有）。
  assert.match(rule,/不要念出 source 网址/);
  assert.match(rule,/只有用户明说要出处、来源或链接时/);
  assert.equal(loreRule(null),"","没有剧情库就不注入这条规则");
});

// ── 真实数据文件的不变量 ────────────────────────────────────────────────
test("真实剧情库：字段齐全、id 唯一、别名不空",()=>{
  assert.ok(stories?.stories?.length,"本地剧情库没装上");
  const ids=new Set();
  for(const item of stories.stories){
    assert.ok(item.id&&!ids.has(item.id),"id 缺失或重复："+item.id);
    ids.add(item.id);
    assert.ok(item.title&&item.summary,"条目必须有标题和摘要："+item.id);
    assert.ok(item.aliases.length,"别名不能为空，否则用户永远问不到："+item.id);
    assert.ok(["main","side","event","memory","adventure"].includes(item.type),"未知类型："+item.type);
    assert.ok(["confirmed","inferred"].includes(item.factConfidence),"未知置信度："+item.id);
    for(const name of item.characters||[])
      assert.ok(knowledge.characters.characters.some(c=>c.name===name),"角色名要用曲库正式写法："+name);
  }
});

test("真实剧情库：quoteRefs 只引用存在的台词 id",()=>{
  // 素材单一存储的第一半：story 层只存 id。id 写错了不会报错，只会静默丢关联，
  // 所以在这里卡住。
  const quotes=JSON.parse(fs.readFileSync(path.join(root,"quotes.json"),"utf8"));
  const known=new Set(quotes.entries.map(e=>e.id));
  let refs=0;
  for(const item of stories.stories)
    for(const ref of item.quoteRefs||[]){
      refs++;
      assert.ok(known.has(ref.ref),item.id+" 引用了不存在的台词 id："+ref.ref);
      assert.ok(["confirmed","inferred"].includes(ref.mappingConfidence),"映射置信度缺失："+item.id+"/"+ref.ref);
    }
  assert.ok(refs>=70,"应当把 B1~B4 的台词都挂上，实际只有 "+refs+" 条");
});

test("审核工具会挡住字段不全的条目（缺来源的不能算事实）",()=>{
  // 审核 CLI 是候选入库的唯一入口，形状检查放在那里最省事——缺字段的条目进了索引只会在
  // 运行期静默失效（比如没有 aliases 就永远问不到）。
  const {validate,reviewState}=require("./lore-review.cjs");
  assert.deepEqual(validate(stories.stories.find(s=>s.id==="one-bullet-left")),[],"真实条目必须是齐的");
  const bad=validate({id:"x",type:"event",aliases:[],factConfidence:"maybe",factSources:[]});
  assert.ok(bad.some(m=>/summary/.test(m))&&bad.some(m=>/aliases/.test(m))&&bad.some(m=>/factSources/.test(m)));
  assert.match(reviewState({factConfidence:"confirmed",factReviewed:null}),/多源未过目/);
  assert.match(reviewState({factConfidence:"confirmed",factReviewed:{at:"2026-09-18",by:"用户"}}),/已人工确认/);
});

test("真实剧情库：没有复制台词正文（素材只存一份）",()=>{
  // 另一半：台词原文只住在 quotes.json。同一份原作素材同时服务 persona 与 canon，
  // 复制第二份就等着两边漂移——所以这里逐条比对，story 里不许出现任何一句台词全文。
  const quotes=JSON.parse(fs.readFileSync(path.join(root,"quotes.json"),"utf8"));
  const texts=quotes.entries.map(e=>String(e.zh_adapted||"")).filter(t=>t.length>=8);
  assert.ok(texts.length>50,"夹具前提：quotes.json 里有足够长的台词可比对");
  const leaves=[];
  const walk=value=>{
    if(typeof value==="string")leaves.push(value);
    else if(Array.isArray(value))value.forEach(walk);
    else if(value&&typeof value==="object")Object.values(value).forEach(walk);
  };
  walk(stories.stories);
  for(const text of texts)
    for(const leaf of leaves)
      assert.equal(leaf.includes(text),false,"剧情库里出现了台词正文，只应留 id："+text.slice(0,24)+"…");
});
