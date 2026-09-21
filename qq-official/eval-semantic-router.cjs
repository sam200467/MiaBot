"use strict";
// Calls only the model, never QQ or player APIs. --live is explicit to avoid accidental billing.
const fs = require("node:fs");
const { routeIntent } = require("./semantic-router.cjs");
const cases = [
  ["你能查到这首歌吗：サドマミホリック", "songsearch", "サドマミホリック"],
  ["有没有哪首歌开头是サド的，如果有多个符合条件的歌，全部列出来", "songsearch", "サド"],
  ["曲名记不清了，好像叫サドマミホリツク，帮我找找", "songsearch", "サドマミホリツク"],
  ["帮我查一下id870", "songsearch", "870"],
  ["VIIIbit Explorer紫谱定数多少", "songsearch", "VIIIbit Explorer"],
  ["我在サドマミホリック上的最高分是多少", "song", "サドマミホリック"],
  ["想看看我的八爪鱼成绩图", "song", "八爪鱼"],
  ["把我那110张成绩整理成图吧", "chart"],
  ["看看我的b50", "chart"],
  ["我13+都打得怎么样了，给个成绩表", "level", "13+"],
  ["查14.2的定数表", "constant", "14.2"],
  ["帮我看看id870紫谱能丢多少分还算鸟", "chartinfo", "870"],
  ["把id870叫成八爪鱼，记下来", "aliasadd", "|"],
  ["别再让其他人查我的成绩了", "deny"],
  ["我想把大饼账号绑一下", "bind"],
  ["在吗", "chat"],
  ["今天打歌手都酸了", "chat"],
  ["我今天单曲分数太烂了，安慰我一下", "chat"],
  ["队列里还剩几个任务", "status"],
  ["算一下14.2打1000737的rating", "clarify"],
  ["14.2，1000737，铃铛fb，连击fc，算rating", "calculate", "fb"],
  ["帮我查一下他的单曲成绩", "clarify"],
  ["那首的成绩也看看", "song", "サドマミホリック", [
    { role: "user", content: "搜索サドマミホリック" }, { role: "assistant", content: "《サドマミホリック》 MAS 13.5" }]],
  ["紫谱", "chartinfo", "870", [
    { role: "user", content: "分析一下id870的分数线" }, { role: "assistant", content: "要哪个难度呢？" }]],
];
async function main() {
  if (!process.argv.includes("--live")) { console.log("Use --live to test the configured model without executing actions."); return; }
  const { loadConfig, createMiaBot } = require("./mia-entry.cjs");
  const bot = createMiaBot(loadConfig(), { log: () => {} });
  const specs = [...require("../takase-core.cjs").CAPABILITY_SPECS, require("./song-search.cjs").SEARCH_SPEC];
  const results = [];
  try {
    for (const [text, expected, queryPart, history = []] of cases) {
      const start = Date.now();
      const result = await routeIntent({ settings: bot.settings, specs, messages: [...history, { role: "user", content: text }], signal: AbortSignal.timeout(30000),
        validateAction: (action, userText) => action.name === "calculate" && bot.commands.hasInventedEnum(action.query, userText).length ? "请补充铃铛和连击" : "" });
      const actual = result?.action?.name || (result ? "clarify" : "chat");
      const passed = actual === expected && (!queryPart || result?.action?.query?.toLowerCase().includes(queryPart.toLowerCase()));
      results.push({ text, expected, actual, query: result?.action?.query, passed, ms: Date.now() - start });
      console.log(`${passed ? "PASS" : "FAIL"} ${expected} -> ${actual}: ${text}`);
    }
  } finally { bot.stop(); }
  const report = { model: bot.settings.c.provider.model, date: new Date().toISOString(), passed: results.filter(r => r.passed).length, total: results.length, results };
  fs.writeFileSync(require("node:path").join(__dirname, "../.codex-temp/mia-router-evaluation.json"), JSON.stringify(report, null, 2));
  console.log(`Result: ${report.passed}/${report.total}`);
}
if (require.main === module) main().catch(() => { console.error("Evaluation failed; check local config/network."); process.exitCode = 1; });
module.exports = { cases };
