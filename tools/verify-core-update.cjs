"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const assert = require("node:assert/strict"), {spawn, spawnSync} = require("node:child_process");
const root = path.resolve(__dirname, "..");
const name = process.argv[2] || "MiaBot-render-timeout-update-20261004";
assert.match(name, /^[A-Za-z0-9._-]+$/);
const pkg = path.join(root, "server-updates", name);
const hash = data => crypto.createHash("sha256").update(data).digest("hex");
const fileHash = file => hash(fs.readFileSync(file));
const manifest = JSON.parse(fs.readFileSync(path.join(pkg, "manifest.json"), "utf8"));
assert.equal(manifest.kind, "core-and-entry");
assert.equal(manifest.liveVerified, false);
assert.equal(manifest.verificationStatus, "pending-server-validation");
// 版本按源码核对：原来写死 v4.1.6，build-core-update.cjs 有了 --notes 以后打的包都过不了这一关。
// dataSources / constantSources 只有不带 --notes 的那份 v4.1.6 说明才写进清单。
const sourceVersion = fs.readFileSync(path.join(root, "app-template.js"), "utf8").match(/const VERSION\s*=\s*"([^"]+)"/)?.[1];
assert.equal(manifest.version, sourceVersion);
if ("dataSources" in manifest || "constantSources" in manifest) {
  assert.deepEqual(manifest.dataSources,["u.otogame.net","rinnet"]);
  assert.deepEqual(manifest.constantSources,{otogame:"server-rating-inference-only",rinnet:"server-music-catalog-only"});
}
assert.equal(manifest.files.length, 2);
assert.equal(manifest.files[0].path, "qq-official/ongeki-core.exe");
assert.equal(manifest.files[1].path, "qq-official/mia-entry.cjs");
const sourceCore = path.join(pkg, "payload", "qq-official", "ongeki-core.exe");
assert.equal(fs.statSync(sourceCore).size, manifest.files[0].bytes);
assert.equal(fileHash(sourceCore), manifest.files[0].sha256);
const selftest = spawnSync(sourceCore, ["--selftest"], {encoding:"utf8", windowsHide:true, timeout:120000});
assert.equal(selftest.status, 0, selftest.stdout + selftest.stderr);
assert.ok(selftest.stdout.split(/\r?\n/).some(line => line.trim() === "SELFTEST OK v" + manifest.version), selftest.stdout + selftest.stderr);
const sourceEntry = path.join(pkg,"payload/qq-official/mia-entry.cjs");
assert.equal(fs.statSync(sourceEntry).size,manifest.files[1].bytes);
assert.equal(fileHash(sourceEntry),manifest.files[1].sha256);
assert.equal(spawnSync(process.execPath,["--check",sourceEntry],{encoding:"utf8",windowsHide:true}).status,0);
const outputRoot = path.join(root, "output");
fs.mkdirSync(outputRoot, {recursive:true});
const temp = fs.mkdtempSync(path.join(outputRoot, "verify-core-update-"));
assert.ok(temp.startsWith(outputRoot + path.sep));
const passed = ["manifest and both payload SHA256 values", "packaged EXE selftest and bundled entry syntax"];
// 安装脚本里有中文提示，Windows PowerShell 5.1 只认带 BOM 的 UTF-8；少了 BOM 会整篇乱码。
const applyBytes = fs.readFileSync(path.join(pkg, "Apply-Update.ps1"));
assert.deepEqual([...applyBytes.subarray(0, 3)], [0xEF, 0xBB, 0xBF], "Apply-Update.ps1 must start with a UTF-8 BOM");
assert.deepEqual([...fs.readFileSync(path.join(pkg, "Restore-Backup.ps1")).subarray(0, 3)], [0xEF, 0xBB, 0xBF], "Restore-Backup.ps1 must start with a UTF-8 BOM");
const cmdText = fs.readFileSync(path.join(pkg, "Apply-Update.cmd"), "utf8");
assert.ok(cmdText.includes("Apply-Update.ps1"), "Apply-Update.cmd must call the installer");
assert.ok(/[\x00-\x7F]*$/.test(cmdText), "Apply-Update.cmd must stay ASCII (it is parsed before chcp takes effect)");
passed.push("installer scripts carry a UTF-8 BOM; cmd wrapper stays ASCII");
function put(file, data) { fs.mkdirSync(path.dirname(file), {recursive:true}); fs.writeFileSync(file, data); }
// 不用 fs.cpSync：Node 22.17 递归拷目录时会 0xC0000409 直接把进程崩掉（这台机器上必现）
function copyTree(from, to) {
  if (fs.statSync(from).isDirectory()) {
    fs.mkdirSync(to, {recursive:true});
    for (const entry of fs.readdirSync(from)) copyTree(path.join(from, entry), path.join(to, entry));
  } else {
    fs.mkdirSync(path.dirname(to), {recursive:true});
    fs.copyFileSync(from, to);
  }
}
function runRaw(script, args, expectOK, serviceOff) {
  const fullArgs = [...args];
  // 文件层面的夹具不该碰真美亚：默认给 Apply-Update 加 -NoService，只有服务那段用得到真开关。
  if (serviceOff && path.basename(script).toLowerCase() === "apply-update.ps1") fullArgs.push("-NoService");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, ...fullArgs], {
    encoding:"utf8", windowsHide:true, timeout:180000,
    // 「上次装过的位置」挪到临时目录，别让夹具读写真机上的 %LOCALAPPDATA%
    env:{...process.env, MIA_UPDATE_TARGET_FILE: path.join(temp, "last-target.txt")},
  });
  if (expectOK) assert.equal(result.status, 0, result.stdout + result.stderr);
  else assert.notEqual(result.status, 0, "Invalid update unexpectedly succeeded");
  return result.stdout + result.stderr;
}
function run(script, args, expectOK=true) { return runRaw(script, args, expectOK, true); }
function fixture(id, corePath="./ongeki-core.exe") {
  const deployment = path.join(temp, id);
  const core = path.resolve(deployment, "qq-official", corePath);
  assert.ok(core.startsWith(temp + path.sep));
  const old = Buffer.from("OLD CORE FIXTURE " + id);
  put(core, old);
  const preserved = {
    "qq-official/config.local.json": JSON.stringify({corePath, appId:"FIXTURE", commandPrefix:"/"}),
    "qq-official/data/bindings.dat": "FIXTURE BINDINGS",
    "qq-official/data/song-aliases.json": "{\"fixture\":true}",
    "qq-official/data/cache/jackets/existing.webp": "FIXTURE CACHE",
    "qq-official/mia-vault.exe": "FIXTURE VAULT"
  };
  for (const [file, content] of Object.entries(preserved)) put(path.join(deployment,file),content);
  const entry = path.join(deployment,"qq-official/mia-entry.cjs"), oldEntry = Buffer.from("OLD ENTRY FIXTURE " + id);
  put(entry,oldEntry);
  return {deployment,core,old,entry,oldEntry,preserved};
}
function preserved(f) {
  for (const [file, content] of Object.entries(f.preserved)) assert.equal(fs.readFileSync(path.join(f.deployment,file),"utf8"),content,file);
}
const apply = path.join(pkg,"Apply-Update.ps1"), restore = path.join(pkg,"Restore-Backup.ps1");
try {
  const f = fixture("standard");
  run(apply,["-TargetRoot",f.deployment,"-CheckOnly"]);
  assert.deepEqual(fs.readFileSync(f.core), f.old);
  assert.deepEqual(fs.readFileSync(f.entry),f.oldEntry);
  assert.equal(fs.existsSync(path.join(f.deployment,"update-backups")),false);
  preserved(f); passed.push("CheckOnly preserves deployment without backups");
  run(apply,["-TargetRoot",f.deployment]);
  assert.equal(fileHash(f.core),manifest.files[0].sha256); preserved(f);
  assert.equal(fileHash(f.entry),manifest.files[1].sha256);
  const backups = path.join(f.deployment,"update-backups");
  const backup = path.join(backups,fs.readdirSync(backups)[0]);
  assert.deepEqual(fs.readFileSync(path.join(backup,"original-core.exe")),f.old);
  assert.deepEqual(fs.readFileSync(path.join(backup,"original-entry.cjs")),f.oldEntry);
  assert.equal(JSON.parse(fs.readFileSync(path.join(backup,"backup.json"),"utf8").replace(/^\uFEFF/,"")).status,"installed");
  passed.push("actual core and entry installation/backup; configs/bindings/aliases/cache/vault preserved");
  run(restore,["-TargetRoot",f.deployment,"-BackupPath",temp],false);
  assert.equal(fileHash(f.core),manifest.files[0].sha256);
  const original = path.join(backup,"original-core.exe");
  fs.appendFileSync(original,"tampered");
  run(restore,["-TargetRoot",f.deployment,"-BackupPath",backup],false);
  assert.equal(fileHash(f.core),manifest.files[0].sha256);
  fs.writeFileSync(original,f.old);
  const originalEntry = path.join(backup,"original-entry.cjs");
  fs.appendFileSync(originalEntry,"tampered");
  run(restore,["-TargetRoot",f.deployment,"-BackupPath",backup],false);
  assert.equal(fileHash(f.core),manifest.files[0].sha256);
  fs.writeFileSync(originalEntry,f.oldEntry);
  fs.appendFileSync(f.entry,"newer");
  run(restore,["-TargetRoot",f.deployment,"-BackupPath",backup],false);
  assert.equal(fileHash(f.core),manifest.files[0].sha256);
  fs.copyFileSync(sourceEntry,f.entry);
  // An old backup must not overwrite a subsequently changed core.
  fs.appendFileSync(f.core,"newer");
  run(restore,["-TargetRoot",f.deployment,"-BackupPath",backup],false);
  fs.copyFileSync(sourceCore,f.core);
  run(restore,["-TargetRoot",f.deployment,"-BackupPath",backup]);
  assert.deepEqual(fs.readFileSync(f.core),f.old); preserved(f);
  assert.deepEqual(fs.readFileSync(f.entry),f.oldEntry);
  passed.push("rollback restores original; outside backups, corrupt backups and newer cores rejected");
  const tiny = path.join(temp,"tiny-package");
  const tinyCore = Buffer.from("NEW CORE FIXTURE");
  const tinyEntry = Buffer.from("module.exports = {fixture: 'NEW ENTRY'};\n");
  for (const script of ["Apply-Update.ps1","Restore-Backup.ps1"]) put(path.join(tiny,script),fs.readFileSync(path.join(pkg,script)));
  put(path.join(tiny,"payload/qq-official/ongeki-core.exe"),tinyCore);
  put(path.join(tiny,"payload/qq-official/mia-entry.cjs"),tinyEntry);
  const tinyManifest = {...manifest, files:[{path:"qq-official/ongeki-core.exe",bytes:tinyCore.length,sha256:hash(tinyCore)},
    {path:"qq-official/mia-entry.cjs",bytes:tinyEntry.length,sha256:hash(tinyEntry)}]};
  const writeManifest = () => put(path.join(tiny,"manifest.json"),JSON.stringify(tinyManifest));
  writeManifest();
  for (const [id,corePath] of [["nested","../bin/出图-core.exe"],["absolute",path.join(temp,"absolute","custom-core.exe")]]) {
    const custom = fixture(id,corePath);
    run(path.join(tiny,"Apply-Update.ps1"),["-TargetRoot",custom.deployment]);
    assert.deepEqual(fs.readFileSync(custom.core),tinyCore); preserved(custom);
    assert.deepEqual(fs.readFileSync(custom.entry),tinyEntry);
    const customBackupRoot = path.join(custom.deployment,"update-backups");
    run(path.join(tiny,"Restore-Backup.ps1"),["-TargetRoot",custom.deployment,"-BackupPath",path.join(customBackupRoot,fs.readdirSync(customBackupRoot)[0])]);
    assert.deepEqual(fs.readFileSync(custom.core),custom.old); preserved(custom);
    assert.deepEqual(fs.readFileSync(custom.entry),custom.oldEntry);
  }
  passed.push("custom relative/absolute corePath within deployment installs and restores");
  const reject = fixture("reject");
  fs.appendFileSync(path.join(tiny,"payload/qq-official/ongeki-core.exe"),"tampered");
  run(path.join(tiny,"Apply-Update.ps1"),["-TargetRoot",reject.deployment],false);
  assert.deepEqual(fs.readFileSync(reject.core),reject.old);
  assert.equal(fs.existsSync(path.join(reject.deployment,"update-backups")),false); preserved(reject);
  put(path.join(tiny,"payload/qq-official/ongeki-core.exe"),tinyCore);
  fs.appendFileSync(path.join(tiny,"payload/qq-official/mia-entry.cjs"),"tampered");
  run(path.join(tiny,"Apply-Update.ps1"),["-TargetRoot",reject.deployment],false);
  assert.deepEqual(fs.readFileSync(reject.core),reject.old);
  assert.deepEqual(fs.readFileSync(reject.entry),reject.oldEntry);
  assert.equal(fs.existsSync(path.join(reject.deployment,"update-backups")),false);
  put(path.join(tiny,"payload/qq-official/mia-entry.cjs"),tinyEntry);
  tinyManifest.files.push({path:"../unexpected.exe",bytes:1,sha256:hash("x")}); writeManifest();
  run(path.join(tiny,"Apply-Update.ps1"),["-TargetRoot",reject.deployment],false);
  tinyManifest.files.pop(); writeManifest();
  const configFile = path.join(reject.deployment,"qq-official/config.local.json");
  put(configFile,JSON.stringify({corePath:"../../outside.exe"}));
  run(path.join(tiny,"Apply-Update.ps1"),["-TargetRoot",reject.deployment],false);
  assert.deepEqual(fs.readFileSync(reject.core),reject.old);
  assert.equal(fs.existsSync(path.join(reject.deployment,"update-backups")),false);
  passed.push("tampered payload, unexpected manifest files and outside corePath rejected before mutation");
  const fault = fixture("transaction-fault");
  const tinyApply = path.join(tiny,"Apply-Update.ps1"), tinyRestore = path.join(tiny,"Restore-Backup.ps1");
  const applySource = fs.readFileSync(tinyApply,"utf8");
  const replaceCall = "[IO.File]::Replace($target.stage, $target.path, [NullString]::Value)";
  assert.ok(applySource.includes(replaceCall));
  put(tinyApply,applySource.replace(replaceCall,"if ($target.relative -eq 'qq-official/mia-entry.cjs') { throw 'Injected entry failure' }; " + replaceCall));
  run(tinyApply,["-TargetRoot",fault.deployment],false);
  assert.deepEqual(fs.readFileSync(fault.core),fault.old);
  assert.deepEqual(fs.readFileSync(fault.entry),fault.oldEntry); preserved(fault);
  put(tinyApply,applySource);
  run(tinyApply,["-TargetRoot",fault.deployment]);
  const faultBackupRoot = path.join(fault.deployment,"update-backups");
  const faultBackup = fs.readdirSync(faultBackupRoot).map(file=>path.join(faultBackupRoot,file)).find(file=>JSON.parse(fs.readFileSync(path.join(file,"backup.json"),"utf8").replace(/^\uFEFF/,"")).status==="installed");
  const restoreSource = fs.readFileSync(tinyRestore,"utf8");
  const restoreCall = "[IO.File]::Replace($target.stage, $target.path, $target.previous)";
  assert.ok(restoreSource.includes(restoreCall));
  put(tinyRestore,restoreSource.replace(restoreCall,"if ($target.path.EndsWith('mia-entry.cjs')) { throw 'Injected restore failure' }; " + restoreCall));
  run(tinyRestore,["-TargetRoot",fault.deployment,"-BackupPath",faultBackup],false);
  assert.deepEqual(fs.readFileSync(fault.core),tinyCore);
  assert.deepEqual(fs.readFileSync(fault.entry),tinyEntry); preserved(fault);
  put(tinyRestore,restoreSource);
  run(tinyRestore,["-TargetRoot",fault.deployment,"-BackupPath",faultBackup]);
  assert.deepEqual(fs.readFileSync(fault.core),fault.old);
  assert.deepEqual(fs.readFileSync(fault.entry),fault.oldEntry);
  passed.push("injected second-file failure rolls back both install and restore transactions");
  const legacy = fixture("legacy-core-only");
  tinyManifest.kind = "core-only"; tinyManifest.files.pop(); writeManifest();
  run(tinyApply,["-TargetRoot",legacy.deployment]);
  assert.deepEqual(fs.readFileSync(legacy.entry),legacy.oldEntry);
  const legacyBackups = path.join(legacy.deployment,"update-backups");
  const legacyBackup = path.join(legacyBackups,fs.readdirSync(legacyBackups)[0]);
  const legacyMetadataFile = path.join(legacyBackup,"backup.json");
  const legacyMetadata = JSON.parse(fs.readFileSync(legacyMetadataFile,"utf8").replace(/^\uFEFF/,""));
  put(legacyMetadataFile,JSON.stringify({kind:"core-only",...legacyMetadata.files[0]}));
  run(tinyRestore,["-TargetRoot",legacy.deployment,"-BackupPath",legacyBackup]);
  assert.deepEqual(fs.readFileSync(legacy.core),legacy.old); preserved(legacy);
  assert.deepEqual(fs.readFileSync(legacy.entry),legacy.oldEntry);
  passed.push("legacy single-core update and backup format remain supported");

  // ---- 自动找部署目录（双击时不用再指定路径） ----------------------------
  const detectRoot = path.join(temp, "detect");
  const detectA = fixture(path.join("detect", "a"));
  const detectB = fixture(path.join("detect", "b"));
  const detectArgs = ["-SearchRoot", detectRoot];
  run(apply, detectArgs, false);   // 两个都像、又都没跑过：不猜，直接拒绝
  assert.deepEqual(fs.readFileSync(detectA.core), detectA.old);
  assert.deepEqual(fs.readFileSync(detectB.core), detectB.old);
  assert.equal(fs.existsSync(path.join(detectA.deployment, "update-backups")), false);
  put(path.join(detectA.deployment, "qq-official/mia.log"), "[00:00:00] someone ran here\n");
  run(apply, detectArgs);          // 谁最近跑过就装谁
  assert.equal(fileHash(detectA.core), manifest.files[0].sha256);
  assert.deepEqual(fs.readFileSync(detectB.core), detectB.old);
  preserved(detectA); preserved(detectB);
  run(apply, ["-TargetRoot", path.join(detectRoot, "not-a-deployment")], false);
  passed.push("auto-detection: ambiguous roots rejected, newest mia.log wins, wrong explicit root rejected");

  // ---- 双击那种用法：找目录 → 停美亚 → 换文件 → 重新启动 → 等就绪 -------
  const READY_LINE = "已就绪，等待消息";
  const MOCK_BOT = [
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'const core = fs.readFileSync(path.join(__dirname, "ongeki-core.exe"), "utf8").trim();',
    'fs.appendFileSync(path.join(__dirname, "mia.log"), "[" + new Date().toISOString().slice(11, 19) + "] ' +
      READY_LINE + ' CORE=" + core + "\\n");',
    "setInterval(() => {}, 1000);",
    "",
  ].join("\n");
  const SVC_OLD_CORE = Buffer.from("OLD CORE FIXTURE");
  const SVC_NEW_CORE = Buffer.from("NEW CORE FIXTURE");
  const svcEntry = Buffer.from(MOCK_BOT);
  const svcBase = path.join(temp, "service");
  const svcQq = path.join(svcBase, "deploy", "qq-official");
  const svcPkg = path.join(svcBase, "pkg");
  const svcCore = path.join(svcQq, "ongeki-core.exe");
  const svcLog = path.join(svcQq, "mia.log");
  function listBots() {
    const query = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; " +
      "@(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'mia-entry' }) | " +
      "ForEach-Object { $_.ProcessId }"], {encoding:"utf8", windowsHide:true, timeout:60000});
    return String(query.stdout || "").trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  }
  function killBots() {
    for (const pid of listBots()) spawnSync("taskkill", ["/PID", pid, "/T", "/F"], {windowsHide:true, stdio:"ignore"});
  }
  const runningBots = listBots();
  if (runningBots.length) {
    console.log("skipped the running-bot round trip: this machine already runs MiaBot (pid " + runningBots.join(", ") + ")");
  } else {
    put(path.join(svcQq, "config.local.json"), JSON.stringify({corePath:"./ongeki-core.exe",appId:"FIXTURE"}));
    put(svcCore, SVC_OLD_CORE);
    put(path.join(svcQq, "mia-entry.cjs"), svcEntry);
    put(path.join(svcQq, "mia-task.cmd"), '@echo off\r\ncd /d "%~dp0"\r\n"' + process.execPath + '" mia-entry.cjs 2>> mia-stderr.log\r\n');
    for (const script of ["Apply-Update.ps1","Restore-Backup.ps1"]) put(path.join(svcPkg, script), fs.readFileSync(path.join(pkg, script)));
    put(path.join(svcPkg, "payload/qq-official/ongeki-core.exe"), SVC_NEW_CORE);
    put(path.join(svcPkg, "payload/qq-official/mia-entry.cjs"), svcEntry);
    put(path.join(svcPkg, "manifest.json"), JSON.stringify({name:"service-fixture",version:"0.0.0",kind:"core-and-entry",platform:"win32-x64",liveVerified:false,verificationStatus:"pending-server-validation",files:[
      {path:"qq-official/ongeki-core.exe",bytes:SVC_NEW_CORE.length,sha256:hash(SVC_NEW_CORE)},
      {path:"qq-official/mia-entry.cjs",bytes:svcEntry.length,sha256:hash(svcEntry)}]}, null, 2));
    const waitFrame = () => spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 250)"], {windowsHide:true});
    let bot = null;
    try {
      bot = spawn(process.execPath, ["mia-entry.cjs"], {cwd: svcQq, stdio:"ignore", windowsHide:true, detached:true});
      bot.unref();
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        if (fs.existsSync(svcLog) && fs.readFileSync(svcLog, "utf8").includes(READY_LINE)) break;
        waitFrame();
      }
      assert.ok(fs.existsSync(svcLog) && fs.readFileSync(svcLog, "utf8").includes(READY_LINE), "the mock bot never came up");
      assert.equal(listBots().length, 1, "exactly one mock bot before the update");
      const output = runRaw(path.join(svcPkg, "Apply-Update.ps1"), ["-SearchRoot", svcBase], true, false);
      assert.ok(output.includes("UPDATE COMPLETE"), output);
      assert.equal(fs.readFileSync(svcCore, "utf8"), SVC_NEW_CORE.toString(), "core must be replaced");
      const log = fs.readFileSync(svcLog, "utf8");
      assert.ok(log.includes(READY_LINE + " CORE=NEW CORE FIXTURE"), "the restarted bot must run the new core\n" + output + "\n--- mia.log ---\n" + log);
      assert.equal(listBots().length, 1, "exactly one bot must be left running, not zero or two");

      // 包坏了：校验在停美亚之前，正在跑的美亚不该被碰
      const installedCore = fs.readFileSync(svcCore);
      const pidsBefore = listBots();
      fs.appendFileSync(path.join(svcPkg, "payload/qq-official/ongeki-core.exe"), "tampered");
      runRaw(path.join(svcPkg, "Apply-Update.ps1"), ["-SearchRoot", svcBase], false, false);
      assert.deepEqual(listBots(), pidsBefore, "a bad package must leave the running bot alone");
      assert.deepEqual(fs.readFileSync(svcCore), installedCore, "a bad package must not touch the files");
      put(path.join(svcPkg, "payload/qq-official/ongeki-core.exe"), SVC_NEW_CORE);

      // 换到一半失败：两个文件都回滚，美亚要重新起来（不是停在半路）
      const faultPkg = path.join(temp, "service-fault");
      copyTree(svcPkg, faultPkg);
      const faultApply = path.join(faultPkg, "Apply-Update.ps1");
      const replaceCall = "[IO.File]::Replace($target.stage, $target.path, [NullString]::Value)";
      const faultSource = fs.readFileSync(faultApply, "utf8");
      assert.ok(faultSource.includes(replaceCall), "the installer must keep the replace call");
      fs.writeFileSync(faultApply, faultSource.replace(replaceCall,
        "if ($target.relative -eq 'qq-official/mia-entry.cjs') { throw 'Injected entry failure' }; " + replaceCall));
      const logBefore = fs.readFileSync(svcLog, "utf8");
      const faultOut = runRaw(faultApply, ["-SearchRoot", svcBase], false, false);
      assert.ok(faultOut.includes("已经恢复成原来的文件"), faultOut);
      assert.equal(fs.readFileSync(svcCore, "utf8"), SVC_NEW_CORE.toString(), "rollback must restore the pre-install core");
      const logAfter = fs.readFileSync(svcLog, "utf8");
      assert.ok(logAfter.length > logBefore.length && logAfter.slice(logBefore.length).includes(READY_LINE),
        "the bot must be restarted after a failed install\n" + faultOut);
      assert.equal(listBots().length, 1, "exactly one bot after the failed install");
      passed.push("double-click path: stopped the running bot, installed, restarted it and saw the ready line (no path given)");
      passed.push("bad package leaves the running bot alone; a mid-install failure rolls back and restarts the bot");
    } finally {
      killBots();
    }
  }

  const report = {passed:true,version:manifest.version,liveVerified:false,serverValidation:"pending",checks:passed};
  fs.writeFileSync(path.join(outputRoot,"core-update-verification.json"),JSON.stringify(report,null,2)+"\n");
  console.log(JSON.stringify(report,null,2));
} finally {
  // This is a directory created exclusively by this verifier, under workspace/output.
  const resolved = fs.realpathSync(temp);
  assert.ok(resolved.startsWith(fs.realpathSync(outputRoot) + path.sep));
  fs.rmSync(resolved,{recursive:true,force:true});
}
