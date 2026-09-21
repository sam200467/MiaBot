"use strict";
// Route by the kind of evidence the task needs, not by model confidence.
// No model-generated answer is involved in this gate.
//
// 检索入口只有三条（见 SEARCH.md「检索入口」）：
//   ① 用户在话里明说要查（联网／搜索／查资料…）—— 一定查；
//   ② 攻略、手法、冲分、上分目标和难度评价 —— 这两张词表收口，直通检索；
//   ③ 模型自己承认拿不准、或答应去查 —— needsResearchRepair 替它按用户原词补一次。
// 其余一律不联网。原先那套「猜这句话算不算事实问答」的判据，以及灰区分诊器，都删掉了：
// 判据是开集，判错的方向恰好是把闲聊送去搜（「你的头像是谁画的」搜回一堆淘宝软文），
// 而漏判有 ③ 兜着 —— 它不需要事先猜对问题类型。
const {matchTitle,gameInText,normalize}=require('./knowledge.cjs');
const {findTitles}=require('./constant-guard.cjs');
// 「用户要出处」的判据在 lore 层（它要用它决定还要不要联网搜），这里共用同一份正则，
// 免得两处各写一条、日后只改一处。
const {WANTS_SOURCE}=require('./lore.cjs');
// 圈内把 Rating 目标写成「w6」「万六」：W=万，W6 就是 16000。展开成 5 位数之后
// ratingTarget 才解得出来，后面的可行性核算和最低定数才有得算。
const cnDigits={一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9};
function expandRatingAliases(text){
 return String(text).replace(/\bw\s*([1-9])\b/gi,(whole,digit)=>' '+whole+' '+(10000+Number(digit)*1000)+' ')
  .replace(/(?:万|萬)\s*([1-9一二三四五六七八九])/g,(whole,digit)=>' '+whole+' '+(10000+(cnDigits[digit]||Number(digit))*1000)+' ');
}
// 挑几首（pickRequest）和好不好打（evaluativeWords）要分开：「推荐几首13红谱」是曲库
// 按条件挑，曲库答得了；带上「好打／简单／出分」才是玩家体感问题，那种才该查。
const evaluativeWords=/出分|上分|推分|刷分|吃分|高分|涨分|漲分|rating|レート|好听|好聽|好打|好上手|好混|不吃力|轻松|輕鬆|简单|簡單|容易|值得|适合|適合|新手|菜鸡|菜雞|手残|手殘|体感|體感|难度|難度|难吗|難嗎|难不难|好难|好難|太难|太難|偏难|偏難|打不过|打不過|有(?:什么|啥)?坑|水平|评价|評價|怎么样|怎麼樣|好不好|如何/i;
const pickRequest=/推荐|推薦|挑几|挑幾|选几|選幾|哪几|哪幾|哪些|随便|隨便|都可以|来几首|來幾首|给我几首|給幾首/i;
// 工具指令：这些由宿主工具执行（查分、出图、算分），不该走检索。只有「算／计算 rating」
// 和「查成绩」这类是；「涨 rating」「上分」是评价性问题，不能混进来。
const toolIntent=/(?:查|看看|看下|看一下|拉|来|要).{0,12}(?:成绩|成績|分数|分表)|成绩图|成績圖|\bid\s*\d+|B50|b50|定数表|定數表|分数线|分數線|版本牌子|牌子|完成度|绑定|綁定|算.{0,6}rating|rating.{0,4}(?:算|计算|計算)/i;
// 曲库能直接答的查询：定数、等级、收录、数量、曲名。
const catalogAnswerable=/定数|定數|等级|等級|几级|幾級|收录|收錄|多少首|有几首|幾首|什么难度|什麼難度|曲名|歌曲名|有几张|幾張/;
// 问的要是 bot 自己（头像、画师、生日、模型…），答案在人格设定里，不在网上。
// 这条主要是给兜底网用的：模型回一句「我也不知道我头像谁画的」时，不能反手搜一遍原句。
const selfSubject=/(?:你|您|梨绪|梨緒|takase)/i;
const selfTopic=/(?:头像|頭像|头图|立绘|立繪|皮套|画师|畫師|谁画的|誰畫的|模型|生日|年龄|年齡|身高|声优|聲優|名字|昵称|暱稱|称呼|设定|設定|人设|人設|性格|爱好|愛好|喜欢什么|喜歡什麼|性别)/;
// 曲库和宿主工具自己答得了的问题，一律不联网。顺序要紧：工具指令必须挡在检索之前，
// 因为检索回合会把工具清单从提示词里拿掉，误判成检索会让那一次查分直接失效。
function localCanAnswer(text){
 if(toolIntent.test(text))return '工具指令';
 if(catalogAnswerable.test(text))return '曲库可答';
 if(pickRequest.test(text)&&!evaluativeWords.test(text))return '曲库筛选';
 return '';
}
// 去掉口语开头和句尾标点，留下可以当检索词的部分。用户请求检索时说的那些话术
// （「帮我联网搜索一下」）本身不是关键词，留在里面会一起发给搜索引擎。
const plainQuery=text=>String(text).replace(/^(?:宝宝|宝贝|梨绪|梨緒|请|麻烦|帮我|给我|教我玩|教我打)[，,：:\s]*/g,'').replace(/[？?！!]+$/,'').trim();
const requestWords=/帮我|麻烦|请|联网|上网|搜一下|搜一搜|搜索一下|搜索|查一下|查资料|查阅|核实|查证|找一下/g;
const scrubQuery=query=>String(query).replace(/sk-[\w-]+|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\b\d{7,}\b/gi,'[已省略]');
// 群里 @ 会在正文里留下 CQ 码和 @ 标记，它们不是用户说的话，判据和检索词都要先剥掉。
const CQ_STRIP=/\[CQ:[^\]]*\]|<@!?\d+>/g;
const latestUserText=messages=>String(messages.filter(m=>m.role==='user').at(-1)?.content||'').replace(CQ_STRIP,'').trim();
function researchPlanCore(messages,knowledge){
 const users=messages.filter(m=>m.role==='user');
 const raw=String(users.at(-1)?.content||'').trim();
 const text=raw.replace(CQ_STRIP,'').trim();
 if(/(?:不要|不用|别|不许).{0,5}(?:联网|搜索|上网)/.test(text))return {required:false,optOut:true};
 if(!text||/^(?:你好|您好|hi|hello|晚安|早安|谢谢|謝謝|哈哈|嗯嗯|好的|好哒|辛苦了|清空对话|重置对话)[!！。～~\s]*$/i.test(text))return {required:false};
 const explicit=/联网|上网|搜一下|搜一搜|搜索|查资料|查阅|核实|查证|帮我搜|搜搜|找.{0,12}(?:攻略|视频|手元)/.test(text);
 if(!explicit&&/夸夸|夸我|安慰我|陪我聊|庆祝一下|庆祝下/.test(text))return {required:false};
 // 自述放在 explicit 之后：用户明说「搜一下我头像谁画的」仍然照办。
 if(!explicit&&!matchTitle(knowledge,text)&&selfSubject.test(text)&&selfTopic.test(text))return {required:false,decided:'人设自述'};
 const strategy=/吃分|上分|推分|冲分|衝分|升段|水谱|水譜|诈称|詐稱|地雷|体感|體感|手法|攻略|运指|運指|手元|怎么打|怎麼打|怎么练|怎麼練|怎么过|如何.{0,6}(?:打|练|过)|教我(?:玩|打)|适合.{0,8}(?:练|上分|冲|鳥|鸟)|(?:上|冲|衝).{0,5}(?:w\d|万[六五四三]|\d{4,5})/i.test(text);
 // 「有没有简单一点的13+」问的是玩家评价，只按定数排序挑歌正好是曲库 caveat 禁止的事，
 // 所以要检索。但「简单」单独出现多半是寒暄（简单介绍一下你自己），必须同时出现谱面、
 // 等级或游戏词才算这一类难度评价问题。
 const easyHardWords=/简单|簡單|容易|好打|好上手|好混|偏难|偏難|太难|太難|很难|很難|好难|好難|不太难|适合.{0,6}(?:新手|入门|入門)/i;
 const chartWords=/谱面|譜面|红谱|紅譜|紫谱|紫譜|黄谱|黃譜|绿谱|綠譜|EXPERT|MASTER|定数|定數|难度|難度|\d{1,2}\s*\+|\d{1,2}\s*级|音击|音擊|ongeki|中二|chunithm|舞萌|maimai/i;
 // 命中曲库里的真曲名也算「谱面词」：提了具体曲子又问好不好打，本来就该查玩家评价。
 const easyHardCharts=easyHardWords.test(text)&&(chartWords.test(text)||Boolean(matchTitle(knowledge,text)));
 // 时效性问题（版本、更新、新曲、活动）本地曲库不记，只有外部资料有。判据收得很窄：
 // 既要有**时效词**、又真的在问（什么/哪些/有没有/？），而且不是工具指令、也不是曲库
 // 答得了的数量与定数。砍掉的那套判据问的是「这句话算不算事实问答」（开集，判错的方向
 // 恰好是把闲聊送去搜）；这一条问的是「它问的东西有没有时效性」，闭集词、且必须同时
 // 是个问句——模型漏标 intent 时靠它兜住「现实事实/时效自动联网」。
 const temporal=/版本|更新|新曲|追加|实装|實裝|活动|活動|最新|近日|本月|本周|新增|调整|調整|维护|維護|アップデート|ver\.?\s*\d/i;
 const asking=/[?？]|什么|什麼|哪些|哪几|哪幾|有没有|有沒有|什么时候|什麼時候|怎么样|怎麼樣|多少|咋样/;
 const temporalAsk=!localCanAnswer(text)&&temporal.test(text)&&asking.test(text);
 let reason=explicit?'用户要求查证':strategy?'攻略或进度目标需要外部依据':easyHardCharts?'难度评价需要玩家体感依据':temporalAsk?'时效信息需要外部依据':'';
 // Follow-up ellipses keep the original target instead of searching an
 // assistant's previous (possibly hallucinated) spelling.
 if(!reason&&/^(?:这首|那首|这个|那个|它|再找|说具体|详细|详细点|nyx|你说错|不是这首)/i.test(text)){
  const previous=users.slice(0,-1).reverse().find(m=>researchPlanCore([m],knowledge).required);
  if(previous)return {...researchPlanCore([previous],knowledge),reason:'查证原问题的追问'};
 }
 // 没命中就按不联网处理，模型拿不准时由 needsResearchRepair 兜。
 if(!reason)return {required:false,decided:localCanAnswer(text)||'默认不联网'};
 let query=plainQuery(text).replace(requestWords,' ').replace(/\s+/g,' ').trim();
 let sites,recoveryQuery,recoverySites;
 const entityMatch=text.match(/(?:教我(?:玩|打)|讲解|讲讲|介绍一下)\s*([a-z][a-z0-9 ._:'’!?-]*)/i);
 const entity=entityMatch?.[1]?.replace(/[?!]+$/,'').trim();
 // 最近三轮里出现过舞萌就算舞萌语境：追问常常省略游戏名，而 B50 这套算式只对舞萌成立。
 const maimaiContext=/舞萌|maimai/i.test(users.slice(-3).map(m=>String(m.content)).join(' '));
 // These are search expansions, not evidence for a rating claim.
 query=expandRatingAliases(query);
 const ratingTarget=query.match(/(?:上|冲|衝|Rating|rating).{0,8}?(1\d{4})/);
 if(strategy&&maimaiContext&&ratingTarget){
  recoveryQuery=query;
  query='maimai '+ratingTarget[1]+' おすすめ';
  sites=['note.com','gamerch.com','hatenablog.com'];
 }
 if(entity)query=entity+' 音游 曲目 谱面';
 else if(/教我(?:玩|打)|怎么打|怎麼打/.test(text))query+=' 攻略 譜面 手元';
 // 「简单的13+」这类问题要找的是玩家评价和谱面清单，把「有没有一些」这种口语原句
 // 直接发给搜索引擎命中率低，按游戏名+等级重建检索词。已经按 Rating 目标重写过查询的
 // 不在此列：那条查询带着目标数字，比这里重建的更准。
 if(easyHardCharts&&!recoveryQuery){
  const game=/舞萌|maimai/i.test(text)?'舞萌 maimai':/音击|音擊|ongeki/i.test(text)?'音击 ongeki':/中二|chunithm/i.test(text)?'中二 chunithm':'';
  const level=(text.match(/(?:1[0-5])\s*\+?/)||[''])[0].replace(/\s+/g,'');
  if(game||level)query=[game,level,'简单 好打 谱面 推荐'].filter(Boolean).join(' ');
 }
 if(!/音击|音擊|オンゲキ|中二|chunithm|舞萌|maimai|lanota/i.test(query)){
  const previous=users.slice(0,-1).reverse().map(m=>String(m.content).match(/音击|音擊|オンゲキ|中二|chunithm|舞萌|maimai|lanota/i)).find(Boolean);
  if(previous)query=previous[0]+' '+query;
 }
 // 入戏/假设从句先切掉，再洗凭据：剩下的才是可以发出去的事实那半句。
 // 切完什么都不剩，说明这一句只有入戏成分——那就不该按规则表预检索
 // （模型仍可按意图请求，走拆分通道）。
 const factOnly=factClauses(query).trim();
 if(!factOnly)return {required:false,decided:'只有入戏/假设成分，没有可检索的事实'};
 query=factOnly;
 // A question containing credentials is never sent to a public search service.
 query=scrubQuery(query);
 return {required:true,reason,query:query.slice(0,220),entity,ratingTarget:ratingTarget?Number(ratingTarget[1]):null,maimaiContext,sites,recoveryQuery,recoverySites,kind:/视频|手元/.test(text)&&!/攻略|怎么|教我|手法/.test(text)?'video':'article',original:text.slice(0,300)};
}
// ── 剧情问题分类（第十四组）──────────────────────────────────────────
// 这里**只回答「这是不是一个原作剧情问题」**，不负责找具体事件。
// 「真人CS」「サバゲー」这类具体事件关键词属于知识库的 aliases/keywords 数据（见
// knowledge/ongeki-story.json），匹配由 lore.cjs 的索引做。往这条正则里加事件名，等于
// 把词表搬进代码——永远加不完；数据可以。
// 它的用处只有一个：模型把「你和明里打过真人CS吗」只标成 self 时，程序仍认得这是剧情
// 问题，于是允许它走 canon 的拆分通道（见 authorizeWeb 的 loreQuestion）。
const LORE_TOPIC=/(?:剧情|劇情|主线|主線|故事|桥段|橋段|情节|情節|章节|章節|第[0-9一二三四五六七八九十]+章|活动|活動|登场|登場|出场|出場|回忆|回憶)/;
const LORE_EVENT=/(?:做过什么|做過什麼|做过啥|发生过什么|發生過什麼|发生过|發生過|干过什么|幹過什麼|干了什么|幹了什麼|干了啥|一起去|一同去|一起打|一起玩|一起干|有过什么|有過什麼)/;
function loreClassify(text){
 const body=String(text||'');
 if(!body)return null;
 if(LORE_TOPIC.test(body)||LORE_EVENT.test(body))
  return {isLoreQuestion:true,wantsSource:WANTS_SOURCE.test(body)};
 return null;
}
// 对外的 researchPlan：核心规则表 + 一层剧情分类。分类是**叠加**的，不改 required /
// decided——本地命中与否由 chat.cjs 用 lore.cjs 的索引查，这里不做事件匹配。
function researchPlan(messages,knowledge){
 const plan=researchPlanCore(messages,knowledge);
 const lore=loreClassify(latestUserText(messages));
 return lore?{...plan,lore}:plan;
}
// 一句话里有没有「可以拿去搜的主题」。补检索要挑有主题的那句当检索词：用户连问两轮之后
// 常来一句纯请求（「你帮我查一下看看」），拿它去搜只会拿到垃圾；中间还可能夹着别人的
// 闲聊或刷屏（线上实测：「梨绪梨绪梨绪梨绪」——按字符数挑正好会挑中它）。所以只认真正的
// 主题信号：游戏名、谱面类词、拉丁词（曲名多半是），以及本地曲库里的真曲名。
const subjectSignals=/(?:音击|音擊|オンゲキ|ongeki|中二|chunithm|舞萌|maimai|lanota|谱面|譜面|定数|定數|难度|難度|等级|等級|\d{1,2}\s*\+|[a-z]{3,})/i;
function hasSubject(text,knowledge){
 const t=String(text||'');
 return subjectSignals.test(t)||Boolean(matchTitle(knowledge,t));
}
function ratingEvidence(plan){
 // 这套算式是舞萌专属：套到别的游戏的目标上就是编依据，不如不给。
 if(!plan.ratingTarget||!plan.maimaiContext)return null;
 const rows=Array.from({length:36},(_,i)=>{const tenth=120+i;return {constant:tenth/10,sssPlusRating:Math.floor(tenth*1005*224/100000)};});
 const average=plan.ratingTarget/50;
 // 每一格的贡献上限都必须够到平均分，主力谱才可能把目标拉起来。
 const floor=rows.find(r=>r.sssPlusRating>=average);
 return {id:'R1',title:'舞萌DX Rating目标核算（规则核对于2026-09-17）',url:'https://gamerch.com/maimai/533647',kind:'article',evidence:'curated-rule',content:JSON.stringify({scope:'Splash PLUS以后B50框架；地区版本新旧曲归属须另核实',target:plan.ratingTarget,slots:50,average,minConstant:floor?floor.constant:null,formula:'SSS+上限贡献=floor(定数×1.005×22.4)，高于100.5%不再增加',rows,note:'只用于目标可行性核算，不证明哪张谱面好打。minConstant 是「SSS+上限刚好够到每格平均贡献」的定数，也就是本目标的推荐下限：主力谱面逐首写清定数并确认不低于它；定数低于 minConstant 的谱就算打出 SSS+ 也贡献不到平均分，最多列 1 至 2 首并明确标成过渡或练习，不能当主力凑数。来源里其他玩家的曲单反映的是他们各自的水平阶段，必须逐首按定数过一遍，不能照搬。'+(floor?'':'表内最高定数也够不到这个目标，须另行核实目标是否可行。')})};
}
const researchRule='\n检索回答要求：先核对用户的原始曲名、游戏、难度和目标，保留曲名原拼写，不把不认识的词改成近似熟词。不认识的曲目不要凭印象猜它是哪款游戏或什么难度，直接说明没听过或不确定就行；有多个真实候选再问必要问题。官方收录优先，不把自制谱/Fanmade/同人搬运混成同等候选。若证据主要指向一款游戏，明确说明按该游戏讨论并先给可用信息，不反复追问；用户未提音击，不要突然声称不是音击曲。攻略和冲分推荐不能用按定数排序的曲库候选代替。Rating目标先核实术语、计分规则和达到目标需要的单曲成绩，再据攻略推荐；不要擅自给目标套13+或某颜色难度，程序给出最低定数时以它为准。带目标的推荐逐首核对谱面定数，主力必须是上限够到平均分的那批，不够的只能标成过渡。有据可查的推荐直接给3至5个名字和简短理由，只有需要个人成绩才能个性化的部分才说明限制。区分来源明确写出的谱面特点、玩家主观评价和你提出的一般练习建议。只有曲目资料时不能据BPM/物量推导具体配置或难点。若只有视频/摘要没有正文，且仍有联网额度，必须再查正文：可用webQuery.sites指定wikiwiki.jp、gamerch.com、note.com等合适站点，或读取真实文章URL，不要同义重复搜索。找不到手法攻略则明确证据不足，可以附视频标题链接。外部事实必须选择实际支持结论的sourceIds；搜索命中不是结论正确的保证。直接给有根据的回答，不用反复追问代替检索，不添加“打不好别怪我”等推责台词。'+
 // 定数口径：下面这三行是从本地曲库的 level/constant 分布量出来的，不是记忆里的说法。
 // 少了它，模型会自己编一条档位规则（实测把中二的「14+」说成 14.0~14.9，那是舞萌的切法）。
 '\n定数口径：显示等级是定数所在的一档。中二：14＝14.0~14.4、14+＝14.5~14.9、15＝15.0~15.4；舞萌：14＝14.0~14.5、14+＝14.6~14.9；音击：14＝14.0~14.6、14+＝14.7~14.9。'+
 '要在回答里写某首谱的定数，就必须先用 knowledgeQuery 查过那一首，只报曲库给出的数字；社区帖子、攻略和视频里的定数可能停留在几个版本之前（中二在 VERSE 版本调整过一批），只能当体感参考，不能当当前定数。'+
 // 等级资格：老资料推荐的是「当时」的档位。定数写对了也不等于这首歌还在这份名单里——
 // 用户要的是「当前的14+」，一首已经升到15的歌不该出现在里面，只能当历史资料说明。
 '用户点名了当前档位（「当前简单的14+」「有没有14+水谱」）时，推荐的每一首都要用 knowledgeQuery 核过它**现在**有没有那一档的谱面；社区帖子推荐过、但现在已经升档的（比如以前是14+、现在是15），不能当推荐，最多说明它是历史资料。'+
 '确实要提旧值时必须写明那是旧数据，否则会被当成现状。';
// 模型「拿不准」或「答应去查」的话术：它说了却没能真查（或只查了本地曲库），程序就
// 替它按用户原词查一次网。不收「不知道」——群里「我不知道你在说什么」太常见，
// 收了会把闲聊也送进检索。
// 「拿不准」和「答应去查」的话术。**两种口气都要收**：线上实测模型说的是「好的，那我
// 帮你翻翻看」，而这里原先只有「我去翻」——"我去…"和"我帮你…"是同一个承诺的两种说法，
// 漏了后一种就等于承诺了却没人查（用户看到的是「我帮你翻翻看」然后什么都没有）。
const uncertainty=/不确定|不肯定|没听过|沒聽過|没见过|沒見過|不认识|不認識|不认得|查不到|搜不到|需要查|查阅|核实|查证|先查|查清楚|确认一下|確認一下|我去查|我去翻|我去找|让我查|帮你翻|帮你查|帮你搜|翻翻看|查查看|查一查|去翻|去查|去搜|没有实时|沒有即時|我这边没有|我這邊沒有|没法确认|沒法確認|无法确认|無法確認|不能凭印象|手头没有|哪个游戏|哪個遊戲|哪一版|你说的是哪个|没把握|沒把握|拿不准|说不上|不敢凭印象|不敢乱(?:说|报|编|猜)|不敢瞎(?:说|编|报)|给不了准确|给不出准确|没法给准确|不能确定|没法确定|无法确定|不能判断|没法判断|无法判断|不好判断|说不好|没查到|沒查到|没搜到|沒搜到/;
function needsResearchRepair(result,plan,webCalls,messages){
 // 本地剧情库已经答得上的轮次也被豁免：模型见资料齐全仍说了句「我不确定」时，不能反手
 // 把它送进搜索——那既费额度，又可能搜回比本地条目更差的来源（与人设自述的豁免同思路）。
 if(plan.optOut||plan.decided==='人设自述'||plan.lore?.localAnswered||plan.profiles?.localAnswered||plan.terms?.localAnswered||webCalls||result?.webQuery)return false;
 if(plan.required)return true;
 const current=messages.filter(m=>m.role==='user').at(-1)?.content||'';
 return !result?.knowledgeQuery&&!result?.action&&uncertainty.test(result?.text||'')&&/[a-z一-鿿]/i.test(current)&&!/你(?:是谁|叫什么)|绑定|账号|密码|你猜|我是谁/.test(current);
}
// ── 结果为空时的重写（第十二组）──────────────────────────────────────
// 不换同义词——同义词换不来新结果。用**已经认出来的东西**重建一句：游戏名（优先日文原名，
// 日文社区的同人攻略最多）、正式曲名（曲名索引认出来的那个；别名解析过的写法走到这里
// 已经是正式曲名了）、问题类型（攻略／定数／评价／冲分各配一个日文词），再带上等级或
// Rating 目标。重建不出和原来明显不同的一句就返回 null：同一句话再搜一次纯属浪费额度。
const gameTerms={chunithm:{jp:'CHUNITHM'},maimai:{jp:'maimai'},ongeki:{jp:'オンゲキ'}};
const typeTail=[
 [/怎么打|怎麼打|怎么练|怎麼練|手法|运指|運指|教我|攻略|手元|手順/, '攻略 譜面 手元'],
 [/定数|定數|等级|等級|レベル/, '定数'],
 [/吃分|上分|推分|冲分|衝分|推荐|推薦|おすすめ|适合|適合/, 'おすすめ 譜面'],
 [/水|简单|簡單|好打|评价|評價|体感|體感|难不难|難不難|怎么样|怎麼樣/, '評価 感想 難易度'],
];
function rewriteQuery({query,plan,knowledge,game}={}){
 const text=String(query||plan?.original||'').trim();
 if(!text)return null;
 const title=knowledge?(findTitles(knowledge,text)[0]?.title||''):'';
 // 游戏名：对话里点名的优先；没点名就看这首曲子在曲库里只收录在哪一款——只收录一款
 // 就直接用那款的名字。多款收录又不点名时不猜（重建出来的检索词宁可少一个词）。
 const only=title&&knowledge?Object.entries(knowledge.catalogs||{}).filter(([,catalog])=>(catalog.charts||[]).some(chart=>normalize(chart.title)===normalize(title))).map(([name])=>name):[];
 const name=gameTerms[game]||gameTerms[gameInText(text)]||gameTerms[only.length===1?only[0]:''];
 const level=(text.match(/(?<![\d.])(1[0-5])\s*\+?(?![\d.])/)||[''])[0].replace(/\s+/g,'');
 const target=plan?.ratingTarget?String(plan.ratingTarget):'';
 const source=text+' '+(plan?.original||'')+' '+(plan?.reason||'');
 const tail=(typeTail.find(([re])=>re.test(source))||[,'攻略 譜面'])[1];
 // 曲名、等级、目标一个都没有，就没有可重建的锚点，别硬凑一句发出去。
 // 曲库外的新曲（「教我玩 X」里 X 本地没有）用 plan.entity——那是用户/模型给的写法，
 // 换日文检索词时它仍然是唯一能抓的东西。
 const anchor=title||target||level||String(plan?.entity||'').trim();
 if(!anchor)return null;
 const rebuilt=[name?.jp||'',anchor,tail].filter(Boolean).join(' ').replace(/\s+/g,' ').trim();
 if(!rebuilt||rebuilt===text)return null;
 // 视频检索词为空时改用文章检索：要看的是正文，不是标题列表。
 return {query:rebuilt,kind:plan?.kind==='video'?'article':(plan?.kind||'article')};
}
// ── 意图 → 授权（第十三组）──────────────────────────────────────────
// 理解语言交给模型（它标 intent、把可验证的外部事实抽成 factQuery），管权限留在程序：
// 这里只对**枚举值**做映射，永远不匹配用户原句。未知取值与缺失一律按拒绝处理，模型
// 编不出一个能通过授权的意图。
// 这一层解决的是「现实事实/时效问题没人自动去查」：规则表（攻略/体感词表）收得住的是
// 攻略类问法，而「CHUNITHM 最新版本是什么」这种既没有攻略词、又本地答不了的问题，
// 以前只能靠模型说一句「拿不准」触发兜底网。现在它可以直接请求，由策略表决定给不给。
// spike 实测（33 条用例、真实模型 + 桩网页）：现实/时效 5 条全部自动联网、模糊 3 条
// 全部不搜、玩梗/创作/假设 3 条全部不搜、闲聊误联网 0、被否后谎称网络故障 0。
const INTENT_POLICY={
 explicit:{web:true,note:"用户明确要求联网"},
 research:{web:true,note:"现实事实、时效信息、资料研究与攻略体感"},
 canon:{web:true,note:"原作剧情事实：本地剧情库优先，缺失或只有弱命中才联网"},
 local:{web:false,note:"本地曲库能直接答的事实"},
 tool:{web:false,note:"功能指令（查分/牌子/绑定），联网会挤掉工具"},
 self:{web:false,note:"人设自述：头像、画师、生日、模型、设定"},
 roleplay:{web:false,note:"入戏、玩梗、创作、假设性问题"},
 chitchat:{web:false,note:"寒暄闲聊"},
};
// 假设语气：带它的句子没有可验证的外部事实。只判**抽出来的事实子问题**，不判用户原句——
// 「会不会有比较水的14+」原句带假设语气，但它问的是真实存在的曲目。
const HYPOTHETICAL=/如果|假如|假设|假設|要是|万一|萬一|会不会|會不會|会怎么样|會怎樣/;
// 自指说法 + 人设属性词同时出现才算（闭集名词，不是语言分类）。用户问「你」就是人设互动；
// 换成「梨绪的画师是谁」是第三方视角的客观问题，该放行。用户原句也要一起看：模型把
// 「你是谁画的」改写成一条干净的第三方 query 之后，只查 query 是抓不住它的（实测漏过）。
const SELF_REF=/(?:你|您|你自己|本梨绪|本梨緒).{0,6}(?:模型|生日|年龄|年齡|性别|性格|喜好|喜欢|喜歡|设定|設定|人设|人設|本体|本體|昵称|暱稱|名字|画师|畫師|谁画的|誰畫的)|你是不是|你是真的/;
// 用户原句里的入戏/假设从句不进检索词。用户当初的要求原话：角色扮演句里夹着独立的
// 现实事实问题时，**只检索那个子问题**。判据取交集，宁可少切：既有假设语气**又**提到
// 角色（或者在问 bot 自己）才算入戏从句。单纯一句「会不会有比较水的14+」问的是真实
// 存在的曲目，不能切掉。
const ROLE_PERSONA=/梨绪|梨緒|takase|高瀬|高濑/i;
function factClauses(text){
 const parts=String(text||'').split(/[。！？；\n]+|—{2,}/).map(part=>part.trim()).filter(Boolean);
 const kept=parts.filter(part=>!((HYPOTHETICAL.test(part)&&ROLE_PERSONA.test(part))||SELF_REF.test(part)));
 return kept.length===parts.length?String(text||''):kept.join(' ');
}
// canon 的客观查询**必然**含角色名（「ONGEKI 高瀬梨緒 サバゲー ストーリー」），所以
// 不能套 SELF_REF——那条会把含「梨绪」的查询一律拒掉，等于这条通道白开。放宽只放到
// 「第三人称角色名」为止：第一/二人称仍然拒绝，那还是人设互动，不是可验证的原作事实。
// 中文没有词边界：「我」后面跟的本来就是汉字，按 [^Han] 判边界等于永远匹配不上，这条
// 规则会形同虚设。所以直接收代词本身——宁可拒掉含「你」的曲名，也不能漏掉第一人称。
const FIRST_SECOND_PERSON=/我|你|您|咱|俺/;
function canonQueryCheck(factQuery,userText){
 const q=String(factQuery||"").replace(/\s+/g," ").trim();
 const strip=s=>s.replace(/[\s，,。.！!？?、~～]/g,"");
 if(q.length<2||q.length>120)return "事实子问题为空或过长";
 if(strip(q)===strip(String(userText||""))||strip(userText).includes(strip(q)))return "没拆开：这就是用户原句";
 if(HYPOTHETICAL.test(q))return "带假设语气，没有可验证的外部事实";
 if(FIRST_SECOND_PERSON.test(q))return "事实子问题里是第一/二人称，这不是可验证的原作事实查询";
 return "";
}
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
// 授权结果：{granted,query,split,source} 或 {granted:false,reason,intents}
// 三条来源按优先级：① 入戏/人设只能走拆分通道 ② 程序已判定要检索（规则表/兜底网）
// ③ 模型自己请求，且意图是 research/explicit。其余一律拒绝。
function authorizeWeb({intents,factQuery,webQuery,userText,programGranted,loreLocal,profilesLocal,loreQuestion}={}){
 const list=(Array.isArray(intents)?intents:[intents]).map(v=>String(v??"").trim()).filter(Boolean);
 // 程序认出是剧情问题时，把 canon 当成一个**实际生效**的意图加进去：否则模型只标了
 // self、而 self 的 web 是 false，后面按意图表查白名单时会一路落到「拒绝」。
 const effective=loreQuestion&&!list.includes("canon")?[...list,"canon"]:list;
 const known=effective.filter(name=>INTENT_POLICY[name]);
 // 走 canon 通道的两种情况：模型自己标了 canon，或者程序认出这是剧情问题（loreQuestion）。
 // 后者是给模型漏标兜底的——「你和明里打过真人CS吗」它常常只标 self，
 // 而只标 self 时含角色名的事实子问题会被 SELF_REF 全拒，这条通道就白开了。
 // 安全性由 canonQueryCheck 兜：只放行第三人称的客观查询，用户原句永远不会发出去。
 const canon=list.includes("canon")||Boolean(loreQuestion);
 // hardish 只对**纯**入戏/人设生效。
 const hardish=(list.includes("roleplay")||list.includes("self"))&&!canon;
 const fact=String(factQuery||"").trim();
 const factFail=fact?(canon?canonQueryCheck:factQueryCheck)(fact,userText):"";
 const useFact=Boolean(fact)&&!factFail;
 if(hardish){
  if(useFact)return {granted:true,query:fact,split:true,source:"拆分通道"};
  return {granted:false,reason:factFail||INTENT_POLICY.roleplay.note,intents:list,factFail};
 }
 // 本地剧情库已确认这一条，且这一轮**没有别的联网理由** → 不联网。
 // 「别的理由」必须单独判：一句话里既问剧情又问最新版本时，一律拦掉会把版本那半截憋死。
 const otherWeb=known.some(name=>name!=="canon"&&INTENT_POLICY[name]?.web);
 if(loreLocal?.localAnswered&&!otherWeb)
  return {granted:false,reason:loreLocal.note||"本地剧情库已有确认条目，直接按资料作答即可",intents:list,localLore:true};
 // 角色档案同理。走的是同一个 otherWeb 逃生口：一句里既问「小星是个什么样的人」又问
 // 「她最近出了什么新卡」时，拦掉会把后半个问题憋死，那不是本层要的效果。
 if(profilesLocal?.localAnswered&&!otherWeb)
  return {granted:false,reason:profilesLocal.note||"本地已有该角色的档案，直接按资料作答即可",intents:list,localProfile:true};
 // 查询为空就不算授权：放行一条空查询会让调用方拿着空串去搜（url 那条路除外，
 // 读网页时 query 本来就是空的）。
 const pick=()=>(useFact?fact:String(webQuery?.query||webQuery?.url||"")).trim();
 const allow=source=>{const query=pick();return query?{granted:true,query,split:useFact,source}
  :{granted:false,reason:"没有可执行的事实子问题或检索词",intents:list,factFail:factFail||"事实子问题为空"};};
 if(programGranted)return allow("程序判定");
 // 白名单**查表**，不要写成语面量。这里原先写的是 known.includes("research")||known.includes("explicit")：
 // 于是在 INTENT_POLICY 里加一个 {web:true} 的新意图时，INTENT_RULE 的取值列表会自动带上它
 // （取值是 Object.keys 生成的），闸门却不放行——加 canon 时踩到的就是这个坑。
 if(known.some(name=>INTENT_POLICY[name]?.web))return allow("意图授权");
 return {granted:false,reason:known.length?INTENT_POLICY[known[0]].note:"意图缺失或未知，按拒绝处理",intents:list,factFail};
}
// 被拒绝之后给模型的纠正话术。**必须说明是「未授权」而不是「没连上」**——说成网络故障
// 等于替程序撒一个它自己都不知道的谎（spike 专门量过这一条，0 次）。
function webDeniedNote({reason,intents,factFail,localLore,localProfile}={}){
 // 本地剧情库拦下的那条不是「不允许查」，是「不用查」——纠正话术要说得不一样，
 // 否则模型会以为自己在被拒绝，转而给用户编一句「查不到」。
 if(localLore)return "【程序未授权联网】本地剧情库里已经有确认的条目，足够回答这一句了。请直接按上面注入的剧情资料作答，"+
  "不要为了显得严谨再去检索。用户明说要来源时，引用条目里已经给出的 sources 即可。";
 // 档案层同理。这里还要额外堵一句「我不认识她」——模型手里有资料时仍然这么说的代价最大。
 if(localProfile)return "【程序未授权联网】本地角色档案里已经有这个角色的资料，足够回答这一句了。请直接按上面注入的档案作答，"+
  "**不要说你不认识这个人、也不要反问有没有这个人**；档案里没写到的部分直说不太清楚即可，不要为了显得严谨再去检索。"+
  "用户明说要来源时，引用条目里已经给出的 sources 即可。";
 const label=(intents||[]).join("+")||"意图缺失";
 const why=factFail?("你给的事实子问题不合格："+factFail):("这一句的意图是「"+label+"」，按策略不联网。");
 return "【程序未授权联网】"+why+
  "请把这一句里**可验证的外部事实**单独抽成 factQuery 重新提交（只写那个事实，不要照抄用户原句）；"+
  "如果确实没有可验证的外部事实（纯人设互动、虚构假设、玩梗创作，或本地曲库/工具就能答），"+
  "就不要给 webQuery，直接回答，也不要声称已经查过或正在查。程序只执行 factQuery，角色扮演那部分永远不会发出去。";
}
const INTENT_RULE="\n意图标注：每次回复都必须在JSON里给出 intent。可以是一个字符串，也可以是一个数组——"+
 "一句话里同时存在多种意图时就都标上（例：{\"intent\":[\"roleplay\",\"research\"]}），不要为了省事只挑一个。"+
 "取值只能是："+JSON.stringify(Object.keys(INTENT_POLICY))+"。"+
 "explicit＝用户这一句里明确要求联网查；research＝现实事实、时效性、资料研究、攻略体感这类需要外部依据的问题；"+
 "canon＝原作剧情事实（你和谁做过什么、某角色和某角色之间发生过什么、某章或某个活动剧情是什么、某角色在哪些剧情登场）；"+
 "local＝本地曲库能直接答；tool＝查成绩/牌子/绑定这类功能指令；self＝问你自己（头像、画师、生日、模型、设定）；"+
 "roleplay＝入戏、玩梗、创作、假设性问题；chitchat＝寒暄闲聊。"+
 "注意 canon 与 self 的分别：「你之前是不是和明里打过真人CS」问的是**原作里发生过的事**，是 canon，不是 self——"+
 "self 指的是头像、画师、生日、模型这类设定问题。这种句子可以同时标 self 和 canon，但 canon 一定要标上。"+
 "\n事实子问题：每次回复还必须给出 factQuery 字段——把这一句话里**可验证的外部事实**单独抽出来，没有就填空字符串。"+
 "只要句子里存在现实的事实问题，哪怕它包在玩笑、入戏或假设里，也必须抽出来；不要照抄用户原句。"+
 "例：「帮我查一下电管现在的定数——顺便，如果梨绪去打这首歌会怎么样？」→ intent 是 [\"roleplay\",\"research\"]，factQuery 只写「CHUNITHM 电管 定数」。"+
 "例：「你和明里打过真人CS吗」→ intent 含 canon；程序会先查本地剧情库，**本地有就直接用**，这时不要给 webQuery。"+
 "只有本地没有、或你看到注入的资料标着 trust:inferred 时，才把客观事实抽成 factQuery（例：「ONGEKI 高瀬梨緒 サバゲー ストーリー」）——"+
 "用第三人称写，不要写「你」，也不要把整句角色扮演发出去。"+
 "例：「帮我联网搜一下你是不是真的梨绪」→ 没有可验证的外部事实，factQuery 留空字符串。"+
 "程序按 intent 授权联网、只执行 factQuery：入戏、玩梗、创作、假设、问你自己这几类永远不联网，"+
 "所以你不必为了安全而放弃句子里那个真实的事实问题，也不要为了搜而搜。"+
 "程序预检索已经查过的事情不要再换词搜一遍（额度有限）；只有第一次结果明显答非所问时才改写关键词重查。"+
 "被否决时不要声称已经查过或正在查，也不要把「我这就去翻」写进 text。";
module.exports={researchPlan,researchPlanCore,researchRule,needsResearchRepair,ratingEvidence,hasSubject,rewriteQuery,
 INTENT_POLICY,INTENT_RULE,authorizeWeb,webDeniedNote,factQueryCheck,canonQueryCheck,loreClassify};
