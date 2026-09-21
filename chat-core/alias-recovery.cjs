"use strict";
// 昵称恢复与候选别名的落盘门槛 —— 「正式 alias 前置解析 → 本地曲库 → Agent 恢复」
// 三级结构里的第三级。前两级在别处：宿主侧的 `resolveAliasTitle`（复用 SongAliasStore
// 的同一套解析规则）把用户词换成正式曲名，再交给这里的 `lookup` 查本地曲库。
// 只有两级都没命中，才会走到这个文件里的事情。
//
// 程序在这条路上只做两件它擅长的事：把**能在本地曲库里验证到**的名字挑出来、
// 把不该记的东西挡掉。「这个词是不是那首歌的昵称」是语言判断，交给模型。
const {findTitles}=require("./constant-guard.cjs");
const {lookup,gameInText,normalize}=require("./knowledge.cjs");

// 曲库查空之后给模型的分岔提示。三种走法按代价从低到高排：可能是游戏猜错了（不花钱）、
// 可能是昵称（联网查，或者它本来就知道）、也可能压根不存在（说不确定）。
function recoveryHint(word){
  const text=String(word||"").trim();
  return "\n【程序提示】曲库按"+(text?"「"+text+"」":"这个写法")+"没有匹配。按顺序试："+
    "① 游戏是不是猜错了，换一个 game 再查，不要默认某个游戏；"+
    "② 如果这是玩家的叫法、昵称或者拼写有出入，用 webQuery 查它到底是哪首曲，或者直接给出你知道的正式曲名——"+
    '格式 {"aliasGuess":{"title":"你认为的正式曲名","why":"依据"}}；'+
    "③ 都没有，就直说不确定，别硬凑一个名字。"+
    "程序会拿你给的名字回曲库验证，验证不过不采用。"+
    "提到中文简称时用圈内通用写法，不要自创（例如 Dengeki Tube 写作「电管」）。";
}

// 哪些游戏收录了这个曲名。用来做消歧提示，以及在没有游戏线索时决定去哪儿查。
// 按曲名规范化后比较：三份快照来自同一个上游，但大小写与标点未必逐字一致。
function gamesWithTitle(knowledge,title){
  const wanted=normalize(title);
  if(!wanted)return [];
  const games=[];
  for(const [game,catalog] of Object.entries(knowledge?.catalogs||{})){
    if((catalog.charts||[]).some((chart)=>normalize(chart&&chart.title)===wanted))games.push(game);
  }
  return games;
}

// 联网**检索词**里出现的曲库真曲名 → 立刻回本地库核一遍。零额外模型轮次，是昵称
// 恢复的主力：模型一旦把「电管」搜成了 Dengeki Tube，这一刻就被接住了。
// 只认检索词，不认资料来源正文——正文里顺带提到一堆曲名，全去核一遍等于把额度随机
// 花掉：实测它把「电管」那条核成了正文里先出现的 Love & Justice，真正要问的那首
// 反而没核到，模型还拿到一条不相干的数据。
//
// 返回值刻意分成两个数组，**结构上就不可能把提示当事实用**：
//   facts —— 该作用域内查到的当前数据，可以当事实喂给模型
//   hints —— 只在「用户点名了游戏、而这款里没有这首」时出现：别的游戏有同名曲，
//            但那最多说明用户说的可能是另一首歌，**不带任何定数**。
// 之所以这么分：Love & Justice 在音击是 MAS 14.7、在中二是 MAS 15.2，用户问音击却
// 拿中二的定数去答，就是跨游戏污染的入口。只有用户压根没提游戏时，曲名索引记的那款
// 才可以直接当恢复线索用。
function recheckFromQuery(knowledge,query,game){
  const facts=[],hints=[];
  for(const hit of findTitles(knowledge,String(query||""))){
    if(game){
      const data=lookup(knowledge,{game,title:hit.title});
      const charts=Array.isArray(data.charts)?data.charts:[];
      if(charts.length){facts.push({title:hit.title,game,charts});continue;}
      const elsewhere=gamesWithTitle(knowledge,hit.title).filter((name)=>name!==game);
      if(elsewhere.length)hints.push({title:hit.title,game:elsewhere[0],
        note:"「"+hit.title+"」在 "+elsewhere.join("、")+" 有收录，但你问的是 "+game+"，可能不是同一首歌；不要拿别款游戏的定数当它的数据。"});
      continue;
    }
    // 没有游戏线索：索引记的那款可以当恢复线索，名字是曲库里真实存在的。
    const data=lookup(knowledge,{game:hit.game,title:hit.title});
    const charts=Array.isArray(data.charts)?data.charts:[];
    if(charts.length)facts.push({title:hit.title,game:hit.game,charts});
  }
  return {facts,hints};
}

// 联网检索词里的中文简称换成正式曲名。搜索引擎不认得「电管」，但认得 Dengeki Tube——
// 纯字符串替换，零成本、零额外轮次，而且让紧接着的自动核对（recheckFromQuery）接得住：
// 换过之后的检索词里有曲库真曲名，回本地库核一遍那一步才会命中。
// entries 是宿主给的正式别名表（SongAliasStore.titleIndex），里面**已经没有歧义别名**
// ——一个叫法落到两首歌的整条被丢掉了，所以这里不会替错。作用域按对话里点名的游戏过滤：
// 音击专属的别名不该在聊中二时被替换。
function applyAliases(query,entries,game){
  let out=String(query||"");
  const applied=[];
  const usable=(entries||[]).filter(item=>item&&item.alias&&item.title&&(!item.game||!game||item.game===game));
  // 长的先替：短别名可能是长别名的一部分
  for(const item of usable.slice().sort((a,b)=>String(b.alias).length-String(a.alias).length)){
    if(!out.includes(item.alias))continue;
    out=out.split(item.alias).join(item.title);
    applied.push(item.alias+"→"+item.title);
  }
  return {query:out,applied};
}

// 一次查询命中的**曲目**数：一首歌几个难度算一首。候选落盘要求唯一命中。
function distinctSongs(charts){
  return new Set((charts||[]).map(c=>String(c&&c.title||""))).size;
}

// 落盘门槛：三条全过才记候选。任何一条不满足都只是「不记」，不影响这一轮的回答——
// 恢复本身照常生效，只是这个映射不留痕迹。
function candidateGate({charts,game,conversation}){
  if(!Array.isArray(charts)||!charts.length)return "曲库里没有这首歌";
  if(distinctSongs(charts)!==1)return "曲库命中不唯一（"+distinctSongs(charts)+" 首）";
  const said=gameInText(conversation);
  if(said&&game&&said!==game)return "游戏上下文冲突（对话说的是 "+said+"，命中的在 "+game+"）";
  return "";
}

module.exports={recoveryHint,recheckFromQuery,gamesWithTitle,distinctSongs,candidateGate,applyAliases};
