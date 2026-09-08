# Takase Bot Discord — macOS 版

与 Windows 版功能、UI 完全一致：Discord 私人服务器查分 Bot（`/help` `/bind` `/chart` `/status` `/unbind`），只是系统适配层换成了 macOS 原生实现。

## 前置要求（构建机）

- macOS 12+
- Node.js 22+（`brew install node`）
- .NET 8 SDK（`brew install dotnet`）
- Git 与 npm（随 Node）

## 构建步骤

```bash
# 1. 在项目根目录安装依赖（首次）
npm install

# 2. 构建（在项目根目录执行）
node mac/build-macos.js
```

构建约几分钟，产物：`mac/dist/Takase Bot Discord.app`。构建脚本内置全部自测：
分表核心自测 → Discord 核心自测 → 凭据库自测（钥匙串读写）→ 图标生成 → Avalonia 发布 → .app 签名与总自测，任何一步失败都会中止。

## 使用

1. 双击 `Takase Bot Discord.app` 打开。
2. 填写自己的 Application ID、服务器 ID 和频道 ID，再粘贴 **Bot Token**。
3. 代理：如果 Discord 连接超时，填本地 HTTP 代理（如 `http://127.0.0.1:7890`）；开启系统代理时启动会自动检测填充。
4. 保存设置（加密存入**登录钥匙串**）→ 启动 Bot → 日志出现"Discord Gateway 已连接"即可在频道使用。
5. 勾选"登录后自动启动"会写入 `~/Library/LaunchAgents/local.takase.discord-bot.plist`。

## 与 Windows 版的差异（仅系统层）

| 项目 | Windows 版 | macOS 版 |
|---|---|---|
| 数据目录 | `%LOCALAPPDATA%\TakaseDiscordBot` | `~/Library/Application Support/TakaseDiscordBot` |
| 设置与绑定存储 | DPAPI 加密文件（secrets.dat / bindings.dat） | **登录钥匙串**（Keychain generic password） |
| 系统代理检测 | 注册表 Internet Settings | `scutil --proxy` |
| 自动启动 | 注册表 Run 键 | LaunchAgent plist |
| 浏览器登录 | Chrome/Edge（Windows 路径） | Chrome/Edge（/Applications 路径，首次运行如系统询问"控制您的电脑"请允许） |
| 分表图片 | 内存传输，不落盘 | 同左 |

## 常见问题

- **打开提示"已损坏/无法验证开发者"**：本机开发构建为 ad-hoc 签名，首次打开请在终端执行
  `xattr -dr com.apple.quarantine "/Applications/Takase Bot Discord.app"`（或右键→打开）。
- **Apple Silicon 上闪退（Killed: 9）**：构建脚本已对每个 SEA 二进制和 .app 做 ad-hoc 签名；
  若手动拷贝单文件二进制请重新签名 `codesign --force --sign - <文件>`。
- **钥匙串弹授权框**：凭据库统一走 `/usr/bin/security`，一般不会弹窗；如弹窗请点"始终允许"。
- **锁屏/睡眠会使 Bot 离线**：与 Windows 版一致，Discord Gateway 是长连接。

## 重新构建

任何源码改动后重新执行 `node mac/build-macos.js` 即可；`mac/dist/` 与 `mac/assets/`、bundle 中间产物可随时重建。
