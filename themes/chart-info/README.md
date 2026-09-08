# Discord 单谱面分析图

`/chartinfo` 使用“曲名或 Song ID + 难度”定位一张谱面，并输出 1800×1200 PNG。

示例：`VIIIbit Explorer master`、`id870 mas`、`初音ミクの激唱 lunatic`。

图片只包含分数线与容错、单项判定/BELL 等价、白金分区间三组数据。它完全使用内置曲库计算，不读取玩家账号。

计算规则：

- TECHNICAL SCORE 的判定分池为 950,000；BREAK / HIT / MISS 分别损失单 Note 的 10% / 40% / 100%。
- BELL 总分为 60,000，单个 BELL 分值按谱面的 BELL 数量均分。
- 白金分理论值为 `总物量 × 2`；各星级最低分按理论值乘区间下界后向上取整。
- 单曲白金分 Rating 为 `星数 × 谱面定数² ÷ 1000`，98% 与 99%+ 都按 5 星计算。

本地视觉预览：

```powershell
npm run preview:chartinfo
```
