# 等级成绩长图主题（level-score）

用于 Discord Bot 的 `/level`（中文 `/等级`）指令。可输入 LEVEL 0～15+、一位小数的谱面定数（如 `14.1`）或 `ABFB`，页码不填时默认为 1。显示等级与定数查询会将除已删除曲外的所有命中谱面（BASIC、ADVANCED、EXPERT、MASTER、LUNATIC 和 BONUS TRACK）按每行 7 张、每页最多 10 行输出。API 返回的 0 分记录按未游玩处理。

排序规则为个人最佳 TECHNICAL SCORE 降序，同分时按谱面定数降序，未游玩谱面保留并置于末尾，同时使用明显的低饱和高亮褪色样式与已游玩谱面区分。输出为 1440px 宽的 JPEG，高度按当页行数计算。顶部统计依次显示 ALL、SSS+、SSS、AB、FB、ABFB 和白金分 5～1 星；其中 AB、FB 分别只统计单独获得该标记的谱面，ABFB 统计两者同时获得的谱面。白金星使用 `assets/platinum_score_icon.png`。卡片会把 TECHNICAL RANK 作为图片显示在难度条上方；曲绘下第一行显示定数和分数，第二行显示曲名。玩家已获得的白金分星级仍显示在曲绘右上角，FB 使用独立的下端槽位。

`ABFB` 查询只保留同时获得 AB 和 FB 的已游玩谱面，跨全部显示等级与五种难度。排序依次为 LUNATIC、MASTER（紫）、EXPERT（红）、ADVANCED（黄）、BASIC（绿），同一难度内部按 `/calculate` 使用的单曲 Rating 公式降序排列。

主题专用图片全部位于 `assets/`：背景、五种难度条、十二种 TECHNICAL RANK、AB/FC/FB 徽章和白金星图标。等级长图使用 `assets/background.png`，渲染时旋转 90° 并添加 25px 高斯模糊，且会随分页高度自动铺满。跨主题共用字体继续位于 `themes/shared/fonts/`。

## CSS 实时调试器

双击项目根目录的 `启动等级成绩模板CSS调试器.bat`；如果中文文件名启动不便，也可运行 `start-level-theme-css-editor.cmd`，或执行 `npm run css:level`。

调试器支持 70 张满页与 11 张末页两套测试数据、CSS 实时预览、常用规则跳转、缩放与适应窗口、放弃未保存修改、将当前未保存样式导出为 PNG，以及 `Ctrl+S` 直接保存到 `renderer/theme.css`。关闭命令行窗口或按 `Ctrl+C` 即可停止调试器。

保存操作只更新主题源文件。需要让单文件 Discord Bot 使用新样式时，请关闭正在运行的 Bot，再于项目根目录执行 `npm run build:bot` 重新构建 EXE。

本地预览：

```powershell
npm run preview:level
```
