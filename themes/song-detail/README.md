# MiaBot 单曲全难度成绩图

此主题供 `/song <Song ID 或曲名>` 的唯一命中结果使用，画布固定为 `2160 × 1350`。

## 目录

```text
song-detail/
├─ assets/       正式运行需要的透明底图及横板资源
├─ renderer/     theme.html、theme.css、theme.js
├─ design/       PSD、完整参考图和未合成背景
├─ examples/     数据契约与三种布局测试数据
├─ previews/     实际浏览器生成的视觉验收图
└─ tools/        render-preview.js
```

## 固定显示规则

1. `song.status` 只接受 `online` 和 `unavailable`。其它值一律按 `unavailable` 显示。
2. 五行顺序固定为 BASIC、ADVANCED、EXPERT、MASTER、LUNATIC。
3. 某难度不存在时，该行九个字段均只显示一条横杠 `-`，包括难度名位置。
4. 只有 LUNATIC 谱面的歌曲，前四行因此会全部显示九个 `-`，第五行正常显示。
5. 谱面存在但用户未游玩时，难度、定数、谱师、Chain、Bell 正常显示；个人评级、AB、FB、技术分显示 `-`。
6. 九列使用固定网格和等宽数字对齐。谱师过长时缩小后截断，不得挤动相邻列。
7. 曲名保持单行，优先缩至安全字号，仍过长时在曲师区域之前以省略号截断。

每一行从左到右为：

```text
难度｜谱面定数｜技术评级｜AB｜FB｜技术分｜谱师｜Chain｜Bell
```

## Boss Card 数据

`ongeki-music-internal.json` 已增加：

```text
bossCardId
bossCardName
bossLevel
status
```

Boss Card ID 与游戏资源中同 Song ID 的 `Music.xml/BossCard` 对应，不根据角色名猜测。
本地游戏资源未覆盖到的完整卡名由同 Song ID 的补充曲库填充，现有值如有冲突会拒绝写入；
可运行 `tools/merge_boss_card_names.py <补充曲库.json>` 先审计，再加 `--write` 合并。

## 本地预览

```powershell
node .\themes\song-detail\tools\render-preview.js
node .\themes\song-detail\tools\render-preview.js `
  .\themes\song-detail\previews\song-detail-lunatic-only.png `
  .\themes\song-detail\examples\preview-lunatic-only.js
```

预览工具使用临时锁，拒绝并发生成，避免两个测试用例覆盖同一个临时 `preview-data.js`。

## CSS 实时调试器

双击项目根目录的“启动单曲模板CSS调试器.bat”。浏览器会自动打开双栏调试页面：

如果系统对中文批处理文件名兼容不好，也可以双击纯英文入口 `start-song-theme-css-editor.cmd`。

- 左侧直接编辑正式的 `renderer/theme.css`，输入后立即反映到右侧预览。
- 支持普通歌曲、仅 Lunatic 和超长文本三组测试数据。
- “跳到规则”可以快速定位标题、作曲家、Status、Boss、Boss Lv 和成绩行等常用区域。
- 点击“保存到 theme.css”或按 `Ctrl+S` 才会写入磁盘；关闭页面前若有未保存内容会提示。
- 调试服务只监听 `127.0.0.1`。关闭启动窗口或按 `Ctrl+C` 即可停止。

## Discord 搜索约定

- `id870` 或完整数字 `870`：按完整 Song ID 精确匹配。
- 其它输入：Unicode NFKC、大小写和连续空格归一化后，对曲名执行包含匹配。
- 多个命中：仅向命令发起者分行列出 `Song ID｜曲名｜作者`，引导再次输入唯一 ID 或更完整曲名。
- 唯一命中：读取已绑定凭据，进入与 `/chart` 共用的有界队列并生成本主题图片。
