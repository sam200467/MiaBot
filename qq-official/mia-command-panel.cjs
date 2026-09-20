#!/usr/bin/env node
"use strict";
// 指令面板：让群里在输入框打「/」时把美亚的指令清单拉出来。
//
// ── 它只做「发现入口」，一行执行逻辑都没有 ──────────────────────────
//
// 面板元素 type=command 的行为是「点击后把 name 填进聊天输入框」（官方文档原文），
// 也就是说用户点一下得到的是 `/帮助` 这五个字符，跟手打一模一样 ——
// 之后照常走 mia-commands.cjs 的硬路由、@ 判断、权限、冷却、队列。
// 所以这个文件**不改也不该改**任何执行路径；它错了最多是面板难看，
// 不会让谁绕过校验。
//
// ── 平台约束（官方文档 bot.qq.com/wiki，2026-08-13 更新）──────────
//   · POST /v2/panels 创建，10 QPM；一个机器人**最多 20 个面板**
//   · scope: c2c | group | channel | dm；**channel/dm 只能 all**
//   · target_type: all | specific；**只有 c2c 和 group 支持 specific**
//   · 一个面板最多 20 个元素；name ≤14 字符、desc ≤30 字符
//   · PUT /v2/panels/{id} 只覆盖面板内容，**不动已关联的群**（所以改内容不用重挂群）
//   · 40030009 = 有并发操作在进行，重试即可
//
// ── 用法 ────────────────────────────────────────────────────────────
//   node qq-official/mia-command-panel.cjs --dry-run          # 只打印要发的 payload
//   node qq-official/mia-command-panel.cjs --register         # 注册到配置里的允许群
//   node qq-official/mia-command-panel.cjs --list             # 看现在有哪些面板
//   node qq-official/mia-command-panel.cjs --delete <panel_id>
//
// ⚠ 默认只挂 `target_type=specific` + `config.local.json` 里的 allowedGroupIds。
//   想全场景生效要显式加 `--all-groups`（会把面板推给所有装了它的群）。

const { COMMANDS, ALIASES } = require("./mia-commands.cjs");

const PANEL_ITEM_MAX = 20;   // 平台上限，一个面板最多 20 个元素
const NAME_MAX = 14;         // 官方文档：约 7 个中文汉字
const DESC_MAX = 30;         // 官方文档：约 15 个中文汉字
const PANEL_COUNT_MAX = 20;  // 一个机器人最多 20 个面板

// 面板备注：**不是给用户看的**，是给我们自己认领面板用的（列表接口不返回别的东西
// 能区分「这个面板是不是我们建的」）。--register 就是靠它找到已存在的面板去改。
const PANEL_REMARK = "mia-command-panel v1｜由 qq-official/mia-command-panel.cjs 生成，勿手改";

// 每条指令在面板里的一句说明，美亚的口吻。
//
// ⚠ **必须和 mia-commands.cjs 的 COMMANDS 一一对应** —— 有测试盯着
// （test-mia-command-panel.cjs「命令表和面板描述必须一一对应」），
// 加了新命令却忘了写描述会在测试里挂掉。
// 这正是「代码里有命令、面板里忘记更新」那类双份维护的防线：
// 描述单独放一张表是没办法的事（面板的 desc 是给人看的话术，塞不进命令表），
// 但**漏了会响**，不会静默。
const DESCRIPTIONS = Object.freeze({
  help: "看看美亚都会些什么",
  // ⚠ 这句不是随便写的。原来是「把你的大饼账号交给美亚（要私聊）」，平台**拒绝**它，
  // 报的却是 40030013「超出数量限制」—— 排查了半天才发现超的不是数量是文案。
  // 实测：同一个意思换个说法就过（半角括号过、去掉括号过、改这句也过），
  // 而那个原句每次都被拒，稳定复现。所以面板文案要当成**面向陌生人的公开文案**来写，
  // 别出现「把你的账号交给…」这类句式 —— 被拦了也要知道错的是文案不是数量。
  bind: "先私聊美亚，再发这一条",
  chart: "B50 + N10 + P50 的分表",
  plate: "版本牌子完成度长图",
  song: "一首歌的全难度成绩图",
  chartinfo: "单张谱面的分数线与容错",
  constant: "按定数查谱面，不用绑定",
  level: "等级成绩长图",
  calculate: "算单曲 Rating",
  aliasadd: "给一首歌加个别名",
  aliasdelete: "删别名（只对指定账号开放）",
  aliases: "这首歌都有哪些叫法",
  whatis: "按别名反查是哪首歌",
  allow: "让别人能查美亚这边的成绩",
  deny: "不让别人查我的成绩",
  status: "美亚现在忙不忙",
  unbind: "删掉本机存的账号",
  cancel: "中断正在进行的操作",
});

// 面板里那条命令长什么样：取 ALIASES 的第一个说法（中文那个），前面加斜杠。
// 点击后填进输入框的就是它，所以它必须是**真能用的命令写法**。
function commandText(name) {
  const words = ALIASES[name];
  if (!words || !words.length) throw new Error("命令没有可用写法：" + name);
  return "/" + words[0];
}

// 按 COMMANDS 的顺序生成面板元素。exclude 里的跳过。
function panelItems(options = {}) {
  const exclude = new Set(options.exclude || []);
  const items = [];
  for (const name of Object.keys(COMMANDS)) {
    if (exclude.has(name)) continue;
    const desc = DESCRIPTIONS[name];
    if (!desc) throw new Error("命令 " + name + " 没有面板描述 —— 往 DESCRIPTIONS 里补一条");
    items.push({ type: "command", name: commandText(name), desc });
  }
  return items;
}

// 发之前先自己验一遍。官方那边报错是 40030013 / 40030016 这类，
// 但等到那时候已经发出了一个半成品请求，不如本地就拦下来、把话说清楚。
function validatePanel(panel) {
  const items = panel.items || [];
  if (items.length > PANEL_ITEM_MAX) {
    throw new Error("面板元素 " + items.length + " 个，超过平台上限 " + PANEL_ITEM_MAX +
      "。请用 exclude 挑掉几条（面板是发现入口，不是全集）。");
  }
  if (!items.length) throw new Error("面板一个元素都没有");
  for (const item of items) {
    if ([...String(item.name)].length > NAME_MAX) {
      throw new Error("面板元素名超长（上限 " + NAME_MAX + " 字符）：" + JSON.stringify(item.name));
    }
    if (item.desc && [...String(item.desc)].length > DESC_MAX) {
      throw new Error("面板元素描述超长（上限 " + DESC_MAX + " 字符）：" + JSON.stringify(item.desc));
    }
  }
  if (panel.remark && [...String(panel.remark)].length > 255) {
    throw new Error("面板备注超长（上限 255 字符）");
  }
  return panel;
}

// 内容的稳定版本号。**不是给用户看的**，是用来判断「这次要不要真的发请求」：
// 内容没变就别再 PUT 一次，免得撞上 40030009（并发操作进行中）。
function contentVersion(panel) {
  const text = JSON.stringify(panel);
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) | 0;
  return Math.abs(hash) % 1000000;
}

function buildPanel(options = {}) {
  const panel = {
    items: panelItems(options),
    remark: PANEL_REMARK,
    version: 0,
  };
  panel.version = contentVersion(panel);
  return validatePanel(panel);
}

// ── 接口调用 ────────────────────────────────────────────────────────
// 只用 transport.rest（它带 access_token 和 base URL），**不连网关** ——
// 所以这个脚本可以在 bot 正跑着的时候执行，不会造成两条 WS 连接那种事。
// ⚠ rest 没有限流/去重/熔断，用它的地方要自己负责（见 official-transport.cjs 的注释）。
function createApi(transport) {
  return {
    list: (scope) => transport.rest("GET", "/v2/panels?scope=" + scope + "&limit=50"),
    create: (body) => transport.rest("POST", "/v2/panels", body),
    detail: (id) => transport.rest("GET", "/v2/panels/" + id),
    update: (id, body) => transport.rest("PUT", "/v2/panels/" + id, body),
    remove: (id) => transport.rest("DELETE", "/v2/panels/" + id),
  };
}

// 在已有面板里认出「我们建的那个」。列表接口不返回别的东西能区分来源，所以靠 remark。
function findOurs(listPayload) {
  const records = Array.isArray(listPayload?.records) ? listPayload.records : [];
  return records.find((record) => String(record?.panel?.remark || "") === PANEL_REMARK) || null;
}

// 比较「我们想放的」和「平台存着的那份」时，先把两边都揉成同一个形状。
//
// 两个实测差异（2026-09-19）：
//   · **平台会把 name 开头那个斜杠去掉再存**：发 "/帮助"，读回来是 "帮助"。
//   · **键的顺序也不一样**：我们发 {type,name,desc}，它返回 {name,desc,type}。
// 而 JSON.stringify 对键序敏感 —— 直接比会**永远判成「有变化」**，
// 于是每次 --register 都白发一个 PUT，还可能撞上 40030009（并发操作进行中）。
function normalizeItems(items) {
  return (Array.isArray(items) ? items : []).map((item) => ({
    name: String(item?.name || "").replace(/^\/+/, ""),
    desc: String(item?.desc || ""),
    type: String(item?.type || "command"),
  }));
}

async function registerGroupPanel(options) {
  const { transport, groups, log = console.log, dryRun = false, allGroups = false } = options;
  const api = createApi(transport);
  const panel = buildPanel(options);

  const body = allGroups
    ? { scope: "group", target_type: "all", panel }
    : { scope: "group", target_type: "specific", group_openids: groups, panel };

  if (!allGroups && (!Array.isArray(groups) || !groups.length)) {
    throw new Error("没有指定群 openid。默认只挂 specific 模式，需要至少一个群；" +
      "要把面板推给所有群请显式加 --all-groups。");
  }

  log("面板元素 " + panel.items.length + " 个，version=" + panel.version);
  log("生效范围：" + (allGroups ? "all（所有群）" : "specific（" + groups.length + " 个群）"));
  for (const item of panel.items) log("  " + item.name.padEnd(8, "　") + "  " + item.desc);

  if (dryRun) {
    log("\n--dry-run：只打印，不发请求。实际会 POST /v2/panels：");
    log(JSON.stringify(body, null, 2));
    return { dryRun: true, body };
  }

  // 已经建过就改它 —— 一个机器人只有 20 个面板名额，反复创建会把名额烧光。
  const existing = findOurs(await api.list("group"));
  if (existing) {
    // ⚠ 拿 items 比，**不要比 version**：实测列表接口根本不返回 panel.version
    // （返回 undefined），拿它比会永远判成「有变化」，于是每次白发一个 PUT。
    // 而且要比归一化之后的形状 —— 直接 stringify 会因为键序和斜杠的差异永远不相等。
    const same = JSON.stringify(normalizeItems(existing?.panel?.items)) === JSON.stringify(normalizeItems(panel.items));
    if (same) {
      log("\n已存在同名面板 " + existing.panel_id + " 且内容一致，不用改。");
      return { panelId: existing.panel_id, updated: false, unchanged: true };
    }
    log("\n已存在面板 " + existing.panel_id + "，内容有变化，改用 PUT 更新（**不动已关联的群**）。");
    await api.update(existing.panel_id, { panel });
    return { panelId: existing.panel_id, updated: true };
  }

  const created = await api.create(body);
  log("\n已创建面板 " + created.panel_id + "（" + PANEL_REMARK.split("｜")[0] + "）");
  return { panelId: created.panel_id, created: true };
}

// ── 命令行 ──────────────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2);
  const has = (flag) => argv.includes(flag);
  const valueOf = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : null;
  };

  const { loadConfig, makeFileLog } = require("./mia-entry.cjs");
  const { createOfficial } = require("./official-transport.cjs");
  const config = loadConfig();
  const log = (text) => console.log(text);
  // 不调用 transport.start()：这里只要 token + REST，不需要网关，
  // 所以 bot 跑着的时候也能安全执行这个脚本。
  const transport = createOfficial({ ...config, log: (m) => console.error("[传输] " + m) });
  const api = createApi(transport);

  try {
    if (has("--list")) {
      const payload = await api.list("group");
      console.log(JSON.stringify(payload, null, 2));
      const ours = findOurs(payload);
      console.log(ours ? "\n本脚本建的面板：" + ours.panel_id : "\n本脚本还没建过面板。");
      return;
    }

    const panelId = valueOf("--delete");
    if (panelId) {
      await api.remove(panelId);
      console.log("已删除面板 " + panelId);
      return;
    }

    // 详情接口是**唯一**能确认「这个面板挂在哪些群」的地方 ——
    // 列表接口不返回 group_openids，所以注册完想核对范围只能用这个。
    const detailId = valueOf("--detail");
    if (detailId) {
      const detail = await api.detail(detailId);
      console.log(JSON.stringify(detail, null, 2));
      console.log("\n生效群（group_openids）：" + JSON.stringify(detail?.group_openids || []));
      return;
    }

    const groups = valueOf("--groups")
      ? String(valueOf("--groups")).split(",").map((s) => s.trim()).filter(Boolean)
      : (config.allowedGroupIds || []).map(String);

    await registerGroupPanel({
      transport, groups, log,
      dryRun: has("--dry-run"),
      allGroups: has("--all-groups"),
    });
  } finally {
    transport.stop();
  }
}

if (require.main === module) {
  main().catch((error) => {
    const msg = String(error?.message || error).replace(/R4hLze[A-Za-z0-9]*/g, "***").replace(/QQBot [\w.-]+/g, "QQBot ***");
    console.error("失败：" + msg);
    if (error?.code) console.error("（官方错误码 " + error.code + "）");
    process.exit(1);
  });
}

module.exports = {
  PANEL_REMARK, PANEL_ITEM_MAX, NAME_MAX, DESC_MAX, PANEL_COUNT_MAX,
  DESCRIPTIONS, commandText, panelItems, validatePanel, contentVersion,
  buildPanel, createApi, findOurs, normalizeItems, registerGroupPanel,
};
