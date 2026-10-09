"use strict";
// 联网判断层的真模型评估：只跑判断调用 + 决策表，不真去搜、不发任何消息。
// 会产生少量 DeepSeek 计费调用（每句一次，--repeat 成倍）。
//
// 用法：node chat-core/search-gate-smoke.cjs                全部用例，关思考
//       node chat-core/search-gate-smoke.cjs --thinking     判断调用开思考
//       node chat-core/search-gate-smoke.cjs --only=play-   只跑 id 以它开头的
//       node chat-core/search-gate-smoke.cjs --repeat=3     每句跑 3 次，看判断稳不稳
//
// 指标分三档，按误判代价排：
//   误搜     —— 不该搜却自动搜了。玩梗类（strict）必须是 0：误搜一次就是一篇攻略式长文接一个梗。
//   误提议   —— strict 用例被判成「可能在问」。只在回答没把握时才真会问「要不要我去查」，算轻度。
//   漏搜     —— 该搜没搜。代价是多聊一轮（用户回「要」或说「搜一下」），可以接受，但要看得见。
// 用例刻意不和 search-gate.cjs 里提示词的例子重复，免得量到的是背题。
//       node chat-core/search-gate-smoke.cjs --replies      走完整回复链路（判断 + 美亚回复都是真模型，
//                                                          网页是桩数据，不调 Kimi），看她实际怎么回
const path = require("node:path");
const { loadSettings, requestReply } = require("./chat.cjs");
const { prepareGate, gateSettings, describeGate } = require("./search-gate.cjs");

const G = lines => ({ context: lines });
const CASES = [
  // ── 玩梗、起哄、吐槽（strict：误搜、误提议都要记）
  { id: "play-howlive", text: "这日子到底怎么过啊", expect: "none", strict: true },
  { id: "play-mahjong", text: "教我打麻将", expect: "none" },
  { id: "play-love", text: "有没有恋爱攻略", expect: "none" },
  { id: "play-century", text: "体感上像过了一个世纪", expect: "none", strict: true },
  { id: "play-xp", text: "群主最近又更新了什么xp？", expect: "none", strict: true },
  { id: "play-range", text: "你最近活动范围有点大啊？", expect: "none", strict: true },
  { id: "play-rank", text: "我今天上分了哈哈哈", expect: "none", strict: true },
  { id: "play-dirty", text: "这手法也太脏了吧", expect: "none", strict: true },
  { id: "play-gossip", text: "最新的瓜是什么", expect: "any" },
  { id: "play-mine", text: "又被地雷谱坑了，气死", expect: "none", strict: true },
  { id: "play-slack", text: "美亚你是不是又摸鱼了", expect: "none", strict: true },
  { id: "play-v50", text: "v我50看看实力", expect: "none", strict: true },
  { id: "play-kfc", text: "疯狂星期四，谁请我吃", expect: "none", strict: true },
  { id: "play-mad", text: "急了急了", expect: "none", strict: true },
  { id: "play-collapse", text: "绷不住了", expect: "none", strict: true },
  { id: "play-copypasta", text: "你说得对，但是音击是一款由世嘉自主研发的全新音乐游戏", expect: "none", strict: true },
  { id: "play-wochao", text: "我超，o", expect: "none", strict: true },
  { id: "play-genshin", text: "原神，启动！", expect: "none", strict: true },
  { id: "play-hachimi", text: "哈基米哈基米", expect: "none", strict: true },
  { id: "play-laoliu", text: "xswl 你个老六", expect: "none", strict: true },
  { id: "play-rdcj", text: "这波啊，这波是肉蛋葱鸡", expect: "none", strict: true },
  { id: "play-family", text: "家人们谁懂啊，又没鸟", expect: "none", strict: true },
  { id: "play-cute", text: "建议改成：美亚今天也很可爱", expect: "none", strict: true },
  { id: "play-leopard", text: "芝士雪豹", expect: "none", strict: true },
  { id: "play-lead", text: "遥遥领先！", expect: "none", strict: true },
  { id: "play-qin", text: "我是秦始皇，打钱", expect: "none", strict: true },
  { id: "play-ciallo", text: "Ciallo～(∠・ω< )⌒★", expect: "none", strict: true },
  { id: "play-b50", text: "完了，我的B50要被刷屏了", expect: "none", strict: true },
  { id: "play-ifmia", text: "如果美亚去打全国大赛能拿第几名", expect: "none", strict: true },
  { id: "play-joke", text: "给我编个打音游的冷笑话", expect: "none", strict: true },
  // ── 问梗本身：真心想知道（act 要是 ask；搜不搜都行，模型认识就直接答）
  { id: "askmeme-kfc", text: "疯狂星期四是什么梗", expect: "any", act: "ask" },
  { id: "askmeme-hachimi", text: "哈基米是什么意思啊", expect: "any", act: "ask" },
  { id: "askmeme-leopard", text: "最近群里老说的芝士雪豹是啥", expect: "any", act: "ask" },
  { id: "askmeme-ciallo", text: "Ciallo 出自哪里", expect: "any", act: "ask" },
  { id: "askmeme-trend", text: "今年最火的网络梗有哪些", expect: "search", act: "ask" },
  // ── 会随时间变的事实
  { id: "fresh-chuni", text: "CHUNITHM 现在最新版本叫什么", expect: "search" },
  { id: "fresh-ongeki-event", text: "音击最近有什么新活动吗", expect: "search" },
  { id: "fresh-maimai", text: "maimai 国服什么时候更新新版本", expect: "search" },
  { id: "fresh-arcaea", text: "Arcaea 现在还在更新吗", expect: "search" },
  { id: "fresh-newgames", text: "最近有什么新出的音游吗", expect: "search" },
  { id: "fresh-sega", text: "SEGA 今年有出新的街机音游吗", expect: "search" },
  // ── 冷门、不认识的东西
  { id: "unknown-inorganyx", text: "inorganyx prayer 是哪款游戏的曲子", expect: "search" },
  { id: "unknown-nora2r", text: "nora2r 最近还有在发新曲吗", expect: "search" },
  { id: "unknown-lanota", text: "Lanota 的开发商后来还做了什么游戏", expect: "any" },
  // ── 常识：模型自己答得了（提议可以，自动搜算浪费但不算破梗）
  { id: "common-genshin", text: "原神是哪个公司做的", expect: "none" },
  { id: "common-tokyo", text: "东京塔有多高", expect: "none" },
  { id: "common-cat", text: "猫为什么喜欢钻纸箱", expect: "none" },
  // ── 问机器人自己、问群里的人和事、本地曲库
  { id: "self-avatar", text: "美亚你的头像是谁画的", expect: "none", strict: true },
  { id: "self-model", text: "你是什么模型", expect: "none", strict: true },
  { id: "self-fruit", text: "美亚最喜欢吃什么水果", expect: "none", strict: true },
  { id: "self-age", text: "你几岁了", expect: "none", strict: true },
  { id: "group-fight", text: "刚才他们在吵什么", expect: "none", strict: true },
  { id: "group-owner", text: "群主是谁啊", expect: "none", strict: true },
  { id: "group-xiaoming", text: "小明今天来打机了吗", expect: "none", strict: true },
  { id: "local-const", text: "音击里 Dengeki Tube 的 MASTER 定数是多少", expect: "none", strict: true },
  { id: "local-list", text: "音击有哪些 14+ 的歌", expect: "none", strict: true },
  // ── 普通聊天
  { id: "chat-tired", text: "今天好累啊", expect: "none", strict: true },
  { id: "chat-opinion", text: "你觉得这首歌好听吗", expect: "none", strict: true },
  { id: "chat-morning", text: "早上好呀美亚", expect: "none", strict: true },
  { id: "chat-company", text: "陪我聊会天嘛", expect: "none", strict: true },
  // ── 玩笑里夹着真问题：只搜那个真问题
  { id: "mixed-chuni", text: "笑死，顺便问下中二最新版本是啥", expect: "search" },
  { id: "mixed-maimai", text: "哈哈哈哈好吧，那 maimai 下个版本叫什么", expect: "search" },
  // ── 明说要搜
  { id: "explicit-chuni", text: "帮我搜一下 CHUNITHM 最新版本", expect: "search" },
  { id: "explicit-kfc", text: "联网查一下疯狂星期四的出处", expect: "search" },
  { id: "explicit-self", text: "搜一下你自己的设定", expect: "none" },
  { id: "explicit-vague", text: "帮我搜搜这个", expect: "none" },
  // ── 要靠群背景才判得对
  { id: "ctx-repeat", text: "疯狂星期四v我50", ...G(["群友：今天又没出勤", "群友：疯狂星期四v我50", "群友：疯狂星期四v我50"]), expect: "none", strict: true },
  { id: "ctx-ask", text: "美亚你知道吗", ...G(["群友：中二是不是快出新版本了", "群友：不知道啊"]), expect: "search" },
  // Opfer 在美亚的音击曲库里，作曲者本地就有；Dengeki Tube 不在（只有中二收录），本地答不了，搜是对的。
  { id: "ctx-local", text: "这首歌是谁写的", ...G(["群友：我今天打了 Opfer", "群友：好难"]), expect: "none", strict: true },
  { id: "ctx-elsewhere", text: "这首歌是谁写的", ...G(["群友：我今天打了 Dengeki Tube", "群友：好难"]), expect: "any" },
  { id: "local-strategy", text: "Opfer 的紫谱有没有什么攻略", expect: "any" },
  { id: "ctx-chat", text: "美亚怎么看", ...G(["群友：我昨天被老板骂了", "群友：哈哈哈哈"]), expect: "none", strict: true },
  { id: "ctx-thread", text: "你们在说什么", ...G(["群友：我是秦始皇", "群友：我是秦始皇，打钱", "群友：v我50"]), expect: "none" },
  { id: "ctx-followup", text: "帮我搜一下", history: [{ role: "user", content: "nora2r 最近还有在发新曲吗" }, { role: "assistant", content: "唔……这个美亚不太清楚呢" }], expect: "search" },

  // ── 留出集（hold-）：2026-10-09 调完规则之后才写的，用来看泛化。首跑 102/102。
  //    改出处检查（两字组→按字）之后，hold-fresh-games 因「2026年 新游戏 推荐」漏搜，
  //    随后把「推荐／好玩」和「年份的年」加进了修饰词——这一句从此不算严格的留出样本。
  //    以后再调规则，要往上面加用例，别往这一组里补「刚好修好的那句」。
  { id: "hold-play-rat", text: "鼠鼠我啊，今天又没出勤", expect: "none", strict: true },
  { id: "hold-play-zundu", text: "尊嘟假嘟", expect: "none", strict: true },
  { id: "hold-play-ikun", text: "你干嘛~哎哟", expect: "none", strict: true },
  { id: "hold-play-slide", text: "我直接一个滑铲", expect: "none", strict: true },
  { id: "hold-play-thanks", text: "听我说谢谢你，因为有你，温暖了四季", expect: "none", strict: true },
  { id: "hold-play-broken", text: "破防了家人们", expect: "none", strict: true },
  { id: "hold-play-human", text: "6，这谱面是给人打的？", expect: "none", strict: true },
  { id: "hold-play-fish", text: "今天的我也是一条咸鱼", expect: "none", strict: true },
  { id: "hold-play-bird", text: "求求了，让我鸟一次吧", expect: "none", strict: true },
  { id: "hold-play-dog", text: "美亚你会不会打音击啊（狗头）", expect: "none", strict: true },
  { id: "hold-play-sayable", text: "这是可以说的吗", expect: "none", strict: true },
  { id: "hold-play-tier", text: "什么档次，也配和我打同一张谱？", expect: "none", strict: true },
  { id: "hold-play-open", text: "格局打开", expect: "none", strict: true },
  { id: "hold-play-judge", text: "鉴定为：手残", expect: "none", strict: true },
  { id: "hold-group-ap", text: "听说今天有人 AP 了？我不信", expect: "none", strict: true },
  { id: "hold-askmeme-zundu", text: "尊嘟假嘟是什么意思", expect: "any", act: "ask" },
  { id: "hold-askmeme-rat", text: "「鼠鼠我啊」这个梗是哪来的", expect: "any", act: "ask" },
  { id: "hold-fresh-collab", text: "maimai 最近有联动活动吗", expect: "search" },
  { id: "hold-fresh-pjsk", text: "Project Sekai 最近有什么新活动", expect: "search" },
  { id: "hold-fresh-chuni-cn", text: "现在 CHUNITHM 国服是什么版本", expect: "search" },
  { id: "hold-fresh-rotaeno", text: "Rotaeno 最近更新了吗", expect: "search" },
  { id: "hold-fresh-games", text: "最近有没有什么好玩的新游戏", expect: "search" },
  { id: "hold-unknown-laur", text: "Laur 这个作曲家写过哪些音游曲", expect: "any" },
  { id: "hold-unknown-xiix", text: "XIIX 这个乐队火吗", expect: "any" },
  { id: "hold-self-chinatsu", text: "美亚你喜欢千夏吗", expect: "none", strict: true },
  { id: "hold-self-sing", text: "你会唱歌吗", expect: "none", strict: true },
  { id: "hold-group-spam", text: "刚才是谁在刷屏", expect: "none", strict: true },
  { id: "hold-group-born", text: "我们群什么时候成立的", expect: "none", strict: true },
  { id: "hold-local-bpm", text: "音击 Opfer 的 BPM 是多少", expect: "none", strict: true },
  { id: "hold-chat-arcade", text: "好想出勤啊", expect: "none", strict: true },
  { id: "hold-chat-dinner", text: "晚饭吃什么好呢", expect: "none", strict: true },
  { id: "hold-mixed-maimai", text: "草，话说 maimai 现在国服出到哪个版本了", expect: "search" },
  { id: "hold-ctx-repeat", text: "尊嘟假嘟", ...G(["群友：尊嘟假嘟", "群友：尊嘟假嘟"]), expect: "none", strict: true },
  { id: "hold-ctx-rumor", text: "美亚你听说了吗", ...G(["群友：听说 SEGA 要出新音游了", "群友：真的假的"]), expect: "search" },
];

const args = process.argv.slice(2);
const thinking = args.includes("--thinking");
const only = (args.find(a => a.startsWith("--only=")) || "").slice(7);
const repeat = Math.max(1, Number((args.find(a => a.startsWith("--repeat=")) || "").slice(9)) || 1);
const settings = loadSettings(path.resolve(__dirname, "../mia-chat"));
if (!settings) throw Error("mia-chat/config.local.json 没启用，跑不了真模型评估");
const gate = { ...gateSettings({ mode: "auto", thinking }), timeoutMs: 45000 };

function messagesOf(c) {
  return [...(c.context ? [{ role: "system", content: "【群里最近的消息，只用来帮你理解话题】\n" + c.context.join("\n") }] : []),
    ...(c.history || []), { role: "user", content: c.text }];
}
async function judge(c) {
  const r = await prepareGate({ settings, gate, messages: messagesOf(c), searchState: {}, now: Date.now() });
  return { obs: r.obs, error: r.error, ms: r.ms, decision: r.decision };
}
function grade(c, d) {
  const action = d.decision.action;
  if (c.expect === "none" && action === "search") return "误搜";
  if (c.expect === "none" && c.strict && action === "offer") return "误提议";
  if (c.expect === "search" && action !== "search") return action === "offer" ? "漏搜（会提议）" : "漏搜";
  if (c.act && d.obs && d.obs.act !== c.act) return "act 不对";
  return "";
}

// --replies：几段对话走完整链路。网页是桩：按检索词给一段写明「测试桩」的资料，
// 只用来看美亚拿到资料、没拿到资料、被提议、被拒时分别怎么说。
async function replies() {
  const s = { ...settings, searchGate: gateSettings({ mode: "auto", thinking, offerText: "要美亚去翻翻情报吗？回我一句「要」就行♪" }),
    search: { apiKey: "stub-key", cache: new Map() } };
  const webFetchImpl = async (_, options) => {
    const query = JSON.parse(options.body).text_query;
    return { ok: true, status: 200, json: async () => ({ search_results: [{ title: query + "（测试桩）", url: "https://example.com/stub",
      snippet: query, chunks: [{ text: "【测试桩资料】关于「" + query + "」：据官方公告，" + query.split(/\s+/)[0] + " 的最新版本于 2026 年 9 月上线，版本名为「STUB-VERSE」。" }] }] }) };
  };
  const scenes = [
    ["玩梗", ["哈基米哈基米"]],
    ["玩一个她可能不认识的梗", ["鼠鼠我啊，今天又没出勤"]],
    ["问会变的事（自动搜）", ["CHUNITHM 现在最新版本叫什么"]],
    ["没把握时提议，回「要」再搜", ["Lanota 的开发商后来还做了什么游戏", "要"]],
    ["明说要搜，但问的是她自己", ["帮我搜一下你自己的设定"]],
  ];
  for (const [title, turns] of scenes) {
    console.log("\n── " + title);
    let history = [], state = {}, now = Date.now();
    for (const text of turns) {
      const messages = [...history, { role: "user", content: text }];
      // 能力说明照抄 mia-entry.cjs 里「指令层没接」那一支（searchGate 开着时的写法）。
      const ability = "运行时实际能力：你正在 QQ 里回复消息，可以查阅本地音击曲库；当前消息直接附带的图片可以读取，但没有原图数据的引用图片看不到。没有查分能力。"
        + "联网由程序决定：需要的时候程序会替你查好，资料标着【程序联网检索】递给你；没有这一段就是没查过网，不能说自己查过、搜过。可以按语境发送你的表情图。";
      const result = await requestReply(s, messages, { webFetchImpl, searchState: state, now, ability, signal: AbortSignal.timeout(90000) });
      console.log("用户：" + text + "\n美亚：" + result.text.replace(/\n+/g, " ") + "\n      " + describeGate(result.searchGate).slice(1));
      history = [...messages, { role: "assistant", content: result.text }];
      state = result.searchState || {};
      now += 30000;
    }
  }
}

(async () => {
  if (args.includes("--replies")) return replies();
  const cases = CASES.filter(c => c.id.startsWith(only));
  const jobs = cases.flatMap(c => Array.from({ length: repeat }, () => c));
  const results = new Array(jobs.length);
  let next = 0;
  const started = Date.now();
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < jobs.length) { const i = next++; results[i] = { c: jobs[i], d: await judge(jobs[i]) }; }
  }));
  const tally = {};
  for (const { c, d } of results) {
    const verdict = grade(c, d);
    tally[verdict || "ok"] = (tally[verdict || "ok"] || 0) + 1;
    const o = d.obs;
    const seen = o ? `${o.act}/${o.about}${o.fresh ? "/时效" : ""}${o.confident === false ? "/没把握" : ""}${o.unknownTerms.length ? "/不认识:" + o.unknownTerms.join("、") : ""}` : "判断失败:" + d.error;
    console.log(`${verdict ? "✗ " + verdict.padEnd(8) : "✓         "} ${c.id.padEnd(20)} ${seen.padEnd(28)} → ${d.decision.action}${d.decision.target ? "「" + d.decision.target + "」" : ""}  (${d.decision.reason}；${d.ms ?? 0}ms)`);
  }
  const ms = results.map(r => r.d.ms || 0).filter(Boolean).sort((a, b) => a - b);
  console.log("\n" + (thinking ? "开思考" : "关思考") + `｜${results.length} 次判断｜` + Object.entries(tally).map(([k, v]) => k + " " + v).join("｜")
    + `｜判断耗时中位 ${ms[Math.floor(ms.length / 2)] || 0}ms、最慢 ${ms.at(-1) || 0}ms｜总用时 ${((Date.now() - started) / 1000).toFixed(0)}s`);
})().catch(error => { console.error("评估失败：", error?.message || error); process.exitCode = 1; });
