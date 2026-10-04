# 双数据源分表使用服务器定数

版本：`4.1.6-render-timeout`（2026-10-04）。适用于大饼与 rinnet 的 B50 / N10 / P50 分表。

## 分表下载超时修复

此前下载超时在收到 HTTP 响应头后解除，图片或 API 正文停滞会一直等待。现在曲绘和大饼 API 的超时覆盖完整正文读取；整批曲绘与头像共享 20 秒预算，每个请求的剩余时间受该预算约束。缓存命中仍使用本地图片，失败、近期失败及预算内未开始的图片直接使用本地占位图，浏览器不再重试相同公网图源。浏览器命令新增超时，连接关闭会结束未完成的命令。

20 秒是补图预算，登录、成绩接口和浏览器渲染另有耗时。这能修复已复现的正文卡死问题，尚不能凭本地测试判断用户服务器是否还存在登录或接口阶段的问题。

所有大饼分表谱面一律根据服务器的单曲 Rating、成绩、AB / FC / FB 标记或白金星数计算定数候选，不采用本地内部曲库或补充曲库的定数。本地数据过旧不会影响分表定数。`music.level_info.level` 是显示等级枚举，不能直接当作定数。

- B50 使用技术分分段插值及评级、达成奖励。
- N10 使用技术分 Rating 除以 5 后截断的单曲贡献。
- P50 使用 `floor(白金星数 × 定数²)`。

枚举一位小数定数，并核对显示等级。同一资源哈希、同一难度在多个榜单出现时取候选交集；严格匹配无解时，允许每条原始整数 Rating 相差 ±1。只有候选唯一才采用，歧义和冲突仍会报错，不回退到本地定数，也不修改公共曲库。本地曲库仍用于歌曲识别、缓存 ID 和其他功能。

## rinnet 的服务器定数

rinnet `/api/game/ongeki/newRating` 返回成绩和星数，没有独立的单曲 Rating。官方网页读取服务器曲库的 `level0`～`level4` 字段后自行计算 Rating，因此不能用本地计算的 Rating 再“反推”定数。

每次生成 rinnet 分表时，入口通过当前登录会话请求 `/api/game/ongeki/data/musicList`，以歌曲 ID 与难度定位当前定数。例如 `level3: "14,80"` 表示 MASTER 定数 14.8；LUNATIC 对应 `level4`。缺失、重复 ID、格式异常或请求失败都会拒绝生成，不回退本地定数。N10 保持 `floor(技术 Rating / 5) × 5` 的口径，P50 使用服务器定数和星数计算。

核对官方前端提交 `99029d7834003bc24e04b5ac8c81b3548cde7eb5`：

- [新版成绩字段](https://github.com/RinNET-OpenSource/RinNET_frontend/blob/99029d7834003bc24e04b5ac8c81b3548cde7eb5/src/features/ongeki/models.ts)
- [曲库加载接口](https://github.com/RinNET-OpenSource/RinNET_frontend/blob/99029d7834003bc24e04b5ac8c81b3548cde7eb5/src/lib/db/preload.ts)
- [网页使用曲库计算 Rating](https://github.com/RinNET-OpenSource/RinNET_frontend/blob/99029d7834003bc24e04b5ac8c81b3548cde7eb5/src/features/ongeki/OngekiRatingPage.tsx)

曲库外歌曲按 `otogame-{32位资源哈希}` 缓存曲绘，三榜共享下载结果。URL 沿用大饼前端的资源地址：

```text
https://oss-hd1.bemanicn.com/SDDT/cover/{music.music_id}.webp-thumbnail
```

此功能仅改变分表定数来源，不会使新歌自动进入本地单曲搜索、定数表或牌子列表。rinnet 曲库外歌曲缺少本地曲绘时使用占位图；P50 白金分理论值仍需要有效音符数量，服务器没有提供音符数量时使用本地数量，两边都缺失则报错，不能拿个人白金分当理论分。

## 验证状态

完整项目测试 291 项通过，核心自测、入口语法及双文件安装与回退检查通过；注入第二个文件的替换失败后，安装和回退事务都能恢复原来的配对版本。

`test-render-network.cjs` 使用本地 HTTP 服务复现响应头成功但正文永不完成，验证图片与 API 超时、批量下载预算、占位图和浏览器命令超时。`node tools/verify-render-network.cjs` 使用同样的故障图源运行真实浏览器渲染；为了加速测试，仅在该测试中将补图预算缩短为 250 毫秒。真实账号数据未参与这项检查。

`test-otogame-renderer.cjs`、`test-rinnet-client.cjs` 与 `test-rinnet-renderer.cjs` 覆盖定数来源、过旧的本地值、读取失败与格式校验、三榜计算、曲库外歌曲、演示数据和曲绘缓存。rinnet 测试还验证两次查询之间服务器定数变化会生效。

更新包的入口与核心替换、备份、回退、配置与数据保留、自定义核心路径、校验失败和越界路径拒绝均已在临时部署目录中验证。打包后逐一核对 ZIP 文件大小与 SHA256。

**尚未进行本版本的两数据源实账号验收。** 按用户要求先提供更新包，由服务器使用者验收；本地测试通过不等于真实服务器联调通过。测试中新歌数据为构造数据，不代表零号车辆的实际成绩或定数。

## 构建待服务器验证的更新包

在 Windows x64、Node.js 22+ 环境中执行；先按 [ASSETS.md](ASSETS.md) 准备渲染素材。公开仓库不包含这些素材。

```powershell
npm ci
npm test
npm run build:core
node tools/build-core-update.cjs MiaBot-render-timeout-update-20261004 --skip-live-verification
node tools/verify-core-update.cjs MiaBot-render-timeout-update-20261004
Compress-Archive -Path server-updates/MiaBot-render-timeout-update-20261004 -DestinationPath server-updates/MiaBot-render-timeout-update-20261004.zip
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/verify-core-update-zip.ps1 -Name MiaBot-render-timeout-update-20261004
```

`--skip-live-verification` 会明确标记 `liveVerified: false` 和 `pending-server-validation`，不会伪造实账号验证结果。包名对应输出目录必须不存在；已有包不会被构建器覆盖。构建产物、日志、个人配置和账号数据不提交 Git。

## 安装与回退

包内提供核心 EXE、已打包的 QQ 入口、安装与回退脚本、清单和说明。rinnet 的服务器曲库读取发生在入口层，**此次必须同时更新 `qq-official/mia-entry.cjs` 与核心**。默认部署根目录为 `C:\MiaBot\deploy-windows-server`。

停止机器人及自动重启任务，完整解压更新包；默认目录可运行 `Apply-Update.cmd`。自定义目录可在解压后的包目录执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Apply-Update.ps1 -TargetRoot "D:\实际部署目录" -CheckOnly
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Apply-Update.ps1 -TargetRoot "D:\实际部署目录"
```

安装器按 `qq-official/config.local.json` 的 `corePath` 定位现有核心，要求路径位于部署根目录内，并校验两个载荷的大小与 SHA256。先备份入口和核心，再替换；任何替换失败会恢复已替换的文件。配置、账号绑定、别名、缓存及其他程序保留。看到 `UPDATE COMPLETE` 后按原方式启动机器人，分别使用两数据源生成分表，核对定数、成绩、曲绘和缓存。

回退前停止机器人，使用安装时打印的备份路径：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Restore-Backup.ps1 -TargetRoot "D:\实际部署目录" -BackupPath "D:\实际部署目录\update-backups\本次备份目录"
```

回退会检查两份备份及当前入口、核心是否仍对应本次更新，避免旧备份覆盖之后的更改；回退过程中第二份文件失败也会恢复原来的配对版本。
