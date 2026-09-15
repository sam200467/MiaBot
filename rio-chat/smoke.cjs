const {loadSettings,requestReply}=require("./chat.cjs");
(async()=>{
 const s=loadSettings(__dirname);
 if(!s)throw Error("聊天未启用");
 const start=Date.now();
 const r=await requestReply(s,[{role:"user",content:"梨绪，你是不是又在吹自己超绝最强啦？"}]);
 console.log(JSON.stringify({ok:true,elapsedMs:Date.now()-start,text:r.text,emotion:r.emotion,scene:r.scene,expressionIds:r.expressionIds},null,2));
})().catch(()=>{console.error("DeepSeek连通测试失败（错误细节已隐藏以保护凭据）");process.exitCode=1;});
