# chat-core —— 聊天引擎与客观事实层

美亚（`qq-official/`）的聊天路径都从这里取用。这里只放**与角色无关**的东西：调模型的
链路、会话壁垒、检索与知识库、以及一圈安全校验（曲名/定数/等级不许编、来源不许伪
造）。角色自己的口吻、示例对话和表情不在这里 —— 美亚那份在 `mia-chat/`。

## 角色目录与事实层是两回事

`chat.cjs` 的 `loadSettings(root)` 里，`root` 是**角色目录**，`factLayerDir` 是**客观事实层**：

| 从角色目录（`root`）读 | 从事实层（`factLayerDir`）读 |
| --- | --- |
| `config.local.json` | `knowledge/`：曲库快照、剧情、角色档案、术语 |
| `persona.md`、`examples.json` | `quotes.json`：原作台词，story 的 `quoteRefs` 按 id 指进来 |
| `expressions.json` 和它引用的表情文件 | |
| `search.local.json`、`search-key.ps1` | |

不配 `factLayerDir` 时两者同为 `root`，行为与从前逐字节一致。美亚的
[`mia-chat/config.example.json`](../mia-chat/config.example.json) 把它指回本目录。

**联网检索留在角色目录是有意的**：引擎分不清「管理员还没配好」和「这个角色本来就不
检索」，如果跟着事实层走，美亚（`research: false`）会被别人的搜索配置带上联网，而
降级文案本身是写给管理员看的，会变成角色台词吐出去。

## 入口

`chat.cjs` 导出 `loadSettings` / `createChat` / `requestReply` / `chooseImage` /
`failureReason` / `discomfort` / `normalizeAction`。

传输层、队列、冷却、去重、绑定状态机**不在这里** —— 它们各写一份放在前端目录里，
原因是各家平台的回复时序和配额模型不一样。宿主注入的能力清单（`adapter.actions`）
是引擎与前端之间唯一的缝。

QQ 宿主的 `routeIntent` 还可接收当前会话的 `queryState`，返回只读查询结果及新的
`queryState`。引擎按频道和用户隔离保存它，重置/过期一起清除；模型历史文本不作为
分页状态的唯一来源。具体字段、筛选和复核由 `qq-official/public-query.cjs` 与
`semantic-router.cjs` 实现，个人成绩和写操作仍交原指令执行器。

## 客观事实层

`knowledge/` 下的 JSON 都带来源、置信度和人工过目标记。字段含义、各文件的用途，
以及候选入库的流程见 [`knowledge/README.md`](knowledge/README.md)。
`lore-review.cjs` 是 canon 条目的唯一入口 —— 缺字段的条目进不来，因为进了索引
也只会静默失效。

## 测试

离线测试使用 mock 模型，不需要真实密钥；`npm test` 会准备 MiaBot 的角色测试配置
和占位素材，并在成功结束后清理临时文件。

```bash
npm test
node --test chat-core/knowledge.test.cjs chat-core/research-policy.test.cjs chat-core/search.test.cjs
```

联网检索的配置与排障见 [`SEARCH.md`](SEARCH.md)；冒烟脚本（`*-smoke.cjs`、
`router-spike.cjs`）会走真模型、产生少量计费调用，只在本地手动跑。
