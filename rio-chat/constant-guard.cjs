"use strict";
// 定数裁决层：结构化事实（曲名、难度、当前定数）以本地曲库为准，Web 只负责玩家评价、
// 攻略和历史资料。模型从社区老帖里抄来的定数常常是几个版本前的值——这是本项目最典型的
// 错答（截图那条把 Dengeki Tube 写成 14.9，本地快照是 15.2），而且 spike 实测：模型会在
// **标注了「这是老帖的说法」之后照样把数字当事实报出去**，所以提示词禁不掉，得由程序核对。
//
// 两类必须避开的误伤：
//   ① 引用旧值来否定它：「老帖把它写成 14.9，那是旧数据」——改了这句就成了胡话。
//   ② 段落里的其它数字：年份、BPM、分数、物量（"物量 1200" 之类）。
// ① 靠句内的时效/否定词表整句跳过；② 靠「只认曲名后一小段窗口里的 13.0~15.9 形状
// 数字，且必须落在该曲某个难度定数的邻域内」收窄。两条都是宁可放过、不可改错。
const {normalize}=require("./knowledge.cjs");

// 一整句里出现这些词，就当这句在讲旧数据，一个数字也不碰。
const STALE=/(?:旧|舊|老帖|老贴|老文|以前|曾经|曾經|过去|過去|过时|過時|调整前|調整前|改成|已经(?:不是|改)|不再|早先|当年|當年|当时|當時|原来是|原來是|当时的|當時的)/;
// 定数形状：13.0~15.9，一位小数。前后不能再接数字或百分号，免得命中 15.25 / 15.2%；
// 后面跟「万／分」的也不是定数，是分数（「这首我打了 13.4 万分」离 EXP 的 12.5 只差 0.9，
// 光靠 MAX_JUMP 拦不住）。
const CONSTANT=/(?<![\d.])(1[0-5])\.(\d)(?![\d%])(?!\s*[万分])/;
// 差值小于这个数就当模型报的就是曲库值（浮点噪声）；大于 MAX_JUMP 说明这不是在说定数，
// 一律不碰。两道闸都是为了让「改错」比「漏改」更难发生。
const MIN_JUMP=0.05,MAX_JUMP=1.0;

// 把正文压成与曲名索引同一套规范化的串，并记住每个压缩字符落在原串的哪个下标：
// 带空格和符号的曲名（Love & Justice）这样才匹配得上，改数字时又能定位回原串。
// 按码点走，不把一个代理对劈成两半。逐字符规范化与整串规范化在组合字符上会有极小差异，
// 曲名里没有这种写法，不值得为它做 O(n²) 的整串对齐。
function compactMap(text){
  const flat=[],map=[];let at=0;
  for(const ch of String(text)){
    for(const c of normalize(ch)){flat.push(c);map.push(at);}
    at+=ch.length;
  }
  return {flat:flat.join(""),map};
}
const isAsciiWord=ch=>ch!==undefined&&/[a-z0-9]/.test(ch);

// 找出正文里出现的所有曲库曲名。索引已按曲名长度从长到短排好，先命中的先占位，
// 于是 PANDORA PARADOXXX 不会被更短的 Parad'ox 切走。ASCII 曲名额外卡词边界：
// 「Air」不能命中 Fairytale 里的 air。
// extra：宿主给的正识别名（{alias,title,game}）。模型会照着用户的话写「电管」这种中文简称，
// 光靠曲名索引认不出来，正文里那一处的旧定数就整条溜过去了。别名解析成正式曲名之后再按
// 曲名去核——规则还是同一个，只是多了几个入口写法。
function findTitles(knowledge,text,extra){
  const titles=[...(Array.isArray(knowledge?.titles)?knowledge.titles:[])];
  for(const item of extra||[]){
    const normalized=normalize(item.alias);
    if(normalized)titles.push({title:item.title,game:item.game||"",normalized});
  }
  if(!titles.length)return [];
  titles.sort((a,b)=>b.normalized.length-a.normalized.length);
  const {flat,map}=compactMap(text);
  if(flat.length<3)return [];
  const taken=new Array(flat.length).fill(false),hits=[];
  for(const entry of titles){
    const needle=entry.normalized;
    if(!needle||needle.length>flat.length)continue;
    let at=flat.indexOf(needle);
    while(at>=0){
      const end=at+needle.length;
      let free=true;
      for(let k=at;k<end;k++)if(taken[k]){free=false;break;}
      // 词边界必须在**原串**上判：压缩串把空格、括号、小数点都剥掉了，
      // 「Love & Justice（14.9）」里标题后面紧跟的是数字 1，在压缩串上会被误判成
      // 「单词中间」而整个漏掉——实测就是这么漏的。
      const start=map[at],stop=map[end-1]+1;
      const bounded=!isAsciiWord((text[start-1]||"").toLowerCase())&&!isAsciiWord((text[stop]||"").toLowerCase());
      if(free&&bounded){
        for(let k=at;k<end;k++)taken[k]=true;
        hits.push({title:entry.title,game:entry.game,start,end:stop});
      }
      at=flat.indexOf(needle,free&&bounded?end:at+1);
    }
  }
  return hits.sort((a,b)=>a.start-b.start);
}

// 数字所在的那一句：向前后各找到句末标点为止。只在这一句里找时效词，避免隔着两句
// 把「上一句提到老帖」误当成「这一句在讲旧值」。
function sentenceAround(text,at){
  const head=text.slice(0,at).search(/[^。！？；\n]*$/);
  const from=head<0?0:head;
  const rest=text.slice(at);
  const cut=rest.search(/[。！？；\n]/);
  return text.slice(from,cut<0?text.length:at+cut+1);
}

// 每款游戏各挑出「离模型报的数最近」的那张谱。模型报的数就是最好的难度线索：
// 它说 14.9，就落在 MAS 的 15.2 上，不会落到 EXP 的 12.5 上。按游戏分开算，
// 是因为同一首歌可能同时收录在多款游戏里（Love & Justice 在音击是 MAS 14.7、
// 在中二是 MAS 15.2），合并成一个最近值会把中二的旧值改到音击的定数上去。
function candidates(knowledge,title,value){
  const wanted=normalize(title),byGame=new Map();
  for(const [game,catalog] of Object.entries(knowledge.catalogs||{})){
    for(const chart of catalog.charts||[]){
      if(chart.constant==null)continue;
      if(normalize(chart.title)!==wanted)continue;
      const gap=Math.abs(chart.constant-value);
      const current=byGame.get(game);
      if(!current||gap<current.gap)byGame.set(game,{gap,chart});
    }
  }
  return [...byGame.entries()].map(([game,value])=>({game,...value})).sort((a,b)=>a.gap-b.gap);
}
// 游戏未知、而两款游戏的候选一样近时放弃：挑错游戏比漏改糟得多（改完这句会变成
// 用音击的定数去说中二的谱）。这个阈值就是「一样近」的容差。
const AMBIGUOUS_GAP=0.15;
function nearestConstant(knowledge,title,value,game){
  const all=candidates(knowledge,title,value);
  if(!all.length)return null;
  // 对话里点名的游戏优先，哪怕另一款的数值更近。
  const hit=game?all.find(c=>c.game===game):null;
  if(hit)return hit.chart;
  if(all.length>1&&all[0].gap+AMBIGUOUS_GAP>all[1].gap)return null;
  return all[0].chart;
}

// 曲名之后要核多宽。模型报定数常写成列表（「BAS 4、ADV 7+、EXP 12+（12.5）、MASTER 15（定数14.9）」），
// 而且曲名和数字常常不在同一句里：线上那条是「喔，DENGEKI Tube啊，早说拼写不就好了！
// BACO那首，我翻到的是：…MASTER 15（定数15.2）」——曲名在第一句，四个难度全在第二句。
// 所以按「段」核：从曲名命中点到下一个曲名命中点为止，最多 REGION 个字符。
// 一段里的每个定数形状数字都要核，只核第一个会漏：列表里第一个数字往往本来就是对的
// （EXP 的 12.5），它改不动，后面的旧值就整条溜过去了——这正是「上一条老定数、这一条
// 新定数」的来路。段尾交给 MAX_JUMP 兜底：段里别的数字（年份、分数、别人的定数）
// 离这首歌任何一个定数都超过 1.0，会被当成别的东西放过。
const REGION=180;
// 数字后面要不要补一句当前值：只在「时效句」里用。位置就在数字后，读者一眼能连上。
const currentNote=value=>"（当前定数 "+value+"）";

// 返回 {text, fixes}。fixes 只用于日志：改了哪几首、从多少改成多少（kind=annotate 是补注，
// 数字没动、只在后面补了当前值）。game 是对话里点名的游戏（knowledge.cjs 的 gameInText
// 给的），用来消歧多游戏收录。
function verifyConstants(knowledge,text,game,extra){
  const fixes=[],edits=[];
  if(!knowledge||typeof text!=="string"||!text)return {text,fixes};
  const hits=findTitles(knowledge,text,extra);
  if(!hits.length)return {text,fixes};
  for(let i=0;i<hits.length;i++){
    const hit=hits[i];
    const stop=Math.min(hits[i+1]?hits[i+1].start:text.length,hit.end+REGION);
    const region=text.slice(hit.end,stop);
    const scan=new RegExp(CONSTANT.source,"g");
    let found;
    while((found=scan.exec(region))!==null){
      const value=Number(found[1]+"."+found[2]);
      const at=hit.end+found.index,end=at+found[0].length;
      const chart=nearestConstant(knowledge,hit.title,value,game);
      if(!chart)continue;
      const jump=Math.abs(chart.constant-value);
      if(jump<=MIN_JUMP||jump>MAX_JUMP)continue;
      // 固定写成一位小数：曲库里 15.0 存的是 15，直接替进去会得到「Angel dust 15」，
      // 而「15」在音游语境里读起来是**等级**，不是定数 15.0。
      const current=Number(chart.constant).toFixed(1);
      if(STALE.test(sentenceAround(text,at))){
        // 时效句：「老帖把它写成 14.9」这种话是对的，硬改就成了胡话，所以数字不动。
        // 但也不能整句放过——模型会在标注「这是老帖的说法」之后照样把旧值当现状报出去，
        // 而程序无法从一句话里判断它到底是在引用还是在报数。折中：旧值留着，后面补一句
        // 当前值。读者看到的是「老帖写 14.9（当前定数 15.2）」，两边都不丢。
        // 这段话（整条回复）里已经出现过当前值的就不补，免得同一篇里重复。
        if(new RegExp("(?<![\\d.])"+current.replace(".","\\.")+"(?![\\d%])").test(text))continue;
        edits.push({at,end,replacement:found[0]+currentNote(current)});
        fixes.push({title:chart.title,difficulty:chart.difficulty,from:value,to:chart.constant,kind:"annotate"});
        continue;
      }
      edits.push({at,end,replacement:current});
      fixes.push({title:chart.title,difficulty:chart.difficulty,from:value,to:chart.constant,kind:"fix"});
    }
  }
  let out=text;
  // 从后往前改：前面的改动会挤歪后面记录的偏移。
  for(const edit of [...edits].sort((a,b)=>b.at-a.at))out=out.slice(0,edit.at)+edit.replacement+out.slice(edit.end);
  return {text:out,fixes};
}

module.exports={verifyConstants,findTitles,nearestConstant,candidates,sentenceAround,STALE};
