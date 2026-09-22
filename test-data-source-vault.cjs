"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync, execFileSync } = require("node:child_process");

for (const platform of ["windows", "macos"]) {
  test(platform + " 凭据库：旧绑定、双源切换、单源解绑与过期刷新隔离", { skip: platform === "windows" ? process.platform !== "win32" : !fs.existsSync(path.join(__dirname, "qq-official/macos-vault.cjs")) }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mia-source-vault-"));
    const vault = path.join(dir, "bindings.dat");
    const env = { ...process.env, MIA_VAULT_TEST_KEY: crypto.randomBytes(32).toString("base64") };
    let exe = process.execPath, prefix = [path.join(__dirname, "qq-official/macos-vault.cjs")];
    try {
      if (platform === "windows") {
        exe = path.join(dir, "vault.exe"); prefix = [];
        execFileSync("C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe", ["/nologo", "/target:exe", "/out:" + exe, "/reference:System.Web.Extensions.dll", "/reference:System.Security.dll", path.join(__dirname, "mia-vault.cs")]);
      }
      const call = (cmd, args = [], input = undefined, status = 0) => {
        const result = spawnSync(exe, [...prefix, cmd, vault, ...args], { env, input: input && JSON.stringify(input), encoding: "utf8" });
        assert.equal(result.status, status, result.stderr);
        return result.stdout.trim();
      };
      const get = () => JSON.parse(call("get", ["U"]));
      const old = { userId: "U", email: "old@example.com", password: "old-secret", playerName: "大饼玩家" };
      call("set", [], old);
      assert.equal(get().password, old.password);
      call("source", ["EMPTY", "rinnet"]);
      assert.equal(call("count"), "1", "只选来源不算绑定");
      call("source", ["U", "rinnet"]);
      const binding = { userId: "U", dataSource: "rinnet", email: "rin@example.com", playerName: "Rin玩家", cardNumber: "00000000000000000001", aimeId: "7", sessionId: "session-one", account: { accessToken: "access-secret", refreshToken: "refresh-secret" } };
      call("set", [], binding);
      assert.equal(get().password, old.password);
      assert.equal(get().rinnet.cardNumber, binding.cardNumber);
      assert.equal(get().dataSource, "rinnet");
      assert.ok(!get().rinnet.password, "rinnet 不保存密码");
      for (const secret of [old.password, binding.cardNumber, binding.account.accessToken]) assert.ok(!fs.readFileSync(vault).includes(Buffer.from(secret)));
      call("source", ["U", "otogame"]);
      assert.equal(get().rinnet.aimeId, "7");
      call("delete-source", ["U", "otogame"]);
      assert.ok(!get().password);
      assert.equal(get().rinnet.aimeId, "7");
      call("refresh-rinnet", [], { userId: "U", sessionId: "session-one", account: { accessToken: "new-access", refreshToken: "new-refresh" } });
      assert.equal(get().rinnet.account.accessToken, "new-access");
      call("set", [], { ...binding, sessionId: "session-two" });
      call("refresh-rinnet", [], { userId: "U", sessionId: "session-one", account: binding.account }, 4);
      assert.equal(get().rinnet.sessionId, "session-two");
      call("delete-source", ["U", "rinnet"]);
      call("refresh-rinnet", [], { userId: "U", sessionId: "session-two", account: binding.account }, 4);
      assert.ok(!get().rinnet, "旧请求不能恢复已解绑账号");
      assert.equal(call("count"), "0");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}
