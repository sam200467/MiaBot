param(
    [string]$TargetRoot = 'C:\MiaBot\deploy-windows-server',
    [switch]$CheckOnly
)
$ErrorActionPreference = 'Stop'
function Get-CoreHash([string]$File) {
    $stream = [IO.File]::OpenRead($File)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '') }
    finally { $sha.Dispose(); $stream.Dispose() }
}
$root = [IO.Path]::GetFullPath($TargetRoot).TrimEnd('\', '/')
if (-not (Test-Path -LiteralPath $root -PathType Container)) { throw 'Deployment directory does not exist.' }
$prefix = $root + [IO.Path]::DirectorySeparatorChar
$configFile = Join-Path $root 'qq-official\config.local.json'
if (-not (Test-Path -LiteralPath $configFile -PathType Leaf)) { throw 'Missing qq-official/config.local.json.' }
$config = Get-Content -LiteralPath $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace([string]$config.corePath)) { throw 'corePath is not configured.' }
$core = [IO.Path]::GetFullPath([IO.Path]::Combine((Join-Path $root 'qq-official'), [string]$config.corePath))
if (-not $core.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'corePath must stay inside TargetRoot.' }
if ([IO.Path]::GetExtension($core) -ne '.exe' -or -not (Test-Path -LiteralPath $core -PathType Leaf)) { throw 'Existing Windows EXE core not found.' }
# Do not follow a junction or symlink outside the checked deployment directory.
$ancestor = Get-Item -LiteralPath $core -Force
while ($null -ne $ancestor -and $ancestor.FullName.Length -ge $root.Length) {
    if ($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse points are not supported in the core path.' }
    if ($ancestor.PSIsContainer) { $ancestor = $ancestor.Parent } else { $ancestor = $ancestor.Directory }
    if ($null -ne $ancestor -and $ancestor.FullName -eq $root) {
        if ($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'TargetRoot must not be a reparse point.' }
        break
    }
}
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$files = @($manifest.files)
if ($manifest.kind -ne 'core-only' -or $files.Count -ne 1 -or $files[0].path -ne 'qq-official/ongeki-core.exe') { throw 'Unexpected update manifest.' }
$item = $files[0]
if ([string]$item.sha256 -notmatch '^[a-fA-F0-9]{64}$' -or [long]$item.bytes -le 0) { throw 'Invalid payload checksum or size.' }
$source = Join-Path $PSScriptRoot 'payload\qq-official\ongeki-core.exe'
if ((Get-Item -LiteralPath $source).Length -ne [long]$item.bytes -or (Get-CoreHash $source) -ne $item.sha256) { throw 'Payload checksum mismatch; no deployment files changed.' }
# A running image core is locked on Windows. Check this before creating a backup.
$handle = [IO.File]::Open($core, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
$handle.Dispose()
Write-Host ('Core target: ' + $core)
Write-Host ('Payload SHA256: ' + $item.sha256)
if ($CheckOnly) { Write-Host 'CHECK OK; deployment files were not changed.'; exit 0 }
$backupRoot = Join-Path $root 'update-backups'
if (Test-Path -LiteralPath $backupRoot) {
    $backupRootItem = Get-Item -LiteralPath $backupRoot -Force
    if (-not $backupRootItem.PSIsContainer -or ($backupRootItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Backup directory must be a regular directory inside TargetRoot.' }
}
$stamp = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0,8)
$backup = Join-Path $root ('update-backups\otogame-core-' + $stamp)
[IO.Directory]::CreateDirectory($backup) | Out-Null
$original = Join-Path $backup 'original-core.exe'
[IO.File]::Copy($core, $original, $false)
$oldHash = Get-CoreHash $original
$coreRelative = $core.Substring($prefix.Length)
$metadata = @{ kind = 'core-only'; targetRoot = $root; coreRelative = $coreRelative; originalSha256 = $oldHash; installedSha256 = [string]$item.sha256; status = 'prepared' }
$metadataFile = Join-Path $backup 'backup.json'
$metadata | ConvertTo-Json | Set-Content -LiteralPath $metadataFile -Encoding UTF8
$stage = $core + '.update-' + [Guid]::NewGuid().ToString('N') + '.tmp'
$changed = $false
try {
    [IO.File]::Copy($source, $stage, $false)
    if ((Get-CoreHash $stage) -ne $item.sha256) { throw 'Staged core checksum mismatch.' }
    [IO.File]::Replace($stage, $core, [NullString]::Value)
    $changed = $true
    if ((Get-CoreHash $core) -ne $item.sha256) { throw 'Installed core checksum mismatch.' }
    $metadata.status = 'installed'
    $metadata | ConvertTo-Json | Set-Content -LiteralPath $metadataFile -Encoding UTF8
    Write-Host 'UPDATE COMPLETE'
    Write-Host ('Backup: ' + $backup)
    Write-Host 'Start MiaBot using its existing launcher. Configs, bindings, aliases and caches were preserved.'
} catch {
    $reason = $_
    if ($changed) {
        [IO.File]::Copy($original, $stage, $false)
        [IO.File]::Replace($stage, $core, [NullString]::Value)
        if ((Get-CoreHash $core) -ne $oldHash) { throw ('Automatic rollback failed. Backup: ' + $backup) }
    }
    $metadata.status = 'failed-original-preserved'
    $metadata | ConvertTo-Json | Set-Content -LiteralPath $metadataFile -Encoding UTF8
    throw $reason
} finally {
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Force }
}
