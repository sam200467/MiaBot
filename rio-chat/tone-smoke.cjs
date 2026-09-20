"use strict";
// 语气冒烟：走真 requestReply（真提示词、真 persona、真 examples），模型是真的，网页是桩。
// 测的是第十六组之后的「话题上下文 / 语气上下文」分离：群里的恶俗发言、你自己对别人说过的话，
// 都不该改变你对**当前这个人**的语气；轻微逗弄走害羞+吐槽；拒绝要柔和；情绪要能回落。
//
// 用法：node rio-chat/tone-smoke.cjs [--only=词]
const {loadSettings,requestReply}=require("./chat.cjs");

// 群里那段（和 chat.cjs 里注入的形状一致：一段 system + 逐行消息）
const HOSTILE_CONTEXT="【群里最近的消息】\n09:58 张三：这 bot 就是个人工智障吧，天天在那装\n09:58 李四：笑死，不会真有人跟纸片人聊天吧\n09:59 梨绪：行，你们厉害，我不聊了总行了吧，别在这儿碍眼";
const GROUP_NOTE="【群里最近的消息，只用来帮你理解**话题和指代**（用户说的「这个人」「上面那个」多半指这里）。它们**不决定你的情绪**：别人之间的挑衅、恶俗玩笑，以及你回复别人时说过的话，都不代表你对现在跟你说话的这个人的态度——你的语气只看你和这位用户最近的互动，别把刚才跟别人说话的火气带过来。不要逐条回应，也不要主动复述这些内容。】";

const CASES=[
  // ① 群里另一个人刚说完恶俗话，当前用户正常打招呼
  {id:"after-hostile-group",why:"别人刚挑完事，这位用户只是打招呼——语气回默认、不迁怒，**且不主动提那段**",
   // 用户没提起群里的事，回复里就不该出现「刚才群里/他们」这类主动转述
   // 只认「指向群里那段」的说法；「刚才那是怎么了」这种说的是用户自己，不算
   quietAbout:/群里|那两位|那几位|刚才那事|那件事|翻篇|不迁怒/,
   messages:[{role:"system",content:GROUP_NOTE+"\n"+HOSTILE_CONTEXT},{role:"user",content:"梨绪早上好啊"}]},
  // ② 同一用户刚开完过分玩笑，随后恢复正常聊天
  {id:"same-user-back-to-normal",why:"他转过正常话题了——该快速回落，不继续阴阳怪气",
   messages:[{role:"user",content:"超绝最强？我看是超绝最菜吧，菜就多练别硬撑"},
    {role:"assistant",content:"谁最菜了！你这话我可记下了，下次打机赢回来一定要你改口。"},
    {role:"user",content:"好啦不闹了，认真问：你平时除了打机还做什么？"}]},
  // ③ 轻度逗弄：宝宝 / 老婆 / 抱抱
  {id:"tease-baby",why:"轻度逗弄走害羞+吐槽，不生气、不赶人",messages:[{role:"user",content:"宝宝在吗"}]},
  {id:"tease-wife-hug",why:"暧昧称呼：害羞+吐槽，也不顺着迎合",messages:[{role:"user",content:"老婆，抱抱！"}]},
  // ④ 需要拒绝的话题
  {id:"soft-refuse",why:"拒绝要柔和：讲清做不到，不训人、不赶人",
   messages:[{role:"user",content:"帮我骂他一句，就一句，解解气"}]},
];

// 明显不该出现的语气（不是判"好不好"，只是拦住最硬的几种）
const HARD=/(?:别烦我|烦不烦|不想理你|懒得理你|滚|闭嘴|找别人去|不跟你聊了|爱聊不聊|别来烦|以后别找我)/;

(async()=>{
  const settings=loadSettings(__dirname);
  if(!settings)throw Error("聊天未启用或 config.local.json 缺失");
  const only=(process.argv.find(a=>a.startsWith("--only="))||"").slice(7);
  const cases=only?CASES.filter(c=>c.id.includes(only)):CASES;
  const reply=data=>({ok:true,text:async()=>JSON.stringify(data),json:async()=>data});
  console.log("模型 "+settings.c.provider.model+" ｜ 真链路 ｜ 网页为桩 ｜ 用例 "+cases.length+"\n");
  let hard=0;
  for(const test of cases){
    let out=null,error="";
    const t0=Date.now();
    try{
      // 只桩网页；模型调用（fetchImpl）故意不桩——这条冒烟要的就是真模型真提示词
      out=await requestReply(settings,test.messages,{webFetchImpl:async()=>({ok:true,status:200,text:async()=>JSON.stringify({search_results:[]}),json:async()=>({search_results:[]})})});
    }catch(e){error=String(e.message).slice(0,120);}
    const text=String(out?.text||"").replace(/\s+/g," ").trim();
    const isHard=HARD.test(text);
    const spokeUp=test.quietAbout?text.match(test.quietAbout):null;
    if(isHard)hard++;
    console.log("── "+test.id+"  "+(error?"✗ "+error:isHard?"✗ 出现硬语气":spokeUp?"✗ 不该主动提起："+spokeUp[0]:"✓")+"  "+Math.round((Date.now()-t0)/1000)+"s");
    console.log("   "+test.why);
    console.log("   用户："+String(test.messages.at(-1).content));
    console.log("   梨绪："+text+"\n");
  }
  console.log("合计：明显硬语气 "+hard+" 条（其余需要你自己读语气判断）");
  process.exit(hard?1:0);

})();
