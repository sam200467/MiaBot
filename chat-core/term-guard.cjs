"use strict";
// 术语实体类型约束：已确认的**版本名/版本组合**命中之后，回答里不能再把它当成一首歌。
//
// 为什么由程序管：线上实测——上一轮用户刚解释过「真超檄」是四个版本的合称，模型当轮答对了，
// 下一轮又写「真超檄这首」。提示词禁不掉，和 constant-guard / canon-guard 同一条教训。
//
// 边界（用户定死的三条）：
//   ① **只做实体类型的确定性约束**，不做机制语义推断——这层不认识「定数 14.2 合不合理」，
//      只认识「这个词不是曲名」。
//   ② **弱匹配不抢占**：只认正式库/会话里逐字命中的别名，子串与模糊一律不算。
//   ③ 误判代价不对称：把一句本来正确的话判成错的，会让纠错轮**改掉对的答案**。
//      所以判据取交集（术语 + 紧邻的歌量词/字段词），宁可漏判。
const TYPE_NAMES={version:"版本名",version_group:"版本组合称呼"};
const GUARDED=new Set(Object.keys(TYPE_NAMES));
// 术语之后紧跟这些词 = 把它当成了歌/谱面
const SONG_AFTER=/^[的之]?\s*(?:这|那)?(?:首|张|曲|歌|谱面|定数|难度|等级|曲名)/;
// 术语之前是这些词 = 同上
const SONG_BEFORE=/(?:这首|那首|这首歌|那首歌|曲名|歌名|歌曲|一首|一曲|叫|名为|叫做)\s*[的之]?\s*$/;
const WINDOW=12;

// hits 来自 terms.cjs 的 matchTerms（对**回答正文**匹配，库 + 会话 glossary 一起）。
function checkTermTypes(text,{hits}={}){
 const body=String(text||"");
 const findings=[];
 if(!body||!Array.isArray(hits))return findings;
 const seen=new Set();
 for(const hit of hits){
  const entry=hit?.entry;
  if(!entry||!GUARDED.has(entry.type))continue;
  if(seen.has(entry.id))continue;
  const after=body.slice(hit.end,hit.end+WINDOW);
  const before=body.slice(Math.max(0,hit.at-WINDOW),hit.at);
  if(!SONG_AFTER.test(after)&&!SONG_BEFORE.test(before))continue;
  seen.add(entry.id);
  findings.push({term:hit.alias||entry.name,type:entry.type,name:entry.name,
   members:entry.catalogVersions||[],game:entry.game||""});
 }
 return findings;
}

// 程序自己补的一句。说清「它是什么」和「该怎么改」，不复述判断过程。
function termNote(findings){
 if(!findings?.length)return "";
 const lines=findings.map(item=>{
  const members=item.members.length?"（"+item.members.join("、")+"）":"";
  return "「"+item.term+"」是"+TYPE_NAMES[item.type]+members+"，不是曲名";
 });
 return "\n（程序核对："+lines.join("；")+"——上面那处把它当成歌了。）";
}

module.exports={checkTermTypes,termNote,TYPE_NAMES,SONG_AFTER,SONG_BEFORE};
