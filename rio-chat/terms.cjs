"use strict";
// 术语层：游戏基础知识——版本、版本俗称、难度叫法、玩家黑话、游戏机制。
//
// 为什么单独一层：曲库只认曲名和谱面字段，于是玩家真正在用的那些词全都落到曲名匹配上。
// 线上实测两次踩坑：①「堇代有哪些 BPM200、定数14.2 的歌」——版本约束被整个丢掉，
// 模型只能凭肉眼翻页；② 上一轮刚解释过「真超檄」是四个版本的合称，下一轮又被当成一首歌。
//
// 三条边界，写在这里免得后来者踩：
//   ① **正式库只收稳定可验证的**：版本名（本地快照的 version 字段能逐字对上）、组合称呼
//      （成员版本逐个能对上）、核心术语。长尾口语走会话 glossary——堆关键词既维护不动，
//      也会把「简单」「水」这类普通词抢成术语。
//   ② **confirmed 术语的精确命中优先于曲名猜测**：version/version_group 命中之后不得再
//      把它解释成一首歌；但**弱匹配不抢占**（子串、模糊一律不算命中）。
//   ③ **机制类条目必须带来源**：写错比查不到更糟，这层的输出会被当成事实讲给群里听。
const fs=require("node:fs"),path=require("node:path");
const {normalize}=require("./knowledge.cjs");

const GAMES=["maimai","chunithm","ongeki"];
const TYPES=["version","version_group","difficulty","mechanic","player_term"];
// 会话 glossary 只从**明确的定义/纠正句式**里学（用户定的规矩：普通提及不学）：
//   X指的是… / X就是… / …合称X（统称X）/ 不是X，是Y
// 目标**不解析散文**：直接在句子里找本地已有的版本名/曲名/难度名，找到什么就用什么。
// 散文解析（「maimai的maimai、maimai plus 和…几个版本的统称」）既脆又容易学错，
// 而「只认本地验证得到的东西」这一条把两边都覆盖了。
const DEFINE_HEAD=/^[^\S\n]*(?:其实|顺便|对了|那个|另外)?[^\S\n]*[「『"“]?([^\s，,。！？、]{1,24}?)[」』"”]?[^\S\n]*(?:指的就是|指的是|就是指|说的就是|指的是|就是|是)[^\S\n]*/;
const GROUP_WORDS=/(?:合称|统称|统称为|合称为|总称|代称)/;
const CORRECT=/(?:不叫|不是|别叫|不读)\s*[「『"“]?([^\s，,。！？、]{1,24}?)[」』"”]?\s*[，,、]?\s*(?:而是|是|叫)\s*/;

// 与 constant-guard.cjs 同一套压缩匹配思路：字符级规范化 + 位置映射，ASCII 别名额外卡
// 词边界（「DX」不能命中「BUDDiES」里的字母），中文别名按子串。
function compactMap(text){
 const flat=[],map=[];let at=0;
 for(const ch of String(text)){
  for(const c of normalize(ch)){flat.push(c);map.push(at);}
  at+=ch.length;
 }
 return {flat:flat.join(""),map};
}
const isAsciiWord=ch=>ch!==undefined&&/[a-z0-9]/.test(ch);
function matchAlias(text,alias){
 const needle=normalize(alias);
 if(!needle)return [];
 // `+` 必须单独判：normalize 会把标点抹掉，「NEW+」和「NEW」规范化之后是同一个串。
 // 不判的话「NEW+」会在「NEW 里有哪些谱」这种句子里命中，等于把复合名退化成裸词。
 const plusAtEnd=/[+＋]\s*$/.test(String(alias));
 const {flat,map}=compactMap(text);
 if(needle.length>flat.length)return [];
 const out=[];let at=flat.indexOf(needle);
 while(at>=0){
  const start=map[at],stop=map[at+needle.length-1]+1;
  const bounded=!isAsciiWord((text[start-1]||"").toLowerCase())&&!isAsciiWord((text[stop]||"").toLowerCase());
  const plusOk=!plusAtEnd||/^[^\S\n]*[+＋]/.test(text.slice(stop));
  // 只有别名本身含 ASCII 字母时才要求词边界；纯中文别名不受影响
  if((bounded||!/[a-z0-9]/.test(needle))&&plusOk){
   const extra=plusOk&&plusAtEnd?(text.slice(stop).match(/^[^\S\n]*[+＋]/)[0]||"").length:0;
   out.push({at:start,end:stop+extra});
  }
  at=flat.indexOf(needle,at+1);
 }
 return out;
}

// ── 载入 ────────────────────────────────────────────────────────────
// 文件：knowledge/{game}-terms.json。缺文件安全退化（这一层没有也能跑）。
function loadTerms(root){
 const byGame={},byId={},index=[];
 for(const game of GAMES){
  const file=path.join(root,"knowledge",game+"-terms.json");
  let data=null;
  try{data=JSON.parse(fs.readFileSync(file,"utf8").replace(/^﻿/,""));}
  catch(error){if(error.code!=="ENOENT")throw Error(game+"-terms.json 读取失败："+error.message);}
  const entries=Array.isArray(data?.entries)?data.entries:[];
  byGame[game]=entries;
  for(const entry of entries){
   if(!entry.id||!entry.type||!TYPES.includes(entry.type))throw Error(game+"-terms.json 里有缺 id/type 或 type 不在清单里的条目："+JSON.stringify(entry).slice(0,80));
   if(byId[entry.id])throw Error("术语 id 重复："+entry.id);
   byId[entry.id]={...entry,game};
   // 名字本身就是别名：name / zh / jp 与 aliases 一起进索引，谁都不用额外登记
   // requiresGameAliases 也要进索引（命中时再判上下文），否则永远都匹配不上
   for(const alias of [entry.name,entry.zh,entry.jp,...(entry.aliases||[]),...(entry.requiresGameAliases||[])]){
    if(!alias)continue;
    index.push({alias:String(alias),normalized:normalize(alias),entry:byId[entry.id]});
   }
  }
 }
 // 长的先匹配：「maimai GreeN PLUS」不能先被「maimai GreeN」切走
 index.sort((a,b)=>b.normalized.length-a.normalized.length);
 return {games:byGame,byId,index,source:path.join(root,"knowledge")};
}

// ── 匹配 ────────────────────────────────────────────────────────────
// 会话 glossary 以同样的形状传进来（source:"session"），优先级高于正式库；
// 两者都命中同一段文字时保留会话那条（用户当场纠正过，以他说的为准）。
function matchTerms(terms,{text,game,session}={}){
 const hits=[];
 const consider=(list,source)=>{
  for(const item of list||[]){
   const entry=item.entry||item;
   if(game&&entry.game&&entry.game!==game)continue;
   const alias=String(item.alias||entry.name||"");
   // requiresGame：只给「很容易误命中的短副标题」用（CHUNITHM 的 NEW/SUN/AIR/STAR 这类
   // 普通英文词或与曲名撞车的写法）。它要求**有可靠的游戏上下文**才算命中——当前句点名了
   // 这款游戏，或者最近几轮对话已经有明确的那一款（由调用方算好传进来的 game）。
   // 没有上下文时宁可不命中：漏掉一个术语比把「新版本」当成 NEW 那一代好。
   if(entry.requiresGameAliases?.includes(alias)){
    if(!game||(entry.game&&entry.game!==game))continue;
   }
   for(const spot of matchAlias(text,alias))hits.push({entry,alias,source,at:spot.at,end:spot.end});
  }
 };
 consider(session,"session");
 consider(terms?.index,"library");
 // 同一段文字被两条命中：覆盖范围长的赢（GreeN PLUS 优先于 GreeN）；范围一样时
 // **原始别名长的赢**（「SUN+」优先于「SUN」——带符号的那个更具体）；再平就取会话的
 // （用户当场纠正过的写法优先于正式库）。
 const taken=[];
 const hits_=hits.sort((a,b)=>(b.end-b.at)-(a.end-a.at)
  ||String(b.alias).length-String(a.alias).length
  ||(a.source==="session"?-1:1));
 for(const hit of hits_){
  if(taken.some(t=>hit.at<t.end&&hit.end>t.at))continue;
  taken.push(hit);
 }
 return taken.sort((a,b)=>a.at-b.at);
}

// 命中里能落到曲库过滤的版本字符串（单版本 + 组合都摊平）。
// **同时返回「认得但没有数据」的那些**：快照里没有的版本（catalogAvailable:false）不能
// 静默忽略——用户点名了一代却拿不到过滤条件时，程序必须能说出这一点，否则就是又一次
// 「版本约束被悄悄丢掉」（正是这一层要修的那类 bug）。
function versionFilterFor(hits,game){
 const versions=new Set(),unavailable=[];
 for(const hit of hits||[]){
  if(!["version","version_group"].includes(hit.entry.type))continue;
  if(game&&hit.entry.game&&hit.entry.game!==game)continue;
  for(const name of hit.entry.catalogVersions||[])versions.add(name);
  // 组合里只要有成员没有数据，也算「部分没有」——说清楚比少说好
  const missing=(hit.entry.members||[]).filter(name=>!(hit.entry.catalogVersions||[]).includes(name));
  if(hit.entry.catalogAvailable===false||missing.length)
   unavailable.push({alias:hit.alias||hit.entry.name,name:hit.entry.name,type:hit.entry.type,
    missing:hit.entry.catalogAvailable===false?[hit.entry.name]:missing});
 }
 return {versions:[...versions],unavailable};
}

// 给模型的事实块（进 evidence，和【本地剧情资料】【本地角色档案】并列）。
function termsPayload(hits,{session}={}){
 const seen=new Set(),out=[];
 for(const hit of hits||[]){
  if(seen.has(hit.entry.id))continue;
  seen.add(hit.entry.id);
  const entry=hit.entry;
  out.push({type:entry.type,id:entry.id,game:entry.game,name:entry.name,
   ...(entry.zh?{zh:entry.zh}:{}),...(entry.jp?{jp:entry.jp}:{}),
   ...(entry.region?{region:entry.region}:{}),
   ...(entry.mappingConfirmed===false?{mappingConfirmed:false,
     note:"这是地区版本名，与日版哪一代对应**没有权威对照**：可以认识这个名字，但涉及日版版本筛选时必须说明对应关系未确认，不要替它映射到某一代。"}:{}),
   ...(entry.catalogAvailable===false?{catalogAvailable:false,
     note:"本地曲库快照没有这一代的曲目数据，不能按它筛曲目——要明确说明这一点，不要默不作声地忽略这个版本条件。"}:{}),
   ...(entry.catalogVersions?.length?{catalogVersions:entry.catalogVersions}:{}),
   // 会变的数据带适用版本/时点；有分歧的说法按多条 claims 存，别单选一个当定论
   ...(entry.asOf?{asOf:entry.asOf}:{}),
   ...(entry.claims?.length?{disputed:Boolean(entry.disputed),claims:entry.claims}:{}),
   ...(entry.members?.length?{members:entry.members}:{}),
   ...(entry.body?{body:entry.body}:{}),
   ...(entry.sources?.length?{sources:entry.sources}:{}),
   ...(hit.source==="session"?{from:"用户本会话的定义"}:{})});
 }
 return out.length?{scope:session?"本会话补充过的术语也在内":"本地术语库",entries:out}:null;
}

// 提示词口径。逐条对应这一层的边界：类型优先、弱匹配不抢占、机制按本地资料答。
function termsRule(terms){
 if(!terms)return "";
 return "\n术语口径：本地有游戏基础知识层（版本名与俗称、版本组合称呼、难度叫法、玩家黑话、游戏机制）。"+
  "用户提到版本（如某一代舞萌、真超檄这类合称）时，先用它过滤曲库，不要把版本名当成曲名或曲目的一部分；"+
  "「这首/曲名/定数/难度」这类说法只对歌用，版本、版本组合、机制都不是歌。"+
  "版本/组合的当前收录以本地曲库的 version 字段为准，命中组合称呼就按组合里的全部版本查。"+
  "**只有当术语资料里那一条明确标了 catalogAvailable:false 时**，才说「这个版本我认识，但本地快照没有它的曲目数据，不能按它筛曲目」；资料里没有这一条就说没有，不要给别的版本也套上这句话。"+
  "游戏机制（rating、榜单、分数评级、牌子、地图/解禁这类）以本地机制资料为准，本地有就直接按它答、不要联网；"+
  "本地没有的机制细节说没有，不要凭印象编。"+
  "机制资料里如果标了 disputed（资料有分歧）或 claims 有多条，说明这一点并按「有资料说有资料说」讲，不要替它选一个当定论。"+
  "标了 asOf 或适用版本的，要照实说那是哪个版本/时点的口径。"+
  "标了 mappingConfirmed:false 的地区版本名，可以认识它，但涉及日版版本筛选时必须说明对应关系未确认，不要自己映射。";
}

// ── 会话 glossary ───────────────────────────────────────────────────
// 只认明确的定义/纠正句式；目标必须是**本地已有的东西**（版本名在快照 version 集合里、
// 曲名在曲名索引里、难度在术语库里）。不通过就什么都不记——宁可漏学，也不能把
// 「我觉得 XX 就是 YY」学进去。
// 规范化名 → 正式版本名。匹配按规范化的来，**输出一律给正式写法**（「maimai GreeN PLUS」
// 不能写成 maimaigreenplus，那东西会跟着事块一起发给模型和用户）。
function catalogVersionSet(terms){
 const map=new Map();
 for(const entry of Object.values(terms?.byId||{}))for(const name of entry.catalogVersions||[])map.set(normalize(name),name);
 return map;
}
// 句子里出现的本地版本名（长的优先，避免「maimai GreeN」把「maimai GreeN PLUS」切走）
function versionsInText(terms,text){
 const set=catalogVersionSet(terms);
 // 按**出现位置**去重，不按名字包含关系：丢掉「每一次出现都被更长的版本名盖住」的那些。
 // 「maimai でらっくす Splash」里那个 maimai 只是前缀，丢掉；而
 // 「maimai、maimai PLUS」里的 maimai 是用户真的要的，必须留下。
 const hits=[];
 for(const [needle,name] of set)for(const spot of matchAlias(text,needle))hits.push({needle,name,at:spot.at,end:spot.end});
 const kept=hits.filter(hit=>!hits.some(other=>other!==hit&&other.needle.length>hit.needle.length
  &&other.at<=hit.at&&other.end>=hit.end&&!(other.at===hit.at&&other.end===hit.end)));
 return [...new Set(kept.map(hit=>hit.name))].sort((a,b)=>b.length-a.length);
}
function validateTarget(raw,{terms,knowledge}={}){
 const text=String(raw||"").replace(/[「」『』“”"'（）()]/g," ").trim();
 if(!text)return null;
 const versions=versionsInText(terms,text);
 if(versions.length)return {kind:"versions",versions};
 const title=(knowledge?.titles||[]).map(entry=>entry.title)
  .sort((a,b)=>b.length-a.length).find(name=>matchAlias(text,name).length);
 if(title)return {kind:"title",title};
 const difficulty=(terms?.index||[]).find(item=>item.entry.type==="difficulty"&&matchAlias(text,item.alias).length);
 if(difficulty)return {kind:"difficulty",id:difficulty.entry.id};
 return null;
}
// 返回 [{alias,type,target,members,evidence}]：调用方自己决定写到会话还是候选文件。
function extractGlossary(text,{terms,knowledge,game}={}){
 const body=String(text||"");
 const out=[];
 const push=(rawAlias,target,evidence)=>{
  const clean=String(rawAlias||"").replace(/[「」『』“”"'（）()]/g,"").trim();
  if(!clean||clean.length>24)return;
  // 别名本身已经是正式库里的术语就不必再学
  if((terms?.index||[]).some(item=>item.normalized===normalize(clean)))return;
  // 别名不能是句子里已有的版本名/曲名本身（「maimai指的是…」是废话）
  if(versionsInText(terms,clean).length)return;
  const checked=validateTarget(target,{terms,knowledge});
  if(!checked)return;
  if(checked.kind==="versions")
   out.push({alias:clean,type:checked.versions.length>1?"version_group":"version",members:checked.versions,game:game||"",evidence});
  else if(checked.kind==="title")out.push({alias:clean,type:"song",target:checked.title,game:game||"",evidence});
  else out.push({alias:clean,type:"difficulty",target:checked.id,game:game||"",evidence});
 };
 // ① X 指的是…：别名在前，目标就是句子里能找到的本地版本/曲名/难度
 const head=body.match(DEFINE_HEAD);
 if(head)push(head[1],body.slice(head[0].length),body);
 // ② …合称 X：别名**紧跟**在合称词后面才算（不紧贴的说明后面是别的话，
 //    例如「…的统称，你可以记一下？」——扫到下一处非标点字符就会学出「你可以记一下」）
 const group=body.match(GROUP_WORDS);
 if(group){
  const after=body.slice(group.index+group[0].length);
  const alias=(after.match(/^[^\S\n]*[「『"“]?([^\s，,。！？、」』"”]{1,24})/)||[])[1];
  if(alias)push(alias,body.slice(0,group.index),body);
 }
 // ③ 纠正句：不是 X，是 Y —— 这里学的是「Y 的正确叫法」，别名取更正后的那个词
 const corrected=body.match(CORRECT);
 if(corrected)push(corrected[1],body.slice(corrected.index+corrected[0].length),body);
 return out;
}
// 会话条目 → 与正式库同形状（多一个 session 标记），交给 matchTerms 用。
function sessionEntries(list){
 return (list||[]).map(item=>({alias:item.alias,source:"session",
  entry:{id:"session:"+item.alias,type:item.type,game:item.game||"",name:item.alias,
   ...(item.members?.length?{catalogVersions:item.members,members:item.members}:{}),
   ...(item.target?{zh:item.target}:{}),session:true}}));
}

module.exports={loadTerms,matchTerms,versionFilterFor,termsPayload,termsRule,
 extractGlossary,validateTarget,sessionEntries,TYPES,GAMES};
