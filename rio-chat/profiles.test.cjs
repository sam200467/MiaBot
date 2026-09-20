"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path"),os=require("node:os");
const {loadProfiles,findProfiles,profilesPayload,profilesRule,blockTrust,soloAliases,soloHit,
  SOLO_CONTEXT,SOLO_BLOCK,SELF_DEFAULT}=require("./profiles.cjs");
const {loadKnowledge}=require("./knowledge.cjs");
const root=__dirname;
// 用真实档案 + 真实角色索引：这一层的价值全在「数据 + 别名」能不能接上。换成合成夹具就
// 测不到「有栖」「枫」这类真正会出错的写法，也测不到数据文件和 characters.json 有没有漂移。
const profiles=loadProfiles(root);
const knowledge=loadKnowledge(root);
const characters=knowledge.characters;
const find=text=>findProfiles(profiles,{text,characters});
const names=hits=>hits.map(hit=>hit.profile.name);
const BLOCKS=["basics","profile","extras"];
// 合成夹具：只在需要构造真实数据里没有的形状（低置信块、单字冲突）时才用。
function fixture(list){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"profiles-"));
  fs.mkdirSync(path.join(dir,"knowledge"));
  fs.writeFileSync(path.join(dir,"knowledge","ongeki-profiles.json"),
    JSON.stringify({schemaVersion:1,game:"ongeki",profiles:list}));
  return loadProfiles(dir);
}
const rec=extra=>({id:"x",name:"高瀬 梨緒",
  basics:{grade:"高校2年生",birthday:"1月25日",zodiac:"水瓶座",bloodType:"A型",height:"157cm",
    factConfidence:"confirmed",factSources:["https://ongeki.sega.jp/character/1040/"]},
  profile:{traits:["自称超绝最强"],factConfidence:"confirmed",factSources:["https://ongeki.sega.jp/character/1040/"]},
  relationships:[],factReviewed:null,...extra});

// ── 用户报的三条原句 ────────────────────────────────────────────────────
test("问别的角色是谁／什么性格，本地能认出来",()=>{
  const a=find("井之原小星是个什么样的人");
  assert.equal(a[0]?.profile.name,"井之原 小星","正式别名要能命中");
  assert.equal(a[0].match,"name");
  const b=find("彩华的性格怎么样");
  assert.equal(b[0]?.profile.name,"早乙女 彩華","「彩华」是两字别名，走正式路径");
  assert.equal(b[0].match,"name");
  // 「枫」在 characters.json 里规范化后长度为 1，被索引丢了，只能走单字路径
  const c=find("有栖和枫是什么关系");
  assert.deepEqual(names(c).sort(),["九條 楓","珠洲島 有栖"]);
  assert.equal(c.find(hit=>hit.profile.name==="九條 楓").match,"solo");
  const payload=profilesPayload(c,{});
  assert.match(payload.note,/可能认错人/,"单字命中要提醒模型别硬答");
});

test("单字简称在像在问人时命中，在常见词里不命中",()=>{
  assert.equal(find("你和椿最近怎么样")[0]?.profile.name,"藍原 椿");
  assert.equal(find("纺最近怎么样")[0]?.profile.name,"東雲 つむぎ","「纺」也是主角的单字简称");
  // 闸门①是硬要求：句子本身不像在问人时，连单字都不启用
  assert.equal(find("纺最近在忙什么").length,0);
  // 黑名单回归：这些句子要么没有问人信号（闸门①），要么邻字是常见词（闸门②）
  for(const text of ["向日葵开了","介绍一下向日葵","香椿炒蛋怎么做","枫叶红了是什么样",
    "纺织业最近行情怎么样","我妹妹叫小葵","茜草是什么植物"])
    assert.equal(find(text).length,0,"误命中："+text);
});

test("只提到梨绪自己不注入，提到梨绪加别人时只注入别人",()=>{
  assert.equal(find("你今天心情怎么样").length,0);
  assert.equal(find("梨绪在吗").length,0);
  const hits=find("梨绪，小星最近怎么样");
  assert.equal(hits.length,1);
  assert.equal(hits[0].profile.name,"井之原 小星");
  // 点到她自己时 payload 要提醒：用第一人称设定答，不要念自己的档案
  const payload=profilesPayload(hits,{selfMentioned:hits.selfMentioned});
  assert.match(payload.note,/不要照这些第三人称档案念自己/);
});

test("多角色按上限截断，并如实报告还有几个没列出来",()=>{
  const hits=find("明里、柚子、葵和枫的性格分别怎么样");
  assert.equal(hits.length,3);
  assert.equal(hits.omitted,1);
  assert.deepEqual(hits.slice(0,2).map(hit=>hit.match),["name","name"],
    "正式命中要排在单字命中前面（单字可能是误命中，先挤掉它）");
  const payload=profilesPayload(hits,{});
  assert.equal(payload.matched,4);
  assert.equal(payload.omitted,1);
  assert.match(payload.note,/不要假装只有列出来的这些/);
});

// ── 单字别名的投影与两道闸门 ────────────────────────────────────────────
test("单字别名是从 characters.json 投影出来的，不是第二套别名表",()=>{
  const map=soloAliases(characters,profiles);
  assert.ok(map.size>=5,"主角的单字简称至少 5 个（茜/枫/葵/纺/椿）");
  const all=new Set();
  for(const char of characters.characters)
    for(const alias of char.aliases||[])
      if(alias.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]/gu,"").length===1)
        all.add(alias.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]/gu,""));
  for(const key of map.keys())
    assert.ok(all.has(key),"单字表里出现了别名表里没有的写法："+key);
  assert.match(SOLO_CONTEXT.source,/性格/);
  assert.ok(SOLO_BLOCK.has("日葵")&&SOLO_BLOCK.has("香椿")&&SOLO_BLOCK.has("纺织"));
});

test("同一个单字落到两个角色时整条丢弃（歧义不猜）",()=>{
  // 真实数据里没有这种冲突，造一个：两个角色都叫「葵」
  const chars={characters:[{name:"三角 葵",aliases:["葵"]},{name:"另一个人",aliases:["葵"]}],
    index:new Map([["另一个人",{name:"另一个人",aliases:["葵"]}]])};
  const fake=fixture([rec({name:"三角 葵"}),rec({name:"另一个人"})]);
  const map=soloAliases(chars,fake);
  assert.equal(map.has("葵"),false);
});

// ── payload ────────────────────────────────────────────────────────────
test("置信度跟着块走，不被最弱的那块拖下水",()=>{
  const fake=fixture([rec({name:"三角 葵",
    basics:{grade:"高校2年生",birthday:"7月16日",zodiac:"巨蟹座",bloodType:"A型",height:"161cm",
      factConfidence:"confirmed",factSources:["https://ongeki.sega.jp/character/1030/"]},
    profile:{traits:["认真又成熟的常识人"],factConfidence:"confirmed",factSources:["https://ongeki.sega.jp/character/1030/"]},
    extras:{attribute:"AQUA",weapon:"剑",factConfidence:"inferred",factSources:["https://wikiwiki.jp/gameongeki/三角 葵"]}}),
    rec({name:"逢坂 茜",basics:{grade:"高校3年生",birthday:"4月1日",zodiac:"白羊座",
      factConfidence:"confirmed",factSources:["https://ongeki.sega.jp/character/1120/"]},profile:null,extras:null})]);
  const hits=findProfiles(fake,{text:"葵的性格怎么样",characters});
  const payload=profilesPayload(hits,{});
  const item=payload.profiles[0];
  // 官方来的两块仍是 source，只有 extras 是 inferred——不能塌缩成一个数
  assert.equal(item.basics.trust,"source");
  assert.equal(item.traitsTrust,"source");
  assert.equal(item.extras.trust,"inferred");
  assert.match(payload.note,/inferred/);
  assert.match(payload.note,/属性\/武器\/游戏内问答/,"要点名是哪一块低置信");
  assert.equal(blockTrust({factConfidence:"confirmed",factReviewed:null}),"source");
  assert.equal(blockTrust({factConfidence:"confirmed",factReviewed:{at:"2026-09-18",by:"用户"}}),"human");
  assert.equal(blockTrust({factConfidence:"inferred"}),"inferred");
  assert.equal(blockTrust(null),null);
});

test("来源把 payload 顶过上限时先减条数，不把内容整块丢掉",()=>{
  // 回归：修剪顺序原来是「先丢整块 traits/relations」，于是用户明说要来源时，多出来的
  // 那几行 URL 会把性格和关系整个挤掉——他问的是出处，拿到的却是一份只剩生日的档案。
  const hits=find("明里、柚子、葵和枫的性格分别怎么样");
  assert.equal(hits.length,3,"夹具前提：一句里提到三个以上的角色");
  const payload=profilesPayload(hits,{preferLocalSources:true});
  for(const item of payload.profiles){
    assert.ok(item.basics,"basics 永不丢——那是本层最硬的产出");
    assert.ok(item.traits?.length>=1,"减条数就够了，不该把性格整块削掉");
    assert.ok(item.unit,"组合是 join 来的，同样不该丢");
  }
});

test("平时不给来源网址，用户明说要来源时才给",()=>{
  const hits=find("井之原小星是个什么样的人");
  assert.ok(!("sources"in profilesPayload(hits,{}).profiles[0]),"列 URL 只会诱使模型念网址");
  const payload=profilesPayload(hits,{preferLocalSources:true});
  assert.ok(payload.profiles[0].sources.some(u=>u.includes("ongeki.sega.jp")));
});

test("payload 不重复存别的层已有的字段",()=>{
  const payload=profilesPayload(find("井之原小星是个什么样的人"),{});
  const item=payload.profiles[0];
  assert.ok(!("aliases"in item)&&!("songs"in item)&&!("personal"in item),"别名/曲目归 characters.json");
  assert.equal(item.unit,"7EVENDAYS⇔HOLIDAYS","组合由 characters.json join");
  assert.ok(item.cv.length,"CV 同样 join，不在档案文件里");
  assert.ok(item.basics.grade&&item.basics.birthday);
  assert.ok(item.traits.length);
});

test("profilesRule 写死了「不能否认这个人存在」和来源的两句",()=>{
  const rule=profilesRule(profiles);
  assert.match(rule,/不能否认这个人存在/);
  assert.match(rule,/嘴硬/);
  // 「平时不要念网址」和「用户要来源就给」必须同时在场：只写前者会把后者堵死
  assert.match(rule,/不要念出 source 网址/);
  assert.match(rule,/只有用户明说要出处、来源或链接时/);
  assert.equal(profilesRule(null),"","没有档案库就不注入这条规则");
});

test("文件缺失／坏 JSON／空数组都当作「这层没装」，不抛异常",()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"profiles-"));
  assert.equal(loadProfiles(dir),null,"文件不存在");
  fs.mkdirSync(path.join(dir,"knowledge"),{recursive:true});
  fs.writeFileSync(path.join(dir,"knowledge","ongeki-profiles.json"),"{坏掉的");
  assert.equal(loadProfiles(dir),null,"JSON 坏掉");
  fs.writeFileSync(path.join(dir,"knowledge","ongeki-profiles.json"),JSON.stringify({profiles:[]}));
  assert.equal(loadProfiles(dir),null,"空数组");
  assert.deepEqual(findProfiles(null,{text:"小星是谁",characters}),[]);
  assert.deepEqual(findProfiles(profiles,{text:"小星是谁",characters:null}),[]);
  assert.deepEqual(findProfiles(profiles,{text:"",characters}),[]);
  assert.equal(profilesPayload([],{}),null);
});

// ── 真实数据文件的不变量 ────────────────────────────────────────────────
test("真实档案：17 名主角、名字能对上 characters.json、cast 全覆盖",()=>{
  assert.ok(profiles?.profiles?.length,"本地档案没装上");
  assert.equal(profiles.profiles.length,17);
  const ids=new Set();
  for(const item of profiles.profiles){
    assert.ok(item.id&&!ids.has(item.id),"id 缺失或重复："+item.id);
    ids.add(item.id);
    const char=characters.characters.find(c=>c.name===item.name);
    assert.ok(char,"角色名要用曲库正式写法："+item.name);
    assert.ok(char.cast,item.name+" 不是原作主角（cast 为假）");
    assert.ok(item.charaId,/^\d+$/.test(item.charaId),"官方角色 id 缺失："+item.name);
  }
  // roster 覆盖等式：以后新角色上线时这条会挂，正是想要的提醒
  assert.deepEqual(profiles.profiles.map(p=>p.name).sort(),
    characters.characters.filter(c=>c.cast).map(c=>c.name).sort());
  assert.ok(profiles.profiles.some(p=>p.name===SELF_DEFAULT),"梨绪本人的档案要在文件里（运行时才排除）");
});

// 官方站的角色 URL 号与 charaId 是**解耦**的：页内 JS 把旧值注释掉、现行值写在下一行——
//   //charaId: '1160',//URLを変更せずにキャラクターIDは交換 「柏木 美亜 <=> 東雲 つむぎ」
//   charaId: '1150',
// 抓取脚本若按正则取第一个 charaId，取到的就是被注释的旧行。这四位的号被官方交换过，
// 钉死在这里：将来重跑抓取若又取回旧值，这条会立刻挂。
test("真实档案：被官方交换过 charaId 的四位用的是现行号",()=>{
  const current={mia:"1150",tsumugi:"1160",koboshi:"1090",kaede:"1110"};
  for(const [id,charaId] of Object.entries(current)){
    const item=profiles.profiles.find(p=>p.id===id);
    assert.ok(item,"档案里找不到 "+id);
    assert.equal(item.charaId,charaId,item.name+" 的 charaId 应是现行值（官方 URL 号与 ID 已解耦）");
  }
});

test("真实档案：不重复存别名/曲目/组合/CV（键白名单）",()=>{
  const allowed=new Set(["id","name","charaId","basics","profile","extras","relationships","factReviewed","note"]);
  const blockKeys={basics:new Set(["grade","birthday","zodiac","bloodType","height","factConfidence","factSources"]),
    profile:new Set(["traits","factConfidence","factSources"]),
    // weakPoints 对应游戏内的「苦手なもの」（怕/不拿手），不是「嫌い」——键名不能写成 dislikes
    extras:new Set(["attribute","weapon","likes","weakPoints","hobbies","skills","factConfidence","factSources"])};
  for(const item of profiles.profiles){
    for(const key of Object.keys(item))
      assert.ok(allowed.has(key),item.name+" 出现多余字段（别的层已经有）："+key);
    for(const block of BLOCKS){
      if(!item[block])continue;
      for(const key of Object.keys(item[block]))
        assert.ok(blockKeys[block].has(key),item.name+" 的 "+block+" 出现多余字段："+key);
    }
  }
});

test("真实档案：每个块的来源、置信度与人工轴",()=>{
  for(const item of profiles.profiles){
    assert.ok(item.profile?.traits?.length,item.name+" 缺性格要点");
    for(const block of BLOCKS){
      const b=item[block];
      if(!b)continue;
      assert.ok(["confirmed","inferred"].includes(b.factConfidence),item.name+"/"+block+" 置信度非法");
      assert.ok(Array.isArray(b.factSources)&&b.factSources.length,item.name+"/"+block+" 缺来源");
      for(const url of b.factSources)assert.match(url,/^https?:\/\//,item.name+"/"+block+" 来源不是 URL");
      // confirmed 的资格：官方一手资料单源即可，非官方要两个以上不同域名
      if(b.factConfidence==="confirmed"){
        const official=b.factSources.some(u=>/ongeki\.sega\.jp/.test(u));
        const domains=new Set(b.factSources.map(u=>new URL(u).hostname));
        assert.ok(official||domains.size>=2,
          item.name+"/"+block+" 标了 confirmed 但既没有官方来源、又只有单一非官方来源");
      }
    }
    assert.ok(item.factReviewed===null||(item.factReviewed.at&&item.factReviewed.by),
      item.name+" 的 factReviewed 形状不对");
  }
  assert.equal(profiles.reviewedAt,null,"还没人工过目，顶层不许写审核日期");
  assert.match(profiles.curatedAt,/^\d{4}-\d{2}-\d{2}$/,"curatedAt 记的是策展日期");
});

// 星座边界表（只住在测试里）。官方给日文星座名、档案存中文名，用生日反查能挡住抄错行。
const ZODIAC_BOUNDARY=[["摩羯座",12,22,1,19],["水瓶座",1,20,2,18],["双鱼座",2,19,3,20],
  ["白羊座",3,21,4,19],["金牛座",4,20,5,20],["双子座",5,21,6,21],["巨蟹座",6,22,7,22],
  ["狮子座",7,23,8,22],["处女座",8,23,9,22],["天秤座",9,23,10,23],["天蝎座",10,24,11,22],
  ["射手座",11,23,12,21]];
function zodiacOf(month,day){
  for(const [sign,m1,d1,m2,d2] of ZODIAC_BOUNDARY){
    if((month===m1&&day>=d1)||(month===m2&&day<=d2))return sign;
  }
  return null;
}
test("真实档案：生日格式正确，且与星座互相印证",()=>{
  for(const item of profiles.profiles){
    const m=item.basics.birthday.match(/^(\d{1,2})月(\d{1,2})日$/);
    assert.ok(m,item.name+" 的生日格式不对："+item.basics.birthday);
    assert.equal(item.basics.zodiac,zodiacOf(Number(m[1]),Number(m[2])),
      item.name+" 的星座与生日对不上（要么抄错行，要么星座名写错）");
    assert.match(item.basics.height,/^\d{3}cm$/,item.name+" 身高格式不对");
    assert.ok(["A型","B型","O型","AB型"].includes(item.basics.bloodType),item.name+" 血型非法");
  }
});

test("真实档案：关系字段合法，且客观对称的关系两边都有",()=>{
  const TYPES=["unit_member","friend","rival","senpai","kouhai","family"];
  const known=new Set(characters.characters.map(c=>c.name));
  const index=new Map(profiles.profiles.map(p=>[p.name,p]));
  for(const item of profiles.profiles){
    const seen=new Set();
    for(const rel of item.relationships){
      assert.ok(TYPES.includes(rel.type),item.name+" 的关系类型非法："+rel.type);
      assert.ok(known.has(rel.who),item.name+" 关系指向了不存在的角色："+rel.who);
      assert.notEqual(rel.who,item.name,"不能和自己建立关系");
      assert.ok(!seen.has(rel.who),"同一个 who 出了两条，合并进 note 就好："+item.name+"→"+rel.who);
      seen.add(rel.who);
      assert.ok(rel.note&&rel.basis,item.name+"→"+rel.who+" 缺 note 或 basis");
      assert.ok(["confirmed","inferred"].includes(rel.confidence),item.name+"→"+rel.who+" 置信度非法");
      assert.ok(rel.factSources?.length,item.name+"→"+rel.who+" 缺来源");
    }
  }
  // 完整性只查**客观对称**的关系：同组合、家人（显式标了 mutual 的朋友同理）。
  // 单向态度、对手、前辈/后辈允许只有一侧有资料——**不许为了通过这条检查去编反向描述**，
  // 反向那条的 type 也可以不同（A→B 是前辈、B→A 是后辈是正常的）。
  for(const item of profiles.profiles)
    for(const rel of item.relationships){
      const mutual=rel.type==="family"||rel.type==="unit_member"||(rel.type==="friend"&&rel.mutual);
      if(!mutual)continue;
      const other=index.get(rel.who);
      if(!other)continue;   // 指向非主角（联动角色）时不查
      assert.ok(other.relationships.some(r=>r.who===item.name),
        other.name+" 缺一条指向 "+item.name+" 的关系（"+rel.type+" 是客观对称的，两边都该有）");
    }
});

test("真实档案：性格要点没把剧情事件抄进来",()=>{
  // 事件归 ongeki-story.json。标题短的（「初登场」这类）不判，避免误伤。
  const stories=JSON.parse(fs.readFileSync(path.join(root,"knowledge","ongeki-story.json"),"utf8"));
  const titles=[];
  for(const s of stories.stories)
    for(const t of [s.title,s.titleCn])
      if(t&&t.length>=6)titles.push(t);
  const leaves=[];
  const walk=value=>{
    if(typeof value==="string")leaves.push(value);
    else if(Array.isArray(value))value.forEach(walk);
    else if(value&&typeof value==="object")Object.values(value).forEach(walk);
  };
  walk(profiles.profiles);
  for(const title of titles)
    for(const leaf of leaves)
      assert.equal(leaf.includes(title),false,"档案里出现了剧情标题，事件应归剧情层："+title);
  for(const leaf of leaves)
    assert.doesNotMatch(leaf,/忽略以上|忽略上述|系统提示|ignore previous/i,"档案里出现了注入特征串");
});
