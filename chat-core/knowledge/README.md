# 音游曲库接入（2026-09-16）

聊天现在可以先输出内部 `knowledgeQuery`，由程序筛选本地曲库，把结果返回模型，再生成最终回复。查询不需要用户绑定查分账号，也不会向群里发送中间消息。QQ、Discord 共用这条代码路径。

## 数据

- 音击：从项目根目录 `ongeki-song-catalog.json` 提取未标记删除的谱面。当前源文件更新时间为 2026-08-24。
- 舞萌、中二：从水鱼公开 `music_data` 接口获取，无需登录或玩家数据。接口文档：https://maimai.diving-fish.com/manual/docs/developer/zh-api-document/
- 每个快照保存来源、抓取时间和来源更新时间（未提供则为 null）。`version` 是原数据的曲目版本字段，不是证明当前机台版本的字段。
- 当前快照不提供可靠的手法、体感难度或推荐标签。不能由定数/BPM推断“节奏简单”“适合连打”。也不保证特定地区当前仍有该曲。

## 更新

在项目根目录运行 `node chat-core/update-knowledge.cjs`，然后重新启动 Bot。需要 Node.js 自带 fetch 和外网连接。更新脚本先获取、转换全部数据，再逐文件原子替换；联网失败不会写入半截下载内容。运行时仅读本地快照，不自动访问外网。

## 角色曲目索引（2026-09-17）

`ongeki-characters.json` 是「音击角色 ↔ 曲目」索引，用来回答「某角色（包括梨绪自己）有哪些曲 / 原创曲 / 个人曲」。它由 `node chat-core/update-characters.cjs` 生成，输入是三份数据：

- 本地曲库快照：`ongeki-music-internal.json` 的对战相手（`boss`）与「歌：」署名，分类取自 `ongeki-song-catalog.json`。
- `../knowledge/ongeki-character-notes.json` 里的 `personalSongs`：萌娘百科各角色条目写明的「个人曲」，一人一首。柏木美亜、皇城セツナ 没有可靠来源，留空，不能编。
- 同一文件里的 `jacketNotes`：**人工逐张看图**核对过的曲绘判定，覆盖 155 首「分类是 オンゲキ、但没有演唱者署名」的曲子 —— 这批光看数据分不出曲绘上有没有角色。另有 `uncertainResolved`，记那几首当初判定没把握、后来由用户逐首确认过的曲子。

口径：

- 她的曲＝对战相手是她，或「歌：」署名里有她（合唱曲的对战相手可能挂在别的成员身上）。
- 原创曲＝上面这批里，分类为 **オンゲキ**，且曲绘不是「纯设计图/logo」。版权曲/联动曲以及チュウマイ/VARIETY 等移植曲不算原创曲。
- 曲绘判定只用来排除**纯设计图/logo**：同一个角色换了色调或战斗装，看图很容易认成别人（梨绪的 `Ai C`、`Selenadia`、`淵底のグレイ・ユークロニア`、`MEGATON BLAST (tpz Overcute Remix)` 都被我误判成外注插画，用户逐首确认过其实都是她的）。所以「像别人的插画」不再作为排除依据。
- 有演唱者署名的曲子，曲绘按「即演唱者」处理，没有再逐张看图。

改曲绘判定时：编辑 `ongeki-character-notes.json`，再跑一次 `update-characters.cjs`。曲绘图源是 `https://norca0721.github.io/otoge-db/ongeki/jacket/<曲库里的 image_url>`（190×190）。

发布到 public-bot 时，新增的 `ongeki-characters.json`、`ongeki-character-notes.json` 和 `update-characters.cjs` 要在 public-bot 里手动 `git add` —— `publish.js` 只自动带 `chat-core/*.cjs`，`knowledge/` 下的文件靠公开仓库的索引同步。

分发 QQ EXE 时保留其上一级的完整 `chat-core` 目录，包括 `knowledge/*.json`。Discord 同样需要配置指向的 `chat-core` 目录。不要只复制 EXE。

## 原作剧情索引（2026-09-18）

`ongeki-story.json` 是「原作剧情事件」索引，用来回答「某角色在哪段剧情登场 / 和谁做过什么 / 某章剧情是什么」。它解决的是线上的一条错答：问「你之前是不是和 akari 打过真人 cs」，梨绪答「没有的事！我哪跟明里打过真人CS」——而原作里确实有，是 2020 年 10 月的银宝石活动 **ONE BULLET LEFT**（学生会长茜在体育祭搞的真人 CS，梨绪和新手明里搭档成「無敵のツーマンセル」双人组，险胜茜）。

为什么单独一层：这类问题**表面是 self，实质是可由原作验证的事实**。self 意图硬禁止联网是为了防角色扮演乱搜，这一条被同一道闸门连坐；本地又没有可查的剧情层，模型只能凭印象否认。所以 canon 与 self/roleplay 分开：命中本地就直接按事实作答，本地缺失或只有弱命中时才走拆分通道联网。

**两条置信度轴互不相通**：

- `factConfidence` / `factReviewed` —— 事件本身。多源交叉 / 单源或推断；以及是否经人过目。
- `quoteRefs[].mappingConfidence` / `mappingReviewed` —— 「这批台词属于这个事件」。

事件由官方页 + wiki 多源确认，**不**意味着某批台词→该事件的映射也被确认。运行时信任等级由两轴合成三档：`human`（人工过目）＞ `source`（多源确认）＞ `inferred`（单源或推断）。

**素材只存一份**：台词正文只住在 `../quotes.json`，剧情层只用 `quoteRefs` 引用 id，不复制正文。同一份原作素材同时服务 persona（提炼说话方式）与 canon（提炼客观事件事实），两边视角不同、互不替代。

**联网查到的新剧情不自动入库**：先写进 `ongeki-story-candidates.json`（`lore.cjs` 永不加载它），再用下面这条命令逐条过目。玩家二创和 wiki 错漏一旦写进索引就洗不掉了，而这一层的输出会被当成事实讲给群里听。

```
node chat-core/lore-review.cjs                          列出 canon 条目与待审候选
node chat-core/lore-review.cjs --confirm <id>           事实部分标为人工确认
node chat-core/lore-review.cjs --confirm-quotes <id>    台词归属标为人工确认
node chat-core/lore-review.cjs --approve <id>           候选入库
node chat-core/lore-review.cjs --reject <id> --why 理由   候选驳回
```

它只把 `*Reviewed` 从 `null` 升级，**从不改 `*Confidence`** —— 推断就是推断，人工过目加的是另一条轴。候选入库前要过形状检查：没有 `factSources` 的条目不能算事实，没有 `aliases` 的条目用户永远问不到。

发布到 public-bot 时，新增的 `ongeki-story.json` 与 `ongeki-story-candidates.json` 同样要在 public-bot 里手动 `git add`。

## 角色档案（2026-09-18）

`ongeki-profiles.json` 是「原作其他角色是谁」的资料层，回答「井之原小星是个什么样的人」「彩华的性格」「有栖和枫是什么关系」。它解决的是线上的一条**静默失败**：这类问题在程序侧没有任何分支接收——`research-policy.cjs` 的「人设自述」闸门只管梨绪自己（`selfSubject` 只含 `你|您|梨绪|梨緒|takase`），`loreClassify` 只认「剧情/章节/一起做过什么」这类事件结构。于是模型只能凭训练印象答（中文译名、组合归属、性格概括都容易串），或者说一句「我不认识这个人」。后者更麻烦：`uncertainty` 词表里有「不认识」，会触发按**用户原句**的兜底检索，而那条路又常被 roleplay/self 的硬闸门掐掉——既不查也不纠正。

收录原作 17 名主角（7 个组合），**含高濑梨绪本人**：数据层不缺口人，运行时由 `self` 排除注入。她的人设以 `../persona.md` 为唯一真相源，档案是第三人称资料，注入给她自己会把第一人称演出变成念设定集。反过来，她在文件里也有用：别人档案里的「与高瀬梨緒同属⊿TRiEDGE」需要她作为角色名存在。

### 来源优先级：官方 > wikiwiki > 萌娘百科

| 来源 | 覆盖 |
|---|---|
| SEGA 官方角色页 `ongeki.sega.jp/character/<id>/` | `basics`（学年/生年月日/星座/血液型/身長）与 `profile.traits`。数据**内联**在页面 HTML 的 `window.charaDetail` 里，不需要执行 JS。角色 id 与官方名册 `assets/js/character.bundle.js` 对齐，注意有 URL 与 charaId 互换的两对（小星/楓、美亜/つむぎ），抓取要用名册的 `url` 字段 |
| wikiwiki `wikiwiki.jp/gameongeki/<日文名>` | 官方站**没有**的 `extras`：属性/武器、游戏内档案问答。该站有速率限制，采集要串行 + 间隔 3~5 秒，连发第 7 个请求就开始 429 |
| 萌娘百科 `zh.moegirl.org.cn/<简体名>` | 中文译名、中文星座名、亲属或相关人、中文简介；个人资料表可作为 wikiwiki 问答的交叉核对。API 只开放 `prop=extracts`（`action=parse`/`prop=revisions` 均 `action-notallowed`），而正文 extract **丢掉表格**，要档案数据必须解析 HTML |

### 置信度按块记，块边界就是来源边界

`basics` / `profile` / `extras` 三块各自带 `factConfidence` 与 `factSources`，`relationships[]` 每条独立。口径：

- `confirmed` ＝ **SEGA 官方一手资料（单源即可）**，或非官方来源有两个以上独立来源一致；
- `inferred` ＝ 单一 wikiwiki/萌娘百科来源，或策展推断；
- **块按块内最弱的一项定级**。`extras` 里的 attribute/weapon 官方站与萌娘百科都没有、只有 wikiwiki 单源，所以整块恒为 `inferred`；游戏内问答即使被萌娘百科个人资料表印证，也随该块保持 `inferred`。

不做字段级：同一块内的字段天然同源（官方一页同时给出五个档案字段，游戏内问答都在 wikiwiki 同一段）。测试会把这条口径变成可执行断言——标 `confirmed` 的块必须要么含 `ongeki.sega.jp`，要么含两个以上不同域名。

**extras 的键名照日文原义**，不要按中文语感改：`weakPoints` 对应「苦手なもの」（怕／不拿手），**不是** `dislikes`（嫌い）。梨绪那条就是反例——她写的是「猫」，原文却是「猫ちゃん大好きなのに、アレルギーで触れない」，译成 dislikes 会被读成「讨厌猫」，正好撞上 `persona.md` 明令禁止的写法。同理 `likes` 对应「好きなもの」。

运行时 payload 里 **trust 跟着块走，不塌缩成一个数**：否则 `extras` 的 `inferred` 会把官方确认的生日一起拖成「语气留余地」。这与 lore 层「两条置信度轴互不相通」是同一条教训。

### 两条数据纪律

- **不重复存** `aliases`/`songs`/`unit`/`cv`：别名与曲目在 `ongeki-characters.json`，组合与 CV 运行时 join。测试用键白名单卡死。事件与剧情归 `ongeki-story.json`，本文件不重复。
- **关系完整性只查客观对称的那些**：`type` 为 `family` / `unit_member`（或显式标 `mutual: true` 的 `friend`）时，两边都必须有；单向态度、`rival`、`senpai`/`kouhai` 允许只有一侧有资料。**不许为了通过检查去编反向描述**，反向那条的 `type` 也可以不同（A→B 是前辈、B→A 是后辈是正常的）。

### 单字简称走两道闸门

`characters.json` 里有 7 个规范化后长度为 1 的别名，被 `knowledge.cjs` 的长度下限挡在索引之外，`charactersInText` 永远认不出来：主角 5 个（茜/枫/葵/纺/椿）外加非主角的光/橙。档案层**从 `characters.json` 投影**出这份单字表（不是第二套别名表，测试卡住这条），同字落到两个角色时整条丢弃。

两道闸门相与：① 整句要像在问人（`性格|什么样|怎么样|是谁|介绍|关系|生日|…`）；② 命中位置的左右邻字不能组成常见词（`日葵|香椿|枫叶|纺织|茜草|…`）。单靠①会被「介绍一下向日葵」打穿，单靠②会被没见过的词打穿。残余误命中在 payload 里标 `match:'solo'` 并让模型「不确定就先问一句」——认错的代价是一句反问，不是错误回答。

### 人工轴与策展日期

- `factReviewed` 是**人工过目轴**，与来源轴互相独立，初始 `null`。这一层只有 17 条，目前靠直接改文件，没有配 review CLI（那套是给持续入库的剧情候选用的）。
- 顶层用 `curatedAt` 记**策展日期**；`reviewedAt` 在人工过目前保持 `null`，不要写成已审核日期。

### 改数据时

`basics` 的五个字段可以直接从官方页的 `description[1]` 解析（形如 `学年：高校3年生／生年月日：4月1日／星座：おひつじ座／血液型：B型／身長：155cm`），中文星座名取自萌娘百科、缺条目时按 `おひつじ座→白羊座` 这类固定映射。测试会用本地星座边界表反查生日与星座是否互相印证。

发布到 public-bot 时，`knowledge/ongeki-profiles.json` 同样要在公开仓库手动 `git add`。

## 术语层（游戏基础知识，2026-09-18）

`{game}-terms.json`（maimai / chunithm / ongeki 各一份）是**版本、版本俗称、难度叫法、玩家黑话、游戏机制**这一层。它解决的是曲库答不了的一类问题：曲库只认曲名和谱面字段，而玩家真正在用的词是「真超檄」「堇代」「DX Rating」「N10」这些。线上实测两次踩坑：①「堇代有哪些 BPM200、定数14.2 的歌」——版本约束被整个丢掉，模型只能肉眼翻页（而且曲库查询当时既不支持 version 也不支持 bpm 过滤，现在两样都有了）；② 上一轮用户刚解释过「真超檄」是四个版本的合称，模型当轮答对了，下一轮又写「真超檄这首」。

**数据从哪来**：`tools/gen-terms.cjs` 从本地快照的 `version` 字段生成版本条目骨架（名称逐字一致、曲目数来自快照），俗称与组合称呼是人工补的，**只收稳定可验证的**：`version` 条目的 `catalogVersions` 必须是快照里真实存在的 version 值（`terms.test.cjs` 有断言守着这条），`version_group` 的成员逐个同理。机制条目**必须带 `sources`**（测试也会拦）——写错比查不到更糟，这层的输出会被当成事实讲给群里听。发行日期与世代先后还没收录（需要来源，留给下一批）。

**三条边界**（写在 `../terms.cjs` 顶部，改动前先读）：

1. **只收稳定可验证的**。长尾口语走会话 glossary，不进正式库——堆关键词维护不动，还会把「简单」「水」这类普通词抢成术语。
2. **confirmed 术语的精确命中优先于曲名猜测**，尤其 version/version_group 命中之后不得再解释成 song；但**弱匹配不抢占**（子串、模糊不算命中，`matchTerms` 只认逐字别名 + ASCII 词边界）。
3. **机制不做语义推断**：`../term-guard.cjs` 只做实体类型约束（「真超檄这首歌」这种把它当歌的说法），不判断「定数 14.2 合不合理」。

**会话 glossary**：用户当场说「X 指的是 Y」「A/B/C 合称 X」「不是 X，是 Y」时，程序只从这些**明确的定义/纠正句式**里提取（普通提及不学），而且目标必须能在本地验证（版本名在快照 version 集合里、曲名在曲名索引里）。学到的东西**只在当前 guild:channel:user 会话生效**（挂在会话记录上，上限 20 条），同时交一条候选给 `qq/data/term-candidates-qq.json`——**不自动写进正式库**，永久化要人工把条目补进 `{game}-terms.json`。

**曲库侧的配套**：`lookup` 现在支持 `version`（字符串或数组）与 `bpm` 过滤；用户句子里命中版本术语时，`chat.cjs` 会把版本字符串自动补进曲库查询（模型自己给了 version 就以它为准）。搜索侧：来源相关性过滤接受**游戏标识 + 正式名/中文名/官方日文名/别名任一项**，避免中文俗称把真正的官方来源误杀。

**条目字段约定**（2026-09-18 补，越往后越容易踩）：

| 字段 | 用途 | 规矩 |
|---|---|---|
| `aliases` | 常规俗称 | 只收**完整称呼**（「紫代」可以，「紫」不行——会撞「紫谱」） |
| `requiresGameAliases` | 容易误命中的短副标题（CHUNITHM 的 `NEW`/`SUN`/`AIR`/`STAR`、`Mate`） | 只在**有可靠游戏上下文**时命中：当前句点名了这款游戏，或最近几轮对话已有明确的那一款（`matchTerms` 的 `game` 参数）。没有上下文宁可不命中 |
| `catalogAvailable:false` + `catalogVersions:[]` | 认得、但本地快照没有这一代的数据 | 命中时程序三层拦截（提示词 + 查询结果 `versionGap` + 程序兜底句），**必须明说不能按它筛曲目**，不许静默忽略 |
| `mappingConfirmed:false` | 地区版本名（国服按年份命名）与日版哪一代**没有权威对照** | 可以认识这个名字；涉及日版版本筛选时必须说明对应关系未确认，不许替它映射 |
| `region:"cn"` | 国服合并代（熊华/爽煌/宙星） | 组合的 `members` 含快照里没有的那一代，`catalogVersions` 只含有数据的那半；**单说「熊代」仍只指 でらっくす** |
| `disputed:true` + `claims:[{text,sources,appliesTo}]` | 资料互相矛盾的机制（解禁条件、库存上限…） | **不许强选一个当定论**，按多条说法存，每条带来源与适用版本 |
| `asOf` | 会变的数据（最高定数、地图格数口径） | 标清是哪个版本/时点的说法 |

`+` 在匹配里是**独立判据**：`normalize` 会抹掉标点，不单独判的话「NEW+」会退化成裸 `NEW`（实测踩过）。别名带 `+` 时要求原文里真的有 `+`，且同一段文字被多条命中时**原始别名长的赢**（`SUN+` 优先于 `SUN`）。

## 范围与后续

已实现精确等级/难度筛选、曲名与ID查询、舞萌 SD/DX 区分、两轮检索上限，以及纯文本降级时保留检索依据。13 和 13+ 不混用。未知别名可能匹配失败，当前没有完整三游戏别名表。

本地曲库本身仍不是攻略知识库：它只有可结构化确认的事实，没有手法、体感、版本历史和有证据的推荐标签。攻略、手法、社区评价这些本地查不到的内容由联网搜索补上，见 `../SEARCH.md`。补充资料时应记录游戏、地区、适用版本、来源URL和核对日期，并区分事实与玩家评价。

真实模型验证采用直接 API 调用，没有往 QQ/Discord 群发送测试消息。

个人成绩推荐保护：识别“我没鸟过／没打过／未SSS”等筛选请求后，程序先检查绑定和他人成绩权限，并直接说明个人筛选尚未接入，禁止退化成公共曲库推荐。短句追问沿用该限制；用户明确改为普通推荐后才恢复公共曲库查询。绑定状态不会作为已读取成绩的证据。
