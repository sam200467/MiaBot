"use strict";
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const assert = require("node:assert/strict"), {spawnSync} = require("node:child_process");
const root = path.resolve(__dirname, "..");
const name = process.argv[2] || "MiaBot-otogame-inferred-update-20261003";
assert.match(name, /^[A-Za-z0-9._-]+$/);
const pkg = path.join(root, "server-updates", name);
const hash = data => crypto.createHash("sha256").update(data).digest("hex");
const fileHash = file => hash(fs.readFileSync(file));
const manifest = JSON.parse(fs.readFileSync(path.join(pkg, "manifest.json"), "utf8"));
assert.equal(manifest.kind, "core-only");
assert.equal(manifest.liveVerified, false);
assert.equal(manifest.verificationStatus, "pending-server-validation");
assert.equal(manifest.version, "4.1.4-otogame-inferred");
assert.equal(manifest.constantSource, "server-rating-inference-only");
assert.equal(manifest.files.length, 1);
assert.equal(manifest.files[0].path, "qq-official/ongeki-core.exe");
const sourceCore = path.join(pkg, "payload", "qq-official", "ongeki-core.exe");
assert.equal(fs.statSync(sourceCore).size, manifest.files[0].bytes);
assert.equal(fileHash(sourceCore), manifest.files[0].sha256);
const selftest = spawnSync(sourceCore, ["--selftest"], {encoding:"utf8", windowsHide:true, timeout:120000});
assert.equal(selftest.status, 0, selftest.stdout + selftest.stderr);
assert.match(selftest.stdout, /SELFTEST OK v4\.1\.4-otogame-inferred/);
const outputRoot = path.join(root, "output");
fs.mkdirSync(outputRoot, {recursive:true});
const temp = fs.mkdtempSync(path.join(outputRoot, "verify-core-update-"));
assert.ok(temp.startsWith(outputRoot + path.sep));
const passed = ["manifest and packaged EXE SHA256", "packaged EXE selftest"];
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
    "qq-official/mia-entry.cjs": "FIXTURE LAUNCHER",
    "qq-official/mia-vault.exe": "FIXTURE VAULT"
  };
  for (const [file, content] of Object.entries(preserved)) put(path.join(deployment,file),content);
  return {deployment,core,old,preserved};
}
function preserved(f) {
  for (const [file, content] of Object.entries(f.preserved)) assert.equal(fs.readFileSync(path.join(f.deployment,file),"utf8"),content,file);
}
const apply = path.join(pkg,"Apply-Update.ps1"), restore = path.join(pkg,"Restore-Backup.ps1");
try {
  const f = fixture("standard");
  run(apply,["-TargetRoot",f.deployment,"-CheckOnly"]);
  assert.deepEqual(fs.readFileSync(f.core), f.old);
  assert.equal(fs.existsSync(path.join(f.deployment,"update-backups")),false);
  preserved(f); passed.push("CheckOnly preserves deployment without backups");
  run(apply,["-TargetRoot",f.deployment]);
  assert.equal(fileHash(f.core),manifest.files[0].sha256); preserved(f);
  const backups = path.join(f.deployment,"update-backups");
  const backup = path.join(backups,fs.readdirSync(backups)[0]);
  assert.deepEqual(fs.readFileSync(path.join(backup,"original-core.exe")),f.old);
  assert.equal(JSON.parse(fs.readFileSync(path.join(backup,"backup.json"),"utf8").replace(/^\uFEFF/,"")).status,"installed");
  passed.push("actual packaged EXE installation and backup; configs/bindings/aliases/cache/launcher/vault preserved");
  run(restore,["-TargetRoot",f.deployment,"-BackupPath",temp],false);
  assert.equal(fileHash(f.core),manifest.files[0].sha256);
  const original = path.join(backup,"original-core.exe");
  fs.appendFileSync(original,"tampered");
  run(restore,["-TargetRoot",f.deployment,"-BackupPath",backup],false);
  assert.equal(fileHash(f.core),manifest.files[0].sha256);
  fs.writeFileSync(original,f.old);
  // An old backup must not overwrite a subsequently changed core.
  fs.appendFileSync(f.core,"newer");
  run(restore,["-TargetRoot",f.deployment,"-BackupPath",backup],false);
  fs.copyFileSync(sourceCore,f.core);
  run(restore,["-TargetRoot",f.deployment,"-BackupPath",backup]);
  assert.deepEqual(fs.readFileSync(f.core),f.old); preserved(f);
  passed.push("rollback restores original; outside backups, corrupt backups and newer cores rejected");
  const tiny = path.join(temp,"tiny-package");
  const tinyCore = Buffer.from("NEW CORE FIXTURE");
  for (const script of ["Apply-Update.ps1","Restore-Backup.ps1"]) put(path.join(tiny,script),fs.readFileSync(path.join(pkg,script)));
  put(path.join(tiny,"payload/qq-official/ongeki-core.exe"),tinyCore);
  const tinyManifest = {...manifest, files:[{path:"qq-official/ongeki-core.exe",bytes:tinyCore.length,sha256:hash(tinyCore)}]};
  const writeManifest = () => put(path.join(tiny,"manifest.json"),JSON.stringify(tinyManifest));
  writeManifest();
  for (const [id,corePath] of [["nested","../bin/出图-core.exe"],["absolute",path.join(temp,"absolute","custom-core.exe")]]) {
    const custom = fixture(id,corePath);
    run(path.join(tiny,"Apply-Update.ps1"),["-TargetRoot",custom.deployment]);
    assert.deepEqual(fs.readFileSync(custom.core),tinyCore); preserved(custom);
    const customBackupRoot = path.join(custom.deployment,"update-backups");
    run(path.join(tiny,"Restore-Backup.ps1"),["-TargetRoot",custom.deployment,"-BackupPath",path.join(customBackupRoot,fs.readdirSync(customBackupRoot)[0])]);
    assert.deepEqual(fs.readFileSync(custom.core),custom.old); preserved(custom);
  }
  passed.push("custom relative/absolute corePath within deployment installs and restores");
  const reject = fixture("reject");
  fs.appendFileSync(path.join(tiny,"payload/qq-official/ongeki-core.exe"),"tampered");
  run(path.join(tiny,"Apply-Update.ps1"),["-TargetRoot",reject.deployment],false);
  assert.deepEqual(fs.readFileSync(reject.core),reject.old);
  assert.equal(fs.existsSync(path.join(reject.deployment,"update-backups")),false); preserved(reject);
  put(path.join(tiny,"payload/qq-official/ongeki-core.exe"),tinyCore);
  tinyManifest.files.push({path:"../unexpected.exe",bytes:1,sha256:hash("x")}); writeManifest();
  run(path.join(tiny,"Apply-Update.ps1"),["-TargetRoot",reject.deployment],false);
  tinyManifest.files.pop(); writeManifest();
  const configFile = path.join(reject.deployment,"qq-official/config.local.json");
  put(configFile,JSON.stringify({corePath:"../../outside.exe"}));
  run(path.join(tiny,"Apply-Update.ps1"),["-TargetRoot",reject.deployment],false);
  assert.deepEqual(fs.readFileSync(reject.core),reject.old);
  assert.equal(fs.existsSync(path.join(reject.deployment,"update-backups")),false);
  passed.push("tampered payload, unexpected manifest files and outside corePath rejected before mutation");
  const report = {passed:true,version:manifest.version,liveVerified:false,serverValidation:"pending",checks:passed};
  fs.writeFileSync(path.join(outputRoot,"core-update-verification.json"),JSON.stringify(report,null,2)+"\n");
  console.log(JSON.stringify(report,null,2));
} finally {
  // This is a directory created exclusively by this verifier, under workspace/output.
  const resolved = fs.realpathSync(temp);
  assert.ok(resolved.startsWith(fs.realpathSync(outputRoot) + path.sep));
  fs.rmSync(resolved,{recursive:true,force:true});
}
