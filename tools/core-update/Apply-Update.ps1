param([string]$TargetRoot = 'C:\MiaBot\deploy-windows-server', [switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
function Get-CoreHash([string]$File) {
    $stream = [IO.File]::OpenRead($File)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '') }
    finally { $sha.Dispose(); $stream.Dispose() }
}
$root = [IO.Path]::GetFullPath($TargetRoot).TrimEnd('\', '/')
$prefix = $root + [IO.Path]::DirectorySeparatorChar
if (-not (Test-Path -LiteralPath $root -PathType Container)) { throw 'Deployment directory does not exist.' }
function Assert-DeploymentFile([string]$File) {
    if (-not $File.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $File -PathType Leaf)) { throw 'Existing target must stay inside TargetRoot.' }
    $ancestor = Get-Item -LiteralPath $File -Force
    while ($null -ne $ancestor -and $ancestor.FullName.Length -ge $root.Length) {
        if ($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse points are not supported in deployment paths.' }
        if ($ancestor.PSIsContainer) { $ancestor = $ancestor.Parent } else { $ancestor = $ancestor.Directory }
    }
}
$configFile = Join-Path $root 'qq-official\config.local.json'
$config = Get-Content -LiteralPath $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace([string]$config.corePath)) { throw 'corePath is not configured.' }
$core = [IO.Path]::GetFullPath([IO.Path]::Combine((Join-Path $root 'qq-official'), [string]$config.corePath))
if ([IO.Path]::GetExtension($core) -ne '.exe') { throw 'Existing Windows EXE core not found.' }
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$files = @($manifest.files)
$withEntry = $manifest.kind -eq 'core-and-entry'
if (($manifest.kind -ne 'core-only' -and -not $withEntry) -or $files.Count -ne (1 + [int]$withEntry) -or $files[0].path -ne 'qq-official/ongeki-core.exe' -or ($withEntry -and $files[1].path -ne 'qq-official/mia-entry.cjs')) { throw 'Unexpected update manifest.' }
$targets = @()
foreach ($item in $files) {
    $path = if ($item.path -eq 'qq-official/ongeki-core.exe') { $core } else { Join-Path $root 'qq-official\mia-entry.cjs' }
    Assert-DeploymentFile $path
    if ([string]$item.sha256 -notmatch '^[a-fA-F0-9]{64}$' -or [long]$item.bytes -le 0) { throw 'Invalid payload checksum or size.' }
    $source = Join-Path (Join-Path $PSScriptRoot 'payload') $item.path
    if ((Get-Item -LiteralPath $source).Length -ne [long]$item.bytes -or (Get-CoreHash $source) -ne $item.sha256) { throw 'Payload checksum mismatch; no deployment files changed.' }
    $handle = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    $handle.Dispose()
    $originalFile = if ($item.path -eq 'qq-official/ongeki-core.exe') { 'original-core.exe' } else { 'original-entry.cjs' }
    $targets += @{ path = $path; relative = [string]$item.path; source = $source; hash = [string]$item.sha256; originalFile = $originalFile; stage = $path + '.update-' + [Guid]::NewGuid().ToString('N') + '.tmp'; changed = $false }
    Write-Host ('Update target: ' + $path)
}
if ($CheckOnly) { Write-Host 'CHECK OK; deployment files were not changed.'; exit 0 }
$backupRoot = Join-Path $root 'update-backups'
if (Test-Path -LiteralPath $backupRoot) {
    $backupRootItem = Get-Item -LiteralPath $backupRoot -Force
    if (-not $backupRootItem.PSIsContainer -or ($backupRootItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Backup directory must be a regular directory inside TargetRoot.' }
}
$stamp = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0,8)
$backup = Join-Path $backupRoot ('server-constants-' + $stamp)
[IO.Directory]::CreateDirectory($backup) | Out-Null
$backupItems = @()
foreach ($target in $targets) {
    $target.original = Join-Path $backup $target.originalFile
    [IO.File]::Copy($target.path, $target.original, $false)
    $target.oldHash = Get-CoreHash $target.original
    $backupItems += @{ coreRelative = $target.path.Substring($prefix.Length); originalFile = $target.originalFile; originalSha256 = $target.oldHash; installedSha256 = $target.hash }
}
$metadata = @{ kind = $manifest.kind; targetRoot = $root; files = $backupItems; status = 'prepared' }
$metadataFile = Join-Path $backup 'backup.json'
$metadata | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $metadataFile -Encoding UTF8
try {
    foreach ($target in $targets) {
        [IO.File]::Copy($target.source, $target.stage, $false)
        if ((Get-CoreHash $target.stage) -ne $target.hash) { throw 'Staged payload checksum mismatch.' }
    }
    foreach ($target in $targets) {
        [IO.File]::Replace($target.stage, $target.path, [NullString]::Value)
        $target.changed = $true
        if ((Get-CoreHash $target.path) -ne $target.hash) { throw 'Installed payload checksum mismatch.' }
    }
    $metadata.status = 'installed'
    $metadata | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $metadataFile -Encoding UTF8
    Write-Host 'UPDATE COMPLETE'
    Write-Host ('Backup: ' + $backup)
    Write-Host 'Start MiaBot using its existing launcher. Configs, bindings, aliases and caches were preserved.'
} catch {
    $reason = $_
    for ($i = $targets.Count - 1; $i -ge 0; $i--) {
        $target = $targets[$i]
        if ($target.changed) {
            [IO.File]::Copy($target.original, $target.stage, $false)
            [IO.File]::Replace($target.stage, $target.path, [NullString]::Value)
            if ((Get-CoreHash $target.path) -ne $target.oldHash) { throw ('Automatic rollback failed. Backup: ' + $backup) }
        }
    }
    $metadata.status = 'failed-original-preserved'
    $metadata | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $metadataFile -Encoding UTF8
    throw $reason
} finally {
    foreach ($target in $targets) { if (Test-Path -LiteralPath $target.stage) { Remove-Item -LiteralPath $target.stage -Force } }
}
