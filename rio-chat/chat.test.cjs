"use strict";
const test=require("node:test"), assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path");
const {createChat,chooseImage,failureReason,discomfort,requestReply,normalizeAction}=require("./chat.cjs");
// persona.md, examples.json and expressions.json are deployment content and are not
// shipped with this repository. Without them the suite cannot run, so skip it on a
// fresh clone rather than failing the build.
const missing=["persona.md","examples.json","expressions.json"].filter(f=>!fs.existsSync(path.join(__dirname,f)));
const skipReason=missing.length?"requires local "+missing.join(", "):false;
const test_=(name,fn)=>test(name,{skip:skipReason},fn);
function settings(){
 const c=JSON.parse(fs.readFileSync(path.join(__dirname,"config.example.json")));
 c.enabled=true;c.expressions.enabled=true;c.provider.apiKey="test-only-not-a-real-key";c.limits.userCooldownSeconds=0;
 const manifest=JSON.parse(fs.readFileSync(path.join(__dirname,"expressions.json")));
 for(const e of manifest.entries)e.absoluteFile=path.join(__dirname,e.file);
 // characterName 照 loadSettings 的口径透出：日志与「恢复正常X性格」那句提示词都按它取名。
 return {c,manifest,characterName:c.characterName,persona:fs.readFileSync(path.join(__dirname,"persona.md"),"utf8"),examples:JSON.parse(fs.readFileSync(path.join(__dirname,"examples.json"))).examples};
}
const result={text:"哼哼，找我就对了！今天想聊什么？尽管说吧！",emotion:"neutral",scene:"ordinary",expressionIds:["small_smile"]};
// 真实的 fetch 响应 text() 和 json() 都能用：chat.cjs 先读 text 再 JSON.parse，
// 网关回 HTML 错误页时才截得出片段写进日志。
const reply=data=>({ok:true,text:async()=>JSON.stringify(data),json:async()=>data});
function mock(body=result){return async()=>reply({choices:[{finish_reason:"stop",message:{content:JSON.stringify(body)}}]});}
let id=0;
function msg(user="u",text="<@123> 你好",channel="c"){
 const replies=[];return {id:String(++id),content:text,guildId:"g",channelId:channel,author:{id:user,bot:false},client:{user:{id:"123"}},channel:{sendTyping:async()=>{},permissionsFor:()=>({has:()=>true})},replies,reply:async x=>{replies.push(x);return x;}};
}
const host={guildId:"g",channelIds:["c","d"],proxyUrl:""};
test_("probabilities have no image cooldown or dedup",()=>{
 const s=settings();const p=s.manifest.selectionPolicy;
 assert.equal(chooseImage(result,s,false,()=>p.ordinaryProbability-0.01).id,"small_smile");
 assert.equal(chooseImage(result,s,false,()=>p.ordinaryProbability),null);
 const emotional={...result,emotion:"proud"};
 assert.ok(chooseImage(emotional,s,false,()=>p.clearEmotionProbability-0.01));
 assert.equal(chooseImage(emotional,s,false,()=>p.clearEmotionProbability),null);
 assert.ok(chooseImage({...result,scene:"explanation",expressionIds:["scarf_calm"]},s,false,()=>0.01));assert.equal(chooseImage(result,s,true,()=>0),null);
 assert.equal(chooseImage({...result,scene:"distress"},s,false,()=>0),null);
 assert.equal(chooseImage({...result,expressionIds:["../../secret","music_taunt"]},s,false,()=>0),null);
});
test("variantGroup expands one model choice and samples every similar image equally",()=>{
 const s={c:{expressions:{enabled:true}},manifest:{selectionPolicy:{ordinaryProbability:1,clearEmotionProbability:1,seriousExplanationProbability:1},entries:[
  {id:"soft-a",variantGroup:"soft",autoEligible:true,emotions:["happy"],absoluteFile:"a"},
  {id:"soft-b",variantGroup:"soft",autoEligible:true,emotions:["happy"],absoluteFile:"b"},
  {id:"other",autoEligible:true,emotions:["happy"],absoluteFile:"c"},
 ]}};
 const picked={text:"",emotion:"happy",scene:"ordinary",expressionIds:["soft-a"]};
 // random 第一次用于概率，第二次选组（只有一个），第三次在组内选成员。
 const values=[0,0,0.1];let i=0;
 assert.equal(chooseImage(picked,s,false,()=>values[i++]).id,"soft-a");
 const values2=[0,0,0.9];i=0;
 assert.equal(chooseImage(picked,s,false,()=>values2[i++]).id,"soft-b");
 assert.equal(chooseImage({...picked,expressionIds:["other"]},s,false,()=>0).id,"other");
});
test_("few-shot samples carry real expression ids",async()=>{
 // 示例是模型唯一的输出样例。全填 [] 它会学成永远返回空数组，chooseImage 拿不到候选就
 // 直接 return null，配图概率调到多少都不会出图 —— 这条守住的是「模型愿意给 ID」。
 const s=settings();let body;
 const chat=createChat(s,host,{fetchImpl:async(u,o)=>{body=JSON.parse(o.body);return mock()()},random:()=>1});
 await chat.handle(msg("s","<@123> 你好"));
 const known=new Set(s.manifest.entries.map(e=>e.id));
 const samples=body.messages.filter(m=>m.role==="assistant")
   .map(m=>{try{return JSON.parse(m.content)}catch{return null}})
   .filter(x=>x&&Array.isArray(x.expressionIds));
 const withIds=samples.filter(x=>x.expressionIds.length);
 assert.ok(withIds.length>=3,"示例里必须有多条带表情候选，否则模型学到的永远是空数组");
 for(const x of withIds)for(const id of x.expressionIds)assert.ok(known.has(id),"示例引用了清单外的表情ID："+id);
 chat.close();
});
test_("具体曲目问定数但没给难度：程序直接追问，不调用模型或曲库",async()=>{
 const s=settings();
 s.knowledge=require('./knowledge.cjs').loadKnowledge(__dirname);
 s.localKnowledge=true;s.research=false;
 let calls=0;
 const reply=await requestReply(s,[{role:'user',content:'帮我查一下 id870 这首歌的定数'}],{fetchImpl:async()=>{calls++;throw Error('不应调用模型')}});
 assert.equal(calls,0);
 assert.equal(reply.localGuard,'constant-difficulty');
 assert.match(reply.text,/哪个难度/);
 assert.doesNotMatch(reply.text,/记不住|不知道这首歌/);
});

test_("定数问题已经给出难度时不拦截",async()=>{
 const s=settings();
 s.knowledge=require('./knowledge.cjs').loadKnowledge(__dirname);
 s.localKnowledge=true;s.research=false;
 let calls=0;
 const reply=await requestReply(s,[{role:'user',content:'帮我查一下 id870 master 的定数'}],{fetchImpl:async()=>{
   calls++;return mock({text:'查询继续',emotion:'neutral',scene:'explanation',expressionIds:[]})();
 }});
 assert.equal(calls,1);
 assert.equal(reply.text,'查询继续');
});
test_("message authorization, direct mention and dedup",async()=>{
 let calls=0;const chat=createChat(settings(),host,{fetchImpl:async(...a)=>{calls++;return mock()(...a)},random:()=>0});
 for(const m of [msg("u","hello"),msg("u","<@123> hello","wrong")])await chat.handle(m);
 const bot=msg();bot.author.bot=true;await chat.handle(bot);
 const dm=msg();dm.guildId=null;await chat.handle(dm);
 assert.equal(calls,0);
 const m=msg();await chat.handle(m);await chat.handle(m);assert.equal(calls,1);assert.equal(m.replies.length,1);
 assert.deepEqual(m.replies[0].allowedMentions,{parse:[],repliedUser:false});chat.close();
});
test_("history isolated by channel/user and bounded",async()=>{
 const calls=[];const s=settings();s.c.conversation.maxTurns=1;
 const chat=createChat(s,host,{fetchImpl:async(url,options)=>{calls.push(JSON.parse(options.body));return mock()()},random:()=>1});
 await chat.handle(msg("a","<@123> first-a"));
 await chat.handle(msg("b","<@123> first-b"));
 assert.ok(!JSON.stringify(calls[1]).includes("first-a"));
 await chat.handle(msg("a","<@123> other-channel","d"));assert.ok(!JSON.stringify(calls[2]).includes("first-a"));
 await chat.handle(msg("a","<@123> second-a"));assert.ok(JSON.stringify(calls[3]).includes("first-a"));
 await chat.handle(msg("a","<@123> third-a"));assert.ok(!JSON.stringify(calls[4]).includes("first-a"));
 await chat.handle(msg("a","<@123> 清空对话"));
 await chat.handle(msg("a","<@123> after-reset"));assert.ok(!JSON.stringify(calls[5]).includes("third-a"));chat.close();
});
test_("discomfort gets one-turn comfort without persistent serious mode",async()=>{
 assert.equal(discomfort("你刚才说话有点过分了"),true);
 assert.equal(discomfort("今天打什么歌"),false);
 const calls=[];const comfort={...result,text:"对不起嘛，我刚才得意过头了……给你顺顺毛，别生气啦。",scene:"distress"};
 const chat=createChat(settings(),host,{fetchImpl:async(u,o)=>{const body=JSON.parse(o.body);calls.push(body);return mock(calls.length===1?comfort:result)()},random:()=>1});
 const upset=msg("a","<@123> 你刚才说话有点过分了");await chat.handle(upset);
 assert.ok(upset.replies[0].content.includes("对不起"));
 assert.equal(calls[0].messages.filter(x=>x.role==="system").length,2);
 await chat.handle(msg("a","<@123> 那推荐一首歌吧"));
 assert.equal(calls[1].messages.filter(x=>x.role==="system").length,1);
 chat.close();
});
test_("model cannot switch an ordinary user into serious mode",async()=>{
 const s=settings(),calls=[];
 const mistaken={...result,text:"这是正常回复",stopTeasing:true};
 const chat=createChat(s,host,{fetchImpl:async(u,o)=>{calls.push(JSON.parse(o.body));return mock(mistaken)()},random:()=>1});
 const first=msg("a","<@123> 今天打什么歌");await chat.handle(first);
 assert.equal(first.replies[0].content,"这是正常回复");
 assert.ok(!first.replies[0].content.includes("不逗你了"));
 await chat.handle(msg("a","<@123> 那再推荐一首"));
 assert.ok(!calls.at(-1).messages.some(x=>x.content==="该用户已要求停止调侃。认真温和回复，禁止斗嘴和自动配图。"));
 chat.close();
});
test_("concurrent requests do not race",async()=>{
 let resolve;const chat=createChat(settings(),host,{fetchImpl:()=>new Promise(r=>resolve=r),random:()=>0});
 const a=msg("a");const pending=chat.handle(a);await new Promise(r=>setImmediate(r));
 const b=msg("a","<@123> 再问一句");await chat.handle(b);assert.equal(b.replies.length,1);assert.ok(b.replies[0].content.includes("上一条"));
 resolve(await mock()());await pending;assert.ok(a.replies[0].content.includes("哼哼"));chat.close();
});
test_("explicit image, permission fallback, repeated images allowed",async()=>{
 const chat=createChat(settings(),host,{fetchImpl:mock(),random:()=>0.99});
 for(let i=0;i<2;i++){const m=msg("a","<@123> 发第6张表情");await chat.handle(m);assert.ok(m.replies[0].files[0].attachment.endsWith(".gif"));}
 const m=msg("a","<@123> 发第6张表情");m.channel.permissionsFor=()=>({has:()=>false});await chat.handle(m);assert.ok(!m.replies[0].files);chat.close();
 let qqReply;const qq=createChat(settings(),host,{fetchImpl:mock(),random:()=>0.99,adapter:{
   accepts:()=>true,extractText:x=>x.content,typing:async()=>{},send:async(_m,text,file)=>{qqReply={text,file};}
 }});
 await qq.handle({id:"qq-image-1",content:"发第6张表情",guildId:"qq",channelId:"996",author:{id:"u",bot:false}});
 assert.ok(qqReply.file.absoluteFile.endsWith(".gif"));qq.close();
});
test_("API sends requested model, JSON, nonthinking; rejects invalid data and hides raw errors",async()=>{
 const s=settings();let req;
 await requestReply(s,[{role:"user",content:"hi"}],{fetchImpl:async(u,o)=>{req=JSON.parse(o.body);return mock()()}});
 assert.equal(req.model,"deepseek-flash");assert.equal(req.thinking.type,"disabled");assert.equal(req.response_format.type,"json_object");
 // 不发送 max_tokens，交给服务端默认上限；长度由 limits.maxReplyChars 兜底。
 assert.ok(!("max_tokens" in req)&&!JSON.stringify(req).includes("maxTokens"));
 await assert.rejects(requestReply(s,[],{fetchImpl:mock({text:s.c.provider.apiKey})}),/敏感/);
 await assert.rejects(requestReply(s,[],{fetchImpl:async()=>({ok:false,status:401})}),/HTTP 401/);
 const m=msg();const chat=createChat(s,host,{fetchImpl:async()=>{throw Error("secret "+s.c.provider.apiKey)}});await chat.handle(m);assert.ok(!JSON.stringify(m.replies).includes(s.c.provider.apiKey));chat.close();
});
test_("failure log names the cause and never prints the key",async()=>{
 const s=settings(),logs=[];
 const run=async error=>{const chat=createChat(s,host,{log:t=>logs.push(t),fetchImpl:async()=>{throw error}});await chat.handle(msg());chat.close();return logs.at(-1)};
 const network=Error("fetch failed");network.cause={code:"ECONNREFUSED"};assert.ok((await run(network)).includes("ECONNREFUSED"));
 const aborted=Error("This operation was aborted");aborted.name="AbortError";assert.ok((await run(aborted)).includes("请求超时"));
 const http=Error("DeepSeek HTTP 402：Insufficient Balance");assert.ok((await run(http)).includes("HTTP 402：Insufficient Balance"));
 assert.ok((await run(Error("boom "+s.c.provider.apiKey))).includes("***"));
 assert.ok(!logs.some(t=>t.includes(s.c.provider.apiKey)));
 assert.equal(failureReason(Error("DeepSeek返回格式无效：\"\""),undefined),"DeepSeek返回格式无效：\"\"");
});
test_("prefill prevents blank replies, a blank retries once then degrades",async()=>{
 const s=settings();const requests=[],logs=[];
 const blank=reply({choices:[{finish_reason:"stop",message:{content:" ".repeat(43)}}]});
 const chat=createChat(s,host,{log:t=>logs.push(t),fetchImpl:async(u,o)=>{requests.push(JSON.parse(o.body));return requests.length===1?blank:await mock()()}});
 const m=msg("a","<@123> 你很擅长音击吗");await chat.handle(m);
 assert.equal(requests.length,2);
 assert.ok(logs.some(t=>t.includes("空白回复后重画成功")),"模型空白和网关故障要在日志里分得开");
 assert.deepEqual(requests[0].messages.at(-1),{role:"assistant",content:"{"});
 assert.ok(m.replies[0].content.includes("哼哼"));
 let blanks=0;const chat2=createChat(s,host,{log:()=>{},fetchImpl:async()=>{blanks++;return blank}});
 const m2=msg("b","<@123> 再问一次");await chat2.handle(m2);
 assert.equal(blanks,3); // JSON 两次 + 纯文本降级一次，都空白才报错
 assert.equal(m2.replies.length,1);assert.ok(m2.replies[0].content.includes("没能顺利完成"));
 chat.close();chat2.close();
});
test_("two blank JSON replies degrade to a plain-text answer",async()=>{
 const s=settings();const bodies=[],logs=[];
 const blank=reply({choices:[{finish_reason:"stop",message:{content:" ".repeat(43)}}]});
 const chat=createChat(s,host,{log:t=>logs.push(t),random:()=>0,fetchImpl:async(u,o)=>{
   bodies.push(JSON.parse(o.body));
   return bodies.length<=2?blank:reply({choices:[{finish_reason:"stop",message:{content:"那次是我状态不好，下次一定赢回来。"}}]});
 }});
 const m=msg("a","<@123> 你到底行不行");await chat.handle(m);
 assert.equal(bodies.length,3);
 assert.ok(!("response_format" in bodies[2])&&!bodies[2].messages.some(x=>x.role==="assistant"));
 assert.equal(m.replies[0].content,"那次是我状态不好，下次一定赢回来。");
 assert.ok(!m.replies[0].files);
 assert.ok(logs.some(t=>t.includes("已降级为纯文本")));
 chat.close();
});
test_("gateway responses that are not JSON retry once, configuration errors do not",async()=>{
 const s=settings();let calls=0;
 const r=await requestReply(s,[{role:"user",content:"hi"}],{fetchImpl:async()=>{
  calls++;
  return calls===1?{ok:true,text:async()=>"<html><body>502 Bad Gateway</body></html>"}:await mock()();
 }});
 assert.equal(calls,2);assert.equal(r.text,result.text);
 assert.equal(r.retried,true,"重试过就要在结果里留痕，日志才看得出代理链路不稳");
 // 200 但不是 JSON、或者没有 choices（网关错误页）都算传输故障
 let gateway=0;
 await assert.rejects(requestReply(s,[{role:"user",content:"hi"}],{fetchImpl:async()=>{gateway++;return {ok:true,text:async()=>JSON.stringify({error:"bad gateway"})}}}),/缺少choices/);
 assert.equal(gateway,2);
 // 401 是鉴权/余额这类配置问题，重试没有意义
 let auth=0;
 await assert.rejects(requestReply(s,[{role:"user",content:"hi"}],{fetchImpl:async()=>{auth++;return {ok:false,status:401,text:async()=>"unauthorized"}}}),/HTTP 401/);
 assert.equal(auth,1);
 // 超时/取消说明预算已经用完，不该再撞一次
 let aborts=0;const aborted=Error("This operation was aborted");aborted.name="AbortError";
 await assert.rejects(requestReply(s,[{role:"user",content:"hi"}],{fetchImpl:async()=>{aborts++;throw aborted}}),/aborted/);
 assert.equal(aborts,1);
 // 日志要带上响应片段，否则分不清是网关 HTML 还是 body 被截断
 const logs=[];
 const chat=createChat(s,host,{log:t=>logs.push(t),fetchImpl:async()=>({ok:true,text:async()=>"<html>502 Bad Gateway</html>"})});
 await chat.handle(msg());chat.close();
 assert.ok(logs.some(t=>t.includes("不是JSON")&&t.includes("<html>502 Bad Gateway</html>")),logs.join("|"));
});
// 定数裁决层的集成夹具：曲名索引的形状必须和 knowledge.cjs 的 buildTitleIndex 一致
// （normalized 去空格去符号、按长度从长到短排），否则 findTitles 匹配不上。
const FIXTURE_KNOWLEDGE={catalogs:{
 chunithm:{source:"fixture",scope:"fixture",charts:[
  {title:"Dengeki Tube",difficulty:"EXP",level:"12+",constant:12.5},
  {title:"Dengeki Tube",difficulty:"MAS",level:"15",constant:15.2},
  {title:"Love & Justice",difficulty:"MAS",level:"15",constant:15.2},
  // 真的有 14+ 谱的歌：等级资格那一层要能留下它，只删掉已经升档的那首
  {title:"Air",difficulty:"MAS",level:"14+",constant:14.5},
  {title:"Air",difficulty:"ULT",level:"15",constant:15.2}]},
 // 音击也收了 Love & Justice，而且更靠近老帖写的 14.9——用来验证游戏线索真的起作用
 ongeki:{source:"fixture",scope:"fixture",charts:[
  {title:"Love & Justice",difficulty:"MAS",level:"14+",constant:14.7}]}},
 titles:[{game:"chunithm",title:"Love & Justice",normalized:"lovejustice"},
  {game:"chunithm",title:"Dengeki Tube",normalized:"dengekitube"},
  {game:"chunithm",title:"Air",normalized:"air"}]};
test_("回答里的旧定数会被本地曲库改掉，不再照抄社区资料",async()=>{
 const s=settings();s.search={apiKey:"kimi-fixture",cache:new Map()};s.knowledge=FIXTURE_KNOWLEDGE;
 const logs=[];
 const chat=createChat(s,host,{random:()=>0,log:t=>logs.push(t),
  // 模型读了老帖，把 VERSE 之前的 14.9 当现状报出来——spike 实测它会这么做，
  // 哪怕自己刚说过「这是老帖的说法」。
  fetchImpl:mock({text:"Dengeki Tube（14.9）偏水，键盘向。",scene:"explanation",expressionIds:[]}),
  webFetchImpl:async()=>reply({search_results:[{title:"中二节奏吧",url:"https://tieba.baidu.com/p/1",chunks:[{text:"Dengeki Tube 14.9 算水"}]}]})});
 const m=msg("a","<@123> 中二有没有比较水的14+？");await chat.handle(m);
 assert.match(m.replies[0].content,/Dengeki Tube（15\.2）/,"旧定数要被曲库当前值取代");
 assert.doesNotMatch(m.replies[0].content,/14\.9/);
 assert.ok(logs.some(t=>t.includes("定数校正")&&t.includes("14.9→15.2")),"日志要留下改了哪几首");
 chat.close();
});
test_("多游戏收录的歌按对话里点名的游戏裁决，不会改到另一款游戏上",async()=>{
 const s=settings();s.search={apiKey:"kimi-fixture",cache:new Map()};s.knowledge=FIXTURE_KNOWLEDGE;
 const chat=createChat(s,host,{random:()=>0,
  fetchImpl:mock({text:"Love & Justice 14.9 挺水的。",scene:"explanation",expressionIds:[]}),
  webFetchImpl:async()=>reply({search_results:[{title:"中二节奏吧",url:"https://tieba.baidu.com/p/1",chunks:[{text:"正文"}]}]})});
 // 用户这句点了「中二」，所以要用中二那张表的 15.2；音击那张 14.7 数值上更近，
 // 但那是另一款游戏的定数，改过去就成了拿音击的定数说中二的谱。
 const m=msg("a","<@123> 中二有没有比较水的14+？");await chat.handle(m);
 assert.match(m.replies[0].content,/Love & Justice 15\.2/);
 assert.doesNotMatch(m.replies[0].content,/14\.7/);
 chat.close();
});
// ── 术语层（第十四组）────────────────────────────────────────────────
const realTerms=()=>require("./terms.cjs").loadTerms(__dirname);
test_("会话内定义过的术语：当轮生效、下一轮还认、只记候选不落正式库",async()=>{
 const s=settings();s.knowledge=FIXTURE_KNOWLEDGE;s.terms=realTerms();
 const proposed=[],logs=[],bodies=[];
 const next=scripted([
  {text:"记下了。",scene:"ordinary",expressionIds:[]},
  {text:"真超檄这几版里水谱不少。",scene:"explanation",expressionIds:[]},
 ]);
 const chat=createChat(s,host,{random:()=>0,log:t=>logs.push(t),
  adapter:{terms:{propose:entry=>proposed.push(entry)}},
  fetchImpl:async(u,o)=>{bodies.push(JSON.parse(o.body));return next()}});
 // 故意用一个**正式库里没有**的俗称：库里有的话就不必学（真超檄已经收录了，不重复学）
 await chat.handle(msg("a","<@123> 老四代指的是 maimai、maimai PLUS、maimai GreeN 和 maimai GreeN PLUS 几个版本的统称"));
 assert.equal(proposed.length,1,"定义句要记一条候选");
 assert.equal(proposed[0].alias,"老四代");
 assert.equal(proposed[0].members.length,4,"成员要摊平成曲库认得的版本名");
 assert.ok(logs.some(t=>t.includes("本会话学到术语")),"日志要能看到学到什么");
 // 第二轮：同一会话里再提这个词，术语事实块要跟着进提示词（模型不必再猜它是什么）
 await chat.handle(msg("a","<@123> 老四代里有哪些水谱"));
 const injected=bodies.at(-1).messages.map(item=>String(item.content)).join("\n");
 assert.match(injected,/本地术语资料/);
 assert.match(injected,/真超檄/);
 chat.close();
});
test_("用户点到本地没有的版本：程序必须说清，不许静默忽略版本条件",async()=>{
 const s=settings();s.knowledge=FIXTURE_KNOWLEDGE;s.terms=realTerms();
 const bodies=[];
 const chat=createChat(s,host,{random:()=>0,
  fetchImpl:async(u,o)=>{bodies.push(JSON.parse(o.body));return mock({text:"我挑了几首：Air、Dengeki Tube。",scene:"explanation",expressionIds:[]})()},
  webFetchImpl:()=>{throw Error("曲库筛选不该联网")}});
 const m=msg("a","<@123> 华代有哪些简单的谱");await chat.handle(m);
 const injected=bodies[0].messages.map(item=>String(item.content)).join("\n");
 assert.match(injected,/catalogAvailable|本地曲库快照没有|没有这一代的曲目数据/,"术语资料里要带着「本地没有这一代」");
 assert.match(m.replies[0].content,/本地快照里没有曲目数据|不能按它筛曲目|本地曲库快照/,"模型没说清楚就由程序补上——禁止静默忽略");
 chat.close();
});
// ── 来源展示策略（第十六组）──────────────────────────────────────────
test_("默认不显示来源：搜到过网页、但答案没引用它，就不挂链接",async()=>{
 const s=settings();s.search={apiKey:"kimi-fixture",cache:new Map()};s.knowledge=FIXTURE_KNOWLEDGE;
 const logs=[];
 // 线上两条实录：本地答得完的问题，底部挂着「企业微信群怎么查群主」「X 动态」
 const next=scripted([
  {intent:"research",webQuery:{query:"电管 是什么歌",kind:"article"}},
  {text:"电管就是 Dengeki Tube，紫谱 15.2。",scene:"explanation",expressionIds:[]},
 ]);
 const chat=createChat(s,host,{random:()=>0,log:t=>logs.push(t),
  fetchImpl:()=>next(),
  webFetchImpl:async()=>reply({search_results:[
   {title:"企业微信群怎么查群主",url:"https://sxhanhai.com/tougao/69826.html",chunks:[{text:"无关内容"}]},
   {title:"X 动态",url:"https://x.com/someone/status/1",chunks:[{text:"无关内容"}]}]})});
 const m=msg("a","<@123> 电管是什么歌");await chat.handle(m);
 assert.match(m.replies[0].content,/Dengeki Tube/);
 assert.equal(/sxhanhai|企业微信|x\.com|搜索结果|参考资料/.test(m.replies[0].content),false,"没被引用的网页一条都不该出现");
 assert.ok(logs.some(t=>t.includes("来源 搜到2")&&t.includes("引用0")&&t.includes("展示0")),"来源明细仍留在日志里，方便调试");
 chat.close();
});
test_("模型点名引用了来源才展示，且只展示它引用的那条",async()=>{
 const s=settings();s.search={apiKey:"kimi-fixture",cache:new Map()};s.knowledge=FIXTURE_KNOWLEDGE;
 const next=scripted([
  {intent:"research",webQuery:{query:"CHUNITHM 最新版本",kind:"article"}},
  {text:"按资料，最近是 X 版。",scene:"explanation",expressionIds:[],sourceIds:["S2"]},
 ]);
 const chat=createChat(s,host,{random:()=>0,
  fetchImpl:()=>next(),
  webFetchImpl:async()=>reply({search_results:[
   {title:"无关页面",url:"https://example.com/noise",chunks:[{text:"无关"}]},
   {title:"CHUNITHM 版本一览",url:"https://gamerch.com/chunithm/1",chunks:[{text:"最新是 X 版"}]}]})});
 const m=msg("a","<@123> CHUNITHM 现在最新版本是什么");await chat.handle(m);
 assert.match(m.replies[0].content,/参考资料/);
 assert.match(m.replies[0].content,/gamerch\.com/,"引用了哪条就给哪条");
 assert.doesNotMatch(m.replies[0].content,/example\.com/);
 chat.close();
});
test_("用户明确要出处：本地条目自带的来源优先，不为凑链接再联网",async()=>{
 const s=settings();s.search={apiKey:"kimi-fixture",cache:new Map()};s.knowledge=FIXTURE_KNOWLEDGE;s.terms=realTerms();
 const chat=createChat(s,host,{random:()=>0,
  fetchImpl:async()=>mock({text:"真超檄是四个版本的合称。",scene:"explanation",expressionIds:[]})(),
  webFetchImpl:()=>{throw Error("用户要出处时不该为了凑链接再联网")}});
 const m=msg("a","<@123> 真超檄是什么，给个来源");await chat.handle(m);
 assert.match(m.replies[0].content,/资料出处/);
 assert.match(m.replies[0].content,/萌娘百科|B站|贴吧|群内用户/,"要给本地条目自带的 source");
 chat.close();
});
test_("机制类术语命中：优先本地资料，模型想联网也拦得住",async()=>{
 const s=settings();s.knowledge=FIXTURE_KNOWLEDGE;s.terms=realTerms();
 const bodies=[];
 const chat=createChat(s,host,{random:()=>0,
  fetchImpl:async(u,o)=>{bodies.push(JSON.parse(o.body));return mock({text:"三榜是这么算的：…",scene:"explanation",expressionIds:[]})()},
  webFetchImpl:()=>{throw Error("机制问题不该联网：线上就是这里搜出「宝宝黄疸16.5」的")}});
 await chat.handle(msg("a","<@123> 音击的 RATING 三榜是怎么算的"));
 const injected=bodies[0].messages.map(item=>String(item.content)).join("\n");
 assert.match(injected,/本地术语资料/,"机制资料要注入，模型才有依据");
 assert.match(injected,/ベスト枠|best_rating_list|三榜/);
 chat.close();
});

// ── 意图 → 授权（第十三组）────────────────────────────────────────────
test_("现实事实/时效问题：模型标 research 就自动联网，程序只发事实子问题",async()=>{
 const s=settings();s.search={apiKey:"kimi-fixture",cache:new Map()};s.knowledge=FIXTURE_KNOWLEDGE;
 const queries=[],logs=[];
 const next=scripted([
  {intent:"research",factQuery:"CHUNITHM 最新版本",webQuery:{query:"CHUNITHM 现在最新版本是什么",kind:"article"}},
  {text:"翻到了，最近是 X 版。",scene:"explanation",expressionIds:[],sourceIds:["S1"]},
 ]);
 const chat=createChat(s,host,{random:()=>0,log:t=>logs.push(t),
  fetchImpl:()=>next(),
  webFetchImpl:async(u,o)=>{queries.push(JSON.parse(o.body).text_query);
   return reply({search_results:[{title:"CHUNITHM 版本一览",url:"https://gamerch.com/chunithm/1",chunks:[{text:"最新版本是 X"}]}]})}});
 // 这一句既没有攻略词、本地曲库也答不了——以前只能靠模型说一句「拿不准」才触发兜底网
 const m=msg("a","<@123> CHUNITHM 现在最新版本是什么");await chat.handle(m);
 // 这一句现在有两条入口都会到：时效规则表先预检索一次（用户问句原样），模型再按意图
 // 请求一次（只发它抽出来的事实子问题）。两次都在 2 轮预算内，且都不含角色扮演内容。
 assert.deepEqual(queries,["CHUNITHM 现在最新版本是什么","CHUNITHM 最新版本"],"规则表预检索 + 模型按意图请求");
 assert.match(m.replies[0].content,/gamerch\.com|版本一览/,"来源要附在回答里");
 assert.ok(logs.some(t=>t.includes("检索 retrieved")),"日志记成检索轮");
 chat.close();
});
test_("入戏/假设：模型请求联网也被拒，改成直接回答",async()=>{
 const s=settings();s.search={apiKey:"kimi-fixture",cache:new Map()};s.knowledge=FIXTURE_KNOWLEDGE;
 const bodies=[],logs=[];
 const next=scripted([
  {intent:["roleplay"],webQuery:{query:"如果梨绪去打全国大赛能拿第几名"}},
  {text:"梦话我可不敢接，先去练底力吧。",scene:"banter",expressionIds:[]},
 ]);
 const chat=createChat(s,host,{random:()=>0,log:t=>logs.push(t),
  fetchImpl:async(u,o)=>{bodies.push(JSON.parse(o.body));return next()},
  webFetchImpl:()=>{throw Error("入戏的句子不该联网")}});
 const m=msg("a","<@123> 如果梨绪去打全国大赛会怎么样");await chat.handle(m);
 assert.match(m.replies[0].content,/梦话/,"被拒之后走的是重写出来的那句话");
 assert.match(bodies[1].messages.map(x=>x.content).join("\n"),/未授权联网/,"要告诉模型为什么没授权，别让它以为网络坏了");
 assert.equal(/我去查|这就去翻|稍等/.test(m.replies[0].content),false,"被拒之后不能还说要查");
 assert.ok(logs.some(t=>t.includes("联网请求被意图策略拒绝1次")&&t.includes("roleplay")));
 chat.close();
});
test_("模糊与闲聊：模型想搜也搜不了（默认不搜）",async()=>{
 const s=settings();s.search={apiKey:"kimi-fixture",cache:new Map()};s.knowledge=FIXTURE_KNOWLEDGE;
 const next=scripted([
  {intent:"chitchat",webQuery:{query:"你觉得呢"}},
  {text:"我啊，我觉得你想说啥就说呗。",scene:"banter",expressionIds:[]},
 ]);
 const chat=createChat(s,host,{random:()=>0,
  fetchImpl:()=>next(),
  webFetchImpl:()=>{throw Error("闲聊不该联网")}});
 const m=msg("a","<@123> 你觉得呢");await chat.handle(m);
 assert.match(m.replies[0].content,/你想说啥/);
 chat.close();
});
test_("角色扮演句里夹着独立事实：拆分通道只把事实那半句发出去",async()=>{
 const s=settings();s.search={apiKey:"kimi-fixture",cache:new Map()};s.knowledge=FIXTURE_KNOWLEDGE;
 const queries=[],logs=[];
 const next=scripted([
  {intent:["roleplay","research"],factQuery:"中二 电管 定数",
   webQuery:{query:"电管 定数 如果梨绪去打会怎么样"}},
  {text:"顺手查到它是 15。",scene:"explanation",expressionIds:[],sourceIds:["S1"]},
 ]);
 const chat=createChat(s,host,{random:()=>0,log:t=>logs.push(t),
  fetchImpl:()=>next(),
  webFetchImpl:async(u,o)=>{queries.push(JSON.parse(o.body).text_query);
   return reply({search_results:[{title:"定数表",url:"https://gamerch.com/chunithm/2",chunks:[{text:"Dengeki Tube 15.2"}]}]})}});
 const m=msg("a","<@123> 帮我联网查一下电管现在的定数——顺便，如果梨绪去打这首歌会怎么样？");await chat.handle(m);
 assert.equal(queries.every(q=>!/梨绪|如果|会怎么样/.test(q)),true,"角色扮演那半句一句都不能发出去："+queries.join("｜"));
 assert.equal(queries[0],"电管现在的定数","程序预检索只发事实那半句");
 assert.equal(queries[1],"中二 电管 定数","模型那一轮走拆分通道，只发它抽出的事实子问题");
 assert.ok(logs.some(t=>t.includes("拆分通道只发事实子问题")));
 chat.close();
});

// ── 结果为空后重建检索词（第十二组）──────────────────────────────────
test_("第一次搜空：用游戏名+正式曲名+问题类型重建，重查一次就够",async()=>{
 const s=settings();s.search={apiKey:"kimi-fixture",cache:new Map()};s.knowledge=FIXTURE_KNOWLEDGE;
 const queries=[],logs=[];
 // 模型说拿不准 → 程序按原词补检索 → 第一次空 → 重建后再查一次
 const chat=createChat(s,host,{random:()=>0,log:t=>logs.push(t),
  webFetchImpl:async(u,o)=>{queries.push(JSON.parse(o.body).text_query);
   return queries.length===1?reply({search_results:[]})
    :reply({search_results:[{title:"中二攻略",url:"https://www.bilibili.com/read/cv1",chunks:[{text:"正文"}]}]})},
  fetchImpl:mock({text:"这个名字我可得先查清楚，不确定。",scene:"explanation",expressionIds:[]})});
 const m=msg("a","<@123> 你会不会打 Dengeki Tube?");await chat.handle(m);
 assert.equal(queries.length,2,"第一次空，重建后再查一次");
 assert.match(queries[0],/Dengeki Tube/i);
 assert.match(queries[1],/CHUNITHM/,"重建要带上游戏名（优先日文原名）");
 assert.match(queries[1],/Dengeki Tube/,"带上曲库认出来的正式曲名");
 assert.match(queries[1],/攻略|定数|評価|おすすめ/,"带上问题类型对应的日文检索词");
 assert.ok(logs.some(t=>t.includes("结果为空后重建检索词")&&t.includes("CHUNITHM")),"日志要能看到重查用了什么词");
 // 两个计数分开记：轮数不涨（不占工具预算），实际请求数要涨（计费按它算）
 const done=logs.find(t=>t.includes("梨绪聊天完成"));
 assert.match(done,/联网1轮／实际请求2次/,"重查不占轮数，但必须占实际请求数");
 chat.close();
});
test_("自动重查整轮只有一次，实际请求数也不会越过硬上限",async()=>{
 // 预检索（1 轮 + 1 次重查）之后模型自己又发起一轮搜索（1 轮）——第二轮的检索词再空，
 // 也不给第二次重查：重查是「同一次搜索」的补救，不是每轮都有的配额。
 const s=settings();s.search={apiKey:"kimi-fixture",cache:new Map()};s.knowledge=FIXTURE_KNOWLEDGE;
 const queries=[],logs=[];
 const next=scripted([
  {webQuery:{query:"CHUNITHM Dengeki Tube 譜面",kind:"article"}},
  {text:"没查到可核实的资料。",scene:"explanation",expressionIds:[]},
 ]);
 const chat=createChat(s,host,{random:()=>0,log:t=>logs.push(t),
  webFetchImpl:async(u,o)=>{queries.push(JSON.parse(o.body).text_query);return reply({search_results:[]})},
  fetchImpl:async()=>next()});
 const m=msg("a","<@123> 教我玩 Dengeki Tube");await chat.handle(m);
 assert.equal(queries.length,3,"预检索 + 它的重查 + 模型那轮，各一次");
 const done=logs.find(t=>t.includes("梨绪聊天完成"));
 assert.match(done,/联网2轮／实际请求3次/);
 assert.ok(Number(done.match(/实际请求(\d+)次/)[1])<=4,"整轮实际请求有硬上限");
 chat.close();
});
test_("两次都空：到此为止，把话交给模型说清楚",async()=>{
 const s=settings();s.search={apiKey:"kimi-fixture",cache:new Map()};s.knowledge=FIXTURE_KNOWLEDGE;
 const queries=[];
 const r=await requestReply(s,[{role:"user",content:"你会不会打 Dengeki Tube?"}],{
  webFetchImpl:async(u,o)=>{queries.push(JSON.parse(o.body).text_query);return reply({search_results:[]})},
  fetchImpl:async()=>reply({choices:[{message:{content:JSON.stringify({text:"这个名字我可得先查清楚，不确定。"})}}]})});
 assert.equal(queries.length,2,"只重查一次，不循环");
 assert.equal(r.research.status,'empty');
 assert.match(r.text,/不确定|没有|资料/,"查空时保留模型自己那句诚实的话");
});
test_("调用本身失败（网关/超时）不重查：那是链路问题，换词也白搭",async()=>{
 const s=settings();s.search={apiKey:"kimi-fixture",cache:new Map()};s.knowledge=FIXTURE_KNOWLEDGE;
 let webs=0;
 const r=await requestReply(s,[{role:"user",content:"你会不会打 Dengeki Tube?"}],{
  webFetchImpl:async()=>{webs++;return {ok:false,status:503,text:async()=>"",json:async()=>({})}},
  fetchImpl:async()=>reply({choices:[{message:{content:JSON.stringify({text:"我不确定。"})}}]})});
 assert.equal(webs,1,"接口报错不触发重查");
 assert.equal(r.research.status,'empty');
});
test_("结果一条都没匹配上要问的那首曲子，也算没有有效结果，照样重查",async()=>{
 // 实测过的那一类：搜回来一堆别的曲子的页面，程序按 entity 过滤之后等于空
 const s=settings();s.search={apiKey:"kimi-fixture",cache:new Map()};s.knowledge=FIXTURE_KNOWLEDGE;
 const queries=[];
 const r=await requestReply(s,[{role:"user",content:"教我玩 Dengeki Tube"}],{
  webFetchImpl:async(u,o)=>{queries.push(JSON.parse(o.body).text_query);
   return queries.length===1
    ?reply({search_results:[{title:"别的曲子",url:"https://www.bilibili.com/read/cv1",chunks:[{text:"完全无关"}]}]})
    :reply({search_results:[{title:"Dengeki Tube 攻略",url:"https://www.bilibili.com/read/cv2",chunks:[{text:"Dengeki Tube 的谱面很吃底力"}]}]})},
  fetchImpl:async()=>reply({choices:[{message:{content:JSON.stringify({text:"按资料说，它很吃底力。",sourceIds:["S1"]})}}]})});
 assert.equal(queries.length,2,"第一句只搜到别的曲子，等于没搜到");
 assert.match(queries[1],/CHUNITHM/);
 assert.equal(r.research.webCalls,1);
 assert.equal(r.research.status,'retrieved');
});

// ── 检索词规范化（第十一组）──────────────────────────────────────────
test_("联网前把检索词里的中文简称换成正式曲名",async()=>{
 const s=settings();s.search={apiKey:"kimi-fixture",cache:new Map()};s.knowledge=FIXTURE_KNOWLEDGE;
 const queries=[],logs=[];
 const next=scripted([
  {intent:"research",webQuery:{query:"电管 定数 水吗",kind:"article"}},
  {text:"翻到了。",scene:"explanation",expressionIds:[]},
 ]);
 const chat=createChat(s,host,{random:()=>0,log:t=>logs.push(t),
  adapter:{alias:{resolve:()=>null,propose:()=>{},titles:()=>[{alias:"电管",title:"Dengeki Tube",game:"chunithm"}]}},
  fetchImpl:async()=>next(),
  webFetchImpl:async(u,o)=>{queries.push(JSON.parse(o.body).text_query);
   return reply({search_results:[{title:"中二节奏吧",url:"https://tieba.baidu.com/p/1",chunks:[{text:"正文"}]}]})}});
 const m=msg("a","<@123> 中二的 电管 算水吗");await chat.handle(m);
 assert.ok(queries.length,"得真搜一次");
 assert.equal(queries.every(q=>!q.includes("电管")),true,"发出去的检索词里不能再有中文简称："+queries.join("｜"));
 assert.equal(queries.some(q=>q.includes("Dengeki Tube")),true,"要换成正式曲名");
 assert.ok(logs.some(t=>t.includes("检索词规范化")&&t.includes("电管→Dengeki Tube")),"日志要能回看替过什么");
 chat.close();
});

// ── 等级资格（第十组）────────────────────────────────────────────────
// 定数裁决层把旧数字改对了，不等于这首歌还在这份名单里：用户要的是「当前的 14+」，
// 而 Dengeki Tube 在中二那张表里已经只有 12+ 和 15。
test_("用户点名当前档位：老资料推荐过、现在已升档的曲子会被换掉",async()=>{
 const s=settings();s.search={apiKey:"kimi-fixture",cache:new Map()};s.knowledge=FIXTURE_KNOWLEDGE;
 const bodies=[],logs=[];
 // 第一次：模型照着老帖把 Dengeki Tube 当 14+ 推。第二次：程序把「它没有14+的谱」交回去，
 // 模型换成别的说法。
 const next=scripted([
  {text:"中二比较水的14+，我推荐 Dengeki Tube 14.9。",scene:"explanation",expressionIds:[]},
  {text:"哎呀，DENGEKI Tube 现在已经升到 15 了，14+ 我得另找。",scene:"explanation",expressionIds:[]},
 ]);
 const chat=createChat(s,host,{random:()=>0,log:t=>logs.push(t),
  fetchImpl:async(u,o)=>{bodies.push(JSON.parse(o.body));return next()},
  webFetchImpl:async()=>reply({search_results:[{title:"中二节奏吧",url:"https://tieba.baidu.com/p/1",chunks:[{text:"Dengeki Tube 14.9 算水"}]}]})});
 const m=msg("a","<@123> 中二有没有比较水的14+？");await chat.handle(m);
 assert.equal(bodies.length,2,"要把「它现在没有14+的谱面」交回模型重写一次");
 const correction=bodies[1].messages.filter(x=>x.role==="system").map(x=>x.content).join("\n");
 assert.match(correction,/没有 14\+ 的谱面/);
 assert.match(correction,/现在已经升到|历史资料/);
 assert.match(m.replies[0].content,/升到 15/);
 assert.equal(/14\.9/.test(m.replies[0].content),false,"旧定数不能留在最终答复里");
 assert.ok(logs.some(t=>t.includes("等级资格重写")&&t.includes("Dengeki Tube")),"日志要记得下这一轮为什么重写");
 chat.close();
});
test_("重写之后还在推荐：程序先把它删掉，不靠末尾纠错",async()=>{
 const s=settings();s.search={apiKey:"kimi-fixture",cache:new Map()};s.knowledge=FIXTURE_KNOWLEDGE;
 const logs=[];
 // 模型两轮都推同一首（嘴上答应、实际不改）
 const chat=createChat(s,host,{random:()=>0,log:t=>logs.push(t),
  fetchImpl:mock({text:"中二水的14+，我推荐 Dengeki Tube 14.9，另外 Air 也可以。",scene:"explanation",expressionIds:[]}),
  webFetchImpl:async()=>reply({search_results:[{title:"中二节奏吧",url:"https://tieba.baidu.com/p/1",chunks:[{text:"正文"}]}]})});
 const m=msg("a","<@123> 中二有没有比较水的14+？");await chat.handle(m);
 // 那句推荐整个不见了，而不是留在正文里等读者看到末尾的纠正
 assert.equal(m.replies[0].content.includes("Dengeki Tube"),false,"不合格的推荐不能留在正文里");
 assert.equal(/14\.9/.test(m.replies[0].content),false);
 assert.match(m.replies[0].content,/中二水的14\+/,"句子里其它的内容要留下");
 assert.match(m.replies[0].content,/Air 也可以/,"合格的那条推荐不能跟着一起删掉");
 assert.ok(logs.some(t=>t.includes("程序删除推荐")&&t.includes("Dengeki Tube")),"日志要记下删了哪条");
 chat.close();
});
test_("删不掉（整条回复就是那条推荐）才退到末尾说明，而且按快照口径",async()=>{
 const s=settings();s.search={apiKey:"kimi-fixture",cache:new Map()};s.knowledge=FIXTURE_KNOWLEDGE;
 const chat=createChat(s,host,{random:()=>0,
  fetchImpl:mock({text:"Dengeki Tube 14.9 挺水，推荐。",scene:"explanation",expressionIds:[]}),
  webFetchImpl:async()=>reply({search_results:[{title:"中二节奏吧",url:"https://tieba.baidu.com/p/1",chunks:[{text:"正文"}]}]})});
 const m=msg("a","<@123> 中二有没有比较水的14+？");await chat.handle(m);
 assert.match(m.replies[0].content,/程序核对/);
 assert.match(m.replies[0].content,/Dengeki Tube 只有 12\+、15 的谱/);
 assert.match(m.replies[0].content,/只能算历史资料/);
 assert.match(m.replies[0].content,/本地曲库快照/);
 assert.match(m.replies[0].content,/不代表国服\/日服实时收录/,"程序自己说的话不能讲成国服实时");
 chat.close();
});
test_("重写那一次调用失败也不能把答复弄丢",async()=>{
 const s=settings();s.search={apiKey:"kimi-fixture",cache:new Map()};s.knowledge=FIXTURE_KNOWLEDGE;
 let calls=0;
 const chat=createChat(s,host,{random:()=>0,
  // 第一次正常回，第二次（重写）直接炸
  fetchImpl:async()=>{calls++;if(calls>1)throw Error("网关故障");return mock({text:"Dengeki Tube 14.9 挺水，推荐。",scene:"explanation",expressionIds:[]})()},
  webFetchImpl:async()=>reply({search_results:[{title:"中二节奏吧",url:"https://tieba.baidu.com/p/1",chunks:[{text:"正文"}]}]})});
 const m=msg("a","<@123> 中二有没有比较水的14+？");await chat.handle(m);
 assert.equal(m.replies.length,1,"答复不能因为重写失败而消失");
 assert.match(m.replies[0].content,/Dengeki Tube/);
 assert.match(m.replies[0].content,/只能算历史资料/,"重写没成，程序自己补的那句必须还在");
 chat.close();
});
test_("没点名当前档位的轮次不会多花一次模型调用",async()=>{
 const s=settings();s.knowledge=FIXTURE_KNOWLEDGE;
 let calls=0;
 const r=await requestReply(s,[{role:"user",content:"推荐几首好听的"}],{fetchImpl:async()=>{calls++;return mock()()}});
 assert.equal(calls,1,"没有档位要求就不该走等级资格那条路");
 assert.equal(r.levelFixed,undefined);
});
test_("模型照着用户的中文简称写答案时，裁决层照样认得出那首歌",async()=>{
 const s=settings();s.search={apiKey:"kimi-fixture",cache:new Map()};s.knowledge=FIXTURE_KNOWLEDGE;
 const logs=[];
 const chat=createChat(s,host,{random:()=>0,log:t=>logs.push(t),
  // 宿主给的正式别名表（QQ 侧背后是 SongAliasStore.titleIndex）：曲名索引里只有
  // Dengeki Tube，模型写的却是用户那个叫法。
  adapter:{alias:{resolve:()=>null,propose:()=>{},titles:()=>[{alias:"电管",title:"Dengeki Tube",game:"chunithm"}]}},
  fetchImpl:mock({text:"电管的紫谱 14.9，偏水。",scene:"explanation",expressionIds:[]}),
  webFetchImpl:async()=>reply({search_results:[{title:"中二节奏吧",url:"https://tieba.baidu.com/p/1",chunks:[{text:"正文"}]}]})});
 const m=msg("a","<@123> 中二 电管 算水吗");await chat.handle(m);
 assert.match(m.replies[0].content,/电管的紫谱 15\.2/,"别名写法的旧定数也要被曲库当前值取代");
 assert.equal(logs.some(t=>t.includes("定数校正")&&t.includes("14.9→15.2")),true);
 chat.close();
});
test_("定数本来就对的一个字都不改；引用旧值的句子只补当前值、原数字不动",async()=>{
 const s=settings();s.search={apiKey:"kimi-fixture",cache:new Map()};s.knowledge=FIXTURE_KNOWLEDGE;
 const cases=[
  ["Dengeki Tube 的紫谱是 15.2，可以上。","Dengeki Tube 的紫谱是 15.2，可以上。",false],
  // 时效句里的数字不能硬改：「老帖写成 14.9」本身是正确的话，改了就成了胡话。
  // 但也不能只留一个旧值——模型会在标注「这是老帖的说法」之后照样把 14.9 当现状用，
  // 所以程序在数字后面补一句当前值，读者两边都看得到。
  ["老帖把 Dengeki Tube 写成 14.9，那是旧数据。","老帖把 Dengeki Tube 写成 14.9（当前定数 15.2），那是旧数据。",true],
 ];
 for(const [text,expect,corrected] of cases){
  const logs=[];
  const chat=createChat(s,host,{random:()=>0,log:t=>logs.push(t),
   fetchImpl:mock({text,scene:"explanation",expressionIds:[]}),
   webFetchImpl:async()=>reply({search_results:[{title:"中二节奏吧",url:"https://tieba.baidu.com/p/1",chunks:[{text:"正文"}]}]})});
  const m=msg("a","<@123> 中二有没有比较水的14+？");await chat.handle(m);
  assert.ok(m.replies[0].content.startsWith(expect),"实际："+m.replies[0].content);
  assert.equal(logs.some(t=>t.includes("定数校正")),corrected,"日志要对得上："+text);
  if(corrected)assert.ok(logs.some(t=>t.includes("仅补注当前值")),"补注要能在日志里认出来");
  chat.close();
 }
});
// 逐轮给不同的回复：mock() 每次都回同一份，会被工具循环一直当成「还要工具」。
// 注意闭包要**在 fetchImpl 外面**建：写在里面等于每次调用都重置轮次，永远停在第一轮。
const scripted=(bodies)=>{let call=0;return async()=>{const body=bodies[Math.min(call,bodies.length-1)];call++;return reply({choices:[{finish_reason:"stop",message:{content:JSON.stringify(body)}}]})};};
test_("正式 alias 作为曲库查询的前置解析：先换成正式曲名，再走本地曲库",async()=>{
 const s=settings();s.knowledge=FIXTURE_KNOWLEDGE;
 const asked=[];let body=null;
 const next=scripted([
  {knowledgeQuery:{game:"chunithm",title:"电管"}},
  {text:"电管的紫谱是 15.2。",scene:"explanation",expressionIds:[]},
 ]);
 const chat=createChat(s,host,{random:()=>0,
  // 宿主注入的解析器背后是 takase-core 的 SongAliasStore，聊天侧只拿到一个正式曲名。
  adapter:{alias:{resolve:word=>{asked.push(word);return word==="电管"?{title:"Dengeki Tube",songId:391,alias:"电管"}:null;}}},
  fetchImpl:async(u,o)=>{body=JSON.parse(o.body);return next()}});
 const m=msg("a","<@123> 电管什么定数");await chat.handle(m);
 assert.deepEqual(asked,["电管"],"曲库查询前要先过一遍正式别名库");
 // 看 evidence 原文：body.messages 再 stringify 会把内层引号转义，正则反而匹配不到
 const evidence=body.messages.filter(x=>x.role==="user").at(-1)?.content||"";
 assert.match(evidence,/"title":"Dengeki Tube"/,"交给曲库的必须是正式曲名");
 assert.match(evidence,/"constant":15\.2/,"换名之后要真查到当前定数");
 assert.match(m.replies[0].content,/15\.2/);
 chat.close();
});
test_("联网检索词里出现曲库真曲名时自动回本地库核一遍，并按门槛记候选",async()=>{
 const s=settings();s.search={apiKey:"kimi-fixture",cache:new Map()};s.knowledge=FIXTURE_KNOWLEDGE;
 const proposed=[];
 const next=scripted([
  {knowledgeQuery:{game:"chunithm",title:"电管"}},          // 曲库按用户的叫法查不到
  {intent:"research",webQuery:{query:"CHUNITHM Dengeki Tube 定数",kind:"article"}},   // 模型联网认出了正式曲名
  {text:"电管就是 Dengeki Tube，紫谱 15.2。",scene:"explanation",expressionIds:[]},
 ]);
 const chat=createChat(s,host,{random:()=>0,
  adapter:{alias:{resolve:()=>null,propose:entry=>{proposed.push(entry);return {added:true};}}},
  fetchImpl:()=>next(),
  webFetchImpl:async()=>reply({search_results:[{title:"中二节奏吧",url:"https://tieba.baidu.com/p/1",chunks:[{text:"Dengeki Tube 14.9"}]}]})});
 const m=msg("a","<@123> 中二的电管是什么");await chat.handle(m);
 assert.equal(proposed.length,1,"恢复成功后要记一条候选");
 assert.deepEqual({alias:proposed[0].alias,title:proposed[0].title,game:proposed[0].game},
  {alias:"电管",title:"Dengeki Tube",game:"chunithm"},"候选挂的是曲名，不绑任何一份曲库的 songId");
 assert.match(m.replies[0].content,/15\.2/,"自动核对到的当前值要进回答");
 chat.close();
});
test_("游戏上下文冲突的候选不落盘：音击的问法不会被记成中二的歌",async()=>{
 const s=settings();s.search={apiKey:"kimi-fixture",cache:new Map()};s.knowledge=FIXTURE_KNOWLEDGE;
 const proposed=[];let body=null;
 const next=scripted([
  {knowledgeQuery:{game:"chunithm",title:"电管"}},
  {intent:"research",webQuery:{query:"CHUNITHM Dengeki Tube 定数",kind:"article"}},
  {text:"电管就是 Dengeki Tube。",scene:"explanation",expressionIds:[]},
 ]);
 const chat=createChat(s,host,{random:()=>0,
  adapter:{alias:{resolve:()=>null,propose:entry=>{proposed.push(entry);return {added:true};}}},
  fetchImpl:async(u,o)=>{body=JSON.parse(o.body);return next()},
  webFetchImpl:async()=>reply({search_results:[{title:"中二节奏吧",url:"https://tieba.baidu.com/p/1",chunks:[{text:"Dengeki Tube 14.9"}]}]})});
 const m=msg("a","<@123> 音击的电管是什么");await chat.handle(m);
 assert.equal(proposed.length,0,"对话说的是音击，命中的是中二，这条映射不能记");
 assert.equal(m.replies.length,1,"不记候选不影响这一轮的回答");
 // 关键的一条：用户点名了音击，就不能把中二的同名曲数据当事实喂回去——
 // 那是跨游戏定数污染的入口（同一首歌在两边定数不同）。最多给一句消歧提示。
 const evidence=body.messages.filter(x=>x.role==="user").at(-1)?.content||"";
 assert.match(evidence,/aliasHints/,"要给的是消歧提示");
 assert.match(evidence,/在 chunithm 有收录/);
 assert.doesNotMatch(evidence,/"constant":15\.2/,"不能把中二的定数当音击的数据喂回去");
 assert.doesNotMatch(evidence,/15\.2/);
 chat.close();
});
test_("检索轮不再发中间提示，整条回复只有一条最终答复",async()=>{
 const s=settings();s.search={apiKey:"kimi-fixture",cache:new Map()};
 const chat=createChat(s,host,{random:()=>0,
  fetchImpl:async()=>reply({choices:[{finish_reason:"stop",message:{content:JSON.stringify({text:"查到了，按定数够线的谱面选。",scene:"explanation"})}}]}),
  webFetchImpl:async()=>reply({search_results:[{title:"16000达成记录",url:"https://note.com/player/n/example",chunks:[{text:"正文"}]}]})});
 const m=msg("a","<@123> 有没有舞萌上w6的吃分推荐？");await chat.handle(m);
 // 曲库查询、联网、改写重搜全部静默：省下的是 QQ 侧每群每小时的发送配额
 // （qq-onebot 的 perGroupPerHour），而「这条在答哪一句」由最终回复引用原消息解决。
 assert.equal(m.replies.length,1,"只有最终答复，不再先发一条「我去翻资料」");
 assert.match(m.replies[0].content,/定数够线/);
 // 模型没点名引用哪条来源 → 一句链接都不挂（搜到不等于用上，见来源展示策略那条用例）
 assert.doesNotMatch(m.replies[0].content,/16000达成记录|note\.com/);
 chat.close();
});
test_("没检索的轮次在日志里写明理由，回看分得清是判对了还是漏了",async()=>{
 const s=settings();s.search={apiKey:"kimi-fixture",cache:new Map()};
 const logs=[];let calls=0;
 const chat=createChat(s,host,{log:t=>logs.push(t),random:()=>0,
  fetchImpl:async(u,o)=>{calls++;
   // 分诊器已经删掉：任何一句闲聊都不该再产生第二次模型调用
   assert.ok(!String(JSON.parse(o.body).messages[0].content).startsWith("你在给一个音游"),"不该再有分诊请求");
   return reply({choices:[{finish_reason:"stop",message:{content:JSON.stringify({text:"看你缺不缺这块分。",scene:"explanation"})}}]})}});
 const m=msg("a","<@123> 这首值不值得练");await chat.handle(m);
 assert.equal(calls,1);
 assert.equal(m.replies.length,1);
 assert.equal(m.replies[0].content,"看你缺不缺这块分。");
 assert.ok(logs.some(t=>t.includes("检索 not-needed")&&t.includes("理由默认不联网")),logs.join("|"));
 chat.close();
});
test_("用户明说要查就一定检索，日志记下理由",async()=>{
 const s=settings();s.search={apiKey:"kimi-fixture",cache:new Map()};
 const logs=[];
 const chat=createChat(s,host,{log:t=>logs.push(t),random:()=>0,
  fetchImpl:async(u,o)=>{const b=JSON.parse(o.body);
   return b.messages.some(m=>String(m.content).includes("程序预检索"))
    ?reply({choices:[{finish_reason:"stop",message:{content:JSON.stringify({text:"按查到的资料答。",scene:"explanation"})}}]})
    :reply({choices:[{finish_reason:"stop",message:{content:JSON.stringify({text:"我去翻一下。",scene:"ordinary"})}}]})},
  webFetchImpl:async()=>reply({search_results:[]})});
 const m=msg("a","<@123> 帮我联网搜索一下 inorganyx prayer 是什么");await chat.handle(m);
 assert.ok(logs.some(t=>t.includes("理由用户要求查证")),logs.join("|"));
 chat.close();
});
test_("reply parses when the prefilled brace is not echoed back",async()=>{
 const s=settings();
 const r=await requestReply(s,[{role:"user",content:"hi"}],{fetchImpl:async()=>reply({choices:[{finish_reason:"stop",message:{content:JSON.stringify(result).slice(1)}}]})});
 assert.equal(r.text,result.text);
});
// ── 工具调用（查分统一进来之后新增的那条契约）──────────────────────────
const specs=[{name:"song",label:"单曲成绩图",argHint:"曲名或 Song ID"},{name:"calculate",label:"Rating",argHint:"定数 技术分"}];
const withAction={text:"哼哼，这就去翻你的成绩——",emotion:"proud",scene:"ordinary",expressionIds:[],action:{name:"song",query:"id870"}};
test_("host actions reach the model prompt and the executor",async()=>{
 const s=settings();let body,seen;
 const chat=createChat(s,host,{adapter:{actions:specs,actionTarget:true,runAction:async(a,m,r)=>{seen={a,r};return {handled:true}}},
   fetchImpl:async(u,o)=>{body=JSON.parse(o.body);return mock(withAction)()}});
 const m=msg("a","<@123> 帮我查一下 id870 的成绩");await chat.handle(m);
 assert.match(body.messages[0].content,/单曲成绩图/);           // 清单进了提示词
 assert.match(body.messages[0].content,/target/);               // 开了查别人就说明 target 怎么用
 assert.deepEqual(seen.a,{name:"song",query:"id870"});
 assert.equal(seen.r.text,"哼哼，这就去翻你的成绩——");           // 执行器拿得到模型那句话
 assert.equal(m.replies.length,0);                              // 宿主说发了，聊天模块就不再发
 chat.close();
});
test_("target is passed through but only as a plain handle",async()=>{
 const s=settings();let seen;
 const chat=createChat(s,host,{adapter:{actions:specs,actionTarget:true,runAction:async(a)=>{seen=a;return {handled:true}}},
   fetchImpl:mock({...withAction,action:{name:"song",query:"id870",target:"10086"}})});
 await chat.handle(msg("a","<@123> 帮我查一下他的成绩"));
 assert.deepEqual(seen,{name:"song",query:"id870",target:"10086"});
 chat.close();
 // 没开 actionTarget 时不提 target；编号里的怪字符也会被收敛掉
 const chat2=createChat(s,host,{adapter:{actions:specs,runAction:async(a)=>{seen=a;return {handled:true}}},
   fetchImpl:mock({...withAction,action:{name:"song",query:"id870",target:"../etc/passwd"}})});
 await chat2.handle(msg("b","<@123> 帮我查一下他的成绩"));
 assert.equal(seen.target,"etcpasswd");
 assert.equal(normalizeAction({name:"song",target:""},specs).target,undefined);
 chat2.close();
});
test_("without an executor the tool list stays out of the prompt",async()=>{
 const s=settings();let body;
 const chat=createChat(s,host,{adapter:{actions:specs},fetchImpl:async(u,o)=>{body=JSON.parse(o.body);return mock(withAction)()}});
 const m=msg("a","<@123> 帮我查一下 id870 的成绩");await chat.handle(m);
 assert.ok(!body.messages[0].content.includes("工具调用"));
 assert.equal(m.replies[0].content,"哼哼，这就去翻你的成绩——");    // 退化成普通聊天
 chat.close();
});
test_("a model-written tool name outside the list is dropped",async()=>{
 const s=settings();let called=0;
 const chat=createChat(s,host,{adapter:{actions:specs,runAction:async()=>{called++;return {handled:true}}},
   fetchImpl:mock({...withAction,action:{name:"rm -rf",query:"x"}})});
 const m=msg("b","<@123> 帮我查一下 id870 的成绩");await chat.handle(m);
 assert.equal(called,0,"清单外的工具名不该进执行器");
 assert.equal(m.replies[0].content,"哼哼，这就去翻你的成绩——");   // 退化成普通聊天
 chat.close();
});
test_("handled:false hands the reply back to the chat module",async()=>{
 const s=settings();let called=0;
 const chat=createChat(s,host,{adapter:{actions:specs,runAction:async()=>{called++;return {handled:false,text:"宿主想说这句"}}},
   fetchImpl:mock(withAction)});
 const m=msg("c","<@123> 帮我查一下 id870 的成绩");await chat.handle(m);
 assert.equal(called,1);
 assert.equal(m.replies[0].content,"宿主想说这句");
 chat.close();
});
test_("group context from the adapter becomes a leading system note",async()=>{
 const s=settings();let body;
 const chat=createChat(s,host,{adapter:{context:()=>["19:40 小明：今天状态真差","19:41 梨绪：SAM2004 的 B50 分表（图片）"]},
   fetchImpl:async(u,o)=>{body=JSON.parse(o.body);return mock()()}});
 await chat.handle(msg("a","<@123> 这个人是不是有点弱啊"));
 const systems=body.messages.filter(m=>m.role==="system");
 assert.equal(systems.length,2);                       // 人设 + 群上下文
 assert.match(systems[1].content,/今天状态真差/);
 assert.match(systems[1].content,/不要逐条回应/);
 assert.equal(body.messages.some(m=>m.content&&m.content.includes("这个人是不是有点弱啊")&&m.role==="system"),false);
 chat.close();
 // 没有 context 钩子时不插这条
 const chat2=createChat(s,host,{fetchImpl:async(u,o)=>{body=JSON.parse(o.body);return mock()()}});
 await chat2.handle(msg("b","<@123> 你好"));
 assert.equal(body.messages.filter(m=>m.role==="system").length,1);
 chat2.close();
});
test_("a quoted message from the adapter lands just before the user turn",async()=>{
 const s=settings();let body;
 const quoted="22:48 梨绪（我自己）：我从曲库里挑了几首：Reach For The Stars（13.9）、DADDY MULK（13.8）";
 const chat=createChat(s,host,{adapter:{quoted:()=>quoted},
   fetchImpl:async(u,o)=>{body=JSON.parse(o.body);return mock()()}});
 // 避开「为什么」：那是检索策略里的「事实问答先核实」，那一轮不走模型，测不到提示词
 await chat.handle(msg("a","<@123> 宝宝你刚才推的这几首是怎么挑的呀"));
 // 请求末尾是 assistant 预填充（"{")，所以定位「最后一条 user」再往回看一格
 const messages=body.messages, lastUser=messages.findLastIndex(m=>m.role==="user"), note=messages[lastUser-1];
 assert.equal(note.role,"system");                      // 紧挨着用户那句话
 assert.equal(messages[lastUser].role,"user");
 assert.match(note.content,/Reach For The Stars/);
 assert.match(note.content,/别当成没发生过/);            // 是引用对象，不是普通背景
 assert.equal(messages.filter(m=>m.role==="system"&&m.content.includes("群里最近的消息")).length,0);
 chat.close();
 // 没有 quoted 钩子（或宿主读不到引用）时不插这条
 const chat2=createChat(s,host,{adapter:{quoted:()=>""},fetchImpl:async(u,o)=>{body=JSON.parse(o.body);return mock()()}});
 await chat2.handle(msg("b","<@123> 你好"));
 assert.equal(body.messages.filter(m=>m.role==="system").length,1);
 chat2.close();
});
test_("a tool call with no text of its own is still a valid reply",async()=>{
 const s=settings();
 const r=await requestReply(s,[{role:"user",content:"hi"}],{actions:specs,
   fetchImpl:mock({emotion:"neutral",scene:"ordinary",expressionIds:[],action:{name:"song",query:"id870"}})});
 assert.equal(r.text,"");            // 不判成「回复为空」——说明文字由程序补
 assert.deepEqual(r.action,{name:"song",query:"id870"});
 await assert.rejects(requestReply(s,[{role:"user",content:"hi"}],{actions:specs,fetchImpl:mock({text:"   "})}),/回复为空/);
});
// ── 原作剧情（canon）层（第十四组）────────────────────────────────────
// 这一组守的是线上那条错答：问「你之前是不是和 akari 打过真人 cs」时，梨绪答
// 「没有的事！我哪跟明里打过真人CS……别让我背锅」——而原作里确实有（ONE BULLET LEFT）。
// 根因是 self 意图硬禁止联网、本地又没有可查的剧情层，模型只能凭印象否认。
const {loadStories}=require("./lore.cjs");
const {loadKnowledge}=require("./knowledge.cjs");
test_("本地剧情命中时直接用本地事实作答，一次网络请求都不发",async()=>{
 const s=settings();s.search={apiKey:"kimi-fixture",cache:new Map()};
 s.knowledge=loadKnowledge(__dirname);s.stories=loadStories(__dirname);
 const bodies=[],logs=[];
 const next=scripted([{text:"哼，那次是那次。别说得好像我输了似的。",scene:"banter",expressionIds:[]}]);
 const chat=createChat(s,host,{random:()=>0,log:t=>logs.push(t),
  fetchImpl:async(u,o)=>{bodies.push(JSON.parse(o.body));return next()},
  webFetchImpl:()=>{throw Error("本地剧情已确认，这一轮不该联网")}});
 const m=msg("a","<@123> 小梨你之前是和akari打过真人cs吗");await chat.handle(m);
 const injected=bodies[0].messages.find(x=>String(x.content).startsWith("【本地剧情资料"));
 assert.ok(injected,"剧情资料要以证据形状注入，模型才有事实可依");
 const payload=JSON.parse(String(injected.content).split("\n").slice(1).join("\n"));
 assert.equal(payload.stories[0].id,"one-bullet-left");
 assert.match(payload.stories[0].summary,/真人 CS|双人组/);
 assert.ok(!("quoteRefs" in payload.stories[0])&&!("quotes" in payload.stories[0]),"注入的只有摘要，台词正文不进 prompt");
 assert.equal(payload.stories[0].trust,"source");
 assert.equal(payload.stories[0].mappingTrust,"inferred","台词归属仍标推定，不跟着事件的 confirmed 走");
 // 系统提示里要有这条边界，否则模型不知道「嘴硬」和「否认」的分别
 assert.match(String(bodies[0].messages[0].content),/不能否认事实存在/);
 assert.match(m.replies[0].content,/那次是那次/);
 assert.ok(logs.some(t=>t.includes("本地剧情命中")&&t.includes("one-bullet-left")&&t.includes("直接作答未联网")));
 chat.close();
});
// 角色档案层守的是另一类静默失败：问别的角色是谁时，本地一条资料都没有，模型只能凭
// 训练印象描述（译名、组合、性格都容易串），或者说「我不认识这个人」——而后者还会
// 触发一次按用户原句的兜底检索。
const {loadProfiles}=require("./profiles.cjs");
test_("本地有角色档案时按档案作答，一次网络请求都不发",async()=>{
 const s=settings();s.search={apiKey:"kimi-fixture",cache:new Map()};
 s.knowledge=loadKnowledge(__dirname);s.profiles=loadProfiles(__dirname);
 const bodies=[],logs=[];
 const next=scripted([{text:"小星？那家伙一天到晚都在睡。",scene:"banter",expressionIds:[]}]);
 const chat=createChat(s,host,{random:()=>0,log:t=>logs.push(t),
  fetchImpl:async(u,o)=>{bodies.push(JSON.parse(o.body));return next()},
  webFetchImpl:()=>{throw Error("本地已有档案，这一轮不该联网")}});
 const m=msg("a","<@123> 井之原小星是个什么样的人");await chat.handle(m);
 const injected=bodies[0].messages.find(x=>String(x.content).startsWith("【本地角色档案"));
 assert.ok(injected,"角色档案要以证据形状注入，模型才有事实可依");
 const payload=JSON.parse(String(injected.content).split("\n").slice(1).join("\n"));
 assert.equal(payload.profiles[0].name,"井之原 小星");
 assert.equal(payload.profiles[0].basics.birthday,"11月23日");
 assert.equal(payload.profiles[0].unit,"7EVENDAYS⇔HOLIDAYS","组合由 characters.json join，不在档案文件里");
 assert.equal(payload.profiles[0].basics.trust,"source","官方来的块是 source");
 assert.equal(payload.profiles[0].extras.trust,"inferred","wikiwiki 单源的块要留余地，且不拖累 basics");
 assert.ok(!("sources" in payload.profiles[0]),"平时不给 source 网址——列出来只会诱使模型念 URL");
 // 系统提示里要有这条边界，否则模型会反问「有这个人吗」
 assert.match(String(bodies[0].messages[0].content),/不能否认这个人存在/);
 assert.ok(logs.some(t=>t.includes("本地角色档案命中")&&t.includes("井之原 小星")&&t.includes("直接作答未联网")));
 chat.close();
});
test_("回答否认了本地已确认的剧情时程序纠一轮，话术留了「不必改」的出口",async()=>{
 const s=settings();s.search={apiKey:"kimi-fixture",cache:new Map()};
 s.knowledge=loadKnowledge(__dirname);s.stories=loadStories(__dirname);
 // 第一轮就是线上那句错答；程序核对后应当只纠一次，发出去的是改写后的版本。
 const bodies=[],logs=[];
 const next=scripted([
  {text:"没有的事！我哪跟明里打过真人CS，别让我背锅。",scene:"banter",expressionIds:[]},
  {text:"哼……那次是那次。别说得好像我输了似的。",scene:"banter",expressionIds:[]},
 ]);
 const chat=createChat(s,host,{random:()=>0,log:t=>logs.push(t),
  fetchImpl:async(u,o)=>{bodies.push(JSON.parse(o.body));return next()},
  webFetchImpl:()=>{throw Error("不该联网")}});
 const m=msg("a","<@123> 小梨你之前是和akari打过真人cs吗");await chat.handle(m);
 assert.match(m.replies[0].content,/那次是那次/,"发出去的是纠错后的版本");
 const note=bodies[1].messages.map(x=>String(x.content)).join("\n");
 assert.match(note,/程序核对剧情事实/);
 assert.match(note,/如果你只是在引用别人的说法、或者在反问，那就不用改/,"留出口才不会把本来正确的回答改错");
 assert.match(note,/可以嘴硬/);
 assert.ok(logs.some(t=>t.includes("剧情否认已纠正")&&t.includes("one-bullet-left")));
 chat.close();
});
test_("本地没有收录的剧情不会被堵死：仍然允许走 canon 的拆分通道",async()=>{
 const s=settings();s.search={apiKey:"kimi-fixture",cache:new Map()};
 s.knowledge=loadKnowledge(__dirname);s.stories=loadStories(__dirname);
 const queries=[];
 const next=scripted([
  {intent:"canon",factQuery:"ONGEKI 高瀬梨緒 星咲あかり イベント ストーリー",
   webQuery:{query:"梨绪和明里还一起做过什么"}},
  {text:"翻到几条，说是 X。",scene:"explanation",expressionIds:[],sourceIds:["S1"]},
 ]);
 const chat=createChat(s,host,{random:()=>0,
  fetchImpl:()=>next(),
  webFetchImpl:async(u,o)=>{queries.push(JSON.parse(o.body).text_query);
   return reply({search_results:[{title:"剧情一览",url:"https://wikiwiki.jp/gameongeki/1",chunks:[{text:"正文"}]}]})}});
 // 本地只认得「梨绪 + 明里」两个角色、没有可对应的事件，属于弱命中/无命中——
 // 新层不能把这种问题按死。
 const m=msg("a","<@123> 梨绪和明里还一起做过什么");await chat.handle(m);
 assert.deepEqual(queries,["ONGEKI 高瀬梨緒 星咲あかり イベント ストーリー"],"只发抽出来的客观事实子问题");
 assert.match(m.replies[0].content,/翻到几条|wikiwiki/);
 chat.close();
});
