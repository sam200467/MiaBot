#!/usr/bin/env node
"use strict";
// 剧情库的人工审核工具。
//
// 它存在的唯一理由：**联网查到的剧情不自动成为 canon**。玩家二创、wiki 错漏一旦写进
// 索引就洗不掉了，而这一层的输出又会被当成事实讲给群里听，所以中间必须有人看一眼。
// 另外它还负责把两条置信度轴上的 **Reviewed 从 null 升级**——注意它**从不改
// *Confidence**：来源维度多源就是多源、推断就是推断，人工过目加的是另一条轴。
//
//   node rio-chat/lore-review.cjs                    列出 canon 条目与待审候选
//   node rio-chat/lore-review.cjs --confirm <id>      canon 条目：事实部分标为人工确认
//   node rio-chat/lore-review.cjs --confirm-quotes <id>  canon 条目：台词归属标为人工确认
//   node rio-chat/lore-review.cjs --approve <id>      候选 → canon
//   node rio-chat/lore-review.cjs --reject <id> --why "理由"  候选标为驳回
const fs=require("node:fs"),path=require("node:path");
const root=__dirname;
const STORY=path.join(root,"knowledge","ongeki-story.json");
const CANDIDATES=path.join(root,"knowledge","ongeki-story-candidates.json");
const TYPES=["main","side","event","memory","adventure"];
const CONFIDENCE=["confirmed","inferred"];
function read(file){return JSON.parse(fs.readFileSync(file,"utf8").replace(/^﻿/,""));}
// 原子写：先写 .tmp 再 rename。中途失败不会把好文件截断——沿用 update-characters.cjs 的做法。
function write(file,data){
  const tmp=file+".tmp";
  fs.writeFileSync(tmp,JSON.stringify(data,null,2)+"\n");
  fs.renameSync(tmp,file);
}
const today=()=>new Date().toISOString().slice(0,10);
// canon 的完整度检查。候选被批准时走这里——缺字段的条目进了索引只会在运行期静默失效，
// 不如在入口挡住。**不检查作者意图**，只检查形状。
function validate(story){
  const bad=[];
  if(!story.id||typeof story.id!=="string")bad.push("缺少 id");
  if(!story.title)bad.push("缺少 title");
  if(!story.summary)bad.push("缺少 summary");
  if(!Array.isArray(story.aliases)||!story.aliases.length)bad.push("aliases 不能为空（用户就是靠它问到的）");
  if(!TYPES.includes(story.type))bad.push("type 必须是 "+TYPES.join("/"));
  if(!CONFIDENCE.includes(story.factConfidence))bad.push("factConfidence 必须是 "+CONFIDENCE.join("/"));
  if(!Array.isArray(story.factSources)||!story.factSources.length)bad.push("factSources 不能为空（没有来源就不能算事实）");
  for(const ref of story.quoteRefs||[])
    if(!CONFIDENCE.includes(ref.mappingConfidence))bad.push("quoteRefs[].mappingConfidence 缺失："+ref.ref);
  return bad;
}
function reviewState(entry){
  const refs=entry.quoteRefs||[];
  const reviewed=refs.filter(ref=>ref.mappingReviewed).length;
  return [
    "事实 "+(entry.factReviewed?"已人工确认("+entry.factReviewed.at+")":entry.factConfidence==="confirmed"?"多源未过目":"单源待核"),
    "台词 "+(refs.length?reviewed+"/"+refs.length+" 已确认":"无"),
  ].join("　");
}
function list(){
  const data=read(STORY),candidates=read(CANDIDATES);
  console.log("canon 条目 "+data.stories.length+" 条（"+STORY+"）");
  for(const entry of data.stories)
    console.log("  "+(entry.factReviewed&&(entry.quoteRefs||[]).every(r=>r.mappingReviewed)?"✔":"·")+" "+entry.id.padEnd(28)+reviewState(entry)+"  "+entry.title);
  console.log("\n候选 "+candidates.candidates.length+" 条（"+CANDIDATES+"）");
  for(const item of candidates.candidates)
    console.log("  ["+item.status+"] "+item.id.padEnd(28)+(item.title||"")+(item.note?"  — "+item.note:""));
  console.log("\n审核：--confirm <id> 事实过目 ｜ --confirm-quotes <id> 台词归属过目 ｜ --approve <id> 候选入库 ｜ --reject <id> --why 理由");
}
function confirm(id,by){
  const data=read(STORY);
  const entry=data.stories.find(item=>item.id===id);
  if(!entry)throw Error("canon 里没有这个 id："+id);
  entry.factReviewed={at:today(),by};
  // 只动 Reviewed，不动 Confidence——来源维度多源就是多源、推断就是推断。
  write(STORY,data);
  console.log("已标为人工确认（事实）："+id+"　"+reviewState(entry));
}
function confirmQuotes(id,by){
  const data=read(STORY);
  const entry=data.stories.find(item=>item.id===id);
  if(!entry)throw Error("canon 里没有这个 id："+id);
  const refs=entry.quoteRefs||[];
  if(!refs.length)throw Error("这条没有台词引用，没什么可确认的："+id);
  for(const ref of refs)ref.mappingReviewed={at:today(),by};
  write(STORY,data);
  console.log("已标为人工确认（台词归属 "+refs.length+" 条）："+id+"　"+reviewState(entry));
}
function approve(id,by){
  const data=read(STORY),queue=read(CANDIDATES);
  const item=queue.candidates.find(entry=>entry.id===id);
  if(!item)throw Error("候选里没有这个 id："+id);
  if(item.status==="approved")throw Error("这条候选已经入库过了："+id);
  if(data.stories.some(entry=>entry.id===id))throw Error("canon 里已经有同 id 的条目："+id);
  const {status,note,...story}=item;
  const bad=validate(story);
  if(bad.length)throw Error("候选字段不完整，先补齐再入库：\n  - "+bad.join("\n  - "));
  story.factReviewed={at:today(),by};
  data.stories.push(story);
  item.status="approved";
  // canon 先写：万一中间失败，候选还留在队列里，不会两头都丢。
  write(STORY,data);write(CANDIDATES,queue);
  console.log("已入库并标为人工确认："+id);
}
function reject(id,why){
  const queue=read(CANDIDATES);
  const item=queue.candidates.find(entry=>entry.id===id);
  if(!item)throw Error("候选里没有这个 id："+id);
  item.status="rejected";
  item.note=[item.note,why].filter(Boolean).join(" ／ ");
  write(CANDIDATES,queue);
  console.log("已驳回："+id+(why?"（"+why+"）":""));
}
function main(argv){
  const at=name=>{const index=argv.indexOf(name);return index<0?null:argv[index+1]??null;};
  const by=at("--by")||"用户";
  if(argv.includes("--confirm"))return confirm(at("--confirm"),by);
  if(argv.includes("--confirm-quotes"))return confirmQuotes(at("--confirm-quotes"),by);
  if(argv.includes("--approve"))return approve(at("--approve"),by);
  if(argv.includes("--reject"))return reject(at("--reject"),at("--why"));
  return list();
}
if(require.main===module){
  try{main(process.argv.slice(2));}
  catch(error){console.error("失败："+error.message);process.exitCode=1;}
}
module.exports={validate,reviewState};
