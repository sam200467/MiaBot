"use strict";
// 等级资格校验：用户点名「当前简单的 14+」时，候选必须是**曲库里现在就有 14+ 谱面**的歌。
//
// 定数裁决层管不了这一类：社区老帖推荐过一首当时是 14+、现在已升到 15 的歌，
// 把正文里的 14.9 改成 15.2 只是让数字对上了，「它现在压根没有 14+ 的谱」没有人管。
// 分工和曲名、定数一致：Web 只提供玩家体感与攻略，**当前等级资格由本地曲库裁决**。
//
// 判定用「这首歌在该游戏里有没有那一档的谱」而不是「主谱面是不是那一档」：一首歌完全
// 可以同时有 MAS 14+ 和 ULT 15（Air 就是），按主谱面判会把这类歌误判成不合格。
// 反过来，Dengeki Tube 是 BAS 4／ADV 7+／EXP 12+／MAS 15，四张谱里一张 14+ 都没有——
// 这就是要拦下的那种老资料推荐。
const {findTitles,sentenceAround}=require("./constant-guard.cjs");
const {normalize,matchTitle,gameInText}=require("./knowledge.cjs");

// 档位：13／14／14+／15 这类。前后都不能接数字或小数点——「14.3 打 1000737 分能有多少
// rating」里的 14 是定数的整数部分，不是档位要求。
const LEVEL=/(?<![\d.])(1[0-5])\s*\+?(?![\d.])/;
// 「要一批曲子」的口气：推荐、挑几首、有没有、有哪些…
const PICK=/推荐|推薦|挑几|挑幾|选几|選幾|来几|來幾|给我几|給我幾|有没有|有沒有|有哪些|找几|找幾|几首|幾首/;
// 评价口气：简单／好打／水／吃分…单独出现也算（「简单的14+」就是在要名单）
const EVAL=/简单|簡單|容易|好打|好上手|水|吃分|上分|推分|冲分|衝分|适合|適合|新手|练习|練習/;

// 用户这一句有没有「当前档位」这个硬条件。只看最后一句：更早那句的档位要求可能已经被
// 后面的话换掉了（「算了，还是找 15 的」），拿旧的档位去要求这一轮就是误判。
function levelCondition(messages,knowledge){
  const text=String(messages.filter(m=>m.role==="user").at(-1)?.content||"").replace(/\[CQ:[^\]]*\]|<@!?\d+>/g,"");
  const level=(text.match(LEVEL)||[""])[0].replace(/\s+/g,"");
  if(!level)return null;
  const pick=PICK.test(text),evaluative=EVAL.test(text);
  if(!pick&&!evaluative)return null;
  // 句子里点了具体曲名、又没要名单的，是在问那一首（「DENGEKI Tube 是14+吗」）——
  // 那种问题里提到这首歌是应该的，不能反过来要求它必须够这一档。
  if(!pick&&knowledge&&matchTitle(knowledge,text))return null;
  // 游戏线索取最近三轮用户消息（和定数裁决层同一套）：追问常常省略游戏名
  // （「那这几首里哪个更简单」），只认当前句会把游戏丢了，跨多款收录的歌就没法判。
  const game=gameInText(messages.filter(m=>m.role==="user").slice(-3).map(m=>m.content).join(" "));
  return {level,game};
}

// 返回该游戏曲库里这首歌的全部谱面（按曲名精确匹配，规范化走曲名索引那套）。
function chartsOf(knowledge,game,title){
  const wanted=normalize(title);
  const rows=(knowledge.catalogs||{})[game]?.charts||[];
  return rows.filter(chart=>normalize(chart.title)===wanted);
}

// 正文里有没有「光写的档位」：14 算，14.5 不算（那是定数），14+ 算。
const bareLevel=(sentence,level)=>new RegExp("(?<![\\d.])"+String(level).replace(/\+/g,"\\+")+"(?![\\d.%+])").test(sentence);

// 逐首核当前显示等级。返回 [{title,game,levels,top,wanted}]，空数组＝全部合格。
// levels 是该游戏曲库里这首歌现存的**全部**档位（给纠正提示用）。
function checkLevels(knowledge,text,{level,game,aliases}={}){
  const violations=[];
  if(!knowledge||!level||typeof text!=="string"||!text)return violations;
  for(const hit of findTitles(knowledge,text,aliases)){
    const games=Object.keys(knowledge.catalogs||{}).filter(name=>chartsOf(knowledge,name,hit.title).length);
    // 游戏不明又跨多款收录：不判。挑错游戏比漏判糟得多（和裁决层同一条规矩），
    // 用户点名了游戏就只按那一款判。
    const scope=game?games.filter(name=>name===game):(games.length===1?games:[]);
    if(scope.length!==1)continue;
    const charts=chartsOf(knowledge,scope[0],hit.title);
    const levels=[...new Set(charts.map(chart=>chart.level).filter(Boolean))];
    if(!levels.length||levels.includes(level))continue;
    // 这一句自己就把真实档位写出来了（「X 的紫谱是 14，比 13 难一档」）——那是在说明，
    // 不是在推荐，别拿它去多要一轮重写。注意只认**光写的档位**：14.5 不算 14（那是定数），
    // 所以「DENGEKI Tube 15.2 挺水，推荐」照样会被拦下来。
    if(levels.some(name=>bareLevel(sentenceAround(text,hit.start),name)))continue;
    // top：定数最高的那张（曲库里 15.0 存成 15 这种整数也照算），用来写「已经升到 15」。
    const best=charts.filter(chart=>chart.constant!=null).sort((a,b)=>b.constant-a.constant)[0];
    // at/end 是正文里的位置：兜底删除（dropRecommendations）按它定位要拿掉的那一小段。
    violations.push({title:hit.title,game:scope[0],levels,top:(best||charts[charts.length-1]).level,wanted:level,at:hit.start,end:hit.end});
  }
  return violations;
}

// 交给模型的重写指令。说清三件事：哪些曲目不合格、为什么不合格、可以怎么改。
// 特别留了「如果你本来就在说明它不符合条件」这条出口——否则模型会把一句正确的
// 「它现在是15，不是14+」也删掉。
function levelNote(violations,condition,knowledge){
  const wanted=condition.level;
  const lines=violations.map(item=>"- "+item.title+"（"+item.game+"）快照里的档位："+item.levels.join("、"));
  return "【程序用"+scopeNote(knowledge,violations[0]?.game||condition.game)+"核对的结果，仅作事实；"+snapshotCaveat+"】\n"+lines.join("\n")+
    "\n上面这些曲目在这份曲库快照里**没有 "+wanted+" 的谱面**，不能作为 "+wanted+" 的推荐出现。"+
    "要么换成确实有 "+wanted+" 的曲子，要么只能明确说明它是历史资料（例如「它以前是 "+wanted+"，快照里已经是 "+violations[0].top+" 了」）。"+
    "如果你本来就是在说明它们不符合条件，那保持原样，不要改。"+
    "网页上的推荐和攻略可能是几个版本之前的，档位一律以这份快照为准；但也**不要**把快照说成国服或日服的实时收录——地区版本差异要照实说明。"+
    "请重新给出最终text，其余内容和语气照旧。";
}

// 口径：本地曲库是**快照**，不是国服/日服实时收录（三份快照的 scope 自己都写着这句）。
// 程序替模型说的话必须按这个口径来——「快照里是这样」不能讲成「国服现在就是这样」，
// 地区版本差异要留给读者判断。
function scopeNote(knowledge,game){
  const catalog=(knowledge?.catalogs||{})[game]||{};
  const when=String(catalog.updatedAt||catalog.fetchedAt||"").slice(0,10);
  return "本地曲库快照"+(when?"（"+when+"）":"");
}
// 跟着快照一起说的那句话。程序替模型写的每个句子都要带上，免得读起来像「国服现在就是这样」。
const snapshotCaveat="该快照不代表国服/日服实时收录";

// ── 兜底删除 ──────────────────────────────────────────────────────
// 重写没成功（模型没改，或那一轮调用失败）时，不能让一条不合格推荐留在正文里只靠末尾
// 纠错——先由程序把它**拿掉**。只做有把握的删除：删除范围必须能被标点切成完整的一小块，
// 块里不能还有别的曲名，也不能把整条回复删空。不做逐字抠名字：那会留下
// 「Titania 和 都能上分」这种断句，比不删更糟。
const STRONG="。！？；\n", WEAK="，,、：:";
const isDelim=ch=>STRONG.includes(ch)||WEAK.includes(ch);

// 以 `chars` 里的标点为界，取包含 [start,end) 的那一小段
function enclosing(text,start,end,chars){
  const head=text.slice(0,start);
  const left=head.replace(new RegExp("[^"+chars+"]*$"),"");
  const from=left.length;
  const cut=text.slice(end).search(new RegExp("["+chars+"]"));
  return [from,cut<0?text.length:end+cut];
}

function dropRecommendations(text,violations,{knowledge,aliases}={}){
  const dropped=[],kept=[];
  const original=String(text||"");
  if(!original||!violations?.length)return {text:original,dropped,kept};
  const hits=knowledge?findTitles(knowledge,original,aliases):[];
  const spans=[];
  for(const item of violations){
    if(item.at==null||item.end==null){kept.push(item);continue;}
    // 先试最小的一段（弱标点也当界），再退到整句；两段里都不许再出现别的曲名。
    let span=null;
    for(const chars of [WEAK+STRONG,STRONG]){
      const [from,to]=enclosing(original,item.at,item.end,chars);
      const others=hits.filter(hit=>hit.start>=from&&hit.end<=to&&!(hit.start>=item.at&&hit.end<=item.end));
      if(!others.length&&to>from){span=[from,to];break;}
    }
    if(span)spans.push({...item,from:span[0],to:span[1]});
    else kept.push(item);
  }
  // 从后往前删：前面的改动会挤歪后面记录的偏移。
  let out=original;
  for(const span of spans.sort((a,b)=>b.from-a.from)){
    const before=out.slice(0,span.from);
    // 接缝上剩下的标点跟着吃掉，免得留下「，另外…」或孤零零的「。」
    let tail=out.slice(span.to);
    while(tail&&isDelim(tail[0]))tail=tail.slice(1);
    out=before+tail;
    dropped.push(span.title);
  }
  // 删空（或只剩个把字）说明整条回复就是那条推荐：不硬删，交回原文 + 末尾说明。
  if((out.match(/[\p{L}\p{N}]/gu)||[]).length<10)return {text:original,dropped:[],kept:violations};
  return {text:out,dropped,kept};
}

module.exports={levelCondition,checkLevels,levelNote,dropRecommendations,scopeNote,snapshotCaveat};
