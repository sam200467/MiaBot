const {loadSettings,requestReply,failureReason}=require("./chat.cjs");
let s=null;
(async()=>{
 s=loadSettings(__dirname);
 if(!s)throw Error("聊天未启用");
 const start=Date.now();
 const r=await requestReply(s,[{role:"user",content:"梨绪，你是不是又在吹自己超绝最强啦？"}]);
 console.log(JSON.stringify({ok:true,elapsedMs:Date.now()-start,text:r.text,emotion:r.emotion,scene:r.scene,expressionIds:r.expressionIds},null,2));
})().catch(error=>{
 // 失败原因照实打印（密钥已抹掉）；只报“失败了”无法判断是超时、网络还是模型返回跑偏。
 console.error("DeepSeek连通测试失败："+failureReason(error,s?.c.provider.apiKey));
 process.exitCode=1;
});
