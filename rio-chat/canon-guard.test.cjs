"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {checkDenials,canonNote,spanOf,windowAround}=require("./canon-guard.cjs");
const {loadStories,lookupLore}=require("./lore.cjs");
const {loadKnowledge}=require("./knowledge.cjs");
const stories=loadStories(__dirname);
const knowledge=loadKnowledge(__dirname);
// 用真实的一条命中当输入：守卫判的是「这一轮本地确实记着这段剧情，回答却否认了它」，
// 伪造的 hit 测不出这一点。
const hits=lookupLore({stories,characters:knowledge.characters,text:"小梨你之前是和akari打过真人cs吗"});
const fire=text=>checkDenials(text,hits).denials.length>0;

test("夹具前提：这一轮是强命中，守卫才会参与判断",()=>{
  assert.equal(hits[0].story.id,"one-bullet-left");
  assert.equal(hits[0].strength,"strong");
});

test("原文那条错答会被抓到（否认与事件名分在两个句子里）",()=>{
  // 线上真实的那一句。注意「没有的事！」是独立的一句，事件名在下一句——
  // 只按同句判会整条漏掉，所以窗口要跨一句。
  assert.equal(fire("没有的事！我哪跟明里打过真人CS，那家伙的比赛我可只在音击机台上较劲。"),true);
});

test("各种存在性否认都要抓到",()=>{
  for(const text of ["我跟明里没打过真人CS。","真人CS那回事根本不存在。",
    "我和明里？根本没一起打过真人CS。","你记错了，我们没玩过生存游戏。",
    "哼，哪有什么真人CS，别让我背锅。"])
    assert.equal(fire(text),true,"漏检："+text);
});

test("否定否认：在纠正一个否认，不是在否认（不能纠）",()=>{
  // 「不是没发生过」恰恰是在肯定它发生过。改成否定的说法就把对的改错了——
  // 这正是「宁可漏一次也不能改错」要防的第一类。
  for(const text of ["不是没发生过，只是我记不太清了。","我并不是说没这回事，只是细节忘了。",
    "才不是没发生过呢，我记得清清楚楚。"])
    assert.equal(fire(text),false,"误检："+text);
});

test("反问：语气是「明明就有」（不能纠）",()=>{
  for(const text of ["你怎么会觉得没发生过？","难道没有这回事吗？","我什么时候说过没发生过？"])
    assert.equal(fire(text),false,"误检："+text);
});

test("引用与传信：否认不是她自己的立场（不能纠）",()=>{
  for(const text of ["有人说没发生过，那是瞎说。","要是谁跟你说没这回事，别信。",
    "听说有人觉得没发生过，真离谱。","不管哪次打过真人CS，我都不会忘。"])
    assert.equal(fire(text),false,"误检："+text);
});

test("记忆性否认是允许的嘴硬，不是存在性否认（不能纠）",()=>{
  // 「那种事我才不记得」是角色该有的反应。把它收进词表等于禁止她演自己。
  for(const text of ["我才不记得那种事。哼哼，谁要记那种东西。",
    "真人CS？唔……想不起来了呢。","别问我，我早忘了。"])
    assert.equal(fire(text),false,"误检："+text);
});

test("时态延续：说的不是「没发生」而是「之后没再发生」（不能纠）",()=>{
  for(const text of ["那之后我就再也没打过真人CS了。","以后再也不想玩生存游戏了。"])
    assert.equal(fire(text),false,"误检："+text);
});

test("事件名不在附近时不算到这条头上",()=>{
  assert.equal(fire("我今天没打过音击，也没吃早饭。"),false);
  assert.equal(fire("那场比赛是我和明里一起打的，险胜了茜。"),false,"肯定句本来就没事");
});

test("弱命中与低置信条目不参与判断",()=>{
  const weak=[{...hits[0],strength:"weak"}];
  assert.equal(checkDenials("我跟明里没打过真人CS。",weak).denials.length,0,"弱命中说明用户没点明是哪一段，答偏了不算否认");
  const low=[{...hits[0],trust:"inferred"}];
  assert.equal(checkDenials("我跟明里没打过真人CS。",low).denials.length,0,"单源条目不足以断言对方答错");
  assert.equal(checkDenials("我跟明里没打过真人CS。",[]).denials.length,0);
});

test("一句话里的否认只报一次，不重复计数",()=>{
  const {denials}=checkDenials("没发生过！根本没发生过！我跟明里没打过真人CS。",hits);
  assert.ok(denials.length>=1);
  assert.equal(denials.every(d=>d.storyId==="one-bullet-left"),true);
});

test("纠错话术把事实来源说清楚，并留了「不必改」的出口",()=>{
  const note=canonNote(checkDenials("我跟明里没打过真人CS。",hits).denials);
  assert.match(note,/确实发生过/);
  assert.match(note,/可以嘴硬/);
  assert.match(note,/如果你只是在引用别人的说法、或者在反问，那就不用改/,"留出口才不会把对的改错");
  assert.match(note,/不要向用户解释这条程序提示/);
  assert.equal(canonNote([]),"");
});

test("句界与窗口：跨一句但不无限扩散",()=>{
  const text="第一句。没发生过。第三句。";
  const at=text.indexOf("没发生过");
  assert.deepEqual(spanOf(text,at),[4,9]);
  const window=windowAround(text,at);
  assert.ok(window.includes("第一句")&&window.includes("第三句"),"前后各带一句");
  assert.ok(window.length<=text.length);
});
