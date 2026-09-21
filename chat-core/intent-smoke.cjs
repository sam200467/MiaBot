"use strict";
// 生产链路的意图—授权冒烟：走**真的** requestReply（真的提示词、真的策略表、真的工具链），
// 模型是真的，网页是桩。router-spike 验的是候选设计（它自带提示词与循环），这一支验的是
// 接进主链路之后的实际行为，两者不能互相替代。
//
// 用法：node chat-core/intent-smoke.cjs           全部用例
//       node chat-core/intent-smoke.cjs fact-    只看 id 匹配的
const {loadSettings,requestReply}=require("./chat.cjs");

const CASES=[
  // 现实事实／时效：用户没说「帮我搜」，也该自动联网
  {id:"fact-version",text:"CHUNITHM 现在最新版本是什么",want:"web",why:"时效事实"},
  {id:"fact-event",text:"音击最近有什么新活动",want:"web",why:"时效／活动"},
  {id:"fact-outsider",text:"inorganyx prayer 是哪款游戏的曲子",want:"web",why:"本地曲库没有的曲目"},
  // 模糊：默认不搜
  {id:"vague-opinion",text:"你觉得呢",want:"none",why:"没有可验证的外部事实"},
  {id:"vague-tired",text:"今天有点累",want:"none",why:"闲聊"},
  // 入戏／人设／玩梗／创作／假设：程序硬否决
  {id:"roleplay-hypo",text:"如果梨绪去打全国大赛会怎么样",want:"none",why:"假设"},
  {id:"meme-slack",text:"梨绪你是不是又摸鱼了",want:"none",why:"玩梗"},
  {id:"create-joke",text:"给我编个打音游的冷笑话",want:"none",why:"创作"},
  {id:"self-painter",text:"宝宝你知道吗，你的头像是谁画的",want:"none",why:"人设自述"},
  // 混合：玩笑＋独立事实 / 入戏＋独立事实
  {id:"mixed-joke-fact",text:"笑死我了，顺便问下 CHUNITHM 现在最新版本是啥",want:"web",why:"玩笑归玩笑，事实要查"},
  {id:"split-fact",text:"帮我联网查一下电管现在的定数——顺便，如果梨绪去打这首歌会怎么样？",want:"web",why:"只该搜事实那半句"},
  // 术语层：版本组合过滤走曲库、机制走本地资料、没收录的俗称不能猜
  {id:"term-group",text:"真超檄里有没有 BPM200、定数14.2 的谱",want:"none",why:"版本组合过滤该走曲库，不必联网"},
  {id:"term-mechanic",text:"音击的 RATING 三榜是怎么算的",want:"none",why:"机制问题本地资料优先（线上就是这里搜出无关结果的）"},
  {id:"term-not-as-song",text:"真超檄是什么",want:"any",why:"观察：会不会把版本组合说成一首歌"},
  // 没收录的俗称：查是合理的（现实事实问题），重点是不能硬猜一个对应关系。
  // 实测它会去搜、搜不到就明说不确定，也没有编一个版本出来——这就是要的行为。
  {id:"term-unknown",text:"堇代指的是哪一代舞萌",want:"any",why:"观察：会不会硬猜一个版本对应关系"},
  // 来源展示（第十六组）：默认零来源 / 要出处给本地 source / 网页回答只展示实际引用的
  {id:"src-local-none",text:"真超檄是什么",want:"any",sources:"none",why:"本地术语答的，底部不该出现任何链接"},
  {id:"src-mechanic-none",text:"音击的 RATING 三榜是怎么算的",want:"none",sources:"none",why:"本地机制资料答的，零联网零来源"},
  {id:"src-asked-local",text:"真超檄是什么，给个来源",want:"none",sources:"asked",why:"要出处时给本地条目自带的 source，且不为凑链接联网"},
  // 搜了但答案来自曲库 → 仍然零来源（这正是本次要修的形状：搜到 ≠ 依据）
  {id:"src-web-unused",text:"中二有没有简单一点的14+",want:"web",sources:"none",why:"搜到但没引用：底部仍然不该有链接"},
  // 答案真的依赖网页（本地答不了）→ 只展示模型引用的那条
  // 桩内容是占位的「最新版本是 X」，好模型会拒绝引用它——所以这里只观察，不硬判脚注形态；
  // 「引用了才展示、且只展示引用那条」由 chat.test.cjs 的确定性用例覆盖。
  {id:"src-web-cited",text:"中二节奏现在最新版本是什么",want:"web",sources:"any",why:"观察：引用到网页时才挂脚注"},
  // 原作剧情（canon）：本地剧情库命中就该直接用本地事实，不联网。
  // 第一条就是线上答错的那句——它曾经答「没有的事！我哪跟明里打过真人CS」，
  // 而原作里确实有（2020 年 10 月的活动 ONE BULLET LEFT）。这一支要看两件事：
  // 联网次数为 0，且回复不再否认。
  {id:"canon-local",text:"小梨你之前是和akari打过真人cs吗",want:"none",why:"本地剧情库已确认，不该联网"},
  {id:"canon-source",text:"你们打真人CS那事给我个来源",want:"none",why:"条目自带 factSources，不重新检索"},
  {id:"canon-unknown",text:"梨绪和明里还一起做过什么",want:"web",why:"本地没有对得上的事件，允许走拆分通道"},
  // 角色档案层：问别的角色是谁。本地有档案就该直接用、不联网；这一支还要看回复有没有
  // 说「我不认识她」——那正是这一层上线前的线上答法（模型手里没资料时最安全的输出）。
  // 第三条的「枫」在 characters.json 里是单字别名，走的是单字那道闸门，专门覆盖它。
  {id:"profile-who",text:"井之原小星是个什么样的人",want:"none",why:"本地档案已覆盖"},
  {id:"profile-teammate",text:"你和椿关系怎么样",want:"none",why:"队友的单字简称也要认出来"},
  {id:"profile-pair",text:"有栖和枫是什么关系",want:"none",why:"本地档案已覆盖，且「枫」走单字路径"},
];

// 桩网页：不碰 Kimi 计费。返回一条能当依据的资料，顺便把发出去的检索词记下来。
const stubSources=query=>({
  sources:[{title:"CHUNITHM 版本一览（桩）",url:"https://gamerch.com/chunithm/1",kind:"article",evidence:"body",
    date:"2026-09-01",snippet:"最新版本是 X。",content:"最新版本是 X，2026 年 9 月实装。音击最近的活动是 Y。"}],
  fetchedAt:new Date().toISOString(),note:"桩数据",
});
const webStub=queries=>async(url,init)=>{
  const body=JSON.parse(init.body);const query=body.text_query||body.url||"";
  queries.push(query);
  const payload={search_results:(stubSources(query).sources||[]).map(s=>({title:s.title,url:s.url,date:s.date,chunks:[{text:s.content}]}))};
  return {ok:true,status:200,text:async()=>JSON.stringify(payload),json:async()=>payload};
};
const strip=s=>String(s||"").replace(/\s+/g," ").trim();

(async()=>{
  const settings=loadSettings(__dirname);
  if(!settings)throw Error("聊天未启用或 config.local.json 缺失");
  if(!settings.search?.apiKey)throw Error("联网搜索未配置：桩模式下仍需要配置项存在");
  const only=(process.argv.find(a=>a.startsWith("--only="))||"").slice(7);
  const cases=only?CASES.filter(c=>c.id.includes(only)):CASES;
  console.log("模型 "+settings.c.provider.model+" ｜ 真链路 requestReply ｜ 网页为桩 ｜ 用例 "+cases.length+"\n");
  const rows=[];
  for(const test of cases){
    const queries=[];
    let out=null,error="";
    const t0=Date.now();
    try{
      // 每个用例一份新的搜索缓存：runWeb 会把成功结果缓存 24 小时，共用一个 cache 的
      // 话后一个用例会直接命中前一个的缓存，桩根本不会被调用——测出来的就不是本次行为。
      const fresh={...settings,search:settings.search?{...settings.search,cache:new Map()}:settings.search};
      out=await requestReply(fresh,[{role:"user",content:test.text}],{webFetchImpl:webStub(queries),fetchImpl:undefined});
    }catch(e){error=strip(e.message).slice(0,120);}
    const research=out?.research||{};
    const searched=Boolean(research.webCalls);
    // 来源展示只在三种形态里判：没有脚注 / 本地出处 / 引用了的网页（「搜索结果（供核对）」不该出现）
    const footer=(out?.text||"").match(/\n\n(资料出处[^\n]*|参考资料：|搜索结果（供核对）：)/);
    const footerKind=!footer?"none":/资料出处/.test(footer[1])?"local":/搜索结果/.test(footer[1])?"unfiltered":"cited";
    const sourcesOk=!test.sources||(test.sources==="none"?footerKind==="none"
      :test.sources==="asked"?(footerKind==="local"||footerKind==="cited"):footerKind==="cited");
    const ok=error?false:(test.want==="web"?searched:!searched)&&sourcesOk;
    rows.push({...test,ok,error,searched,queries,intent:out?.intent,factQuery:out?.factQuery,
      denied:out?.webDenied||[],splits:out?.webSplits||[],text:strip(out?.text).slice(0,400),ms:Date.now()-t0,
      lore:out?.lore,profiles:out?.profiles,canonFixed:out?.canonFixed||[],canonDenied:out?.canonDenied||[]});
    const mark=error?"✗ "+error:ok?"✓":"✗ 期望 "+(test.want==="web"?"联网":"不联网");
    console.log([test.id.padEnd(16),("网"+(searched?queries.length:0)).padEnd(6),("来源:"+footerKind).padEnd(12),
      ("拒绝"+(rows.at(-1).denied.length)).padEnd(6),String(rows.at(-1).ms+"ms").padEnd(8),mark].join(" "));
    console.log("     意图："+JSON.stringify(out?.intent)+" ｜ 事实子问题："+JSON.stringify(out?.factQuery));
    if(queries.length)console.log("     发出去的检索词："+queries.map(q=>JSON.stringify(String(q).slice(0,60))).join(" → "));
    if(rows.at(-1).denied.length)console.log("     被拒："+rows.at(-1).denied.map(d=>d.intents.join("+")+"/"+d.reason).join("；"));
    // 剧情层要单独看：命中没命中、本地答的还是转的联网、有没有触发否认纠正。
    // 纠正次数是这一层的核心指标——它决定「事实必须认」这条规则到底有没有生效。
    const lore=rows.at(-1).lore;
    if(lore)console.log("     剧情：命中 "+lore.hits.map(h=>h.id+"/"+h.strength).join("、")+
      " ｜ 本地作答="+lore.localAnswered+
      " ｜ 纠错"+(rows.at(-1).canonFixed.length?"已触发并成功（"+rows.at(-1).canonFixed.join("、")+"）":
        rows.at(-1).canonDenied.length?"已触发但失败（"+rows.at(-1).canonDenied.join("、")+"）":"未触发"));
    // 档案层同样单独看：命中了谁、本地答的还是转的联网。单字命中会带 /solo 后缀，
    // 那是这一层唯一可能认错人的路径，值得单独盯。
    const profiles=rows.at(-1).profiles;
    if(profiles?.hits?.length)console.log("     档案：命中 "+profiles.hits.join("、")+
      " ｜ 本地作答="+profiles.localAnswered);
    // 回复恒打印：冒烟的价值一半在数字、一半在实际说了什么，只在失败时打印等于丢掉一半。
    if(rows.at(-1).text)console.log("     回复："+rows.at(-1).text);
  }
  const bad=rows.filter(r=>!r.ok);
  const leaked=rows.filter(r=>r.want==="none"&&r.searched);
  const missed=rows.filter(r=>r.want==="web"&&!r.searched);
  console.log("\n合计：不该搜却搜了 "+leaked.length+" ｜ 该搜没搜 "+missed.length+" ｜ 失败 "+rows.filter(r=>r.error).length);
  if(bad.length)console.log("未通过的用例："+bad.map(r=>r.id).join("、"));
  process.exit(bad.length?1:0);
})();
