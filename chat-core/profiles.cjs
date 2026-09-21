"use strict";
// 角色档案层（其他角色的基本人设）。
//
// 为什么单独一层：群里问「井之原小星是个什么样的人」「有栖和枫是什么关系」，是这一层
// 唯一能给出**有来源**答案的地方。剧情层（lore.cjs）答的是「发生过什么」，persona.md 答的
// 是「梨绪自己是谁」，两者都不覆盖「别人是谁」。没有这一层时模型只能凭训练印象描述，
// 而印象里的角色设定经常是错的（中文译名、组合归属、性格概括都容易串）；更糟的是它会
// 说「我不认识这个人」——而 uncertainty（research-policy.cjs）含「不认识」，会触发一次
// 按用户原句的兜底检索，那条路又常被 roleplay/self 的硬闸门掐掉，最后既不查也不纠正。
//
// 三条边界，写在这里免得后来者踩：
//   ① **不存别名、不存曲目、不存组合与 CV**。别名解析只有一套（knowledge.cjs 的 index +
//      lore.cjs 的 charactersInText），直接复用；组合与 CV 运行时从 ongeki-characters.json
//      join。曲目问题归 knowledge.cjs，事件归 ongeki-story.json。
//   ② **数据里含梨绪本人，但运行时不注入她**。她的人设以 persona.md 为唯一真相源；
//      档案是第三人称资料，注入给她自己会把第一人称演出变成念设定集。
//   ③ **置信度按块记，不塌缩成一个数**。basics/profile 来自 SEGA 官方角色页，extras 官方站
//      没有、只有 wikiwiki 单源。若按整条取最弱，官方确认的生日会被 extras 拖成「语气留
//      余地」——这正是 lore.cjs 那两条互不相通的轴的同一个教训。
//
// 误判代价不对称（同 canon-guard.cjs）：宁可漏检，也不要把正确回答改错。单字别名
// （茜/枫/葵/纺/椿）因此要走两道闸门，任何一道不过就整条不注入。
const fs=require('node:fs'),path=require('node:path');
const {normalize}=require('./knowledge.cjs');
const {charactersInText}=require('./lore.cjs');
const looseNorm=s=>String(s??'').normalize('NFKC').toLowerCase();
const SELF_DEFAULT='高瀬 梨緒';

// ── 单字别名 ────────────────────────────────────────────────────────────
// characters.json 里规范化后长度为 1 的别名共 7 个：主角 5 个（茜/枫/葵/纺/椿）外加非主角
// 的光/橙。knowledge.cjs:82 会把它们挡在 index 之外，所以 charactersInText 永远认不出来。
//
// **这不是第二套别名表**：它是从 characters.json 的 aliases 投影出来的，只挑「规范化后
// 长度恰为 1」的写法，改别名表不必改这里（测试卡住这条）。同一个单字落到两个角色时整条
// 丢弃——歧义不猜。
//
// 两道闸门相与，因为单独任何一道都漏：
//   ① 只靠闸门②会被没见过的词打穿（黑名单永远补不完）；
//   ② 只靠闸门①会被「介绍一下/怎么样」这类泛问句打穿（「介绍一下向日葵」）。
// 残余误命中的代价只是多注入一条档案，且 payload 里带了提醒，认错的代价是一句反问。
// 「怎么样」也在里面：它是问一个人最自然的说法（「你和椿最近怎么样」），漏掉它等于把
// 队友的问法也漏了。放宽的代价由闸门② 兜——「向日葵长得怎么样」靠「日葵」挡住。
const SOLO_CONTEXT=/性格|人设|人設|什么样|什麼樣|怎么样|怎麼樣|是谁|是誰|介绍|介紹|关系|關係|生日|身高|血型|星座|年级|年級|年龄|年齡|爱好|愛好|擅长|擅長|印象|特点|特點|为人|為人/;
// 邻字黑名单（二元组）。闭集词表，加词比加正则便宜。只判二元组不判单字，因为要挡的正是
// 「这个字是某个常见词的一部分」。用户真把「葵」当人叫时，两边通常是标点、空格或「和/的」。
const SOLO_BLOCK=new Set([
  '日葵','葵花','秋葵','蜀葵','锦葵','冬葵','葵扇','葵鼠',
  '香椿','椿象','椿油','山椿','臭椿','椿萱',
  '枫叶','楓葉','枫树','楓樹','枫糖','楓糖','丹枫','红枫','紅楓','枫林','枫桥',
  '纺织','紡織','纺纱','紡紗','纺车','紡車','纺锤','紡錘','棉纺','毛纺','混纺',
  '茜草','茜色','茜素',
]);
function soloAliases(characters,profiles){
  if(!characters?.characters||!profiles?.profiles?.length)return new Map();
  if(profiles.__soloAliases)return profiles.__soloAliases;
  const byName=new Map(characters.characters.map(char=>[char.name,char]));
  const map=new Map(),conflict=new Set();
  for(const profile of profiles.profiles){
    const char=byName.get(profile.name);
    for(const alias of char?.aliases||[]){
      const key=normalize(alias);
      if(key.length!==1)continue;
      const prev=map.get(key);
      if(prev&&prev.name!==char.name){conflict.add(key);continue;}
      if(!prev)map.set(key,char);
    }
  }
  // 冲突的单字整条丢弃：宁可漏检，也不猜用户叫的是哪个
  for(const key of conflict)map.delete(key);
  profiles.__soloAliases=map;   // 缓存挂在 profiles 上，它由 loadProfiles 每次新建，不会串
  return map;
}
function soloHit(text,flat,characters,profiles){
  const out=new Map();
  const map=soloAliases(characters,profiles);
  if(!map.size)return out;
  if(!SOLO_CONTEXT.test(String(text||'')))return out;   // 闸门①：整句不像在问角色，整段不启用
  for(const [key,char] of map){
    for(let at=flat.indexOf(key);at>=0;at=flat.indexOf(key,at+1)){
      const before=flat[at-1]||'',after=flat[at+1]||'';
      if(SOLO_BLOCK.has(before+key)||SOLO_BLOCK.has(key+after))continue;   // 闸门②
      out.set(key,{key,char,at});
      break;
    }
  }
  return out;
}

// ── 装载 ────────────────────────────────────────────────────────────────
// 失败语义照 loadStories：缺文件 / JSON 坏 / profiles 不是非空数组 → null。
// 消费侧一律真值兜底；「这层没装」与「装了但没数据」必须是同一种表现。
function loadProfiles(root,fileName='ongeki-profiles.json'){
  const file=path.join(root,'knowledge',fileName);
  if(!fs.existsSync(file))return null;
  let data;
  try{data=JSON.parse(fs.readFileSync(file,'utf8').replace(/^﻿/,''));}catch{return null;}
  if(!Array.isArray(data.profiles)||!data.profiles.length)return null;
  return data;
}

// ── 检索 ────────────────────────────────────────────────────────────────
// 打分只分两档：正式命中 > 单字命中。排序用（档位，正文位置，名字）三级，保证输出确定，
// 测试可以断言顺序；三级全用完还没分出胜负的情况不存在（名字唯一）。
const SCORE={name:10,solo:4};
function firstPos(char,flat,fallback){
  let best=-1;
  for(const alias of char?.aliases||[]){
    const key=normalize(alias);
    if(key.length<2)continue;
    const at=flat.indexOf(key);
    if(at>=0&&(best<0||at<best))best=at;
  }
  return best<0?fallback:best;
}
function findProfiles(profiles,{text,characters,self=SELF_DEFAULT,limit=3}={}){
  if(!profiles?.profiles?.length)return [];
  const flat=normalize(text),loose=looseNorm(text);
  if(!flat)return [];
  const byName=new Map(profiles.profiles.map(profile=>[profile.name,profile]));
  const seen=new Set(),hits=[];
  let selfMentioned=false;
  const push=(char,match,matchedBy,pos)=>{
    if(!char||char.name===self||seen.has(char.name))return;   // 梨绪自己不进注入
    const profile=byName.get(char.name);
    if(!profile)return;
    seen.add(char.name);
    hits.push({profile,character:char,match,matchedBy,pos,score:SCORE[match]});
  };
  for(const char of charactersInText(characters,flat,loose)){
    if(char.name===self)selfMentioned=true;   // 点到梨绪自己：payload 要提醒她别念自己的档案
    push(char,'name',[char.name],firstPos(char,flat,Number.MAX_SAFE_INTEGER));
  }
  for(const {key,char,at} of soloHit(text,flat,characters,profiles).values())
    push(char,'solo',[key],at);
  const sorted=hits.sort((a,b)=>b.score-a.score||a.pos-b.pos||(a.profile.name<b.profile.name?-1:1));
  // 没命中就返回**干净的空数组**：挂上 omitted/total 会让调用方的 deepEqual(hits,[]) 挂掉，
  // 也会诱使别人用 `if(hits)` 判空（有属性的数组永远为真）。
  if(!sorted.length)return [];
  const kept=sorted.slice(0,Math.max(1,limit));
  kept.omitted=Math.max(0,sorted.length-kept.length);
  kept.total=sorted.length;
  kept.selfMentioned=selfMentioned;
  return kept;
}

// ── payload ─────────────────────────────────────────────────────────────
// PAYLOAD_CHARS 是**注入上限**，不是目标值：三条完整档案（含来源）实测约 2600 字符，
// 定得比它低会让修剪每轮都触发、把内容削成半截。这一层每轮只注入命中的角色，上限 3 条，
// 所以最坏情况的固定成本是可控的。
const TRAITS_MAX=4,RELATIONS_MAX=3,PROFILES_MAX=3,PAYLOAD_CHARS=2600;
// 块级信任：人工轴优先于来源轴，与 lore.cjs 的 trustLevel 同一套词
function blockTrust(block){
  if(!block)return null;
  if(block.factReviewed)return 'human';
  return block.factConfidence==='confirmed'?'source':'inferred';
}
const BLOCK_LABEL={basics:'基础资料',profile:'性格要点',extras:'属性/武器/游戏内问答'};
const BLOCK_FIELDS={
  basics:['grade','birthday','zodiac','bloodType','height'],
  // 键名照 N1 的「苦手なもの」直译成 weakPoints（不拿手的），**不是** dislikes：
  // 游戏内问答里 苦手 常是「怕/不擅长」而不是「讨厌」。梨绪那条就是典型——她写的是
  // 「猫」，原文却是「猫ちゃん大好きなのに、アレルギーで触れない」，译成 dislikes
  // 会被读成「讨厌猫」，正好和 persona.md 明令禁止的写法撞上。
  extras:['attribute','weapon','likes','weakPoints','hobbies','skills'],
};
function pickFields(block,fields,trust){
  if(!block)return null;
  const out={};
  for(const key of fields){
    const value=block[key];
    // 空值整个省略：给模型看 null 会诱使它说「身高未知」，而数据里的 null 是给维护者的
    if(value===null||value===undefined)continue;
    if(Array.isArray(value)&&!value.length)continue;
    out[key]=value;
  }
  if(!Object.keys(out).length)return null;
  out.trust=trust;
  return out;
}
function profilesPayload(hits,{preferLocalSources=false,context,selfMentioned=false}={}){
  const list=(hits||[]).slice(0,PROFILES_MAX);
  if(!list.length)return null;
  const inferredBlocks=new Set();
  const items=list.map(hit=>{
    const profile=hit.profile,char=hit.character;
    const item={id:profile.id,name:profile.name,match:hit.match};
    if(char?.unit)item.unit=char.unit;
    if(char?.cv?.length)item.cv=char.cv;
    const basicsTrust=blockTrust(profile.basics),profileTrustT=blockTrust(profile.profile),extrasTrust=blockTrust(profile.extras);
    if(basicsTrust==='inferred')inferredBlocks.add(BLOCK_LABEL.basics);
    if(profileTrustT==='inferred')inferredBlocks.add(BLOCK_LABEL.profile);
    if(extrasTrust==='inferred')inferredBlocks.add(BLOCK_LABEL.extras);
    if(profile.basics)item.basics=pickFields(profile.basics,BLOCK_FIELDS.basics,basicsTrust);
    const traits=(profile.profile?.traits||[]).slice(0,TRAITS_MAX);
    if(traits.length){
      item.traits=traits;
      item.traitsTrust=profileTrustT;
      if(profile.profile.traits.length>traits.length)item.traitsOmitted=profile.profile.traits.length-traits.length;
    }
    if(profile.extras)item.extras=pickFields(profile.extras,BLOCK_FIELDS.extras,extrasTrust);
    // 关系排序后再截断：同组合的成员关系条数最多（3 人队每人两条），若按文件顺序切，
    // 「姐妹」「竞争对手」这类真正有信息量的条目会被挤掉。家人/对手/前辈优先于同组合。
    const relPriority={family:0,rival:1,senpai:2,kouhai:3,friend:4,unit_member:5};
    const relations=[...(profile.relationships||[])]
      .sort((a,b)=>(relPriority[a.type]??9)-(relPriority[b.type]??9)).slice(0,RELATIONS_MAX);
    if(relations.length){
      item.relations=relations.map(rel=>({with:rel.who,type:rel.type,note:rel.note,
        trust:rel.factReviewed?'human':(rel.confidence==='confirmed'?'source':'inferred')}));
      if(profile.relationships.length>relations.length)item.relationsOmitted=profile.relationships.length-relations.length;
    }
    // 只有用户明说要来源时才给 URL（平时列一串链接只会诱使模型念网址）。三块与关系
    // 的来源全并进来去重：用户问「哪看的」时，他想要的是这条档案的全部出处。
    if(preferLocalSources){
      const sources=[profile.basics,profile.profile,profile.extras]
        .flatMap(block=>block?.factSources||[])
        .concat((profile.relationships||[]).flatMap(rel=>rel.factSources||[]));
      if(sources.length)item.sources=[...new Set(sources)];
    }
    return item;
  });
  // matched 报的是**总命中数**而不是列出来的条数：跟 omitted 并排给模型看，
  // 「matched 3 / omitted 1」那种自相矛盾的说法会让它以为一共只有三个。
  const payload={profiles:items,matched:hits.total??(hits||[]).length};
  if(hits?.omitted)payload.omitted=hits.omitted;
  const notes=[];
  if(items.some(item=>item.match==='solo'))
    notes.push('有一条是按单字简称（枫/茜/葵/纺/椿）认出来的，可能认错人。不确定用户问的是谁就先问一句，不要硬答。');
  if(inferredBlocks.size)
    notes.push('标着 trust:inferred 的块是单源资料（'+[...inferredBlocks].join('、')+'），语气上留余地，不要说死。');
  if(payload.omitted)
    notes.push('另外还提到 '+payload.omitted+' 个角色，这一轮没列出来，不要假装只有列出来的这些。');
  if(selfMentioned)
    notes.push('用户也提到了你本人。你自己的人设以第一人称设定为准，不要照这些第三人称档案念自己。');
  if(notes.length)payload.note=notes.join(' ');
  if(context)payload.context=context;
  return fitPayload(payload);
}
// 总长兜底。条目里全是散文，且这一层每轮都跑，所以除了字段级截断还要一道总长闸。
//
// 削的顺序有讲究：**先减条数、再丢整块、最后减角色**。反过来的话，用户明说要来源时
// 多出来的那几行 URL 会把 traits/relations 整个挤掉——他要的是出处，结果拿到一份
// 只剩生日的档案。**basics 永不丢**，那是本层最硬的产出。
function fitPayload(payload,limit=PAYLOAD_CHARS){
  const size=()=>JSON.stringify(payload).length;
  if(size()<=limit)return payload;
  payload.trimmed=true;
  const shrink=(item,key,max)=>{
    if(!item[key]||item[key].length<=max)return;
    item[key+"Omitted"]=(item[key+"Omitted"]||0)+item[key].length-max;
    item[key]=item[key].slice(0,max);
  };
  // ① 先减条数：关系留 1 条、性格留 2 条——内容还在，只是少列几条
  for(const item of payload.profiles){
    if(size()<=limit)return payload;
    shrink(item,"relations",1);
    shrink(item,"traits",2);
  }
  // ② 再整块丢，从最后一条开始：先丢 sources（用户没明说要），再 relations、traits
  for(let i=payload.profiles.length-1;i>=0;i--){
    const item=payload.profiles[i];
    for(const key of ["sources","relations","traits"]){
      if(size()<=limit)return payload;
      if(!item[key])continue;
      if(key==="traits")delete item.traitsTrust;
      if(key!=="sources"&&Array.isArray(item[key]))
        item[key+"Omitted"]=(item[key+"Omitted"]||0)+item[key].length;
      delete item[key];
    }
  }
  // ③ 最后才减少角色数，且至少留一条
  while(payload.profiles.length>1&&size()>limit){
    payload.profiles.pop();
    payload.omitted=(payload.omitted||0)+1;
  }
  return payload;
}

// ── 规则句 ──────────────────────────────────────────────────────────────
function profilesRule(profiles){
  if(!profiles?.profiles?.length)return '';
  return '\n本地角色档案（原作其他角色的基本人设）：被问到某个角色的性格、是个什么样的人、基本资料（年级／生日／身高／血型／星座）或某两个角色是什么关系时，先看程序注入的角色档案，按它的事实作答；它和你的印象冲突时以它为准。'+
    // 模型对自己不熟的角色，最「安全」的输出就是反问「有这个人吗」——而那是错的
    '可以说嘴硬的话（「哼，那家伙啊」），但**不能否认这个人存在**、不能把她当成不认识的人。'+
    '档案里没写到的角色、或没写到的部分，直说「这我不太清楚」，不要编，也不要拿另一个角色的资料套上去。'+
    // 「不要念网址」与「用户要来源就给」必须写在一起：只写前半句会把后者堵死
    // （loreRule 已经踩过一次——用户明说「给我个来源」，回复里一个链接都没有）。
    '平时不要念出 source 网址或条目 id；**只有用户明说要出处、来源或链接时**，才把条目里 sources 给的链接照实给出。'+
    '标着 trust:inferred 的块语气上留余地（「我记得好像是……」），关系描述同理。'+
    '档案是第三人称资料：用你平时的叫法提到她们就行，不要把字段名、条目 id 或整段描述原样背出来。被问到你自己的事时，用你自己的第一人称设定回答，不要念自己的档案。'+
    '只聊用户提到的角色，不要因为资料里列了别人就把话题拉过去。不要向用户解释这段资料是怎么来的。';
}
module.exports={loadProfiles,findProfiles,profilesPayload,profilesRule,blockTrust,
 soloAliases,soloHit,SOLO_CONTEXT,SOLO_BLOCK,SELF_DEFAULT,SCORE,
 TRAITS_MAX,RELATIONS_MAX,PROFILES_MAX,PAYLOAD_CHARS};
