"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const assert = require("node:assert/strict"), {spawnSync} = require("node:child_process");
const root = path.resolve(__dirname, "..");
const name = process.argv[2] || "MiaBot-server-constants-update-20261004";
assert.match(name, /^[A-Za-z0-9._-]+$/);
const pkg = path.join(root, "server-updates", name);
const hash = data => crypto.createHash("sha256").update(data).digest("hex");
const fileHash = file => hash(fs.readFileSync(file));
const manifest = JSON.parse(fs.readFileSync(path.join(pkg, "manifest.json"), "utf8"));
assert.equal(manifest.kind, "core-and-entry");
assert.equal(manifest.liveVerified, false);
assert.equal(manifest.verificationStatus, "pending-server-validation");
assert.equal(manifest.version, "4.1.5-server-constants");
assert.deepEqual(manifest.dataSources,["u.otogame.net","rinnet"]);
assert.deepEqual(manifest.constantSources,{otogame:"server-rating-inference-only",rinnet:"server-music-catalog-only"});
assert.equal(manifest.files.length, 2);
assert.equal(manifest.files[0].path, "qq-official/ongeki-core.exe");
assert.equal(manifest.files[1].path, "qq-official/mia-entry.cjs");
const sourceCore = path.join(pkg, "payload", "qq-official", "ongeki-core.exe");
assert.equal(fs.statSync(sourceCore).size, manifest.files[0].bytes);
assert.equal(fileHash(sourceCore), manifest.files[0].sha256);
const selftest = spawnSync(sourceCore, ["--selftest"], {encoding:"utf8", windowsHide:true, timeout:120000});
assert.equal(selftest.status, 0, selftest.stdout + selftest.stderr);
assert.match(selftest.stdout, /SELFTEST OK v4\.1\.5-server-constants/);
const sourceEntry = path.join(pkg,"payload/qq-official/mia-entry.cjs");
assert.equal(fs.statSync(sourceEntry).size,manifest.files[1].bytes);
assert.equal(fileHash(sourceEntry),manifest.files[1].sha256);
assert.equal(spawnSync(process.execPath,["--check",sourceEntry],{encoding:"utf8",windowsHide:true}).status,0);
const outputRoot = path.join(root, "output");
fs.mkdirSync(outputRoot, {recursive:true});
const temp = fs.mkdtempSync(path.join(outputRoot, "verify-core-update-"));
assert.ok(temp.startsWith(outputRoot + path.sep));
const passed = ["manifest and both payload SHA256 values", "packaged EXE selftest and bundled entry syntax"];
function put(file, data) { fs.mkdirSync(path.dirname(file), {recursive:true}); fs.writeFileSync(file, data); }
function run(script, args, expectOK=true) {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, ...args], {encoding:"utf8", windowsHide:true, timeout:120000});
  if (expectOK) assert.equal(result.status, 0, result.stdout + result.stderr);
  else assert.notEqual(result.status, 0, "Invalid update unexpectedly succeeded");
  return result.stdout + result.stderr;
}
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
  const report = {passed:true,version:manifest.version,liveVerified:false,serverValidation:"pending",checks:passed};
  fs.writeFileSync(path.join(outputRoot,"core-update-verification.json"),JSON.stringify(report,null,2)+"\n");
  console.log(JSON.stringify(report,null,2));
} finally {
  // This is a directory created exclusively by this verifier, under workspace/output.
  const resolved = fs.realpathSync(temp);
  assert.ok(resolved.startsWith(fs.realpathSync(outputRoot) + path.sep));
  fs.rmSync(resolved,{recursive:true,force:true});
}
