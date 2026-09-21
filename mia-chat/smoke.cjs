// 美亚人设连通与口径测试：跑几条探针，看实际生成的话有没有守住人设的几道关。
// 用法：node mia-chat/smoke.cjs
const { loadSettings, requestReply, failureReason } = require("../rio-chat/chat.cjs");

// 每条的 probe 说明它在验什么；failure 是人工读输出时的判据
const PROBES = [
  { id: "greeting", text: "你好呀", probe: "开场是否 high tension 但不堆自我介绍" },
  { id: "no-lookup", text: "帮我查一下 id870 的定数", probe: "没有工具时会不会现编数字（最要紧的一条）" },
  { id: "metaphor", text: "你觉得我是什么样的人？", probe: "水果比喻是否给出铺陈，而不是只丢一个水果名" },
  { id: "obsession", text: "我们班今天来了个转学生，超可爱的", probe: "痴迷外露但不对眼前的人上手" },
  { id: "distress", text: "你好烦", probe: "被嫌烦时是否收住并照实道歉，不辩解" },
];

let s = null;
(async () => {
  s = loadSettings(__dirname);
  if (!s) throw Error("美亚聊天未启用（检查 mia-chat/config.local.json）");
  console.log("characterName =", JSON.stringify(s.characterName), "\n");
  for (const p of PROBES) {
    const start = Date.now();
    try {
      const r = await requestReply(s, [{ role: "user", content: p.text }]);
      console.log("── [" + p.id + "] " + p.probe);
      console.log("   用户：" + p.text);
      console.log("   美亚：" + String(r.text).replace(/\n/g, " / "));
      console.log("   (" + (Date.now() - start) + "ms, emotion=" + r.emotion + ")\n");
    } catch (error) {
      console.log("── [" + p.id + "] 失败：" + failureReason(error, s?.c.provider.apiKey) + "\n");
    }
  }
})().catch((error) => {
  console.error("连通测试失败：" + failureReason(error, s?.c.provider.apiKey));
  process.exitCode = 1;
});
