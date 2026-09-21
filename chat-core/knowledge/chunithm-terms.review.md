# CHUNITHM 版本与术语 · 人工复核表

**已按 2026-09-18 的决定写入 `chunithm-terms.json`**（`tools/gen-terms.cjs` 统一产出）。落实情况：

- ✅ 独特副标题正常收（`PARADISE` / `PARADISE LOST` / `LUMINOUS` / `CRYSTAL` / `AMAZON` / `VERSE` / `X-VERSE`）。
- ✅ 短副标题走 `requiresGame`：`AIR` / `STAR` / `NEW` / `SUN` 只在「当前句点名了这款游戏」或「最近几轮已有明确的那一款」时才算命中——`AIR` 同时是曲名，实测无上下文时不再误命中。
- ✅ `PLUS` 单独不作别名，只有 `NEW PLUS` / `SUN PLUS` / `AIR PLUS` … 这类完整复合名才映射；`+` 形式也收（`NEW+` / `SUN+`）。
- ✅ 国服年份版（`中二节奏 NEW / 2024 / 2025`）保留并登记，标 `mappingConfirmed:false`，条目里写明「与日版对应没有权威对照」。
- ✅ `ULTIMA = 黑谱` 与 WORLD'S END 基础机制已按来源补进正式库；绿/黄/红/紫/黑五档俗称齐了。
- ✅ 三处互相矛盾的机制（ULTIMA 解禁条件、课题曲库存上限、最高定数说法）**没有强选一个**，按 `disputed: true` + 多条 `claims`（每条带来源与适用版本）存。
- ✅ 会变的数据带 `asOf` 或适用版本说明（最高定数 15.7、地图格数口径等）。
- ✅ 快照缺失的版本（`X-VERSE-X`、`Mate`、`SUPERSTAR`、`SUPERSTAR PLUS`、`中二节奏 2026`）按 `catalogAvailable:false` 登记。

下表保留原始调研记录，后续复查用它对照。

## 和 maimai 的关键差别（先说这个，它影响后面所有判断）

CHUNITHM **没有 maimai 那种「单字代」体系**。社区直接用**副标题本身**称呼版本（NEW、SUN、LUMINOUS、VERSE），PLUS 版写 `+`（NEW+、SUN+）。区分硬件世代用的是**框体**：**银框体**（PARADISE LOST 及以前，2023-02-01 停服）、**金框体**（NEW 起）。所以这一层能落库的是「副标题 / 副标题+ / 框体」，不是「X代」。

⚠️ 但这里有个**实现层面的坑**：`NEW`、`SUN`、`AIR`、`STAR` 这些短词当别名非常危险——`AIR` 同时也是曲名，`NEW`/`SUN` 是普通英文词，术语层的匹配按子串 + 词边界，收了它们必然误命中。**建议只收复合形式（`NEW PLUS`/`SUN PLUS`/`AIR PLUS`…）与足够独特的副标题（PARADISE、LUMINOUS、VERSE…），裸的 NEW/SUN/AIR/STAR 先不收**——除非给术语层加一个「这个别名只在对话里点名了这款游戏时才生效」的开关（要单独做，见文末待定项 3）。

## 一、版本（23 条，基准＝快照 version 字段）

| # | 正式版本名（canonical） | 社区常用叫法 | 建议 aliases | 来源 | 歧义／备注 |
|---|---|---|---|---|---|
| 1 | `CHUNITHM` | 初代 / 无印 | — | 萌娘百科 CHUNITHM、chunithm.fandom 游戏简介 | 无印是通称，不建议当别名（任何游戏的初代都能叫无印） |
| 2 | `CHUNITHM PLUS` | PLUS | — | 同上 | ⚠ 裸 `PLUS` 不能收（所有 PLUS 版本共用这个词） |
| 3 | `CHUNITHM AIR` | AIR | — | 同上 | ⚠ `AIR` 与曲名/AIR 音符冲突，建议不收裸词 |
| 4 | `CHUNITHM AIR PLUS` | AIR+ / AIR PLUS | AIR PLUS、AIR+ | 同上 | 复合形式安全 |
| 5 | `CHUNITHM STAR` | STAR | — | 同上 | ⚠ 同 AIR，裸词不收 |
| 6 | `CHUNITHM STAR PLUS` | STAR+ | STAR PLUS、STAR+ | 同上 | 复合形式安全 |
| 7 | `CHUNITHM AMAZON` | AMAZON | AMAZON | 同上 | 足够独特，可收 |
| 8 | `CHUNITHM AMAZON PLUS` | AMAZON+ | AMAZON PLUS、AMAZON+ | 同上 | 复合形式安全 |
| 9 | `CHUNITHM CRYSTAL` | CRYSTAL | CRYSTAL | 同上 | 可收 |
| 10 | `CHUNITHM CRYSTAL PLUS` | CRYSTAL+ | CRYSTAL PLUS、CRYSTAL+ | 同上 | 复合形式安全 |
| 11 | `CHUNITHM PARADISE` | PARADISE | PARADISE | 同上 | 可收 |
| 12 | `CHUNITHM PARADISE LOST` | PARADISE LOST / PL | PARADISE LOST | 同上 | ⚠ `PL` 两字母太短易误命中，建议不收；`PARADISE` 会同时命中这一代（长的优先，实际按整名匹配） |
| 13 | `CHUNITHM NEW` | NEW / NEW!! | — | 萌娘百科、chunithm.fandom | ⚠ 裸 `NEW` 是普通英文词，**强烈建议不收**；国服版名是「中二节奏 NEW」 |
| 14 | `CHUNITHM NEW PLUS` | NEW+ / NEW PLUS | NEW PLUS、NEW+ | 同上 | 复合形式安全 |
| 15 | `CHUNITHM SUN` | SUN | — | 同上 | ⚠ 裸词不收 |
| 16 | `CHUNITHM SUN PLUS` | SUN+ | SUN PLUS、SUN+ | 同上 | 复合形式安全 |
| 17 | `CHUNITHM LUMINOUS` | LUMINOUS | LUMINOUS | 同上 | 可收。国际版 2024-03 更新 |
| 18 | `CHUNITHM LUMINOUS PLUS` | LUMINOUS+ | LUMINOUS PLUS、LUMINOUS+ | 同上 | 复合形式安全 |
| 19 | `CHUNITHM VERSE` | VERSE | VERSE | 同上 | 可收（`X-VERSE` 出现时按最长匹配优先，不会串） |
| 20 | `CHUNITHM X-VERSE` | X-VERSE | X-VERSE | 同上 | 可收。系统版本号 EX1.50 |
| 21 | `中二节奏 NEW` | （国服） | — | 百度百科「中二节奏」、萌娘百科 | ⚠ 国服 2022-09-08 上线，取的是 NEW 这一代的名字，与日版 `CHUNITHM NEW` **是否逐字对应未确认** |
| 22 | `中二节奏 2024` | 国服 2024 | 中二节奏2024 代 | 同上 | ⚠ 国服按年份命名，**对应日版哪一代没有权威对照**，别硬映射 |
| 23 | `中二节奏 2025` | 国服 2025 | — | 同上 | ⚠ 同上（国服 2026 已于 2025-09-16 上线，但快照里没有这一代） |

**快照里没有、但社区在用的版本**（按 maimai 那轮的做法登记 `catalogAvailable:false`，不建曲目数据）：`CHUNITHM X-VERSE-X`（EX1.55，2025-12-11）、`CHUNITHM Mate`（2026-07-02，最新一代）、`CHUNITHM SUPERSTAR` / `SUPERSTAR PLUS`（海外版，已离线）、`中二节奏 2026`（国服，2025-09-16 上线）。

反过来，快照里 PLUS 版是齐的（AIR PLUS、STAR PLUS、AMAZON PLUS、CRYSTAL PLUS、NEW PLUS、SUN PLUS、LUMINOUS PLUS 都有独立 version 值），这一代代不用额外登记。

## 二、框体（version_group，与 maimai 的旧框/DX框 同形状）

| 称呼 | 成员 | 来源 | 备注 |
|---|---|---|---|
| 银框体 | 快照里 PARADISE LOST 及以前的所有代 | 萌娘百科 CHUNITHM、chunithm.fandom | 旧框体已于 2023-02-01 停服 |
| 金框体 | NEW 起的所有代 | 同上 | 支持 120fps 的新框体 |

## 三、难度（现库里只有 MASTER/EXPERT/ULTIMA 三条，这是补齐）

| 难度 | 正式字段 | 中文俗称 | 来源 |
|---|---|---|---|
| BASIC | BAS | 绿谱 | 萌娘百科 CHUNITHM：「通常分別稱為綠譜、黃譜、紅譜、紫譜與黑譜」 |
| ADVANCED | ADV | 黄谱 | 同上 |
| EXPERT | EXP | 红谱 | 同上（现库已有） |
| MASTER | MAS | 紫谱 | 同上（现库已有） |
| ULTIMA | ULT | **黑谱** | 同上 —— 现库写的是「俗称尚未收录」，**现在查到了，可补** |

## 四、机制（每条都带来源，按你的规矩）

| 条目 | 要点 | 来源 |
|---|---|---|
| 定数 | 等级 1~15+，7 级起同数字分两档；定数大致在等级 +0.0~+0.9；7 级以上 ≥ +0.5 划为「+」档；**当前最高定数 15.7** | 萌娘百科 CHUNITHM、B站《中二节奏小tips》 |
| Rating 与定数 | SSS+ 可达「谱面定数 +2.15」，SSS 为 +2.0，S 为定数本身；**当前版本常规谱面取最高的 20 个参与，WORLD'S END 不参与** | 萌娘百科、chunithm.fandom |
| WORLD'S END（WE） | CHUNITHM PLUS 起加入的特殊谱面类（海外版为 SUPERSTAR PLUS），类似 maimai 的宴谱 / オンゲキ 的 LUNATIC；需 WE 票券；难度以 **☆1~5** 标记；**不参与 Rating**；属性汉字（光/避/止/时/速/戻/敷/跳/弹/半/两/割/狂/歌/布/觉/翔/改/藏/招/舞/击/分/嘘/谜/！/？） | 萌娘百科、remywiki CHUNITHM:WORLD'S END、chunithm.fandom 歌曲清单 |
| 解禁 | MASTER/ULTIMA 通常需解禁：在对应曲目 EXPERT 或 MASTER 取得 S 及以上即可解锁（旧资料写 SS，NEW 起改为 S）；ULTIMA 票券只能临时游玩、不解锁 | 萌娘百科 CHUNITHM 修订差异 |
| 地图 / 跑图 | 游玩 GAUGE 换算成地图格数：EXPERT 每曲 +7，MASTER/ULTIMA/WE 每曲 +9；CLASS 通关 +3、FC +4、AJ +5；地图有加成条件与区域分类 | 萌娘百科、B站小tips |
| 课题曲 | 部分地图格设课题曲，到终点须通关该曲才能完成地图领奖；通关后解禁该曲并获角色/技能点；卡住时剩余格数存入「ストック」（库存），未通关不增不减 | 萌娘百科、B站小tips |
| 评价与达标 | FC（全连）、AJ（ALL JUSTICE）、AJC（全 JUSTICE CRITICAL）；通关评价 CLEAR/HARD/BRAVE/ABSOLUTE/CATASTROPHY | 萌娘百科 |
| 段位认定 | クラス認定 / CLASS 认定，通关得徽章、缎带 | 萌娘百科 |

⚠️ **有争议的地方要标出来（不写死）**：ULTIMA 解禁条件在不同资料里是 S 还是 SS；课题曲库存上限旧资料 99、新资料 500；最高定数曲目列表不同资料不一致。这些我在条目 body 里会写成「资料有分歧」而不是单选一个。

## 五、需要你定的三件事

1. **短副标题收不收**：`NEW` / `SUN` / `AIR` / `STAR` / `PLUS` 这些裸词当别名会误命中（`AIR` 还是曲名）。我建议**不收裸词，只收 `NEW PLUS`/`SUN PLUS` 这类复合形式**；`PARADISE`/`LUMINOUS`/`VERSE`/`CRYSTAL`/`AMAZON` 这类足够独特的收。
2. **国服年份版与日版的对应**：`中二节奏 2024 / 2025` 对应日版哪一代**没有权威对照**，我不做映射，只在条目里写「国服按年份命名，与日版代的对应关系未确认」。要不要留这条说明？
3. **要不要给术语层加「需要游戏上下文」的别名开关**（`requiresGame: true`）：加了它，`NEW`/`SUN` 这类词只有在同一轮对话点名了 CHUNITHM 时才生效，既安全又能用。不加就按第 1 条办。

你定完这三件，我就按 maimai 那轮同样的方式写进 `chunithm-terms.json`（版本 alias + 银/金框体 group + 难度补齐 + 机制条目 + 快照缺失版本登记）。

## 六、来源清单

- 萌娘百科《CHUNITHM》：（难度俗称、解禁、定数、地图、课题曲）https://moegirl.icu/CHUNITHM ・ http://zh.moegirl.tw/index.php?title=CHUNITHM
- CHUNITHM Wiki（fandom 中文）：（游戏简介、版本日期、WE 歌曲清单）https://chunithm.fandom.com/zh/wiki/%E9%81%8A%E6%88%B2%E7%B0%A1%E4%BB%8B
- remywiki：CHUNITHM:WORLD'S END（WE 属性、☆难度）https://silentblue.remywiki.com/CHUNITHM:WORLD%27S_END
- B站专栏《中二节奏小tips》：（解禁、跑图、库存）https://m.bilibili.com/opus/755524729447645220
- 百度百科「中二节奏」：（国服名称与上线时间）https://baike.baidu.com/item/%E4%B8%AD%E4%BA%8C%E8%8A%82%E5%A5%8F/65279967
- 维基百科（草稿）CHUNITHM：（版本时间线）https://zh.m.wikipedia.org/zh-hans/User:Cookai1205/%E8%8D%89%E7%A8%BF/CHUNITHM
