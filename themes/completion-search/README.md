# 牌子完成度主题（completion-search）

这是 1080×1920 的版本牌子完成度渲染器。它使用完整 `ui_userplate_*` 布局、MASTER 曲目分级网格和底部四难度汇总，并已接入 Discord Bot 的 `/plate`（中文 `/牌子`）命令。

## 已实现规则

- 主列表只按 MASTER（紫谱）等级分组，每行固定 10 张 75×75 曲绘。
- `15+`、`15`、`14+` 等等级由数据动态生成；中间没有曲目的等级框仍然保留。
- AB 优先于 FC；FB 独立显示，可以与 AB 或 FC 同时出现。
- BASIC / ADVANCED / EXPERT / MASTER 汇总固定在底部，不随主列表移动。
- 按所选牌子的版本精确查询成绩；删除曲、当前不可游玩曲、BONUS TRACK（包括角色 Solo 版）和 LUNATIC 曲不会进入图片。
- 当前支持从桜撃到爽撃的 11 个版本牌子；四个通常难度的成绩并行读取。
- 120 曲压力数据超出自然高度时，只把主列表中的等级框、曲绘与间距等比例紧凑化；曲绘仍保持正方形，并且不会覆盖底部统计和牌子下框。

正式生成时，核心程序会先完成版本、删除状态和当前可游玩状态过滤，再把结果交给主题排版。

## 数据契约

渲染前设置 `window.__THEME_DATA__`：

```js
{
  profile: { playerName, level, avatarUrl },
  plate: { id, nameJa, version, layoutUrl },
  levelRange: { max: "15", min: "11+" }, // 可省略，省略时按曲目自动判断
  songs: [{
    songId,
    title,
    jacketUrl,
    masterLevel,
    masterConstant,
    isAllBreak,
    isFullCombo,
    isFullBell
  }],
  summary: {
    basic:   { allBreak, fullBell, total },
    advanced:{ allBreak, fullBell, total },
    expert:  { allBreak, fullBell, total },
    master:  { allBreak, fullBell, total }
  }
}
```

## 本地使用

- 双击项目根目录的 `启动牌子完成度模板CSS调试器.bat`。
- 调试器左上角可切换“新版模板布局”和“爽击 120 曲压力测试”。
- 左侧 CSS 修改即时应用，`Ctrl+S` 或“保存”写回 `renderer/theme.css`。
- 生成静态预览：

```powershell
node themes/completion-search/tools/render-preview.js
node themes/completion-search/tools/render-preview.js --sample themes/completion-search/examples/preview-stress.js --output themes/completion-search/previews/completion-search-stress.png
```

`design/`、`examples/`、`previews/`、`tools/` 都是设计与调试文件；运行时只需 `renderer/`、`assets/` 和 `themes/shared/fonts/`。
