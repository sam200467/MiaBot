# 谱面图（ongeki-chart）

`/谱面图 <曲名或 ID> [难度]` 出的整张谱面预览长图。谱面来自部署机器上本地游戏数据里的 `.ogkr` 文件，
解析、排版、绘制全部在本目录的代码里完成，不用外部图片素材（字体沿用 `shared/fonts/`，缺了退回系统字体）。

## 配置

`qq-official/config.local.json`：

```json
"ongekiChartRoots": ["D:/SDDT/package/mu3_Data/StreamingAssets"]
```

可以填多个目录（本体和 option 包）。会递归查找形如 `0036_03.ogkr` 的文件：前半是曲目 ID（与
`ongeki-music-internal.json` 的 `id` 相同，前导零不计），后半是难度 `00`–`03`（BASIC–MASTER）、`04`（LUNATIC）。
同一张谱面有多份时，取路径排序靠后的那份。没找到的谱面一分钟后会重扫，所以更新游戏数据不用重启机器人。

难度可以不写：有 MASTER 就看 MASTER，只有 LUNATIC 的曲目（白谱单独编号）就看 LUNATIC。

## 文件

| 文件 | 作用 |
| --- | --- |
| `renderer/ongeki-chart.js` | `.ogkr` 解析、小节与分栏、SVG 输出。浏览器和 Node 共用，不碰 DOM |
| `renderer/theme.html/css/js` | 头部信息卡、物量、图例，把 SVG 放进页面；排完版把尺寸写到 `window.__THEME_SIZE__` |
| `tools/render-preview.js` | 本地预览：`npm run preview:chartview -- <谱面.ogkr> [输出.png]` |

数据契约（`window.__THEME_DATA__`）：

```js
{
  song: { songId, title, artist, jacketUrl },
  chart: { difficultyId, level, constant, designer, noteCount, bellCount }, // difficultyId: 0–3，LUNATIC 为 10
  ogkr: "<.ogkr 全文>",
  layout: { /* 可选，覆盖 ongeki-chart.js 里的 DEFAULTS */ },
}
```

## 排版规则

- **纵轴按乐谱时间**（tick）线性排，不按秒。变速只体现在 BPM 标注和右缘色带上，不拉伸版面，同样的节奏在哪儿看都一样密。
- **一栏约 4 个 4/4 小节**，按小节顺序贪心装栏，不会从小节中间切开；超过一栏的长小节按拍切。
- 每栏自下而上读，栏从左到右、行从上到下接。栏首尾各多画 1/8 小节的前后内容（压暗 + 虚线），方便对上衔接。
- 每行默认最多 1840px；超过 4 行时放宽到最多 2800px，避免图片过长。
- 短于半拍的小节是演出用的（拍号 1/32 之类），只画淡线、不占小节号。拍号只在持续了整小节、且与上次标注不同时标出。
- 左侧刻度挨得太近时按「小节号 > BPM > 拍号 > BOSS」只留一个。

## 图形约定

| 物件 | 画法 |
| --- | --- |
| 场地 | 墙线之外压暗，场地的形状和移动一眼可见 |
| 轨道 | 红 / 绿 / 蓝细线（L / C / R） |
| TAP | 轨道色圆角块；金框为 CRITICAL |
| HOLD | 轨道色半透明带，沿所属轨道弯曲，头是 TAP，尾是短横 |
| SIDE | 墙色（左粉右紫）方块，中间一道白线；SIDE HOLD 为更宽的墙色带 |
| FLICK | 白色箭头指向滑动方向；金色为 CRITICAL |
| BELL | 黄色圆点 |
| 子弹 | 针形 / 圆形 / 方形来自调色板；粉＝普通、橙＝硬、红＝危险；显示范围外的不画 |
| 激光 | 粉色半透明带 + 中线 |
| 墙封锁 | 墙线上的红色粗虚线 |
| 变速 | 栏右缘细带：青＝减速、橙＝加速、灰＝停止 |
