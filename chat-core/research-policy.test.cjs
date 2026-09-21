"use strict";
const test=require('node:test'),assert=require('node:assert/strict');
const {researchPlan,ratingEvidence}=require('./research-policy.cjs');
const {requestReply}=require('./chat.cjs');
const {videoUrl,searchPage,runWeb,loadSearch}=require('./search.cjs');
const msg=content=>[{role:'user',content}];
const settings=()=>({search:{apiKey:'kimi-fixture'},persona:'test',examples:[],manifest:{entries:[]},c:{provider:{model:'test',timeoutMs:10000,baseUrl:'https://api.deepseek.com',endpoint:'/chat/completions',apiKey:'deepseek-fixture'},limits:{maxReplyChars:600}}});
const response=data=>({ok:true,text:async()=>JSON.stringify(data),json:async()=>data});
test('strategy and unfamiliar entity requests research before model confidence matters',()=>{
 const w=researchPlan(msg('有没有舞萌上w6的吃分推荐？'));
 assert.equal(w.required,true);assert.match(w.query,/16000/);assert.ok(w.sites.includes('note.com'));assert.ok(!w.query.includes('13+'));
 assert.equal(w.ratingTarget,16000);
 // 圈内也写「万六」「W5」：目标解不出来就接不到后面的可行性核算。
 assert.equal(researchPlan(msg('有没有舞萌上万六的吃分推荐')).ratingTarget,16000);
 assert.equal(researchPlan(msg('舞萌上W5怎么练')).ratingTarget,15000);
 assert.match(researchPlan(msg('舞萌上万六的吃分推荐')).query,/16000/);
 const p=researchPlan(msg('教我玩inorganyx prayer'));assert.equal(p.required,true);assert.match(p.query,/inorganyx prayer/);assert.doesNotMatch(p.query,/inorganic/i);
 // 用户请求里的「帮我联网搜索一下」是话术，不是检索词：留着会一起发给搜索引擎
 const asked=researchPlan(msg('帮我联网搜索一下 inorganyx prayer 是什么'));
 assert.equal(asked.required,true);assert.match(asked.query,/inorganyx prayer/);assert.doesNotMatch(asked.query,/联网|搜索/);
 // 攻略／手法／难度评价直通检索；其余归兜底网或直接不查
 for(const q of ['怎么练交互','音击13红谱好打吗'])assert.equal(researchPlan(msg(q)).required,true,q);
 for(const q of ['你好','夸夸我，我上w6啦','推荐三首音击13红谱','帮我查id870成绩','不用联网，简单聊聊'])assert.equal(researchPlan(msg(q)).required,false,q);
});
test('web happens before a confident wrong model answer can be generated',async()=>{
 const order=[];
 const r=await requestReply(settings(),msg('有没有舞萌上w6的吃分推荐？'),{
  webFetchImpl:async(u,o)=>{order.push('web');assert.match(JSON.parse(o.body).text_query,/16000/);return response({search_results:[{title:'玩家16000达成记录',url:'https://note.com/player/n/example',chunks:[{text:'14.3 SSS+ 321; Trick tear 14.4'}]}]});},
  fetchImpl:async(u,o)=>{order.push('model');assert.ok(JSON.parse(o.body).messages.some(m=>m.content.includes('Trick tear')));return response({choices:[{message:{content:JSON.stringify({text:'依据玩家达成记录选择目标谱面。',sourceIds:['S1']})}}]});}
 });
 assert.deepEqual(order,['web','model']);assert.equal(r.research.webCalls,1);assert.match(r.text,/note.com/);
});
test('uncertainty triggers search with original entity; personal account guard stays ahead',async()=>{
 let models=0,webs=0;
 const r=await requestReply(settings(),msg('想了解Zyphren'),{
  fetchImpl:async()=>response({choices:[{message:{content:JSON.stringify(++models===1?{text:'不确定你说的是哪个游戏'}:{text:'找到了资料',sourceIds:['S1']})}}]}),
  webFetchImpl:async(u,o)=>{webs++;assert.match(JSON.parse(o.body).text_query,/Zyphren/);return response({search_results:[{title:'Zyphren',url:'https://example.com/zyphren',chunks:[{text:'资料'}]}]});}
 });
 assert.equal(webs,1);assert.equal(r.research.sourceCount,1);
 await requestReply(settings(),msg('推荐我没鸟过的12+'),{webFetchImpl:()=>{throw Error('private data must not reach web')},fetchImpl:()=>{throw Error('must not generate')}});
});
test('missing configuration is explicit and cannot masquerade as search success',async()=>{
 const s=settings();s.search={error:'unavailable'};
 const r=await requestReply(s,msg('教我玩inorganyx prayer'),{fetchImpl:()=>{throw Error('must not bluff')}});
 assert.match(r.text,/配置读取失败/);assert.equal(r.research.status,'unavailable');
});
test('Bilibili articles retain text; aggregate search pages are excluded',async()=>{
 assert.equal(videoUrl('https://www.bilibili.com/read/cv123'),false);
 assert.equal(videoUrl('https://www.bilibili.com/opus/123'),false);
 assert.equal(videoUrl('https://www.bilibili.com/video/BV123'),true);
 assert.equal(searchPage('https://search.bilibili.com/all?keyword=foo'),true);
 const r=await runWeb({apiKey:'fixture'},{query:'谱面攻略'}, {fetchImpl:async()=>response({search_results:[
  {title:'search',url:'https://search.bilibili.com/all?keyword=foo',chunks:[{text:'误导聚合页'}]},
  {title:'文字攻略',url:'https://www.bilibili.com/read/cv123',chunks:[{text:'经过核实的文章正文'}]}
 ]})});
 assert.equal(r.sources.length,1);assert.equal(r.sources[0].content,'经过核实的文章正文');
});
test('no evidence means no fabricated tutorial even if model tries',async()=>{
 const r=await requestReply(settings(),msg('教我玩某首陌生曲'),{
  webFetchImpl:async()=>response({search_results:[]}),
  fetchImpl:async()=>response({choices:[{message:{content:JSON.stringify({text:'它有很难的交互和纵连'})}}]})
 });
 assert.match(r.text,/没有拿到/);assert.doesNotMatch(r.text,/很难的交互/);
});
test('rating math distinguishes practice charts from charts that can reach the target',()=>{
 const data=JSON.parse(ratingEvidence(researchPlan(msg('舞萌上w6的吃分推荐'))).content);
 assert.equal(data.average,320);
 assert.equal(data.rows.find(r=>r.constant===13.9).sssPlusRating,312);
 assert.equal(data.rows.find(r=>r.constant===14.3).sssPlusRating,321);
 assert.equal(data.rows.find(r=>r.constant===14.4).sssPlusRating,324);
 assert.ok(data.rows.find(r=>r.constant===13.9).sssPlusRating*50<16000);
 // 主力下限：只有上限够到每格平均分的定数才可能把目标拉起来
 assert.equal(data.minConstant,14.3);
 assert.ok(data.rows.find(r=>r.constant===14.2).sssPlusRating<data.average,'14.2 上限低于平均，不能当主力');
 assert.match(data.note,/过渡/);
 // 舞萌专属算式不能套到别家游戏的 Rating 目标上
 assert.equal(ratingEvidence(researchPlan(msg('中二上w6的吃分推荐'))),null);
});
test('难度评价类问法要检索玩家体感，寒暄和纯曲库筛选不受影响',()=>{
 const simple=researchPlan(msg('舞萌有没有一些比较简单一点的13+'));
 assert.equal(simple.required,true);
 assert.match(simple.query,/maimai/);assert.match(simple.query,/13\+/);assert.match(simple.query,/简单/);
 for(const q of ['音击13红谱好打吗','舞萌有没有很难的14'])assert.equal(researchPlan(msg(q)).required,true,q);
 // 只出现「简单」而没有谱面、等级或游戏词的句子是寒暄，不能因为一个形容词就去查网
 for(const q of ['简单聊聊吧','简单点说','夸夸我，我上w6啦'])assert.equal(researchPlan(msg(q)).required,false,q);
});
// ── 检索入口：用户请求 + 攻略档 + 兜底 ────────────────────────────────
const {loadKnowledge}=require('./knowledge.cjs');
test('检索入口只剩用户请求和攻略档，自述和闲聊一律不联网',()=>{
 const k=loadKnowledge(__dirname);
 const plan=(text,history=[])=>researchPlan([...history.map(c=>({role:'user',content:c})),{role:'user',content:text}],k);
 // 用户明说要查
 for(const text of ['帮我联网搜索一下 inorganyx prayer 是什么','inorganyx prayer 帮我搜一下','查资料确认下这首歌是哪款游戏的'])
  assert.equal(plan(text).required,true,text);
 // 问 bot 自己的事：答案在人格设定里，网上搜不到，也不该搜
 for(const text of ['宝宝你知道吗，你的头像是谁画的','你的头像谁画的','你的模型是什么'])
  assert.equal(plan(text).decided,'人设自述',text);
 // 曲库自己答得了的、由程序执行的指令、以及其余闲聊，一律不联网
 for(const [text,decided] of [['这首的定数是多少','曲库可答'],['舞萌一共有多少首歌','曲库可答'],
  ['推荐三首音击13红谱','曲库筛选'],['给我挑几首14.5','曲库筛选'],
  ['帮我看看这首的定数表','工具指令'],['帮我查一下 id870 的成绩','工具指令'],['舞萌帮我查下我的成绩','工具指令'],
  ['今天好累','默认不联网'],['晚饭吃什么','默认不联网'],['你会不会打inorganyx prayer?','默认不联网'],
  ['你是在说音击里的，还是中二那边的？','默认不联网']]){
  const p=plan(text);assert.equal(p.required,false,text);assert.equal(p.decided,decided,text);
 }
});
test('模型说拿不准时按用户原词补一次联网，查空则保留它自己的答复',async()=>{
 const queries=[],notices=[];let calls=0;
 const r=await requestReply(settings(),msg('你会不会打inorganyx prayer?'),{
  // 中间步骤静默：即使宿主把慢提示的钩子接上了，没超过阈值也不发。
  // 联网次数改从 r.research.webCalls 看，不再拿提示当「查过了」的探针。
  slowNotice:async()=>{notices.push(1)},slowNoticeAfterMs:0,
  webFetchImpl:async(u,o)=>{queries.push(JSON.parse(o.body).text_query);return response({search_results:[]})},
  fetchImpl:async()=>response({choices:[{message:{content:JSON.stringify(++calls===1
   ?{text:'这个名字我可得先查清楚是哪里的谱面，不确定。'}
   :{text:'我印象里这是别的游戏的曲子。'})}}]})
 });
 assert.equal(queries.length,1);assert.match(queries[0],/inorganyx prayer/i);
 assert.equal(notices.length,0);                 // 不再发「我去翻资料」
 assert.equal(r.research.webCalls,1);
 assert.equal(calls,2);                          // 只有两次模型调用，没有分诊这类额外请求
 assert.equal(r.research.status,'empty');
 assert.match(r.research.reason,/拿不准/);        // 日志里看得出这一查是兜底补的
 assert.match(r.text,/别的游戏/);                 // soft：查空不覆盖模型自己那句「不确定」
});
// 线上那次的完整形状：问一句 →（中间夹着刷屏/别人的话）→ 一句纯请求 → 模型答应去查却没动。
const transcript=[
 {role:'user',content:'CHUNITHM 现在最新版本是什么？'},
 {role:'user',content:'梨绪梨绪梨绪梨绪梨绪梨绪梨绪梨绪'},
 {role:'user',content:'你帮我查一下看看'},
];
test('模型答应了去查却没动：补检索要挑有主题的那句，不能挑到中间那句刷屏',async()=>{
 const queries=[];
 const r=await requestReply(settings(),transcript,{
  webFetchImpl:async(u,o)=>{queries.push(JSON.parse(o.body).text_query);return response({search_results:[]})},
  fetchImpl:async()=>response({choices:[{message:{content:JSON.stringify({text:'好，那我去帮你翻翻看，稍等一下。'})}}]}),
 });
 assert.equal(queries.length,1,'答应了去查就得真查一次');
 assert.match(queries[0],/chunithm/i,'要用有主题的那句当检索词');
 assert.doesNotMatch(queries[0],/梨绪|你帮我查一下看看/,'「梨绪梨绪…」和纯请求句都不能当检索词');
 assert.match(r.research.reason,/拿不准/);
});

test('模型说「我这边没有实时版本信息」也是拿不准，同样补一次',async()=>{
 const queries=[];
 await requestReply(settings(),[transcript[0]],{
  webFetchImpl:async(u,o)=>{queries.push(JSON.parse(o.body).text_query);return response({search_results:[]})},
  fetchImpl:async()=>response({choices:[{message:{content:JSON.stringify({text:'中二的最新版本我这边没有实时版本信息，不能凭印象乱报。想查的话我可以帮你找找看。'})}}]}),
 });
 assert.equal(queries.length,1);
 assert.match(queries[0],/chunithm/i);
});

test('曲库查空之后模型说查不到，仍能补一次联网',async()=>{
 const queries=[];let calls=0;
 const r=await requestReply(settings(),msg('inorganyx prayer 是什么曲子'),{
  slowNotice:async()=>{},slowNoticeAfterMs:0,
  webFetchImpl:async(u,o)=>{queries.push(JSON.parse(o.body).text_query);
   return response({search_results:[{title:'Inorganyx Prayer',url:'https://example.com/i',chunks:[{text:'Lanota 收录曲'}]}]})},
  fetchImpl:async()=>response({choices:[{message:{content:JSON.stringify(++calls===1
   ?{knowledgeQuery:{title:'inorganyx prayer'}}
   :{text:'曲库里没有这首，我不确定它属于哪款游戏。'})}}]})
 });
 assert.equal(queries.length,1);assert.match(queries[0],/inorganyx prayer/i);
 assert.equal(r.research.status,'retrieved');
});
test('自述问题即使模型说不知道也不联网',async()=>{
 const r=await requestReply(settings(),msg('宝宝你知道吗，你的头像是谁画的'),{
  webFetchImpl:()=>{throw Error('自述问题不该联网')},
  fetchImpl:async()=>response({choices:[{message:{content:JSON.stringify({text:'我也不知道我头像谁画的诶。',emotion:'neutral',scene:'ordinary',expressionIds:[]})}}]})
 });
 assert.match(r.text,/头像/);assert.equal(r.research.status,'not-needed');assert.equal(r.research.webCalls,0);
});
test('闲聊只有一次模型调用，不联网也不发分诊',async()=>{
 let calls=0;
 const r=await requestReply(settings(),msg('今天好累'),{
  webFetchImpl:()=>{throw Error('must not search')},
  fetchImpl:async()=>{calls++;return response({choices:[{message:{content:JSON.stringify({text:'那就歇会儿嘛。',emotion:'neutral',scene:'ordinary',expressionIds:[]})}}]})}
 });
 assert.equal(calls,1);assert.equal(r.research.status,'not-needed');assert.equal(r.research.webCalls,0);
});
test('中间步骤静默，只有整条回复超过慢阈值才补一条状态提示',async()=>{
 // 阈值为 0（默认）：联网也不发任何中间消息
 const notices=[];
 const r=await requestReply(settings(),msg('有没有舞萌上w6的吃分推荐？'),{
  slowNotice:async()=>{notices.push(1)},slowNoticeAfterMs:0,
  webFetchImpl:async()=>response({search_results:[{title:'16000达成记录',url:'https://note.com/player/n/example',chunks:[{text:'14.4 SSS+'}]}]}),
  fetchImpl:async()=>response({choices:[{message:{content:JSON.stringify({text:'按资料里定数够线的谱面选。',sourceIds:['S1']})}}]})
 });
 assert.equal(notices.length,0);assert.equal(r.research.webCalls,1);
 // 阈值极小、且模型那一轮已经先花掉了时间：这时才补一条，且整条回复最多一条。
 // 注意这里走的是「模型自己发起检索」，不是程序预检索——预检索发生在任何模型调用
 // 之前（elapsed≈0），永远够不到阈值，所以慢提示只可能出现在后续那几次联网前。
 const slow=[];let round=0;
 const sr=await requestReply(settings(),msg('今天好累'),{
  slowNotice:async()=>{slow.push(1)},slowNoticeAfterMs:1,
  webFetchImpl:async()=>response({search_results:[{title:'16000达成记录',url:'https://note.com/player/n/example',chunks:[{text:'14.4 SSS+'}]}]}),
  fetchImpl:async()=>{await new Promise(done=>setTimeout(done,25));
   return response({choices:[{message:{content:JSON.stringify(++round===1?{intent:'research',factQuery:'舞萌 上w6 吃分推荐',webQuery:{query:'舞萌 上w6 吃分'}}:{text:'按资料里定数够线的谱面选。',sourceIds:['S1']})}}]})}
 });
 assert.equal(slow.length,1);assert.equal(sr.research.webCalls,1);
 // 用户明确要求不联网的那一轮不发
 const quiet=[];let calls=0;
 const off=await requestReply(settings(),msg('不用联网，聊聊怎么练音游'),{
  slowNotice:async()=>{quiet.push(1)},slowNoticeAfterMs:1,
  webFetchImpl:()=>{throw Error('network must not be used')},
  fetchImpl:async()=>response({choices:[{message:{content:JSON.stringify(++calls===1?{webQuery:{query:'练习音游'}}:{text:'可以先聊通用练习思路。'})}}]})
 });
 assert.equal(off.research.webCalls,0);assert.equal(quiet.length,0);
});
test('decimal constants are verified against the catalog instead of mistaken for display levels',()=>{
 const {lookup}=require('./knowledge.cjs');
 const k={catalogs:{maimai:{source:'fixture',charts:[{title:'A',difficulty:'MAS',level:'14',constant:14.3},{title:'B',difficulty:'MAS',level:'14',constant:14.4}]}}};
 assert.deepEqual(lookup(k,{game:'maimai',level:'14.3'}).charts.map(c=>c.title),['A']);
 assert.equal(lookup(k,{game:'maimai',level:'14'}).total,2);
});
test('explicit no-web preference prevents a model-requested search',async()=>{
 let calls=0;
 const r=await requestReply(settings(),msg('不用联网，聊聊怎么练音游'),{
  webFetchImpl:()=>{throw Error('network must not be used')},
  fetchImpl:async()=>response({choices:[{message:{content:JSON.stringify(++calls===1?{webQuery:{query:'练习音游'}}:{text:'可以先聊通用练习思路。'})}}]})
 });
 assert.equal(r.research.webCalls,0);
});
// ── 结果为空时重建检索词（第十二组）────────────────────────────────────
test('结果为空时用认出来的信息重建检索词，不是换同义词',()=>{
 const {rewriteQuery}=require('./research-policy.cjs');
 const k=loadKnowledge(__dirname);
 // 游戏名（日文原名）+ 正式曲名 + 问题类型，各出一份力
 const fight=rewriteQuery({query:'中二的 Dengeki Tube 怎么打',knowledge:k});
 assert.match(fight.query,/CHUNITHM/);
 assert.match(fight.query,/Dengeki Tube/);
 assert.match(fight.query,/攻略/);
 // 对话里没点游戏名：这首曲子在曲库里只收录在中二，就用它
 assert.match(rewriteQuery({query:'你会不会打 Dengeki Tube?',knowledge:k}).query,/^CHUNITHM /);
 // Rating 目标：已经解析出来的数字，比任何同义词都硬
 assert.equal(rewriteQuery({query:'舞萌上W6的吃分推荐',plan:{ratingTarget:16000},knowledge:k}).query,'maimai 16000 おすすめ 譜面');
 // 曲库外的新曲只能用 entity 当锚点，而且视频检索词换成文章——要看的是正文
 const outside=rewriteQuery({query:'教我玩 inorganyx prayer',plan:{entity:'inorganyx prayer',kind:'video'},knowledge:k});
 assert.match(outside.query,/inorganyx prayer/);
 assert.equal(outside.kind,'article');
 // 没有锚点（曲名、等级、目标、entity 都没有）就不重建
 assert.equal(rewriteQuery({query:'这个游戏好玩吗',knowledge:k}),null);
 // 重建出来和原句一样等于没重建：同一句话再搜一次纯属浪费额度
 assert.equal(rewriteQuery({query:'CHUNITHM Dengeki Tube 攻略 譜面 手元',knowledge:k}),null);
});

// ── 意图 → 授权（第十三组）────────────────────────────────────────────
test('意图→授权：现实事实放行，入戏/人设/闲聊/未知一律拒绝',()=>{
 const {authorizeWeb,INTENT_POLICY}=require('./research-policy.cjs');
 // 现实事实与时效：模型标 research（或用户明说要查的 explicit）就放行
 for(const intent of ['research','explicit'])
  assert.equal(authorizeWeb({intents:intent,webQuery:{query:'CHUNITHM 最新版本'}}).granted,true,intent);
 // 闲聊／本地曲库／工具指令：不联网
 for(const intent of ['chitchat','local','tool'])
  assert.equal(authorizeWeb({intents:intent,webQuery:{query:'x'}}).granted,false,intent);
 // 未知取值与缺失一律按拒绝处理：模型编不出一个能通过授权的意图
 assert.equal(authorizeWeb({intents:'nonsense',webQuery:{query:'x'}}).granted,false);
 assert.equal(authorizeWeb({intents:undefined,webQuery:{query:'x'}}).granted,false);
 assert.equal(authorizeWeb({webQuery:{query:'x'}}).granted,false);
 // 入戏／人设：能不能搜只看 factQuery 合不合格，不看它给自己标了什么
 const deny=authorizeWeb({intents:['roleplay'],webQuery:{query:'如果梨绪去打会怎样'}});
 assert.equal(deny.granted,false);
 assert.equal(authorizeWeb({intents:['self'],webQuery:{query:'你是谁画的'}}).granted,false);
 // 程序自己判定的检索（规则表预检索、兜底网）不受意图策略影响
 assert.equal(authorizeWeb({intents:'chitchat',webQuery:{query:'x'},programGranted:true}).granted,true);
 assert.ok(Object.keys(INTENT_POLICY).includes('research'));
});
test('事实子问题的三项形式检查：没拆开、带假设、问你自己都算不合格',()=>{
 const {factQueryCheck}=require('./research-policy.cjs');
 const user='帮我联网查一下电管现在的定数——顺便，如果梨绪去打这首歌会怎么样？';
 assert.equal(factQueryCheck('CHUNITHM 电管 定数',user),'');
 assert.match(factQueryCheck(user,user),/没拆开/);
 assert.match(factQueryCheck('如果梨绪去打会怎么样','随便问问'),/假设/);
 assert.match(factQueryCheck('梨绪的资料','梨绪你喜欢什么'),/人设自述/);
 assert.match(factQueryCheck('CHUNITHM 最新版本','你的模型是什么'),/人设自述/,"用户原句在问你自己，改写过的 query 也不行");
 assert.match(factQueryCheck('',user),/为空/);
});
test('时效性问题自动联网：模型漏标 intent 时靠这条规则兜住',()=>{
 const k=loadKnowledge(__dirname);
 for(const text of ['音击最近有什么新活动','CHUNITHM 现在最新版本是什么','新版本有什么改动','这个版本的水谱有哪些'])
  assert.equal(researchPlan(msg(text),k).required,true,text);
 // 但曲库答得了的、以及不是问句的，一样不查：规则表不能把本地事实送去搜
 for(const text of ['中二节奏 Dengeki Tube 现在的定数是多少','中二一共有多少首歌','这个版本我打不过','你今天心情怎么样','我最近在练13+，有什么建议'])
  assert.equal(researchPlan(msg(text),k).required,false,text);
});
test('程序侧的预检索词也先切掉入戏/假设从句',()=>{
 const {researchPlan}=require('./research-policy.cjs');
 const user='帮我联网查一下电管现在的定数——顺便，如果梨绪去打这首歌会怎么样？';
 const plan=researchPlan(msg(user));
 assert.equal(plan.required,true);
 assert.match(plan.query,/电管/);
 assert.doesNotMatch(plan.query,/梨绪|如果|会怎么样/,"角色扮演那半句不能进检索词");
 // 第三方视角的客观问题不算入戏：该搜
 assert.equal(researchPlan(msg('帮我联网搜一下梨绪的画师是谁')).required,true);
 // 整句都是入戏/假设，没有可检索的事实：不预检索（模型仍可按意图请求）
 for(const text of ['帮我联网查一下你是不是真的梨绪','如果梨绪去打中二节奏会怎么样'])
  assert.equal(researchPlan(msg(text)).required,false,text);
});

// ── 原作剧情（canon）：意图、授权与本地优先（第十四组）─────────────────
test('canon 意图真的能拿到联网授权（白名单必须查表，不能是字面量）',()=>{
 const {authorizeWeb,INTENT_POLICY}=require('./research-policy.cjs');
 // 回归：白名单以前写死成 known.includes("research")||known.includes("explicit")。
 // 那样一来，往 INTENT_POLICY 里加一个 {web:true} 的新意图时，提示词的取值列表会自动
 // 带上它（取值由 Object.keys 生成），闸门却不放行——加 canon 时踩到的就是这个坑。
 assert.equal(INTENT_POLICY.canon.web,true);
 const granted=authorizeWeb({intents:['canon'],factQuery:'ONGEKI 高瀬梨緒 星咲あかり サバゲー ストーリー',userText:'你和明里打过真人CS吗'});
 assert.equal(granted.granted,true);
 assert.equal(granted.split,true,"canon 走的也是拆分通道：只发客观那半句");
 assert.equal(granted.query,'ONGEKI 高瀬梨緒 星咲あかり サバゲー ストーリー');
 // 每一个声明 web:true 的意图都必须真的放行，否则就是同一个坑的复发
 for(const [name,policy] of Object.entries(INTENT_POLICY))
  if(policy.web)assert.equal(authorizeWeb({intents:[name],webQuery:{query:'x'}}).granted,true,name);
});
test('canon 的事实子问题放宽到第三人称角色名，第一/二人称仍然拒绝',()=>{
 const {authorizeWeb,canonQueryCheck}=require('./research-policy.cjs');
 const user='你和明里打过真人CS吗';
 // 客观查询必然含角色名，所以不能套 SELF_REF（那条会把含「梨绪」的查询一律拒掉）
 assert.equal(canonQueryCheck('ONGEKI 高瀬梨緒 サバゲー',user),'');
 assert.match(canonQueryCheck('我之前和明里打过真人CS','随便'),/第一\/二人称/);
 assert.match(canonQueryCheck('你为什么和明里打真人CS','随便'),/第一\/二人称/);
 assert.match(canonQueryCheck(user,user),/没拆开/);
 assert.match(canonQueryCheck('如果梨绪去打真人CS','随便'),/假设/);
 assert.match(canonQueryCheck('','随便'),/为空/);
 assert.equal(authorizeWeb({intents:['canon'],factQuery:'我之前和明里打过真人CS吗',userText:user}).granted,false);
});
test('模型漏标 canon 时，程序侧的剧情分类把它兜回意图白名单',()=>{
 const {authorizeWeb}=require('./research-policy.cjs');
 const base={intents:['self'],factQuery:'ONGEKI 高瀬梨緒 星咲あかり サバゲー',userText:'你和明里打过真人CS吗'};
 // 只标 self 时这一轮落在硬否决分支里：能过是因为这句话的 userText 不含人设属性词，
 // SELF_REF 没命中。走的是「拆分通道」。
 const hardish=authorizeWeb(base);
 assert.equal(hardish.granted,true);
 assert.equal(hardish.source,'拆分通道');
 // 程序认出这是剧情问题时，canon 被当成一个**实际生效**的意图加进白名单，
 // 于是这一轮不再靠硬否决的例外放行，而是正常按意图授权。
 const relaxed=authorizeWeb({...base,intents:['self'],loreQuestion:true});
 assert.equal(relaxed.granted,true);
 assert.equal(relaxed.source,'意图授权');
 // 放宽的只是「谁是剧情问题」这一层，查询本身的形式检查一条都没松，反而更严：
 // canon 检查器明确拒绝第一/二人称，而 self 那条（factQueryCheck 的 SELF_REF）里
 // 压根没有「我」——它只防人设名词（画师、生日、模型…），所以第一人称查询在那边是放行的。
 const {canonQueryCheck,factQueryCheck}=require('./research-policy.cjs');
 assert.match(canonQueryCheck('我之前和明里打过真人CS','x'),/第一\/二人称/);
 assert.equal(factQueryCheck('我之前和明里打过真人CS','x'),'');
 assert.equal(authorizeWeb({intents:['canon'],factQuery:'我之前和明里打过真人CS',userText:'你和明里说过什么'}).granted,false);
});
test('本地已确认的剧情不重复联网，但同一句还有别的联网理由时照常放行',()=>{
 const {authorizeWeb}=require('./research-policy.cjs');
 const loreLocal={localAnswered:true,note:'本地已确认'};
 const only=authorizeWeb({intents:['canon'],userText:'你和明里打过真人CS吗',loreLocal});
 assert.equal(only.granted,false,"本地够答就不该再去搜一遍");
 assert.equal(only.localLore,true);
 // 同一句里还问了最新版本：拦掉会把版本那半截憋死
 const mixed=authorizeWeb({intents:['canon','research'],webQuery:{query:'音击 最新版本'},userText:'你和明里打过真人CS吗？顺便最新版本是啥',loreLocal});
 assert.equal(mixed.granted,true);
 // 查询为空不算授权：放行空串会让调用方拿着空查询去搜
 assert.equal(authorizeWeb({intents:['canon'],userText:'x'}).granted,false);
 // 读网页那条路 query 本来就是空的，靠 url 放行
 assert.equal(authorizeWeb({intents:['research'],webQuery:{url:'https://example.com/a'}}).granted,true);
});
test('本地已有角色档案时不重复联网，但同一句还有别的联网理由时照常放行',()=>{
 const {authorizeWeb}=require('./research-policy.cjs');
 const profilesLocal={localAnswered:true,note:'本地已有该角色的档案'};
 const only=authorizeWeb({intents:['canon'],factQuery:'ONGEKI 井之原小星 性格',userText:'小星是个什么样的人',profilesLocal});
 assert.equal(only.granted,false,"本地够答就不该再去搜一遍");
 assert.equal(only.localProfile,true);
 assert.match(only.reason,/本地已有该角色的档案/);
 // 同一句里还问了新卡：拦掉会把那半截憋死（与剧情层的 otherWeb 逃生口同一条）
 const mixed=authorizeWeb({intents:['canon','research'],webQuery:{query:'音击 小星 新卡'},
   userText:'小星是个什么样的人？顺便她最近出了什么新卡',profilesLocal});
 assert.equal(mixed.granted,true);
 // 本地没答上（没命中档案）时不该拦
 assert.equal(authorizeWeb({intents:['canon'],factQuery:'ONGEKI 井之原小星 性格',
   userText:'小星是个什么样的人',profilesLocal:{localAnswered:false}}).granted,true);
});
test('本地档案已作答的轮次不会再被兜底网按原句搜一遍',()=>{
 const {needsResearchRepair}=require('./research-policy.cjs');
 const result={text:'我不认识井之原小星这个人。'};
 // 模型手里有档案却说了「不认识」——搜索治不了这个，纠正话术才治得了
 const messages=[{role:'user',content:'小星是谁'}];
 assert.equal(needsResearchRepair(result,{profiles:{localAnswered:true}},0,messages),false);
 assert.equal(needsResearchRepair(result,{},0,messages),true,
   "没有本地档案兜着时，这句话仍然该触发一次兜底检索");
});
test('剧情分类只看结构，不认具体事件名',()=>{
 const {loreClassify}=require('./research-policy.cjs');
 // 事件关键词属于知识库的 aliases/keywords 数据，不属于正则。往这里加事件名等于把
 // 词表搬进代码，永远加不完——所以单独的「真人CS」「サバゲー」不该被认出来。
 for(const text of ['真人CS','サバゲー','生存游戏','ONE BULLET LEFT'])
  assert.equal(loreClassify(text),null,'事件名不该写进正则：'+text);
 for(const text of ['第4章讲了什么','你和明里当时干过什么','圣诞夜的活动剧情是什么'])
  assert.equal(loreClassify(text)?.isLoreQuestion,true,text);
 // 用户要来源这件事由 lore 层的 WANTS_SOURCE 判，和分类彼此独立：分类不中也不影响
 // 「引用条目自带 factSources」那条路（本地命中本来就不看分类）。
 assert.equal(loreClassify('你们打真人CS那事给我个来源'),null);
 assert.equal(loreClassify('圣诞夜那个活动剧情给我个来源').wantsSource,true);
 for(const text of ['音击13红谱推荐','今天天气怎么样','帮我查B50'])
  assert.equal(loreClassify(text),null,text);
});

test('Windows key reader survives an inherited incompatible PowerShell module path',{skip:process.platform!=='win32'},()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'mia-key-test-'));
 const key='offline-fixture-key';
 const env={...process.env};for(const n of Object.keys(env))if(n.toLowerCase()==='psmodulepath')delete env[n];
 const protectedKey=execFileSync('powershell.exe',['-NoProfile','-Command',"ConvertTo-SecureString 'offline-fixture-key' -AsPlainText -Force | ConvertFrom-SecureString"],{encoding:'utf8',env,windowsHide:true}).trim();
 fs.copyFileSync(path.join(__dirname,'search-key.ps1'),path.join(root,'search-key.ps1'));
 fs.writeFileSync(path.join(root,'search.local.json'),JSON.stringify({enabled:true,schemaVersion:1,apiKeyProtected:protectedKey}));
 const old=process.env.PSModulePath;
 try{process.env.PSModulePath=path.join(root,'missing-pwsh7-modules');assert.equal(loadSearch(root).apiKey,key);}
 finally{if(old===undefined)delete process.env.PSModulePath;else process.env.PSModulePath=old;fs.unlinkSync(path.join(root,'search.local.json'));fs.unlinkSync(path.join(root,'search-key.ps1'));fs.rmdirSync(root);}
});
