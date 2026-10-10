"use strict";
// 翻页按钮（QQ 消息按钮 keyboard.content 那一层 { rows }）。/搜索歌曲、自然语言查询、/等级 共用一套排法，
// 照「提比不想睡觉」：上一页、页码、下一页一行，首页、末页一行。
// 分两行是因为一行五个会被挤成「⏮…」—— 点按钮发出的那页不带引用，QQ 给的气泡窄（2026-10-10 线上截图）。
//
// 翻页是回调按钮（type 1）：点了平台推 INTERACTION_CREATE，美亚把 data 当这个人发的话执行，群里不多一条消息。
// 页码是指令按钮（type 2，enter=false）：只把 input 填进输入框，页数让用户自己补；不给 input 就不放页码按钮（页码写在正文里）。
// 到头的方向不放按钮，免得点了只得到一句「没有这一页」。
// 字段出处：bot.q.qq.com/wiki 的「消息按钮」。permission.type=2 是所有人可点。
//
// owner：只该由发起人点的按钮（翻的是这个人自己的查询或成绩），data 前面加上 ownedData 的标记，
// 入口收到时比对点击人，别人点了回「没有权限」（见 mia-entry.cjs 的 parseOwnedData）。

const UNSUPPORTED = "这个版本的 QQ 不支持按钮，请手动发送翻页指令";

// 「mia:<openid>:<原 data>」。openid 只有字母数字，冒号分得开。
const ownedData = (owner, data) => owner ? `mia:${owner}:${data}` : data;
function parseOwnedData(data) {
  const match = String(data || "").match(/^mia:([A-Za-z0-9_-]+):([\s\S]+)$/);
  return match ? { owner: match[1], data: match[2] } : { owner: null, data: String(data || "") };
}

// jump(page)：翻到那一页要执行的话；input：页码按钮填进输入框的前缀（不给就不能手填）。
function pagerKeyboard({ page, pages, jump, input = null, owner = null, firstLast = true }) {
  const button = (id, label, style, action) => ({
    id, render_data: { label, visited_label: label, style },
    action: { permission: { type: 2 }, unsupport_tips: UNSUPPORTED, ...action },
  });
  const go = (id, label, target) => button(id, label, 1, { type: 1, data: ownedData(owner, jump(target)) });
  const pageButton = input ? [button("page", `第${page}/${pages}页`, 0, { type: 2, data: input, enter: false })] : [];
  const rows = [
    [...(page > 1 ? [go("prev", "◀ 上一页", page - 1)] : []), ...pageButton, ...(page < pages ? [go("next", "下一页 ▶", page + 1)] : [])],
    firstLast ? [...(page > 1 ? [go("first", "⏮ 首页", 1)] : []), ...(page < pages ? [go("last", "末页 ⏭", pages)] : [])] : [],
  ];
  return { rows: rows.filter(buttons => buttons.length).map(buttons => ({ buttons })) };
}

module.exports = { pagerKeyboard, ownedData, parseOwnedData };
