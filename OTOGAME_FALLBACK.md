# 大饼曲库外歌曲的分表补齐

版本：`4.1.3-otogame-fallback`（2026-10-03）。适用于 `u.otogame.net` 的 B50 / N10 / P50 分表。

本地曲库缺少歌曲或对应难度定数时，核心根据服务器的单曲 Rating、成绩、AB / FC / FB 标记或白金星数计算定数候选。`music.level_info.level` 是显示等级枚举，不能直接当作定数。

- B50 使用技术分分段插值及评级、达成奖励。
- N10 使用技术分 Rating 除以 5 后截断的单曲贡献。
- P50 使用 `floor(白金星数 × 定数²)`。

枚举一位小数定数，并核对显示等级。同一资源哈希、同一难度在多个榜单出现时取候选交集；严格匹配无解时，允许每条原始整数 Rating 相差 ±1。只有候选唯一才采用，歧义和冲突仍会报错。本地定数保持优先，不修改公共曲库。

曲库外歌曲按 `otogame-{32位资源哈希}` 缓存曲绘，三榜共享下载结果。URL 沿用大饼前端的资源地址：

```text
https://oss-hd1.bemanicn.com/SDDT/cover/{music.music_id}.webp-thumbnail
```

此功能补齐分表，不会使新歌自动进入本地单曲搜索、定数表或牌子列表。没有修改 rinnet 的客户端或计算公式。

## 验证状态

本次完整项目测试 281 项通过，核心构建与自测通过。`test-otogame-renderer.cjs` 覆盖三榜独立还原、技术分奖励、末位容差、歧义与冲突、不同资源和难度的隔离、本地定数优先，以及曲绘下载与缓存复用。

更新包的实际核心替换、备份、回退、配置与数据保留、自定义核心路径、校验失败和越界路径拒绝均已在临时部署目录中验证。ZIP 内文件也已逐一核对大小和 SHA256。

**尚未用发生报错的正确大饼账号验证零号车辆。** 按用户要求先提供更新包，由服务器使用者验收；本地测试通过不等于真实服务器联调通过。测试中新歌数据为构造数据，不代表零号车辆的实际成绩或定数。

## 构建待服务器验证的更新包

在 Windows x64、Node.js 22+ 环境中执行；先按 [ASSETS.md](ASSETS.md) 准备渲染素材。公开仓库不包含这些素材。

```powershell
npm ci
npm test
npm run build:core
node tools/build-core-update.cjs MiaBot-otogame-fallback-update-20261003 --skip-live-verification
node tools/verify-core-update.cjs MiaBot-otogame-fallback-update-20261003
Compress-Archive -Path server-updates/MiaBot-otogame-fallback-update-20261003 -DestinationPath server-updates/MiaBot-otogame-fallback-update-20261003.zip
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/verify-core-update-zip.ps1 -Name MiaBot-otogame-fallback-update-20261003
```

`--skip-live-verification` 会明确标记 `liveVerified: false` 和 `pending-server-validation`，不会伪造实账号验证结果。包名对应输出目录必须不存在；已有包不会被构建器覆盖。构建产物、日志、个人配置和账号数据不提交 Git。

## 安装与回退

包内只提供核心 EXE、安装与回退脚本、清单和说明。默认部署根目录为 `C:\MiaBot\deploy-windows-server`。

停止机器人及自动重启任务，完整解压更新包；默认目录可运行 `Apply-Update.cmd`。自定义目录可在解压后的包目录执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Apply-Update.ps1 -TargetRoot "D:\实际部署目录" -CheckOnly
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Apply-Update.ps1 -TargetRoot "D:\实际部署目录"
```

安装器按 `qq-official/config.local.json` 的 `corePath` 定位现有核心，要求路径位于部署根目录内，并校验载荷大小与 SHA256。先备份原核心，再替换；配置、账号绑定、别名、缓存及其他程序保留。看到 `UPDATE COMPLETE` 后按原方式启动机器人，使用大饼数据源生成含零号车辆的分表，核对定数、成绩、曲绘和重复查询的缓存效果。

回退前停止机器人，使用安装时打印的备份路径：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Restore-Backup.ps1 -TargetRoot "D:\实际部署目录" -BackupPath "D:\实际部署目录\update-backups\本次备份目录"
```

回退会检查备份校验值及当前核心是否仍对应本次更新，避免旧备份覆盖之后的核心更改。
