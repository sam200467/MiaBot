# 谱面图（ongeki-chart）

`/谱面图 <曲名或 ID> [难度]` 出的整张谱面预览长图。谱面来自部署机器上本地游戏数据里的 `.ogkr` 文件，
解析、排版、绘制全部在本目录的代码里完成，不用外部图片素材（字体沿用 `shared/fonts/`，缺了退回系统字体）。

## 配置

`qq-official/config.local.json`：

```json
"ongekiChartRoots": ["D:/SDDT/package/mu3_Data/StreamingAssets"]
```

可以填多个目录（本体和 option 包）。会递归查找形如 `0036_03.ogkr` 的文件：前半是曲目 ID（与
`ongeki-music-internal.json` 的 `id` 相同，前导零不计），后半是难度 `00`–`03`（BASIC–MASTER）、`10`（LUNATIC）。
同一张谱面有多份时，取 option 包号（`A037` 这样的目录名）最大的那份，包号相同再取路径排序靠后的。
没找到的谱面一分钟后会重扫，所以更新游戏数据不用重启机器人。

**服务器上没有装游戏**时，在装了游戏的电脑上把谱面单独收集出来，再拷到服务器。

本体谱面（A000）一般不是散装文件，而是在 `HDD\SDDT_*.vhd` 镜像里；部分 option 包也可能还是 `.zip`。
散装目录里只能找到已经解开的 option 包，所以先把这两样打开：

```powershell
$g = "D:\SDDT"   # 游戏根目录
# 1. 只读挂载本体镜像，看看分到了哪个盘符
Mount-DiskImage -ImagePath (Resolve-Path "$g\HDD\SDDT_*.vhd").Path -Access ReadOnly
Get-DiskImage -ImagePath (Resolve-Path "$g\HDD\SDDT_*.vhd").Path | Get-Disk | Get-Partition | Get-Volume

# 2. 只从 option 压缩包里取出谱面，放到游戏目录外面
Add-Type -AssemblyName System.IO.Compression.FileSystem
$dst = "D:\ongeki-option-zip"
foreach ($zipPath in Get-ChildItem "$g\option\*.zip") {
  $zip = [IO.Compression.ZipFile]::OpenRead($zipPath.FullName)
  foreach ($e in $zip.Entries | Where-Object Name -like "*.ogkr") {
    $to = Join-Path $dst $e.FullName; New-Item -ItemType Directory -Force (Split-Path $to) | Out-Null
    [IO.Compression.ZipFileExtensions]::ExtractToFile($e, $to, $true)
  }
  $zip.Dispose()
}

# 3. 三处一起收集（E: 换成第 1 步看到的盘符）
node tools/collect-ongeki-charts.cjs E:\ "$g\option" $dst --out D:\ongeki-charts

# 4. 卸载镜像
Dismount-DiskImage -ImagePath (Resolve-Path "$g\HDD\SDDT_*.vhd").Path
```

镜像挂不上（提示文件损坏、或者挂上后打不开）说明是加密镜像，需要先用对应工具解密，这一步脚本帮不了。

脚本只拷 `.ogkr` 谱面文件，平铺成 `0036_03.ogkr` 这样，并对照本地曲库报告缺了哪些。把输出目录压缩后传到服务器、解压，
`ongekiChartRoots` 指向解压后的目录即可。这些谱面属于游戏数据，只放在自己的服务器上，不要提交进仓库或公开分发。

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

- **纵轴按乐谱时间**（tick）线性排，不按秒，一个 4/4 小节 320px。变速只体现在 BPM 标注和右缘色带上，不拉伸版面，同样的节奏在哪儿看都一样密。
- **从第一个有物件的小节画起**，记为第 1 小节；谱面开头的空白小节不画（和常见的谱面站编号一致）。开头的 BPM 挪到第 1 小节标出。
- **一栏约 4 个 4/4 小节**，按小节顺序贪心装栏，不会从小节中间切开；超过一栏的长小节按拍切。
- 每栏自下而上读，栏从左到右、行从上到下接。栏首尾各多画 1/8 小节的前后内容（压暗 + 虚线），方便对上衔接。
- 每行默认最多 1840px；超过 4 行时放宽到最多 2800px，避免图片过长。放到最宽仍超过 8400px 高的超长谱面（约 280 小节以上）整体压矮小节，最矮 150px。
- 短于半拍的小节是演出用的（拍号 1/32 之类），只画淡线、不占小节号。拍号只在持续了整小节、且与上次标注不同时标出。
- 左侧刻度挨得太近时按「小节号 > BPM > 拍号 > BOSS」只留一个。
- **分音**：栏右侧在每个击打时刻（TAP、侧键、HOLD 头和尾、FLICK）画一道短刻度，旁边写它与上一个击打时刻的间隔，
  按全音符约分（1/16、3/16、1/24…），不规则的时值也照实写（19/384、5/96）。超过一整小节的只画刻度不写数。
  字放不下时先保证节奏变化处的数字，再在空隙里补上连续相同的数字。
- 变速色带在栏的左缘。

## 图形约定

格式字段含义参照社区整理的 ogkr 说明（MikiraSora/OngekiFumianDescription，Re:Fresh 1.50），尺寸比例参照游戏 / 谱面编辑器贴图：TAP 40×16、SIDE 40×40、子弹 40×40（针形 30×80），
按 TAP 宽 12px 等比缩放。子弹和 BELL 常常很密，再缩小到约 3/4，避免相邻的叠在一起。

| 物件 | 画法 |
| --- | --- |
| 场地 | 墙线之外压暗，场地的形状和移动一眼可见 |
| 轨道 | 红 / 绿 / 蓝细线（L / C / R） |
| TAP | 轨道色圆角块；金框为 CRITICAL |
| HOLD | 轨道色半透明带，沿所属轨道弯曲，头是 TAP，尾是短横 |
| SIDE | 墙色描边的五边形箭头，尖端指向场内，中间一道白线；SIDE HOLD 为更宽的墙色带 |
| FLICK | 判定拍上一根细条（与 TAP 差不多粗），箭头 ≪≪≪ / ≫≫≫ 画在条的上方；金色为 CRITICAL。谱面文件里 FLICK 没有长度，同一拍、同方向、中心相距不超过 12.5 的几个 FLICK 合并成一根长条（游戏里也是连成一条） |
| BELL | 金色圆点；带调色板的 BELL 像子弹一样飞，落点同样加偏移 |
| 子弹 | 画在落点上：X + 调色板偏移（BPL 第 3 列）；瞄准玩家（PLR）的落点取决于玩家位置，画在写的 X 上并调淡。形状来自调色板：针形（下端尖，尖端是落点）/ 圆环 / 竖长方块；颜色表示伤害：粉＝普通、紫＝硬、橙＝危险；大号子弹放大 1.4 倍；显示范围外的不画 |
| 激光 | 粉色半透明带 + 中线 |
| 装饰轨道 | 谱面里演出用的彩色细线（CL），颜色号 0–19 是角色代表色（0 星咲あかり、1 藤沢柚子 … 19 三角葵），取近似色，比轨道还淡 |
| 隐藏轨道 | 轨道 / 墙 / 装饰轨道起点行第 7 列 isTransparent > 0 的不画线（墙照样决定场地） |
| 保护墙 | 墙线上的红色粗虚线（谱面的 LBK）；墙线在同一拍瞬移时，虚线停在瞬移之前的位置 |
| 地板消失 | 左墙越过右墙（左右反转），或两墙之间整段在场外（一起瞬移到场外）时没有地板，角色悬空；两墙正好贴住时角色还能站在线上，不算；「场外」指离中线 40 以外（扫墙时墙常短暂推到 ±36，不算）：整栏宽铺一层青色（对应游戏里整片压暗），左侧标「悬空」，反转的标「反转」 |
| 变速 | 栏左缘细带：青＝减速、橙＝加速、灰＝停止、红＝倒退（倍率为负） |

## 打服务器更新包

核心 `ongeki-core.exe` 会把字体和分表素材一起封进去，这些素材只在部署者本机，所以更新包要在平时构建核心的那台 Windows 机器上打：

```powershell
npm ci
npm run build:core
node tools/build-core-update.cjs MiaBot-chart-view-update-20261011 --notes tools/core-update/notes/chart-view-20261011.txt --with-panel
Compress-Archive -Path server-updates/MiaBot-chart-view-update-20261011 -DestinationPath server-updates/MiaBot-chart-view-update-20261011.zip
```

`--notes` 是这次更新的说明（写进包里的「使用说明.txt」，安装与回退步骤自动附上）；`--with-panel` 附带 `Update-Panel.cmd`，把 /谱面图 加进 QQ 指令面板。
更新程序不改配置文件，`ongekiChartRoots` 要在服务器的 `qq-official/config.local.json` 里手动加。
