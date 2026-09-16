# Takase Bot

用于 Discord 的音击（ONGEKI）查分机器人，支持 B50 / N10 / P50 分表、版本牌子完成度、单曲成绩、谱面分析、等级成绩、定数表与 Rating 计算。

## Windows 构建

需要 Windows、Node.js 22、npm，以及 Windows .NET Framework C# 编译器。构建脚本使用系统路径下的 csc.exe。

```powershell
npm ci
npm run build:bot
```

构建产物为 `Takase Bot Discord.exe`，构建流程包含离线自测。首次构建需要联网下载依赖和 postject。

启动程序后，在界面配置 Bot Token、Application ID、服务器 ID 和频道 ID；首次启动时这些 ID 留空，需要填写自己的配置。详细说明见 [Discord 使用说明](Takase%20Bot%20Discord%20使用说明.md)。

## 源码结构

- `takase-core.cjs`：平台无关核心（曲库检索、定数计算、凭据库、分表渲染调用）。
- `takase-discord-entry.mjs`：Discord 命令与任务处理。
- `takase-discord-gui.cs`：Windows 设置与启动界面。
- `takase-discord-vault.cs`：Windows DPAPI 凭据存储。
- `app-template.js`、`build.js`：分表核心与构建。
- `themes/`：图片渲染模板、素材与调试工具。

## 本地数据

不要提交 Bot Token、账号密码、`.env`、`secrets.dat`、`bindings.dat` 或个人成绩导出文件。Windows 凭据存放在 `%LOCALAPPDATA%\TakaseDiscordBot`。EXE、缓存、设计 PSD、预览图片和本地 SDDT 资源包已由 `.gitignore` 排除；EXE 可单独通过 GitHub Releases 分发。

预览示例使用虚构昵称和演示成绩。仓库包含第三方图片及字体；各项资源的使用和再分发应遵循其各自授权。本仓库暂未指定开源许可证。
