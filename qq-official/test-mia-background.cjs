"use strict";
// 启动器背后的 mia-background.cjs，和生成启动器的 make-launchers.cjs。
// 全用假的进程列表、假计划任务、临时目录里的假日志：不起真美亚，不碰计划任务。
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const bg = require("./mia-background.cjs");
const { writeLaunchers, OBSOLETE } = require("./make-launchers.cjs");

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "mia-background-"));
// 等得很短：真实时间跑，但几十毫秒就分出结果
const FAST = { timeoutMs: 400, appearMs: 120, pollMs: 5, lookMs: 10 };
const noTask = { find: async () => null, run: async () => { throw new Error("不该走计划任务"); } };
const mia = (pid) => ({ pid, commandLine: '"C:\\Program Files\\nodejs\\node.exe" mia-entry.cjs' });

// 假美亚：launch 之后过一会儿出现在进程列表里，再往 mia.log 写一行
function fakeLaunch(dir, procs, { line = "[01:02:03] 已就绪，等待消息。\n", pid = 4321, delay = 20 } = {}) {
  const calls = [];
  return {
    calls,
    launch(where) {
      calls.push(where);
      setTimeout(() => { procs.push(mia(pid)); if (line) fs.appendFileSync(path.join(dir, "mia.log"), line); }, delay);
    },
  };
}

test("就绪那句跟 mia-entry 打的一致", () => {
  const source = fs.readFileSync(path.join(__dirname, "mia-entry.cjs"), "utf8");
  assert.ok(source.includes('log("' + bg.READY_LINE), "mia-entry.cjs 里找不到 log(\"" + bg.READY_LINE + "…\")");
});

test("认美亚：命令行里带 mia-entry 的 node，别的不算", () => {
  assert.equal(bg.isMiaCommand('"C:\\Program Files\\nodejs\\node.exe" mia-entry.cjs'), true);
  assert.equal(bg.isMiaCommand("node C:\\MiaBot\\deploy-windows-server\\qq-official\\mia-entry.cjs"), true);
  assert.equal(bg.isMiaCommand("node mia-background.cjs start"), false);
  assert.equal(bg.isMiaCommand("node stop-mia.cjs"), false);
  assert.equal(bg.isMiaCommand(null), false);
});

test("计划任务：只认启动这个目录的 mia-task.cmd、又没被禁用的", () => {
  const dir = "C:\\MiaBot\\deploy-windows-server\\qq-official";
  const actions = 'cmd.exe /d /s /c ""C:\\MiaBot\\deploy-windows-server\\qq-official\\mia-task.cmd" task"';
  assert.equal(bg.taskStartsHere({ state: "Ready", actions }, dir), true);
  assert.equal(bg.taskStartsHere({ state: "Running", actions: actions.toUpperCase() }, dir), true);
  assert.equal(bg.taskStartsHere({ state: "Disabled", actions }, dir), false);
  assert.equal(bg.taskStartsHere({ state: "Ready", actions }, "D:\\mia\\qq-official"), false);
  assert.equal(bg.taskStartsHere(null, dir), false);
});

test("读新日志：从 offset 往后；文件被换成新的（比 offset 短）就从头读", () => {
  const dir = tmpDir();
  const file = path.join(dir, "mia.log");
  fs.writeFileSync(file, "旧的一行\n");
  const offset = fs.statSync(file).size;
  fs.appendFileSync(file, "新的一行\n");
  assert.equal(bg.readFrom(file, offset), "新的一行\n");
  fs.writeFileSync(file, "换过的\n");
  assert.equal(bg.readFrom(file, offset + 1000), "换过的\n");
  assert.equal(bg.readFrom(path.join(dir, "没有.log"), 0), "");
});

test("给 .vbs 的结果：UTF-16LE 带 BOM，换行是 CRLF", () => {
  const data = bg.encodeResult("第一行\n第二行");
  assert.deepEqual([...data.subarray(0, 2)], [0xff, 0xfe]);
  assert.equal(data.toString("utf16le").slice(1), "第一行\r\n第二行");
});

test("PowerShell 报错：CLIXML 只留第一行人话", () => {
  const clixml = '#< CLIXML\r\n<Objs Version="1.1.0.1"><S S="Error">找不到任务 MiaBot。_x000D__x000A_</S><S S="Error">所在位置 行:1_x000D__x000A_</S></Objs>';
  assert.equal(bg.powerShellError(clixml), "找不到任务 MiaBot。");
  assert.equal(bg.powerShellError("拒绝访问。\r\n第二行"), "拒绝访问。");
});

test("start：已经有美亚在跑就不再开", async () => {
  let launched = false;
  const result = await bg.start({ dir: tmpDir(), list: async () => [mia(111)], task: noTask, launch: () => { launched = true; }, ...FAST });
  assert.equal(result.code, 2);
  assert.match(result.text, /已经在运行了（进程 111）/);
  assert.equal(launched, false);
});

test("start：没有计划任务就自己起，等到「已就绪」报成功", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "mia.log"), "[00:00:00] 已就绪，等待消息。（上一次的，不算）\n");
  const procs = [];
  const fake = fakeLaunch(dir, procs);
  const result = await bg.start({ dir, list: async () => procs, task: noTask, launch: fake.launch, ...FAST });
  assert.deepEqual(fake.calls, [dir]);
  assert.equal(result.code, 0, result.text);
  assert.equal(result.pid, 4321);
  assert.doesNotMatch(result.text, /计划任务/);
});

test("start：有计划任务就交给它", async () => {
  const dir = tmpDir();
  const procs = [];
  const fake = fakeLaunch(dir, procs);
  let ran = 0;
  const task = { find: async () => ({ state: "Ready", actions: "" }), run: async () => { ran++; fake.launch(dir); } };
  const result = await bg.start({ dir, list: async () => procs, task, launch: () => assert.fail("有任务时不该直接起"), ...FAST });
  assert.equal(ran, 1);
  assert.equal(result.code, 0, result.text);
  assert.match(result.text, /计划任务 MiaBot/);
});

test("start：查计划任务出错时照常直接起", async () => {
  const dir = tmpDir();
  const procs = [];
  const fake = fakeLaunch(dir, procs);
  const task = { find: async () => { throw new Error("PowerShell 坏了"); }, run: async () => assert.fail("不该走计划任务") };
  const result = await bg.start({ dir, list: async () => procs, task, launch: fake.launch, ...FAST });
  assert.equal(result.code, 0, result.text);
});

test("start：起来又没了，带上 mia-stderr.log 里新的报错", async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "mia-stderr.log"), "上次的旧报错\n");
  const procs = [];
  const launch = () => {
    procs.push(mia(55));
    setTimeout(() => { procs.length = 0; fs.appendFileSync(path.join(dir, "mia-stderr.log"), "Error: Cannot find module 'ws'\n"); }, 20);
  };
  const result = await bg.start({ dir, list: async () => procs, task: noTask, launch, ...FAST });
  assert.equal(result.code, 1);
  assert.match(result.text, /Cannot find module 'ws'/);
  assert.doesNotMatch(result.text, /上次的旧报错/);
});

test("start：一直没见到进程，也没报错", async () => {
  const result = await bg.start({ dir: tmpDir(), list: async () => [], task: noTask, launch: () => {}, ...FAST });
  assert.equal(result.code, 1);
  assert.match(result.text, /没见到进程/);
});

test("start：日志里出现 11298 就说白名单", async () => {
  const dir = tmpDir();
  const procs = [];
  const fake = fakeLaunch(dir, procs, { line: '[01:02:03] 换 access_token 失败：{"code":11298,"message":"接口访问源IP不在白名单"}\n' });
  const result = await bg.start({ dir, list: async () => procs, task: noTask, launch: fake.launch, ...FAST });
  assert.equal(result.code, 1);
  assert.match(result.text, /白名单/);
});

test("start：进程在，但一直没连上", async () => {
  const dir = tmpDir();
  const procs = [];
  const fake = fakeLaunch(dir, procs, { line: "[01:02:03] 还在连\n" });
  const result = await bg.start({ dir, list: async () => procs, task: noTask, launch: fake.launch, ...FAST });
  assert.equal(result.code, 2);
  assert.equal(result.pid, 4321);
  assert.match(result.text, /还没连上 QQ/);
});

test("stop：没在跑；在跑就连子进程一起结束，并记进 mia.log", async () => {
  const dir = tmpDir();
  assert.deepEqual(await bg.stop({ dir, list: async () => [] }), { code: 0, text: "美亚本来就没在运行。" });

  const dead = new Set();
  const killed = [];
  const result = await bg.stop({ dir, list: async () => [mia(7), mia(8)],
    kill: async (pid) => { killed.push(pid); dead.add(pid); }, isAlive: (pid) => !dead.has(pid), waitMs: 200 });
  assert.equal(result.code, 0);
  assert.deepEqual(killed, [7, 8]);
  assert.match(fs.readFileSync(path.join(dir, "mia.log"), "utf8"), /^\[\d\d:\d\d:\d\d\] 停止美亚：结束了进程 7、8\n$/);

  const stuck = await bg.stop({ dir, list: async () => [mia(9)], kill: async () => { throw new Error("拒绝访问"); }, isAlive: () => true, waitMs: 50 });
  assert.equal(stuck.code, 1);
  assert.match(stuck.text, /进程 9 还在[\s\S]*拒绝访问/);
});

test("启动器：只生成一个启动、一个停止，UTF-16LE 带 BOM，顺手删掉旧的后台启动器", () => {
  const dir = tmpDir();
  for (const name of OBSOLETE) fs.writeFileSync(path.join(dir, name), "旧的");
  const written = writeLaunchers(dir);
  assert.deepEqual(written.sort(), ["停止美亚.vbs", "启动美亚.vbs"].sort());
  assert.deepEqual(fs.readdirSync(dir).sort(), written.sort());
  for (const [name, action] of [["启动美亚.vbs", "start"], ["停止美亚.vbs", "stop"]]) {
    const data = fs.readFileSync(path.join(dir, name));
    assert.deepEqual([...data.subarray(0, 2)], [0xff, 0xfe], name + " 要是 UTF-16LE 带 BOM");
    const text = data.toString("utf16le");
    assert.ok(text.includes('shell.Run("node mia-background.cjs ' + action + ' --result """ & result & """", 0, True)'), name);
    assert.doesNotMatch(text, /[^\r]\n/, name + " 换行要是 CRLF");
  }
});

test("mia-task.cmd：纯 ASCII、CRLF（cmd 和 PowerShell 5.1 都按本机代码页读），跑的是 mia-entry.cjs", () => {
  const data = fs.readFileSync(path.join(__dirname, "mia-task.cmd"));
  assert.equal(data.filter((byte) => byte > 127).length, 0);
  const text = data.toString("latin1");
  assert.doesNotMatch(text, /[^\r]\n/);
  assert.match(text, /node mia-entry\.cjs 2>> mia-stderr\.log/);
  assert.match(text, /ongeki-exe-\*/);
});
