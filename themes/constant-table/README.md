# 定数表查询

Discord 指令 `/constant query:14`（中文显示为 `/定数表查询`）按 14.9 → 14.0 分组；`/constant query:14.2` 精确匹配 14.2。参数采用字符串，保留 `14` 与 `14.0` 的区别。无需绑定账号。

使用内置曲库，包含全部有效难度，沿用曲库的删除歌曲排除规则。每行 8 张曲绘，难度色边框，左侧标注行起始编号。曲绘先读本地缓存 `jacket-cache/`（与分表、等级图相同），缓存里没有的由核心在 20 秒下载预算内补，补不上换成写着曲名与 ID 的占位图；浏览器不再去公网拉曲绘。按 1 倍截图，截图失败时先同倍率重试，再降到 0.75 倍。背景复用 chart-info 的 spring-green-background.png，正文为资源圆体，底部署名为辰宇落雁体。

构建：`npm run build:core`，产物为项目根目录的 `ongeki-core.exe`。QQ 入口通过 `corePath` 调用它；更新后重启 MiaBot。部署包需重新运行 `node qq-official/build-deploy.cjs` 生成。

查询回归检查：`node test-constant-table.cjs`（先构建）。预览位于本目录 previews。
