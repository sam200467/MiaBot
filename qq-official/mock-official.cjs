"use strict";
// 假的 QQ 官方开放平台，供测试用：同时冒充 token 接口、REST API 和 WebSocket 网关。
// 与 qq/mock-onebot.cjs 同一个用途 —— 没有真实凭据也能把整条链路跑通。
//
// 用法：
//   const mock = createMockOfficial();
//   await mock.start();
//   const t = createOfficial({ appId:"1", clientSecret:"x", tokenUrl: mock.tokenUrl,
//                              apiBase: mock.apiBase, sandboxApiBase: mock.apiBase });
//   await t.start((name, d) => {...});
//   mock.push("C2C_MESSAGE_CREATE", {...});

const http = require("node:http");
const { WebSocketServer } = require("ws");

function createMockOfficial(options = {}) {
  const log = typeof options.log === "function" ? options.log : () => {};
  const server = http.createServer();
  const wss = new WebSocketServer({ server, path: "/gateway" });

  const state = {
    sent: [],           // 发出去的消息 { path, body }
    uploads: [],        // 富媒体上传 { path, body }
    identified: [],     // 收到的 Identify / Resume 帧
    heartbeats: 0,
    sockets: new Set(),
    nextError: null,    // { status, err_code, message } —— 让下一次 REST 调用失败
    tokenCalls: 0,
  };

  let port = 0;

  function json(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(body);
  }

  server.on("request", (req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { /* 忽略非 JSON */ }
      const url = req.url.split("?")[0];

      if (url === "/app/getAppAccessToken") {
        state.tokenCalls += 1;
        if (!body?.appId || !body?.clientSecret) return json(res, 400, { message: "missing credentials" });
        return json(res, 200, { access_token: "mock-token-" + state.tokenCalls, expires_in: 7200 });
      }

      if (req.headers.authorization !== "Authorization-Bypass" && !String(req.headers.authorization || "").startsWith("QQBot ")) {
        return json(res, 401, { message: "unauthorized", err_code: 11244 });
      }

      if (state.nextError) {
        const e = state.nextError; state.nextError = null;
        return json(res, e.status || 400, { message: e.message || "mock error", err_code: e.err_code });
      }

      if (url === "/gateway" && req.method === "GET") {
        return json(res, 200, { url: "ws://127.0.0.1:" + port + "/gateway" });
      }
      if (/^\/v2\/(groups|users)\/[^/]+\/files$/.test(url)) {
        state.uploads.push({ path: url, body });
        return json(res, 200, { file_uuid: "uuid-" + state.uploads.length, file_info: "fileinfo-" + state.uploads.length, ttl: 3600 });
      }
      if (/^\/v2\/(groups|users)\/[^/]+\/messages$/.test(url) && req.method === "POST") {
        state.sent.push({ path: url, body });
        return json(res, 200, { id: "sent-" + state.sent.length, timestamp: new Date().toISOString() });
      }
      return json(res, 404, { message: "not found: " + url });
    });
  });

  wss.on("connection", (ws) => {
    state.sockets.add(ws);
    // 真实网关的顺序：连上先发 Hello，客户端据此发 Identify，网关再回 READY。
    // 顺序反了客户端会发两次 Identify（收到 Hello 时又发一次）。
    ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: options.heartbeatIntervalMs || 30000 } }));
    ws.on("close", () => state.sockets.delete(ws));
    ws.on("message", (data) => {
      let frame = null;
      try { frame = JSON.parse(data.toString()); } catch { return; }
      if (frame.op === 2 || frame.op === 6) {
        state.identified.push(frame);
        ws.send(JSON.stringify({ op: 0, s: 1, t: "READY", d: { session_id: "mock-session", user: { id: "bot" } } }));
        return;
      }
      if (frame.op === 1) { state.heartbeats += 1; ws.send(JSON.stringify({ op: 11 })); return; }
    });
  });

  return {
    get tokenUrl() { return "http://127.0.0.1:" + port + "/app/getAppAccessToken"; },
    get apiBase() { return "http://127.0.0.1:" + port; },
    get port() { return port; },
    state,
    start() {
      return new Promise((resolve, reject) => {
        server.on("error", reject);
        server.listen(options.port || 0, "127.0.0.1", () => { port = server.address().port; resolve(port); });
      });
    },
    stop() {
      for (const ws of state.sockets) { try { ws.terminate(); } catch {} }
      state.sockets.clear();
      return new Promise((resolve) => { wss.close(() => server.close(() => resolve())); });
    },
    // 推一条事件给已连接的客户端
    push(eventName, d) {
      const frame = JSON.stringify({ op: 0, s: (state.sent.length + 100), t: eventName, d });
      let n = 0;
      for (const ws of state.sockets) { if (ws.readyState === 1) { ws.send(frame); n++; } }
      if (!n) log("mock.push 时没有活动连接");
      return n;
    },
    // 让下一次 REST 调用返回指定错误
    failNext(status, err_code, message) { state.nextError = { status, err_code, message }; },
    // 模拟客户端掉线
    dropClients() { for (const ws of state.sockets) { try { ws.terminate(); } catch {} } state.sockets.clear(); },
    // 等某个条件成立（测试里等异步链路跑完用）
    async waitFor(fn, timeoutMs = 3000) {
      const until = Date.now() + timeoutMs;
      while (Date.now() < until) { if (fn()) return true; await new Promise((r) => setTimeout(r, 20)); }
      return false;
    },
  };
}

module.exports = { createMockOfficial };
