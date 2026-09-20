# MiaBot

MiaBot（美亚）是一个面向 QQ 开放平台的音游查询与角色聊天机器人。它将确定性的查分、曲目检索和图片生成与大模型聊天分开：模型只负责识别意图和参数，实际查询、权限校验与结果生成均由程序执行。

作者：**sam2004**。

## 功能

- QQ 官方机器人网关、鉴权、心跳、限流和被动回复
- B50 / N10 / P50、单曲成绩、谱面分析、等级成绩、定数表与版本牌子查询
- 柏木美亚角色聊天、表情和知识库
- 群聊白名单、账号绑定、别名管理、冷却队列与重复消息保护
- Mock 平台与自动化测试，不需要真实凭据即可验证主要流程

## 目录

| 路径 | 内容 |
| --- | --- |
| `qq-official/` | MiaBot 的 QQ 开放平台入口、指令层与传输层 |
| `mia-chat/` | 美亚人设、示例与表达配置（不含第三方图片） |
| `rio-chat/` | 共用的聊天、知识库和安全校验引擎（历史目录名） |
| `takase-core.cjs` | 平台无关的查分与能力层 |
| `themes/` | 查询结果图片的 HTML/CSS 渲染主题（不含第三方素材和字体） |
| `qq/` | 可选的 OneBot 兼容前端及桌面整合脚本 |

## 环境要求

- Node.js 22+
- Windows（生成本地查分核心和凭据助手时需要）
- QQ 开放平台机器人 AppID / AppSecret
- 一个 OpenAI 兼容的聊天模型 API（角色聊天可选）

## 安装与配置

```powershell
npm ci
Copy-Item qq-official/config.example.json qq-official/config.local.json
Copy-Item mia-chat/config.example.json mia-chat/config.local.json
```

填写两个 `config.local.json`。真实配置已被 `.gitignore` 排除，请勿提交 AppSecret、API Key、账号密码或绑定数据。

QQ 指令层还需要：

```powershell
npm run build:core
```

该命令会生成被忽略的 `ongeki-core.exe`。凭据助手可按项目中的 C# 源码构建；详细的平台配置、白名单和排障说明见 [`qq-official/README.md`](qq-official/README.md)。

启动：

```powershell
npm start
```

## 测试

```powershell
npm test
```

测试使用本地 mock，不会连接真实 QQ 开放平台，也不会消耗模型 API 额度。测试准备脚本会临时生成无版权内容的占位图片，并在测试结束后删除。

## 外部素材

本仓库不提供角色图片、游戏图片、游戏 UI、曲绘或字体。渲染器和表情清单中保留的路径只是资源槽位，不代表相应素材获准公开或再分发。

部署者只能放入自己创作、已获明确授权或许可条款允许使用的素材。缺失目录和文件清单见 [`ASSETS.md`](ASSETS.md)。Fork 本仓库不会获得任何第三方素材的许可。

## 安全说明

- `qq-official/config.local.json`、`mia-chat/config.local.json`、`.env*`、`bindings.dat` 和运行期 `data/` 均不得提交。
- 仓库只提供源码；生成的 EXE、部署包和本地日志不纳入版本控制。
- 账号绑定涉及用户凭据，部署者应限制主机访问权限，并遵守相关平台条款与当地法律。
- 不要把授权不明的角色图片、游戏图片、字体或其他第三方素材提交到仓库。

## 许可

Copyright © sam200467（sam2004）. All rights reserved.

本仓库未附带开源许可证，也不是开源软件。除 GitHub 服务条款为查看和 Fork 所必需的权限外，不授予复制、修改、再分发、再许可或商业使用权。详见 [`COPYRIGHT.md`](COPYRIGHT.md)。
