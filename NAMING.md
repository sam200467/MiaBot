# MiaBot 命名与兼容说明

## 当前目录

| 路径 | 职责 |
| --- | --- |
| `qq-official/mia-*.cjs` | QQ 入口、命令、文案与面板 |
| `mia-chat/` | 柏木美亚人设、示例、表达配置 |
| `chat-core/` | 共用聊天引擎与客观知识库 |
| `mia-core.cjs` | 查询能力层 |
| `mia-vault.cs` | Windows 凭据助手源码 |
| `themes/` | 图片主题与预览工具 |

2026-09-21 检查时，公开仓库已没有以 `takase` 或 `rio` 命名的文件和目录。
本次统一主题署名、示例数据、文档和测试临时目录的产品名称为 MiaBot；
保留现有入口与文件布局，避免破坏启动器和已有配置。
分表署名读取 `generatorName`，未提供时使用 MiaBot。

`ongeki` 是游戏名称；`reiwa-ongeki-from-otogame-rating-json.js` 是渲染脚本名称，
不属于旧机器人品牌，保留其名称和调用接口。

## 有意保留的名称

- `mia-vault.cs` 的 `TakaseDiscordBotBindingsV1` 是 DPAPI 附加熵，不是展示名称。
  修改它会使已有 `bindings.dat` 无法解密。本次不修改加密格式与存储路径。
- 搜索调试使用 `MIA_SEARCH_DEBUG`，继续接受旧变量 `TAKASE_SEARCH_DEBUG`。
  新变量已设置时优先使用新变量；日志仍脱敏。
- `aliasScope: "qq"` 与 `song-aliases-qq.json` 保持不变，已有别名无需迁移。
- 曲名、角色档案、台词、知识检索规则及其测试中的高瀬梨緒／Rio／Takase 是
  原作事实或既有行为，不做全局替换。历史排障记录保留原始案例。

## 本地其他机器人

部分开发目录另有 `qq/`、`rio-chat/`、`takase-discord-*` 与 Discord 可执行文件，
属于独立机器人，不随当前 MiaBot 源码仓库分发。这些文件不在本次整理范围内。
共用引擎中的历史注释和可选的跨前端命令冲突检查仍予保留。

源码变更不会自动更新已有 EXE 或部署目录。使用源码入口的实例重启后生效；
图片主题需 `npm run build:core` 重建核心，打包部署需重新生成部署包。
生成新包时保留原部署的真实配置和数据，不直接覆盖运行中的数据目录。
