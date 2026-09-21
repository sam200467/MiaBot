"use strict";
// 原作剧情（lore/canon）层。
//
// 为什么单独一层：群里问「小梨你之前是和 akari 打过真人 CS 吗」，表面是 self，实质是
// **可由原作验证的事实问题**。research-policy 的 hardish 对 roleplay/self 硬禁止联网
// 是为了防止角色扮演时乱搜，但这条问题被同一道闸门连坐；本地又没有可查的剧情层，
// 模型只能凭印象否认——而原作里确实有（ONE BULLET LEFT，2020/10）。
// 所以 canon 不并入 self/roleplay，单独成层：命中本地剧情库就直接按事实作答。
//
// 两条边界，写在这里免得后来者踩：
//   ① **台词正文不在这里**。quotes.json 是唯一的原始台词存储，本层只用 quoteRefs
//      引用 id——同一份原作素材同时服务 persona（提炼说话方式）与 canon（提炼客观
//      事件事实），复制第二份就等着两边漂移。
//   ② **两条置信度轴互不相通**。事件本身被官方页+wiki 多源确认，不等于「这批台词
//      属于这个事件」也被确认。见 trustLevel / mappingTrust。
const fs=require('node:fs'),path=require('node:path');
const {normalize,findCharacter}=require('./knowledge.cjs');
// 保留空格标点的轻规范化：ASCII 别名的词边界必须在它上面判。压成 flat 之后
// 「Air」会命中 Fairytale 里的 air，constant-guard.cjs 已经为同一件事踩过坑。
const looseNorm=s=>String(s??'').normalize('NFKC').toLowerCase();
const esc=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const isAscii=s=>/^[\x00-\x7f]*$/.test(s);
// 别名匹配器。ASCII 走词边界，CJK 走规范化子串——两种写法误命中方向不同，
// 分开处理比统一收紧更划算（统一收紧会把「rio」这种短别名整个丢掉）。
function matcher(raw){
  const norm=normalize(raw);
  if(!norm)return null;
  if(isAscii(norm)){
    if(norm.length<3)return null;
    // 词边界要判在**保留空格**的写法上，而别名本身可能带空格（ONE BULLET LEFT）。
    // 用压平的 onebulletleft 去比带空格的 "one bullet left" 永远不中——实测就是
    // 「ONE BULLET LEFT 是什么剧情」一条都匹配不到。所以照别名原样再留一份带空格的 key。
    const looseKey=String(raw).normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
    if(!looseKey)return null;
    const re=new RegExp('(^|[^a-z0-9])'+esc(looseKey)+'(?![a-z0-9])');
    return {raw,norm,test:(flat,loose)=>re.test(loose)};
  }
  if(norm.length<2)return null;
  return {raw,norm,test:flat=>flat.includes(norm)};
}
function matchList(values){
  const out=[];
  for(const value of values||[]){
    const item=matcher(value);
    if(item)out.push(item);
  }
  // 长别名先匹配：命中优先取更具体的那条（「無敵のツーマンセル」比「ツーマンセル」具体）
  return out.sort((a,b)=>b.norm.length-a.norm.length);
}
// 角色别名在正文里的扫描。characters.index 是 knowledge.cjs 建好的 Map<别名,角色>，
// 这里反着扫一遍：302 条别名 × 一句短文本，比给每个角色写正则省事，也和
// findCharacter 共用同一批别名（「明里」→星咲あかり、「高濑梨绪」/「梨绪」/rio→高瀬梨緒）。
// 编译结果缓存在 characters 对象上：它由 loadCharacters 每次新建，缓存跟着它走不会串。
function charMatchers(characters){
  if(!characters?.index)return [];
  if(characters.__loreMatchers)return characters.__loreMatchers;
  const list=[];
  for(const [key,char] of characters.index){
    if(!key||key.length<2)continue;
    if(isAscii(key)){
      if(key.length<3)continue;
      const re=new RegExp('(^|[^a-z0-9])'+esc(key)+'(?![a-z0-9])');
      list.push({key,char,test:(flat,loose)=>re.test(loose)});
    }else{
      list.push({key,char,test:flat=>flat.includes(key)});
    }
  }
  characters.__loreMatchers=list;
  return list;
}
function charactersInText(characters,flat,loose){
  const found=new Map();
  for(const item of charMatchers(characters))
    if(item.test(flat,loose)&&!found.has(item.char.name))found.set(item.char.name,item.char);
  return [...found.values()];
}
// 信任等级由**两条轴合成**：人工轴优先于来源轴，来源轴优先于推断。
// 不能只看 factConfidence——事件被多源确认不代表台词映射也被确认，反过来也一样。
function trustLevel(story){
  if(story?.factReviewed)return 'human';
  return story?.factConfidence==='confirmed'?'source':'inferred';
}
function mappingTrust(story){
  const refs=Array.isArray(story?.quoteRefs)?story.quoteRefs:[];
  if(!refs.length)return 'none';
  if(refs.every(ref=>ref.mappingReviewed))return 'human';
  if(refs.every(ref=>ref.mappingConfidence==='confirmed'))return 'source';
  return 'inferred';
}
function loadStories(root,fileName='ongeki-story.json'){
  const file=path.join(root,'knowledge',fileName);
  if(!fs.existsSync(file))return null;
  let data;
  try{data=JSON.parse(fs.readFileSync(file,'utf8').replace(/^﻿/,''));}catch{return null;}
  if(!Array.isArray(data.stories)||!data.stories.length)return null;
  const stories=data.stories.map(story=>({...story,aliasList:matchList(story.aliases),keywordList:matchList(story.keywords)}));
  return {...data,stories};
}
// 三个信号源合成一次命中：别名（最具体）＞关键词＞角色实体。
// 只要角色的命中**单独**不足以成为一条命中——「你和明里做过什么」会命中全部有明里的
// 章节，那是噪声不是答案。所以设一道下限：角色命中必须**同时**有别的信号，
// 或者命中两个以上角色（说话人自己算一个，见 options.self）。
const SELF_DEFAULT='高瀬 梨緒';
const SCORE={alias:5,keyword:2,character:1};
function findStory(stories,{text,characters,self=SELF_DEFAULT,limit=3}={}){
  if(!stories?.stories?.length)return [];
  const flat=normalize(text),loose=looseNorm(text);
  if(!flat)return [];
  const present=new Set(charactersInText(characters,flat,loose).map(char=>char.name));
  if(self)present.add(self);
  const hits=[];
  for(const story of stories.stories){
    const aliases=story.aliasList.filter(item=>item.test(flat,loose)).map(item=>item.raw);
    const keywords=story.keywordList.filter(item=>item.test(flat,loose)).map(item=>item.raw);
    const names=(story.characters||[]).filter(name=>present.has(name));
    // 说话人自己不算「文本里点名了谁」。把她算进去的话，任何一句话都会命中她出场的
    // 全部 16 条——问「你今天心情怎么样」也会。所以下限只看**文本里另外点名**的角色：
    // 光有一个角色、又没有话题，仍然不算命中（「你和明里做过什么」会命中所有有明里的
    // 章节，那是噪声不是答案，该交给拆分通道或反问「哪一件」）。
    const others=names.filter(name=>name!==self);
    if(!aliases.length&&!(keywords.length&&others.length)&&others.length<2)continue;
    const score=aliases.length*SCORE.alias+Math.min(keywords.length,3)*SCORE.keyword+names.length*SCORE.character;
    // strong＝有别名，或关键词两条以上且另有角色在场。其余都是弱命中，弱命中允许联网补查
    // （见 loreDecision）；这条线画高一点没关系，画低了才会把该查的憋成本地回答。
    const strength=aliases.length||(keywords.length>=2&&others.length)?'strong':'weak';
    hits.push({story,matchedBy:{aliases,keywords,characters:names},strength,score,trust:trustLevel(story)});
  }
  return hits.sort((a,b)=>b.score-a.score).slice(0,limit);
}
// 程序侧预检索入口。**只做检索，不做判断**：具体是不是剧情问题由 research-policy 的
// 正则分类（那边只管「像不像剧情提问」，不管是哪一段），匹配哪一条完全由这里的索引决定。
// 这样事件关键词只活在数据里（aliases/keywords），不需要往正则里越加越长。
function lookupLore({stories,characters,text,self,limit}={}){
  return findStory(stories,{text,characters,self,limit});
}
// 用户明说要出处。收到它就**不要再去搜**——条目里已经带着 factSources，
// 重新检索一遍既费额度又可能搜回比本地更差的来源。
const WANTS_SOURCE=/来源|來源|出處|出处|参考|參考|引用|核实|核實|查证|查證|查一下|搜一下|确认一下|確認一下|哪(?:儿|裡|里|裡)看|哪看到的/;
// 联网策略的唯一出口。本地强命中默认不联网——这是本层存在的主要理由：
// 每次回答都去搜一遍，等于把「本地索引」退化成一个缓存。
function loreDecision(hits,userText){
  const wantsSource=WANTS_SOURCE.test(String(userText||''));
  if(!hits?.length)return {useWeb:true,wantsSource,reason:'本地剧情库无命中，可走拆分通道联网'};
  const best=hits[0];
  if(best.trust==='inferred'||best.strength!=='strong')
    return {useWeb:true,wantsSource,reason:'本地只有弱命中或低置信条目，可联网补查'};
  if(wantsSource)
    return {useWeb:false,wantsSource,preferLocalSources:true,reason:'本地条目自带来源，直接引用 factSources，不必重新检索'};
  return {useWeb:false,wantsSource,reason:'本地已确认条目可直接作答，不需要联网'};
}
const SUMMARY_MAX=240;
// 进 prompt 的形状。只给摘要和出处，**不给台词正文**——正文在 quotes.json，
// 条目里的 quoteRefs 只是 id。列表有上限，模型不该把列出来的当成全部。
function lorePayload(hits,{preferLocalSources=false,context}={}){
  const items=(hits||[]).slice(0,3).map(hit=>{
    const story=hit.story;
    const summary=String(story.summary||'');
    const item={
      id:story.id,game:story.game,type:story.type,topic:[story.chapter,story.title].filter(Boolean).join(' '),
      titleCn:story.titleCn||'',date:story.date||null,version:story.version||null,
      characters:story.characters||[],strength:hit.strength,trust:hit.trust,
      mappingTrust:mappingTrust(story),
      summary:summary.length>SUMMARY_MAX?summary.slice(0,SUMMARY_MAX)+'……':summary,
    };
    if(summary.length>SUMMARY_MAX)item.summaryTruncated=true;
    if(story.rivals?.length)item.rivals=story.rivals.slice(0,6);
    // 台词只在**用户要来源**时给出 id：平时列一串 B4-xx 只会诱使模型去复述台词原文。
    if(preferLocalSources&&story.factSources?.length)item.sources=story.factSources;
    return item;
  });
  const payload={stories:items,matched:(hits||[]).length};
  // 只有弱命中说明用户没点明是哪一段，条目只是角色上相关。不提醒的话模型会挑一条硬答。
  if(items.length&&items.every(item=>item.strength==='weak'))
    payload.note='用户没有点明具体是哪一段剧情，下面只是角色上相关的条目。不确定就先问是哪一件，不要挑一条硬答。';
  if(items.some(item=>item.trust==='inferred'))
    payload.note=(payload.note?payload.note+' ':'')+'标着 trust:inferred 的条目是单源或推断，语气上留余地，不要说死。';
  if(context)payload.context=context;
  return payload;
}
function storyAnswer(stories,query){
  const hits=findStory(stories,query);
  if(!hits.length)
    return {error:'本地剧情库里没有匹配的条目。已知条目：'+(stories?.stories||[]).slice(0,24).map(story=>story.title).join('、')+
      '。不要凭印象编剧情；可以说明本地没有收录这一条。'};
  return lorePayload(hits,{preferLocalSources:Boolean(query?.wantsSource)});
}
function loreRule(stories){
  if(!stories?.stories?.length)return '';
  return '\n本地剧情资料（原作 canon）：被问到原作里发生过什么、你和谁做过什么、某角色和某角色之间发生过什么、某章或某个活动剧情是什么、某角色在哪些剧情登场时，先看程序注入的剧情资料，按它的事实作答；它和你的印象冲突时以它为准。'+
    '可以说嘴硬的话（「那种事我才不记得」），但**不能否认事实存在**——「没发生过」「没有这回事」「你记错了」是错的，因为资料里确实记着。'+
    '资料里没有的剧情，直说「这我不确定」，不要编。'+
    // 「不要念网址」与「用户要来源就给」必须写在一起：只写前半句会把后者堵死
    // （实测用户明说「给我个来源」，回复里只给了活动名，一个链接都没有）。
    '平时不要念出 source 网址或条目 id，提到剧情用作品内的说法；**只有用户明说要出处、来源或链接时**，才把条目里 sources 给的链接照实给出。'+
    '标着 trust:inferred 的条目语气上留余地（「我记得好像是……」）。';
}
module.exports={loadStories,findStory,lookupLore,loreDecision,lorePayload,storyAnswer,loreRule,
 trustLevel,mappingTrust,charactersInText,matcher,matchList,normalize,WANTS_SOURCE};
