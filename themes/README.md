# MiaBot 主题目录

主题按“输出类型”组织，共用资源单独存放，避免 B50 分表与单曲成绩图互相混杂。

```text
themes/
├─ shared/
│  └─ fonts/                 多种主题共用的字体与许可证
├─ rating-chart/             B50 + N10 + P50 分表
│  ├─ assets/                运行时图片
│  ├─ renderer/              正式 HTML / CSS / JS 渲染器
│  ├─ design/                PSD、底图等设计源文件，不打包进程序
│  ├─ examples/              示例数据
│  ├─ previews/              历次视觉预览图
│  └─ tools/                 本地预览工具
├─ song-detail/              单曲全难度成绩图
   ├─ assets/                运行时底图
   ├─ renderer/              正式 HTML / CSS / JS 渲染器
   ├─ design/                PSD 与参考图
   ├─ examples/              数据契约及布局测试
   ├─ previews/              浏览器实渲染验收图
   ├─ tools/                 本地预览工具
│  └─ README.md              交互、字段与显示规则
├─ chart-info/               单谱面分数线、容错与白金分分析图
│  ├─ renderer/              1600×1100 正式渲染器
│  ├─ examples/              VIIIbit Explorer MASTER 公式样例
│  ├─ previews/              浏览器实渲染验收图
│  ├─ tools/                 本地预览生成器
│  └─ README.md              查询格式、公式与显示规则
└─ completion-search/        版本牌子全曲完成度图
└─ level-score/              按显示等级查询的全谱面成绩长图
   ├─ assets/                完整牌子、背景、等级框和徽章
   ├─ renderer/              1080×1920 正式渲染器
   ├─ design/                template.png / PSD 设计源文件
   ├─ examples/              模板数据和 120 曲压力数据
   ├─ previews/              浏览器实渲染验收图
   ├─ tools/                 预览生成与 CSS 实时调试器
   └─ README.md              数据契约与显示规则
```

各主题均只将 `renderer/`、实际使用的 `assets/` 以及共用字体打包进 EXE；
`design/`、`examples/`、`previews/`、`tools/` 不进入最终程序。
