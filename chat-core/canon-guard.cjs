"use strict";
// 剧情事实的生成后校验层：本地剧情库已经确认的事，回答里**不能否认它存在**。
//
// 为什么提示词不够：constant-guard.cjs 的注释已经写过同一条教训——模型会在「标注了这是
// 老帖的说法」之后照样把旧值当事实报出去。这里同理：提示词里写了「可以嘴硬但不能说没
// 发生过」，它答应得好好的，轮到自己答还是会顺手来一句「没有的事！」。
//
// 误判代价**不对称**，这决定了本模块的全部取舍：
//   · 漏检 → 偶尔还是否认一次，下一轮或者人工发现，损失有限；
//   · 误检 → 把一句本来正确的回答打成错的，而纠错轮会让模型**改掉对的答案**。
// 所以每一道过滤都是「宁可放过」：先要求别名/关键词真的在同一段里出现，再排掉否定否认、
// 反问、引用三种句式，最后纠错话术本身也留了「如果你只是引用，不必改」的出口。
//
// 句界标点与 constant-guard.cjs 的 sentenceAround 保持同一套（。！？；\n）。
// normalize 必须与剧情索引共用同一套规则，否则条目别名在正文里的命中结果两边不一致。
const {normalize}=require("./knowledge.cjs");
const DELIM=/[\n。！？；]/;
// 存在性否认（闭集）。**只收「这件事不存在」**，不收「我不记得」——「那种事我才不记得」
// 是允许的嘴硬，把它收进来等于禁止角色演自己。
const EXISTENCE_DENIAL=/(?:没|沒|没有|沒有|从没|從沒|从来没有|從來沒有|根本不|压根不|壓根不|压根儿不)\s*(?:发生过|發生過|这回事|這回事|这种事|這種事|那回事|那件事|这回事儿|這回事兒)|(?:根本|压根|壓根|压根儿)?\s*(?:没|沒|没有|沒有|从没|從沒|从来没有|從來沒有)\s*(?:一起|一同|再|真的|可能|机会|機會|办法|辦法)?\s*(?:打过|打過|做过|做過|去过|去過|玩过|玩過)|(?:没|沒|没有|沒有)的事|(?:根本|压根|壓根|压根儿|完全|绝对|絕對)不存在|不存在(?:这回事|這回事|这种事|這種事|那回事|那样的事|那樣的事)|(?:你|您)(?:记错|記錯)了?|哪有(?:这|這)(?:回|种|種|么|麼)事|别让我背锅|別讓我背鍋|(?:纯属|純屬)?(?:瞎|胡)(?:编|編|说|說)|不可能(?:发生过|發生過)|(?:哪|哪能)(?:跟|和|同|与|與)[^。！？；\n]{0,12}(?:打过|打過|做过|做過|去过|去過|玩过|玩過)/;
// ① 否定否认：「**不是**没发生过」「**并非**没有这回事」——这是**在纠正**一个否认，
//    句子是对的，纠了就成了胡话。窗口取否认词前 12 字。
//    另一半是**时态延续**：「那之后**再也没**打过真人CS」说的是此后再没打过，不是在否认
//    打过——「再也不」还常是今后的打算。这一条不加，最常见的误解方向就反了。
const NEGATED_DENIAL=/(?:不是|并不是|並非|并非|才不是|不可能是|不会是|不會是|不算是|算不上|没有说|沒有說|不能说|不能說|谁说|誰說|再|再也|就再|从今|從今|从此|從此|后来|後來|之后|之後|以后|以後)[^。！？；\n]{0,12}$/;
// ② 反问：「你怎么会觉得没发生过？」「难道没有这回事？」——反问的语气是「明明就有」，
//    与断言否认相反。疑问标点也算：以「吗／么／嗎／麼 + ？？」收尾的句子多半在反问。
const RHETORICAL=/(?:难道|難道|怎么会|怎麼會|怎么可以|怎麼可以|为什么.{0,4}(?:觉得|認為|认为)|岂不|豈不)|[吗麼么嗎]\s*[？?]\s*$|[？?]\s*$/;
// ③ 引用/传信/假设：「有人说没发生过，那是瞎说」「要是谁说没发生过」——否认不是她自己的
//    立场。「不管哪次打过…」这类让步句也在这里排掉。
const QUOTATIVE=/(?:有人说|有人說|听说|聽說|据说|據說|你说|你說|他说|他說|谁说|誰說|要是|如果|假如|假设|假設|万一|萬一|不管|无论|無論|不論|不论|哪怕|即使)/;
// 找一句话的边界。返回 [start,end)，与上面 DELIM 同一套标点。
function spanOf(text,at){
  let start=at;
  while(start>0&&!DELIM.test(text[start-1]))start--;
  let end=at;
  while(end<text.length&&!DELIM.test(text[end]))end++;
  if(end<text.length&&text[end]!=="\n")end++;
  return [start,end];
}
// 否认所在的那一段：本句 + 前后各一句，最多各扩 WINDOW 字。
// 为什么要跨句：线上那条错答是「没有的事！我哪跟明里打过真人CS」——否认和事件名
// 分在两个句子里，只按同句判会整条漏掉。反过来窗口开太大又容易误伤，所以封顶。
const WINDOW=120;
function windowAround(text,at){
  const [start,end]=spanOf(text,at);
  let from=start;
  if(from>0){
    const prev=spanOf(text,from-1);
    from=Math.max(prev[0],start-WINDOW);
  }
  let to=Math.min(text.length,Math.max(end,end+WINDOW));
  const next=text.slice(end).search(DELIM);
  to=next<0?text.length:Math.min(end+next+1,to);
  return text.slice(from,to);
}
// 只对**强命中且非低置信**的条目判。弱命中说明用户没点明是哪一段，模型答偏了不算否认。
function checkDenials(text, hits){
  const body=String(text||"");
  const denials=[];
  if(!body||!Array.isArray(hits)||!hits.length)return {denials};
  for(const hit of hits){
    const story=hit.story;
    if(!story||hit.strength!=="strong"||hit.trust==="inferred")continue;
    const aliasList=story.aliasList||[], keywordList=story.keywordList||[];
    const scan=new RegExp(EXISTENCE_DENIAL.source,"g");
    let found;
    while((found=scan.exec(body))!==null){
      const at=found.index;
      const before=body.slice(Math.max(0,at-24),at);
      if(NEGATED_DENIAL.test(before))continue;           // ① 在纠正否认，别碰
      const [start,end]=spanOf(body,at);
      const sentence=body.slice(start,end);
      if(QUOTATIVE.test(sentence))continue;              // ③ 引用/传信/假设，不是她的立场
      if(RHETORICAL.test(sentence))continue;             // ② 反问
      // 事件名必须真的出现在否认附近。远端另一个话题里的「没有」不该被算到这条头上。
      const window=windowAround(body,at);
      const flat=normalize(window), loose=window.normalize("NFKC").toLowerCase();
      const mentioned=aliasList.some(item=>item.test(flat,loose))||keywordList.some(item=>item.test(flat,loose));
      if(!mentioned)continue;
      denials.push({storyId:story.id,title:story.title,phrase:found[0],at});
    }
  }
  return {denials};
}
// 纠错话术。**刻意不写成「你答错了」**——如果这一轮其实只是引用或反问，模型要能判断
// 出「不必改」。事实本身从本地条目来，不是程序现编的，所以它不可能把对的改成错的。
function canonNote(denials){
  const list=(denials||[]).filter((item,index,array)=>array.findIndex(other=>other.storyId===item.storyId)===index);
  if(!list.length)return "";
  return "【程序核对剧情事实】这一轮的回答里出现了否认原作剧情存在的说法（"+list.map(item=>"「"+item.phrase+"」→"+item.title).join("；")+"）。"+
    "本地剧情库里这些事是**确实发生过**的。如果你是在否认它们（「没发生过」「你记错了」），请改成不否认的说法——可以嘴硬（「那种事我才不记得」「哼，那都在作战计划之内」），但不能说它不存在；"+
    "如果你只是在引用别人的说法、或者在反问，那就不用改，保持原样即可。不要向用户解释这条程序提示。";
}
module.exports={checkDenials,canonNote,spanOf,windowAround,EXISTENCE_DENIAL};
