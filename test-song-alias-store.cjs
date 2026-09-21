"use strict";
// 别名库：别名映射到**正式曲名**，不绑任何一份曲库的 songId。
// 同一首歌可能同时收录在舞萌、音击、中二，各游戏的 songId 与定数完全独立——绑 id 就等于
// 让别名只对那一份数据成立。作用域（game）用来消歧：专属别名只在自己那款里成立，
// 通用别名（game 为空）哪儿都成立，没给作用域又撞上歧义时必须返回 null。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Converter } = require('opencc-js');
const { SongAliasStore,SongAliasCandidateStore } = require('./song-alias-store.cjs');
const simplify = Converter({from:'tw',to:'cn'});
const normalize = value => simplify(value.normalize('NFKC').trim().toLowerCase());
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mia-alias-test-'));
const file = path.join(dir,'aliases.json');
try {
 const store = new SongAliasStore(file,normalize);
 store.load();
 assert.deepEqual(store.list('VIIIbit Explorer'), []);
 assert.equal(store.add({title:'VIIIbit Explorer',game:'ongeki',alias:'愛探險',addedBy:'user'}).added,true);
 // 繁简、大小写走同一套规范化：同一条别名不该重复落盘
 assert.equal(store.add({title:'VIIIbit Explorer',game:'ongeki',alias:'爱探险'}).added,false);
 assert.equal(store.matches('VIIIbit Explorer',normalize('爱探'),'ongeki'),true);
 assert.equal(store.matches('VIIIbit Explorer',normalize('爱探'),'ongeki',true),false);
 // 同一条别名挂到另一首歌：共存，不是重复——那正是人工复核时要看的冲突
 store.add({title:'另一首曲子',game:'ongeki',alias:'愛探險',addedBy:'other'});

 // ── 作用域 ────────────────────────────────────────────────────────
 store.add({title:'Dengeki Tube',game:'chunithm',alias:'电管'});
 store.add({title:'通用曲',alias:'大家伙'});
 assert.equal(store.lookup('电管','chunithm').title,'Dengeki Tube');
 assert.equal(store.lookup('电管','ongeki'),null,'别的游戏专属的别名不能在音击作用域里命中');
 assert.equal(store.lookup('电管').title,'Dengeki Tube','没给作用域时它只有一种结果，可以用');
 assert.equal(store.lookup('大家伙','maimai').title,'通用曲','通用别名在任何游戏下都成立');

 // ── 歧义 ──────────────────────────────────────────────────────────
 store.add({title:'甲曲',game:'ongeki',alias:'叫法'});
 store.add({title:'乙曲',game:'chunithm',alias:'叫法'});
 assert.equal(store.lookup('叫法','ongeki').title,'甲曲','给了作用域就按作用域走');
 assert.equal(store.lookup('叫法','maimai'),null,'作用域里没有这条别名，也不能回退到别的游戏上');
 assert.equal(store.lookup('叫法'),null,'没作用域又撞歧义时绝不许任选一个');
 // 反查（#是什么歌）和解析是两种操作：反查列全部候选给人看，解析撞歧义必须 null
 assert.deepEqual(store.names('叫法').map(n=>n.title).sort(),['乙曲','甲曲']);
 assert.deepEqual(store.names('叫法','ongeki').map(n=>n.title),['甲曲'],'反查同样按作用域过滤');
 assert.deepEqual(store.names('叫法','maimai'),[]);
 // 同名不同游戏（同一首歌两边收录）：曲名一致就不算歧义，游戏数据靠下游曲库各自区分
 store.add({title:'跨游戏曲',game:'ongeki',alias:'双收录'});
 store.add({title:'跨游戏曲',game:'chunithm',alias:'双收录'});
 assert.equal(store.lookup('双收录').title,'跨游戏曲');

 // ── 裁决层要的别名表 ──────────────────────────────────────────────
 // 定数裁决层拿它在模型那句话里认曲名（模型会照着用户的话写「电管」）。只收唯一的
 // 「别名→曲名」：歧义别名整条丢掉，拿它认曲名会把定数改到另一首歌上。
 const byAlias = Object.fromEntries(store.titleIndex().map(item => [item.alias, item.title]));
 assert.equal(byAlias['电管'],'Dengeki Tube');
 assert.equal(byAlias['大家伙'],'通用曲','通用别名也进表');
 assert.equal(byAlias['双收录'],'跨游戏曲','同一首歌的两条游戏专属别名不算歧义');
 assert.equal('愛探險' in byAlias,false,'同一个叫法落到两首曲子：歧义，不能进裁决表');
 assert.equal('叫法' in byAlias,false,'换游戏的作用域消歧那是解析的事，裁决表不替它选');

 // ── 落盘与原子写 ──────────────────────────────────────────────────
 const reload = new SongAliasStore(file,normalize);
 reload.load();
 assert.deepEqual(reload.list('VIIIbit Explorer','ongeki'),['愛探險']);
 assert.equal(reload.lookup('電管','chunithm').alias,'电管','重载后作用域仍然生效');
 for(const invalid of ['', '  ', 'id870', '８７０', 'x'.repeat(81), 'a​b']) assert.throws(()=>store.add({title:'X',alias:invalid}));
 assert.throws(()=>store.add({alias:'没曲名'}),/曲名/);
 const before = fs.readFileSync(file,'utf8');
 const rename = fs.renameSync;
 try {fs.renameSync = () => {throw Error('simulated disk failure');}; assert.throws(()=>store.add({title:'VIIIbit Explorer',alias:'failed write'})); assert.throws(()=>store.remove('爱探险','VIIIbit Explorer')); }
 finally {fs.renameSync = rename;}
 assert.equal(fs.readFileSync(file,'utf8'),before,'写失败不能动原文件');
 assert.equal(store.matches('VIIIbit Explorer','failed write','ongeki'),false);
 assert.equal(store.matches('VIIIbit Explorer',normalize('爱探险'),'ongeki',true),true);
 assert.equal(store.remove('爱探险','VIIIbit Explorer').removed,true);
 assert.equal(store.remove('爱探险','VIIIbit Explorer').removed,false);
 reload.load();
 assert.deepEqual(reload.list('VIIIbit Explorer','ongeki'),[]);
 assert.deepEqual(reload.list('另一首曲子','ongeki'),['愛探險'],'删别名只能删指定曲目下的那条');

 // ── 两个进程共用一份别名文件 ──────────────────────────────────────
 // 梨绪（qq/qq-entry.cjs）和美亚（qq-official/）是两个独立进程、共用同一份别名文件，
 // 而 entries 只在启动时 load 一次。以前每次改动都是拿这份内存副本整个覆盖回盘：
 //   梨绪内存 [A]   美亚内存 [A]
 //   梨绪加 B → 盘 [A,B]
 //   美亚加 C → 盘 [A,C]   ← B 没了
 const shared = path.join(dir,'shared.json');
 // 读侧刷新带 250ms 节流（理由见 REFRESH_THROTTLE_MS：matches 会被按曲库逐首调用，
 // 不能每读一次就 stat 一次文件）。要断言「看得见另一个进程刚写的」，先等过一个窗口。
 // 写入不受节流约束——transaction 永远先读盘，所以下面写路径的断言不用等。
 const waitRefresh = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,300);
 const leo = new SongAliasStore(shared,normalize); leo.load();
 const mia = new SongAliasStore(shared,normalize); mia.load();
 assert.equal(leo.add({title:'甲曲',game:'ongeki',alias:'甲叫法'}).added,true);
 assert.equal(mia.add({title:'乙曲',game:'ongeki',alias:'乙叫法'}).added,true);
 const disk = new SongAliasStore(shared,normalize); disk.load();
 assert.deepEqual(disk.list('甲曲','ongeki'),['甲叫法'],'交替写盘：先写的那条不能被后写的进程覆盖掉');
 assert.deepEqual(disk.list('乙曲','ongeki'),['乙叫法']);
 // 读侧刷新：另一个进程写完之后，本进程不重建实例也该看得见
 waitRefresh();
 assert.deepEqual(leo.list('乙曲','ongeki'),['乙叫法'],'美亚写的记录，梨绪的读方法要看得见');
 assert.deepEqual(mia.names('甲叫法').map(n=>n.title),['甲曲']);
 assert.equal(mia.lookup('甲叫法','ongeki').title,'甲曲');
 assert.equal(Object.fromEntries(leo.titleIndex().map(i=>[i.alias,i.title]))['乙叫法'],'乙曲','裁决表也要跟着刷新');
 // 关键用例：删掉的条目绝不能被另一个进程的过期副本复活
 // （「重新读盘再和内存合并」那种改法正是死在这里）
 assert.equal(leo.remove('甲叫法').removed,true);
 assert.equal(mia.add({title:'丙曲',game:'ongeki',alias:'丙叫法'}).added,true);
 disk.load();
 assert.deepEqual(disk.list('甲曲','ongeki'),[],'删掉的别名不能被另一个进程的旧内存副本复活');
 assert.deepEqual(disk.list('丙曲','ongeki'),['丙叫法'],'删除之后的正常写入也不能被误伤');
 // 同一进程重入：盘上已经有别人加的同名别名时，判重也要认出来
 assert.equal(mia.add({title:'甲曲',game:'ongeki',alias:'甲叫法'}).added,true);
 assert.equal(leo.add({title:'甲曲',game:'ongeki',alias:'甲叫法'}).added,false,'另一个进程刚加的同名别名要判成重复');

 // 候选库同理：两边共用同一份候选文件，判重、上限、序号定位都按盘上最新那份算
 const sharedCandidates = path.join(dir,'shared-candidates.json');
 const candLeo = new SongAliasCandidateStore(sharedCandidates,normalize); candLeo.load();
 const candMia = new SongAliasCandidateStore(sharedCandidates,normalize); candMia.load();
 assert.equal(candLeo.add({alias:'候甲',title:'甲曲',proposedBy:'10001'}).added,true);
 assert.equal(candMia.add({alias:'候乙',title:'乙曲',proposedBy:'10002'}).added,true);
 waitRefresh();
 assert.equal(candLeo.list().length,2,'候选库读侧要刷新');
 assert.equal(candMia.add({alias:'候甲',title:'甲曲',proposedBy:'10002'}).added,false,'另一个进程提过的候选不能再记一遍');
 assert.equal(candLeo.remove('1').removed,1,'序号按盘上最新的列表数，不能用过期的内存副本');
 waitRefresh();
 assert.deepEqual(candMia.list().map(item=>item.alias),['候乙'],'驳回一条不能连另一个进程的候选一起冲掉');

 // ── 锁：崩溃残留要自愈，完成后一个都不许留下 ──────────────────────
 const lockPath = shared + '.lock';
 assert.equal(fs.existsSync(file+'.lock'),false,'前面模拟写盘失败的那两次也不能把锁留下');
 // 进程异常退出会留下永久锁，之后每次别名写入都失败，现场症状是「别名功能莫名其妙
 // 不能用了」——过期的锁必须当成崩溃残渣摘掉
 fs.writeFileSync(lockPath,JSON.stringify({pid:999999,createdAt:Date.now()-60000}));
 assert.equal(leo.add({title:'丁曲',game:'ongeki',alias:'丁叫法'}).added,true,'过期的锁要自愈，不能把写入永久卡死');
 assert.equal(fs.existsSync(lockPath),false,'成功之后不能留下锁文件');
 // 读不出内容的锁（空文件、半个 JSON、被别的文件占了名字）同样按残渣处理
 fs.writeFileSync(lockPath,'这不是 JSON');
 assert.equal(mia.add({title:'戊曲',game:'ongeki',alias:'戊叫法'}).added,true,'读不出内容的锁也当残渣清掉');
 assert.equal(fs.existsSync(lockPath),false);
 // mutator 抛错时也要放锁（finally），否则一次异常就把写入永久锁死
 assert.throws(()=>leo.transaction(()=>{throw Error('mutator 炸了');}),/mutator 炸了/);
 assert.equal(fs.existsSync(lockPath),false,'mutator 抛错也要放锁，否则之后永远写不进去');
 // 写盘失败（rename 挂掉）时同样不能留锁
 const renameBefore = fs.renameSync;
 const failing = path.join(dir,'shared-fail.json');
 const failingStore = new SongAliasStore(failing,normalize); failingStore.load();
 try {fs.renameSync = () => {throw Error('simulated disk failure');}; assert.throws(()=>failingStore.add({title:'己曲',alias:'己叫法'}));}
 finally {fs.renameSync = renameBefore;}
 assert.equal(fs.existsSync(failing+'.lock'),false,'写盘失败也要放锁');
 assert.equal(failingStore.add({title:'己曲',alias:'己叫法'}).added,true,'放锁之后还能继续写');
 // 锁被一个真在写的进程占着时，等待必须有上限，不能把命令吊死
 fs.writeFileSync(lockPath,JSON.stringify({pid:process.pid,createdAt:Date.now()}));
 const waitStart = Date.now();
 assert.throws(()=>leo.add({title:'庚曲',game:'ongeki',alias:'庚叫法'}),/等待超时/,'抢不到锁要有界地失败并说清原因');
 assert.ok(Date.now()-waitStart < 30000,'超时要有界，不能无限等下去');
 fs.unlinkSync(lockPath);
 assert.equal(leo.add({title:'庚曲',game:'ongeki',alias:'庚叫法'}).added,true);
 assert.deepEqual(fs.readdirSync(dir).filter(name=>/\.(lock|tmp|stale)$/.test(name)),[],'任何一步都不能留下锁文件、临时文件或残渣');

 // ── version 1 迁移 ────────────────────────────────────────────────
 const legacy = path.join(dir,'legacy.json');
 fs.writeFileSync(legacy,JSON.stringify({version:1,entries:[{songId:870,alias:'老别名',addedBy:'u',addedAt:'2026-01-01'}]}));
 const resolveSong = (id) => Number(id) === 870 ? {title:'VIIIbit Explorer',game:'ongeki'} : null;
 const migrated = new SongAliasStore(legacy,normalize,{resolveSong});
 migrated.load();
 assert.deepEqual(migrated.list('VIIIbit Explorer','ongeki'),['老别名'],'旧文件按 songId 存的别名要能换回曲名');
 migrated.add({title:'新曲',alias:'新别名'});
 assert.equal(JSON.parse(fs.readFileSync(legacy,'utf8')).version,2,'写回时统一成 version 2');
 // 认不出的 songId：宁可报错也不静默丢数据
 fs.writeFileSync(legacy,JSON.stringify({version:1,entries:[{songId:999999,alias:'孤儿别名'}]}));
 assert.throws(()=>new SongAliasStore(legacy,normalize,{resolveSong}).load(),/找不到/);

 fs.writeFileSync(file,'broken json');
 assert.throws(()=>reload.load(),/原文件未修改/);
 // 读方法也要照抛：refresh 会先 load，文件坏了就照实报错，不能拿内存里的旧副本装作没事
 // （宁可让人看见「文件坏了」，也别继续用过期数据回答）
 assert.throws(()=>reload.list('VIIIbit Explorer','ongeki'),/原文件未修改/);
 assert.equal(fs.readFileSync(file,'utf8'),'broken json');
 console.log('歌曲别名库测试通过');
} finally { fs.rmSync(dir,{recursive:true,force:true}); }
