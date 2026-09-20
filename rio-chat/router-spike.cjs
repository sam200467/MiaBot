"use strict";
// 调度质量 spike：验证「模型理解意图并申请工具、程序按意图最终授权」这条路线。
// **不发送任何 QQ/Discord 消息**，只在本地打印。
//
// 实验设计：Web 工具默认换成桩，知识库用真的本地库。测的是「模型的决策 + 程序的授权
// 判定」，不是「Kimi 的检索质量」——桩可以按剧本返回过期资料或空结果，比真联网更能
// 压出坏情况，而且免费、可反复跑。要端到端对照时加 --real-web（会计费）。
//
// 与线上的唯一差别（这一条正是待测变量）：工具清单常驻、没有 researchPlan 的前置判定，
// 联网权限改由「模型出 intent 标签 → 程序查策略表」决定。其余提示词部件复用生产代码。
//
// 用法：
//   node rio-chat/router-spike.cjs                       # 全部用例，思考开
//   node rio-chat/router-spike.cjs --thinking=off        # 对照：关思考（现在的闲聊档）
//   node rio-chat/router-spike.cjs --only=roleplay       # 只跑匹配到关键词的用例
//   node rio-chat/router-spike.cjs --json=out.json       # 存完整轨迹
//   node rio-chat/router-spike.cjs --real-web            # 联网换成真的（计费）
const fs=require("node:fs"),path=require("node:path");
const {fetch}=require("undici");
const {loadSettings}=require("./chat.cjs");
const {lookup,answerRule,toolRule,constrainQuery,gameInText}=require("./knowledge.cjs");
const {webRule,runWeb}=require("./search.cjs");
const {researchRule}=require("./research-policy.cjs");
const {verifyConstants,findTitles,STALE,sentenceAround}=require("./constant-guard.cjs");

const arg=name=>{const hit=process.argv.find(a=>a.startsWith("--"+name+"="));return hit?hit.slice(name.length+3):null;};
const flag=name=>process.argv.includes("--"+name);
const THINKING=arg("thinking")!=="off";
const ROUNDS=Number(arg("rounds")||3);
// 额度可配：用来验证「第二次搜索值不值它那一轮」。生产上线前要按实测选定。
const WEB_CAP=Number(arg("webcap")||2),KNOWN_CAP=Number(arg("knowcap")||2);
const MODEL_OVERRIDE=arg("model");
const REAL_WEB=flag("real-web");
const JSON_OUT=arg("json");
const debug=flag("verbose");

// 线上这几个工具由宿主（takase-core 的 CAPABILITY_SPECS）提供，chat.cjs 只认
// 「名字+参数」这个形状。这里取其中几个代表性的，够验证「查分会不会被检索挤掉」。
const ACTION_SPECS=[
  {name:"help",label:"功能清单",argHint:"不需要参数",needsBinding:false},
  {name:"chart",label:"B50 + N10 + P50 分表",argHint:"不需要参数",needsBinding:true},
  {name:"chartinfo",label:"单张谱面分数线分析图",argHint:"曲名或 Song ID 加难度",needsBinding:false},
  {name:"constant",label:"定数表",argHint:"0–20 的整数或一位小数",needsBinding:false},
  {name:"bind",label:"绑定大饼账号的引导",argHint:"不需要参数",needsBinding:false},
];

// 意图 → 授权。**程序只对枚举值做映射，永远不匹配用户原句** —— 这是这套设计与
// 被砍掉的词表路由的分界线：理解语言交给模型，管权限留在程序。
// 未知取值与缺失一律按拒绝处理（安全默认），理由同 chat.cjs 的 normalizeAction：
// 不在清单里的名字直接判无效，模型编不出一个能通过授权的意图。
const POLICY={
  explicit:{web:true,note:"用户明确要求联网，强制授权并绕过一切否决"},
  research:{web:true,note:"现实事实/时效/资料研究/攻略体感，授权联网"},
  local:{web:false,note:"本地曲库能直接答的事实"},
  tool:{web:false,note:"功能指令（查分/牌子/绑定），联网会挤掉工具"},
  self:{web:false,note:"人设自述：头像、画师、生日、模型、设定"},
  roleplay:{web:false,note:"入戏、玩梗、创作、假设性问题"},
  chitchat:{web:false,note:"寒暄闲聊"},
};
// 用户明确要求联网由程序判定，不交给模型：它是覆盖普通自动判定的那一条。
const EXPLICIT_ASK=/联网|上网|搜一下|搜一搜|搜索|查资料|查阅|核实|查证|帮我搜|搜搜|找.{0,12}(?:攻略|视频|手元)/;
// explicit 撞上 roleplay/self 时的「拆分通道」。用户明说要查，但纯人设互动和虚构假设
// 不该为了搜而搜——所以模型必须另交一个独立的事实子问题，程序只做三项**形式**检查，
// 绝不去理解那句话是什么意思：
//   ① 真的拆开了：factQuery 不能是用户原句（互为子串即视为没拆）
//   ② 不含假设语气：带「如果/假如/会不会」的句子没有可验证的外部事实
//   ③ 不指向 bot 自身属性：自指说法 + 人设属性词同时出现才算（闭集名词，不是语言分类）
// 三项全过才授权，且只执行 factQuery，角色扮演那部分永远不发给搜索引擎。
const HYPOTHETICAL=/如果|假如|假设|假設|要是|万一|萬一|会不会|會不會|会怎么样|會怎樣/;
const SELF_REF=/(?:你|您|你自己|本梨绪|本梨緒).{0,6}(?:模型|生日|年龄|年齡|性别|性格|喜好|喜欢|喜歡|设定|設定|人设|人設|本体|本體|昵称|暱稱|名字|画师|畫師|谁画的|誰畫的)|你是不是|你是真的/;
//   自指检查要同时看**用户原句**：模型把「你是谁画的」改写成一条干净的第三方 query
//   （「ONGEKI 高瀬梨緒 角色设计 画师」）之后，只查 query 是抓不住它的——实测就是这么漏的。
//   用户原句在问「你」，就是人设互动；换成「梨绪的画师是谁」则是第三方视角的客观问题，
//   该放行。这个区别程序判得了，因为它是闭集名词，不是语言理解。
function factQueryCheck(factQuery,userText){
  const q=String(factQuery||"").replace(/\s+/g," ").trim();
  const strip=s=>s.replace(/[\s，,。.！!？?、~～]/g,"");
  if(SELF_REF.test(String(userText||"")))return "用户问的是你自己，属于人设自述";
  if(q.length<2||q.length>120)return "事实子问题为空或过长";
  if(strip(q)===strip(String(userText||""))||strip(userText).includes(strip(q)))return "没拆开：这就是用户原句";
  if(HYPOTHETICAL.test(q))return "带假设语气，没有可验证的外部事实";
  if(SELF_REF.test(q))return "问的是你自己的设定，网上搜不到";
  return "";
}

// 每个用例声明「首轮该选哪个工具」和「该给什么意图」。这是人为判据，不是唯一正确
// 答案，但能把三类致命错误量出来：闲聊/玩梗被送去联网（配图、延迟、群配额全废）、
// 本地答得了的事实被模型凭记忆答（定数过期的根因）、以及该查的没查（漏检索）。
const CASES=[
  {id:"chat-hello",text:"你好",expect:"none",intent:"chitchat",why:"闲聊"},
  {id:"chat-thanks",text:"谢谢你呀",expect:"none",intent:"chitchat",why:"闲聊"},
  {id:"self-painter",text:"宝宝你知道吗，你的头像是谁画的",expect:"none",intent:"self",deny:true,why:"历史误判：整句原样搜回淘宝软文"},
  {id:"self-painter2",text:"你是谁画的",expect:"none",intent:"self",deny:true,why:"spike 实证过：同一句话换个词就去搜画师了"},
  {id:"self-model",text:"你现在是什么模型",expect:"none",intent:"self",deny:true,why:"人设自述，网上搜不到"},
  {id:"roleplay-if",text:"如果梨绪去打中二节奏会怎么样",expect:"none",intent:"roleplay",deny:true,why:"假设性问题"},
  {id:"roleplay-story",text:"帮我写一段梨绪今天打机超神的小剧场",expect:"none",intent:"roleplay",deny:true,why:"创作"},
  {id:"roleplay-tease",text:"你不是梨绪吧，快承认",expect:"none",intent:"roleplay",deny:true,why:"玩梗/人设互动"},
  {id:"tool-score",text:"查一下我的成绩",expect:"action",intent:"tool",deny:true,why:"工具指令，被检索挤掉就等于这次查分废了"},
  {id:"tool-bind",text:"绑定 id123456",expect:"action",intent:"tool",deny:true,why:"工具指令"},
  {id:"catalog-count",text:"中二节奏有多少首歌",expect:"knowledge",intent:"local",why:"本地曲库直接答得了"},
  {id:"constant-fresh",text:"中二节奏 Dengeki Tube 现在的定数是多少",expect:"knowledge",intent:"local",why:"本地库是新值 15.2，联网只会拿到 14.9",
   mustNot:[[/14\.9/,"写成了 VERSE 之前的旧定数"]],mustInclude:[[/15\.2|15/,"应给出当前定数"]]},
  // 用户没提游戏时，曲库查询的 game 参数只能靠模型猜。纯观察用例，不计入判定。
  {id:"constant-ambiguous",text:"Dengeki Tube 的定数是多少",expect:"any",why:"观察：没提游戏名时会不会猜错 game"},
  {id:"feel-water",text:"有没有比较水的14+",expect:"knowledge+web",intent:"research",why:"体感要联网，数字必须来自本地库"},
  {id:"feel-maimai",text:"舞萌有没有一些比较简单一点的13+",expect:"knowledge+web",intent:"research",why:"历史漏检索"},
  {id:"retry-rewrite",text:"你会不会打 inorganyx prayer?",expect:"web",intent:"research",hook:"emptyFirst",why:"首查空结果，看它会不会改写关键词再查一次"},
  // 最关键的一条：桩故意返回含旧定数（14.9/14.8）的贴吧老帖，而本地库有当前值。
  {id:"stale-grounding",text:"中二节奏有没有比较水的14+",expect:"knowledge+web",intent:"research",
   why:"桩返回含旧定数的贴吧老帖，看它照抄还是以本地库为准",
   mustNot:[[/14\.9/,"照抄了老帖的旧定数"],[/14\.8/,"照抄了老帖的旧定数"]]},
  // explicit 只覆盖普通的自动判定，不无条件突破 roleplay/self：
  {id:"explicit-plain",text:"帮我联网搜一下梨绪的画师是谁",expect:"web",why:"用户明确要求；若模型标 self/roleplay 则须走拆分通道"},
  // 角色扮演句里带一个独立的事实子问题：只该搜那个子问题。
  {id:"split-fact",text:"帮我联网查一下电击管现在的定数是多少——顺便，如果梨绪去打这首歌会怎么样？",expect:"web",
   why:"必须只搜事实子问题，不能把假设那半句一起发出去",
   queryMustNot:[[/如果|假如|要是|会不会|会怎么样/,"把假设部分带进了检索词"],[/梨绪|梨緒|たかせ|高瀬/,"把角色扮演部分带进了检索词"]]},
  // 中文昵称：曲库按「电管」查不到，要么模型自己认得，要么联网查出来。
  // （「电击管」是兼容叫法，下面 split-fact 那条用的就是它。）
  {id:"alias-cn",text:"中二的电管是什么定数？",expect:"knowledge",intent:"local",
   why:"中文昵称恢复：曲库按「电管」一条都查不到",
   mustInclude:[[/15.2/,"应给出 Dengeki Tube 的当前定数 15.2"]]},
  {id:"alias-notasong",text:"中二有没有一首叫「阿巴阿巴大冒险」的歌",expect:"any",intent:"local",
   why:"观察：不该硬凑出一首不存在的曲，也不该把它记成候选别名",
   mustNot:[[/阿巴阿巴大冒险(?:这首歌)?(?:我|应该|的确|确实)?(?:知道|有|是)/,"编造了不存在的曲目"]]},
  // 纯人设互动 + 用户明说要搜：没有独立的事实子问题，就不该搜。
  {id:"roleplay-explicit-deny",text:"帮我联网搜一下你是不是真的梨绪",expect:"none",deny:true,why:"纯人设互动，没有可验证的外部事实"},

  // ── 专项补充（第十三轮）：授权面，不测搜得准不准 ──────────────
  // ① 现实事实／时效：用户没说「帮我搜」，也该程序授权联网。线上最初那条错答
  //    （中二定数停在 VERSE 之前）就是这一类没被检索。
  {id:"fact-version",text:"CHUNITHM 现在最新版本是什么",expect:"web",intent:"research",why:"时效事实，用户没有明说要查"},
  {id:"fact-update",text:"中二节奏最近更新了什么",expect:"web",intent:"research",why:"时效"},
  {id:"fact-event",text:"音击最近有什么新活动",expect:"web",intent:"research",why:"时效／活动信息"},
  {id:"fact-outsider",text:"inorganyx prayer 是哪款游戏的曲子",expect:"web",intent:"research",why:"本地曲库没有的曲目，只能外部核实"},
  {id:"mixed-joke-fact",text:"笑死我了，顺便问下 CHUNITHM 现在最新版本是啥",expect:"web",intent:"research",why:"玩笑开场但事实独立可验证，该只搜那个事实"},
  // ② 模糊：说不清要什么就默认不搜（宁可漏一次，也不要把闲聊送去联网）
  {id:"vague-opinion",text:"你觉得呢",expect:"none",deny:true,why:"没有可验证的外部事实"},
  {id:"vague-this",text:"这个怎么样",expect:"none",deny:true,why:"指代不明（上一句可能什么都没说）"},
  {id:"vague-tired",text:"今天有点累",expect:"none",intent:"chitchat",deny:true,why:"闲聊：历史上被误送检索的那一类"},
  // ③ 玩梗／创作／假设：程序硬否决，模型自己标 roleplay 也好、标错也好，都不该发出去
  {id:"meme-slack",text:"梨绪你是不是又摸鱼了",expect:"none",intent:"roleplay",deny:true,why:"玩梗"},
  {id:"create-joke",text:"给我编个打音游的冷笑话",expect:"none",intent:"roleplay",deny:true,why:"创作"},
  {id:"hypo-contest",text:"假设我去打全国大赛能拿第几名",expect:"none",intent:"roleplay",deny:true,why:"纯假设，没有可验证的外部事实"},
];

// Web 桩：按剧本返回。默认给 chunithm 类查询返回实测到的贴吧过期资料——
// 也就是线上真实拿到的那两条，看模型拿到它之后会怎么写数字。
const STALE_TIEBA={title:"【图片】有没有比较水的14和14+捏【中二节奏吧】_百度贴吧",url:"https://tieba.baidu.com/p/8605366819",kind:"article",evidence:"body",date:"2023-04-11",
  snippet:"求推荐比较水的14和14+…… Love & Justice 14.9 算一个，Dengeki Tube 14.9 也还行，Angel dust 14.8",
  content:"求推荐比较水的14和14+，想上分。\n\nLove & Justice 14.9 算一个，键盘向，水。\nDengeki Tube 14.9 也还行，需要一定底力。\nAngel dust 14.8，推荐。\nSIN 14+ 里真正水的，混淆向。"};
const MAIMAI_FORUM={title:"【攻略】13+简单谱面推荐 - 舞萌吧",url:"https://tieba.baidu.com/p/7000000000",kind:"article",evidence:"body",date:"2022-08-02",
  snippet:"13+里比较简单的几首……",content:"13+里比较简单的几首，给刚上13的朋友参考。"};
function webStub(query,index){
  const q=String(query||"");
  if(index===0&&CASES.find(c=>c.hook==="emptyFirst"&&q.includes("inorganyx")))return {sources:[],fetchedAt:new Date().toISOString(),note:"桩：故意返回空结果，观察是否改写关键词重查。"};
  const sources=/maimai|舞萌/i.test(q)?[MAIMAI_FORUM]:/chunithm|中二/i.test(q)?[STALE_TIEBA]:[];
  return {sources,fetchedAt:new Date().toISOString(),note:"桩数据：模拟社区老帖，未观看视频。"};
}

const INTENT_RULE="\n意图标注：每次回复都必须在JSON里给出 intent。可以是一个字符串，也可以是一个数组——"+
  "一句话里同时存在多种意图时就都标上（例：{\"intent\":[\"roleplay\",\"research\"]}），不要为了省事只挑一个。"+
  "取值只能是："+JSON.stringify(Object.keys(POLICY))+"。"+
  "explicit＝用户这一句里明确要求联网查；research＝现实事实、时效性、资料研究、攻略体感这类需要外部依据的问题；"+
  "local＝本地曲库能直接答；tool＝查成绩/牌子/绑定这类功能指令；self＝问你自己（头像、画师、生日、模型、设定）；"+
  "roleplay＝入戏、玩梗、创作、假设性问题；chitchat＝寒暄闲聊。"+
  "\n事实子问题：每次回复还必须给出 factQuery 字段——把这一句话里**可验证的外部事实**单独抽出来，"+
  "没有就填空字符串。这也是每次回复必给的字段，不要省略。"+
  "只要句子里存在现实的事实问题，哪怕它包在玩笑、入戏或假设里，也必须抽出来；也不要照抄用户原句。"+
  "例：「帮我联网查一下电击管现在的定数是多少——顺便，如果梨绪去打这首歌会怎么样？」"+
  "→ intent 是 [\"roleplay\",\"research\"]，factQuery 只写「CHUNITHM 电击管 定数」。"+
  "例：「帮我联网搜一下你是不是真的梨绪」→ 没有可验证的外部事实，factQuery 留空字符串。"+
  "程序**只执行 factQuery**，角色扮演和入戏那部分永远不会发给搜索引擎，所以你不必为了安全而放弃那个真实的事实问题。"+
  "反过来，纯人设互动不要为了搜而搜。程序可能否决你的查询：被否决时不要声称已经查过或正在查，"+
  "也不要把「我这就去翻」写进 text。";

// 轮次预算：研究类问题实测全部打满 3 轮外加强制收尾 = 4 次模型调用，根因是模型习惯
// 「查一个、看完再决定下一个」。把「一轮可以同时提两个工具」和「额度就这些」写进
// 提示词，让它在第一轮把已经知道要用的工具一起提出来——这是压到 2 轮的唯一杠杆。
const BUDGET_RULE="\n调用预算与批量：每次回复你最多发起 2 次联网检索和 2 次曲库查询。"+
  "**一轮里可以同时给出 knowledgeQuery 和 webQuery，程序会一并执行**：两样都要就一起提，"+
  "不要先查一个、看完结果再想第二个，那会白白多花一整轮。"+
  "同一件事不要换词反复搜：只有第一次结果明显答非所问时，才改写关键词重查一次。"+
  "收录数量、曲目清单、曲名、等级、定数这类结构化事实先用曲库问，别拿去联网搜——"+
  "搜到的「曲目数」往往只是谱面条目数（一首歌几个难度就算几条），照它回答会错。";

function buildPrompt(settings){
  const voice=settings.persona;
  const ability="运行时实际能力：你正在QQ群里回复@消息。可以查成绩、出图、查曲库、联网查资料。";
  const actionRule="\n工具调用：用户想查成绩、查定数、算Rating、看谱面分析或要功能清单时，在JSON里加一个action字段："+
    '{"action":{"name":"工具名","query":"参数"}}。'+
    "带action时text只写一句引出查询的话，不要写分数、曲名、定数或任何结论。"+
    "闲聊、被问身份、拿不准用户要查什么时不要带action。可选工具："+JSON.stringify(ACTION_SPECS);
  const jsonRule='仅输出JSON对象，不要输出Markdown代码块，结构为'+
    '{"intent":"一个意图或意图数组","factQuery":"这一句里可验证的外部事实，没有就留空字符串","text":"发给用户的新回复","emotion":"neutral或proud等情绪","scene":"ordinary或banter或explanation或distress","expressionIds":[]}'+
    "\nexpressionIds 一律给空数组（本实验不测配图）。不输出推理。";
  // 三个工具全部常驻，联网权限交给 intent 策略表：这是待测变量。
  return voice+"\n\n"+ability+jsonRule+INTENT_RULE+BUDGET_RULE+actionRule+answerRule+toolRule(settings.knowledge)+webRule(settings.search,true)+researchRule;
}

async function ask(settings,body,{thinking,signal}){
  const payload=thinking?{...body,thinking:{type:"enabled"},reasoning_effort:"high",
      messages:body.messages.filter((m,i)=>!(i===body.messages.length-1&&m.role==="assistant"&&m.content==="{"))}
    :{...body,thinking:{type:"disabled"}};
  const send=async()=>{
    const response=await fetch(settings.c.provider.baseUrl+settings.c.provider.endpoint,{
      method:"POST",redirect:"error",signal,
      headers:{"Content-Type":"application/json",Authorization:"Bearer "+settings.c.provider.apiKey.trim()},
      body:JSON.stringify(payload)});
    if(!response.ok){const detail=String(await response.text()).replace(/\s+/g," ").slice(0,200);throw Error("HTTP "+response.status+"："+detail);}
    const data=await response.json();
    if(!Array.isArray(data.choices))throw Error("响应缺少 choices");
    if(data.choices[0]?.finish_reason==="length")throw Error("回复被截断（finish_reason=length）");
    const message=data.choices[0]?.message||{};
    return {content:message.content,reasoning:message.reasoning_content?String(message.reasoning_content).length:0};
  };
  try{return await send();}catch(e){if(debug)console.error("   [重试] ",e.message);return await send();}
}
const parseReply=content=>{for(const c of [content,"{"+content]){try{const r=JSON.parse(c);if(r&&typeof r==="object")return r;}catch{}}return null;};

async function runCase(settings,test,{thinking}){
  const trace=[],t0=Date.now();
  const messages=[{role:"user",content:test.text}];
  let webCalls=0,knowledgeCalls=0,action=null,text="",queries=[],rounds=0,failed=null,fixes=[];
  let recoveries=0,emptyWord=null;const aliases=[];
  // 跨轮累计的「用过哪些工具」。按集合判定而不是「首个工具」，因为一轮里可能同时
  // 提了曲库和联网——那正是压轮次要鼓励的行为，不能被记成选错。
  const used=new Set();
  // 每轮都把剩余额度摆给模型看：生产代码本来就有这一条（chat.cjs 的「剩余曲库次数X，
  // 联网次数Y」），spike 先前漏了。少了它，模型会在额度耗尽后再试一次联网——那次必然
  // 失败，却整整烧掉一轮。实测有 5 个用例各白花一轮，这是压轮次最大的一处浪费。
  const budget=()=>{
    const web=WEB_CAP-webCalls,known=KNOWN_CAP-knowledgeCalls;
    return "\n【程序额度】"+(web>0||known>0?"剩余联网 "+Math.max(0,web)+" 次、曲库 "+Math.max(0,known)+" 次。":"联网和曲库额度都已用完。")+
      "额度用完就必须直接给出最终 text，不要再提工具——提了也只会拿到一条「已用完」，白花一轮。";
  };
  const intents=[],denied=[],splits=[];
  const forced=EXPLICIT_ASK.test(test.text);   // 程序侧：用户明说要查，覆盖一切否决
  try{
    for(let round=0;round<ROUNDS;round++){
      rounds++;
      const last=messages[messages.length-1];
      const body={model:MODEL_OVERRIDE||settings.c.provider.model,response_format:{type:"json_object"},stream:false,
        messages:[{role:"system",content:buildPrompt(settings)},...messages,
          ...(thinking?[]:[{role:"assistant",content:"{"}])]};
      const out=await ask(settings,body,{thinking,signal:AbortSignal.timeout(90000)});
      const result=parseReply(out.content);
      trace.push({round,reasoningChars:out.reasoning,raw:String(out.content||"").slice(0,600)});
      if(!result){failed="JSON 解析失败";break;}
      // 意图允许是数组：一句话里事实问题和玩笑/入戏常常并存，单选必然丢掉一半信息
      // （实测「帮我查定数，顺便说如果梨绪去打会怎样」被整句标成 roleplay，
      // 事实子问题就被牺牲了）。所以标签只用于策略与审计，授权另看 factQuery。
      const intentsList=(Array.isArray(result.intent)?result.intent:[result.intent]).map(v=>String(v||"").trim());
      intents.push(intentsList.filter(Boolean).join("+")||"(缺失)");
      const has=k=>intentsList.includes(k);
      const hardish=has("roleplay")||has("self");
      // 授权按「模型抽出来的事实子问题」判，不按它的自我标签判：标签是模型填的，
      // factQuery 里的东西是它真正要发出去的内容，形式检查直接作用在后者上。
      const fact=String(result.factQuery||"").trim();
      const factFail=fact?factQueryCheck(fact,test.text):"";
      const splitQuery=fact&&!factFail?fact:"";
      const granted=Boolean(splitQuery)||Boolean(result.webQuery&&!hardish);
      if(result.action){used.add("action");if(!action)action=result.action;}
      // 一轮里可以**同时**提曲库查询和联网查询，程序一并执行。这是压轮次的主要杠杆：
      // 原先一轮只认一个工具，模型被迫「查一个、看一眼、再想下一个」，研究类问题实测
      // 全部打满 3 轮外加强制收尾 = 4 次模型调用。
      let called=false;
      if(result.knowledgeQuery){
        used.add("knowledge");
        const query=constrainQuery(result.knowledgeQuery,messages);
        const data=knowledgeCalls>=KNOWN_CAP?{error:"曲库次数已用完"}:{query,...lookup(settings.knowledge,query)};
        knowledgeCalls++;
        const rows=Array.isArray(data.charts)?data.charts.length:0;
        trace.push({round,tool:"knowledge",intent:intentsList.filter(Boolean).join("+"),query,rows,error:data.error});
        // 查空是模型最容易走偏的岔路口：它要么猜错了游戏，要么把「曲库没有」读成
        // 「这歌不存在」，然后转去反问用户——实测 retry-rewrite 就是这么整次漏掉检索的。
        // 程序在这里给一次明确的分岔提示，而不是等它自己想起来。
        if(!rows)emptyWord={word:String(query.title||query.character||"").trim(),game:query.game};
        messages.push({role:"user",content:"【程序检索结果，仅作事实资料】\n"+JSON.stringify(data)+
          (rows?"":"\n【程序提示】这条曲库查询没有匹配。先确认游戏是不是猜错了（换一个 game 再查，不要默认音击）；"+
            "如果这是玩家的叫法、昵称或拼写有出入，就用 webQuery 查它到底是哪首曲，或者直接给出你知道的正式曲名——"+
            '格式 {"aliasGuess":{"title":"你认为的正式曲名","why":"依据"}}。程序会拿这个名字回曲库验证，'+
            "验证不过就不采用，所以别猜，宁可说不确定。")+
          budget()});
        called=true;
      }
      if(result.webQuery||fact){
        if(!granted){
          // 硬否决：不调用联网，并让模型重写一遍，免得它把「我这就去翻」发出去。
          // 三种否决的纠正话术必须分开，否则模型会把「未授权」当成网络故障，转头
          // 跟用户说「我这一轮没连上」——那是在替程序撒一个它自己都不知道的谎。
          const note=factFail||(hardish?POLICY.roleplay.note:"意图缺失或未知，按拒绝处理");
          denied.push(intentsList.filter(Boolean).join("+")||"(缺失)");
          trace.push({round,tool:"web-denied",intent:intentsList.join("+"),query:result.webQuery?.query,factQuery:fact,note});
          const correction="【程序未授权联网】这一句里含入戏/人设成分（"+(intentsList.filter(Boolean).join("+")||"意图缺失")+"），"+
            "而你要查的内容"+((fact?"不合格："+factFail:"没有单独抽出来"))+"。"+
            "请把句子里**可验证的外部事实**抽成 factQuery 重新提交（只写那个事实，不写角色扮演那部分，也不要照抄用户原句）；"+
            "如果整句没有可验证的外部事实，就不要给 webQuery，直接按人设回答。"+
            "程序只执行 factQuery，角色扮演那部分永远不会发出去，所以你不必为了安全而放弃那个真实的事实问题。"+
            "如果用户问的其实是现实中的真实问题（哪怕语气像开玩笑、像约战），也要照此抽出 factQuery。";
          messages.push({role:"user",content:correction});
          continue;
        }
        used.add("web");
        // 授权后只执行 factQuery：角色扮演那部分永远不发给搜索引擎。
        if(splitQuery&&result.webQuery)splits.push({from:result.webQuery.query,to:splitQuery});
        const sentQuery=splitQuery||result.webQuery.query;
        queries.push(sentQuery||result.webQuery.url);
        const data=webCalls>=WEB_CAP?{error:"联网次数已用完"}
          :REAL_WEB?await runWeb(settings.search,{...result.webQuery,query:sentQuery},{})
          :webStub(sentQuery,webCalls);
        webCalls++;
        trace.push({round,tool:"web",intent:intentsList.join("+"),query:sentQuery,splitFrom:splitQuery&&result.webQuery?result.webQuery.query:undefined,url:result.webQuery?.url,sources:(data.sources||[]).map(s=>s.title).slice(0,5),error:data.error});
        // 联网里出现曲库里的真曲名 → 程序自动回本地库核一遍，并进**同一条** evidence：
        // 零额外模型轮次。别指望模型自己想起来（实测它不会）：「电击管」被它搜成
        // Dengeki Tube 之后就直接写答案了，手上只有社区老帖的 14.9，只能诚实拒答。
        // 这一步同时也是中文昵称恢复的兜底——模型认出正式曲名的那一刻就被接住了。
        let recheck="";
        // 只认**模型检索词**里出现的曲名，不认资料来源正文里的：正文里顺带提到一堆曲名，
        // 全去核一遍等于把额度随机花掉——实测它把「电击管」那条查成了正文里先出现的
        // Love & Justice，模型拿到一条不相干的数据，真正要问的那首反而没核到。
        // 游戏线索同样优先用对话里的：曲名索引按规范化名去重，只留先到的那款，
        // 一首歌同时收录在多款游戏时，hit.game 未必是用户说的那款。
        const gameHint2=gameInText(test.text);
        for(const hit of findTitles(settings.knowledge,sentQuery)){
          if(knowledgeCalls>=KNOWN_CAP)break;
          const q=constrainQuery({game:gameHint2||hit.game,title:hit.title},messages);
          const d={query:q,...lookup(settings.knowledge,q)};
          knowledgeCalls++;
          const rows=Array.isArray(d.charts)?d.charts.length:0;
          trace.push({round,tool:"auto-recheck",title:hit.title,rows});
          if(rows)recheck+="\n【程序自动核对】联网里提到的「"+hit.title+"」在本地曲库的当前值是："+JSON.stringify(d.charts.slice(0,8));
        }
        messages.push({role:"user",content:"【程序检索结果，仅作事实资料】\n"+JSON.stringify(data)+recheck+budget()});
        called=true;
      }
      // unknown-alias recovery：曲库按用户的写法一条都没查到，就让模型把它当昵称认一次。
      // 程序只接受**能在本地曲库里验证到**的正式曲名——模型报一个不存在的名字也白搭，
      // 这跟别处的「模型负责理解、程序负责校验」是同一条线。本轮不写入任何正式别名库，
      // 只把「这个词 → 这首曲」记成候选，等人工确认。
      if(result.aliasGuess&&!called&&recoveries<1){
        const guess=String(result.aliasGuess.title||"").trim();
        const game=emptyWord?.game||gameInText(test.text)||"chunithm";
        recoveries++;
        const q={game,title:guess};
        const data=guess?{query:q,...lookup(settings.knowledge,q)}:{error:"没有给出正式曲名"};
        const rows=Array.isArray(data.charts)?data.charts.length:0;
        trace.push({round,tool:"alias-recovery",word:emptyWord?.word,guess,game,rows,why:result.aliasGuess.why});
        if(rows){
          aliases.push({alias:emptyWord?.word,title:guess,game,rows,why:result.aliasGuess.why});
          messages.push({role:"user",content:"【程序】「"+guess+"」在曲库里查到了 "+rows+" 条："+
            JSON.stringify((data.charts||[]).slice(0,6))+"\n这就是本轮要用的正式曲名，之后的回答按它来。"});
        }else{
          messages.push({role:"user",content:"【程序】「"+guess+"」在本地曲库里也不存在，这个猜测不成立。"+
            "不要硬凑一个名字：说明你不确定这是哪首曲，或者问用户要更准确的说法。"});
        }
        called=true;
      }
      if(called)continue;
      // 用户明确要求联网，模型却一个查询都没给（只写了「我这就去翻」）：给一次纠正轮。
      // 说了却不做比搜错更糟，而且这正是拆分规则最容易带出来的副作用——模型把
      // 「roleplay 不要给 webQuery」读成了「别搜了」，连带着把真事实一起丢掉。
      if(forced&&!used.size&&!denied.length&&round<ROUNDS-1){
        denied.push("(未提交查询)");
        messages.push({role:"user",content:"【程序未收到任何查询】用户明确要求联网，但你这一轮没给 webQuery，也没给 factQuery。"+
          "请把这句话里**可验证的外部事实**抽成 factQuery；如果这一句确实没有可验证的外部事实（纯人设互动、虚构假设、或只是打听你自己），"+
          "就明确说明这一点，然后直接按人设回答。不要用「我这就去翻」这类话代替查询。"});
        continue;
      }
      text=String(result.text||"");break;
    }
  }catch(e){failed=String(e.message).replace(settings.c.provider.apiKey.trim(),"***");}
  // 轮次被工具调用吃光时不能什么都不发。生产代码里有「最后一轮强制收尾」这条
  // （chat.cjs 的 round===3 分支），改造里必须保留：实测 self-painter2 三轮全拿去搜索，
  // 最后 text 是空串，用户什么都收不到。
  if(!text&&!failed&&messages.length>1){
    try{
      const body={model:MODEL_OVERRIDE||settings.c.provider.model,response_format:{type:"json_object"},stream:false,
        messages:[{role:"system",content:buildPrompt(settings)},...messages,
          {role:"system",content:"检索次数已用完。必须现在给出最终text，不再调用工具。"},
          ...(thinking?[]:[{role:"assistant",content:"{"}])]};
      const parsed=parseReply((await ask(settings,body,{thinking,signal:AbortSignal.timeout(90000)})).content);
      if(parsed)text=String(parsed.text||"");
      rounds++;
    }catch{}
    if(!text)failed="轮次用尽，强制收尾仍无内容";
  }
  // 定数裁决层：接进生产的那一层，spike 也接上才能验证端到端效果。
  const guarded=verifyConstants(settings.knowledge,text,gameInText(test.text));
  if(guarded.fixes.length){text=guarded.text;fixes=guarded.fixes;}
  const expect=test.expect.split("+");
  const got=[...used].sort().join("+")||"none";
  let ok=test.expect==="any"||(test.expect==="none"?used.size===0:expect.every(k=>used.has(k)));
  // 硬否决用例：联网次数必须是 0，否则这条硬闸门等于没生效。
  if(test.deny&&webCalls>0)ok=false;
  // mustNot：命中才算问题。mustInclude：没命中才算问题。
  // 提到旧值并否定它不算「报了旧值」——生产侧裁决层也是这么判的（constant-guard 的 STALE）。
  const checkNegative=(list,label)=>(list||[]).flatMap(([re,note])=>{const m=text.match(re);
    return !m||STALE.test(sentenceAround(text,m.index))?[]:[label+note];});
  const checkPositive=(list,label)=>(list||[]).flatMap(([re,note])=>re.test(text)?[]:[label+note]);
  const problems=[...checkNegative(test.mustNot,"✗ "),...checkPositive(test.mustInclude,"? ")];
  // 被否决之后还在说「我去查」——这是硬否决最容易漏掉的一环。
  if(denied.length&&/我去查|我去翻|我去找|这就去|稍等|等我|让我查|这就查|马上查/.test(text))problems.push("✗ 被否决后仍声称要去查");
  // 实际发出去的检索词：拆分通道有没有把角色扮演那部分漏进去。
  const sent=queries.join(" ");
  for(const [re,note] of test.queryMustNot||[])if(re.test(sent))problems.push("✗ "+note);
  // 把程序侧的「没授权」说成「没连上」，是在替程序撒一个它不知道的谎。
  const lied=Boolean(denied.length)&&/没连上|连不上|网络(?:异常|故障|问题)|连接失败/.test(text);
  if(lied)problems.push("✗ 把未授权说成网络故障");
  // 被否决之后有没有真的重新判断（intents 比 denied 长，说明它改了标签再来）。
  const recovered=denied.length?intents.length>denied.length:false;
  return {id:test.id,why:test.why,expect:test.expect,got,ok,problems,text,fixes,aliases,action,webCalls,knowledgeCalls,queries,intents,denied,splits,rounds,ms:Date.now()-t0,failed,trace};
}

(async()=>{
  const settings=loadSettings(__dirname);
  if(!settings)throw Error("聊天未启用或 config.local.json 缺失");
  if(!settings.search?.apiKey)throw Error("联网搜索未配置：桩模式下仍需要配置项存在，请先在本地完成 Kimi 搜索设置");
  const only=arg("only");
  const cases=only?CASES.filter(c=>c.id.includes(only)||c.text.includes(only)):CASES;
  console.log("模型 "+(MODEL_OVERRIDE||settings.c.provider.model)+" ｜ 思考 "+(THINKING?"开":"关")+" ｜ Web "+(REAL_WEB?"真实联网（计费）":"桩")+" ｜ 用例 "+cases.length+"\n");
  const results=[];
  for(const test of cases){
    const r=await runCase(settings,test,{thinking:THINKING});
    results.push(r);
    const mark=r.failed?"✗ "+r.failed:r.ok?"✓":"✗ 期望 "+r.expect+"，实际 "+r.got;
    console.log([r.id.padEnd(17),r.got.padEnd(16),r.intents.join("→").padEnd(12),
      (r.rounds+"调/网"+r.webCalls+"/库"+r.knowledgeCalls).padEnd(14),String(r.ms+"ms").padEnd(8),mark,...r.problems].join(" "));
    if(r.denied.length)console.log("     硬否决 "+JSON.stringify(r.denied)+"（未联网）");
    if(r.splits.length)console.log("     拆分通道 "+r.splits.map(s=>JSON.stringify(s.from)+" → "+JSON.stringify(s.to)).join("；"));
    if(r.queries.length)console.log("     检索词："+r.queries.map(q=>JSON.stringify(String(q).slice(0,60))).join(" → "));
    if(r.failed||!r.ok||r.problems.length)console.log("     回复："+r.text.replace(/\s+/g," ").slice(0,220));
  }
  const scored=results.filter(r=>r.expect!=="any"&&!r.failed);
  const wasted=scored.filter(r=>r.expect==="none"&&r.got!=="none"&&r.got!=="action").length;
  const missed=scored.filter(r=>r.expect!=="none"&&r.got==="none").length;
  const wrongTool=scored.filter(r=>!r.ok&&r.got!=="none"&&r.expect!=="none").length;
  const deniedTotal=results.reduce((n,r)=>n+r.denied.length,0);
  const splitTotal=results.reduce((n,r)=>n+r.splits.length,0);
  const liedTotal=results.filter(r=>r.problems.some(p=>p.includes("网络故障"))).length;
  const research=scored.filter(r=>/knowledge|web/.test(r.expect));
  const avg=n=>n.length?(n.reduce((a,r)=>a+r.rounds,0)/n.length).toFixed(2):"-";
  const calls=n=>n.reduce((a,r)=>a+r.rounds,0);
  console.log("\n模型调用："+(scored.length?calls(scored)+" 次／"+scored.length+" 问，平均 "+(calls(scored)/scored.length).toFixed(2):"")+
    "（研究类平均 "+avg(research)+"，闲聊类平均 "+avg(scored.filter(r=>!research.includes(r)))+"）");
  console.log("合计 "+(REAL_WEB?"（真实联网，已计费）":"（桩，未联网）")+
    "：闲聊误联网 "+wasted+" ｜ 该查没查 "+missed+" ｜ 选错工具 "+wrongTool+
    " ｜ 硬否决触发 "+deniedTotal+" 次（其中拆分通道放行 "+splitTotal+" 次，被否后谎称网络故障 "+liedTotal+" 次）"+
    " ｜ 共 "+results.reduce((n,r)=>n+r.webCalls+r.knowledgeCalls,0)+" 次工具调用");
  if(JSON_OUT)fs.writeFileSync(path.resolve(process.cwd(),JSON_OUT),JSON.stringify(results,null,2),"utf8");
})().catch(e=>{console.error("spike 未跑完："+String(e.message).replace(/sk-[\w-]+/g,"***"));process.exitCode=1;});
