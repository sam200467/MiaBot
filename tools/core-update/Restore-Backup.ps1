param([string]$TargetRoot = 'C:\MiaBot\deploy-windows-server', [Parameter(Mandatory=$true)][string]$BackupPath)
$ErrorActionPreference = 'Stop'
function Get-CoreHash([string]$File) {
    $stream = [IO.File]::OpenRead($File)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '') }
    finally { $sha.Dispose(); $stream.Dispose() }
}
$root = [IO.Path]::GetFullPath($TargetRoot).TrimEnd('\', '/')
$prefix = $root + [IO.Path]::DirectorySeparatorChar
$backup = [IO.Path]::GetFullPath($BackupPath).TrimEnd('\', '/')
$backupsPrefix = (Join-Path $root 'update-backups') + [IO.Path]::DirectorySeparatorChar
if (-not $backup.StartsWith($backupsPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'BackupPath must stay inside TargetRoot/update-backups.' }
$metadata = Get-Content -LiteralPath (Join-Path $backup 'backup.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($metadata.kind -notin @('core-only','core-and-entry')) { throw 'Invalid backup metadata.' }
# Also support single-core backups from v4.1.3 and v4.1.4.
$items = @(if ($metadata.files) { $metadata.files } else { @{ coreRelative = $metadata.coreRelative; originalFile = 'original-core.exe'; originalSha256 = $metadata.originalSha256; installedSha256 = $metadata.installedSha256 } })
$withEntry = $metadata.kind -eq 'core-and-entry'
if ($items.Count -ne (1 + [int]$withEntry) -or $items[0].originalFile -ne 'original-core.exe' -or ($withEntry -and ($items[1].originalFile -ne 'original-entry.cjs' -or $items[1].coreRelative.Replace('/', '\') -ne 'qq-official\mia-entry.cjs'))) { throw 'Unexpected backup files.' }
$targets = @()
foreach ($item in $items) {
    if ([string]$item.originalSha256 -notmatch '^[a-fA-F0-9]{64}$' -or [string]$item.installedSha256 -notmatch '^[a-fA-F0-9]{64}$' -or [string]::IsNullOrWhiteSpace([string]$item.coreRelative) -or [IO.Path]::IsPathRooted([string]$item.coreRelative)) { throw 'Invalid backup target or checksum.' }
    $path = [IO.Path]::GetFullPath([IO.Path]::Combine($root, [string]$item.coreRelative))
    if (-not $path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'Backup target must stay inside TargetRoot.' }
    if ($item.originalFile -eq 'original-core.exe' -and [IO.Path]::GetExtension($path) -ne '.exe') { throw 'Invalid core backup target.' }
    $source = Join-Path $backup $item.originalFile
    foreach ($file in @($path, $source)) {
        $ancestor = Get-Item -LiteralPath $file -Force
        while ($null -ne $ancestor -and $ancestor.FullName.Length -ge $root.Length) {
            if ($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse points are not supported in restore paths.' }
            if ($ancestor.PSIsContainer) { $ancestor = $ancestor.Parent } else { $ancestor = $ancestor.Directory }
        }
    }
    if ((Get-CoreHash $source) -ne $item.originalSha256) { throw 'Backup checksum mismatch.' }
    if ((Get-CoreHash $path) -ne $item.installedSha256) { throw 'Current file differs from this update; restore the most recent update first.' }
    $handle = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    $handle.Dispose()
    $targets += @{ path = $path; source = $source; hash = $item.originalSha256; stage = $path + '.restore-' + [Guid]::NewGuid().ToString('N') + '.tmp'; previous = $path + '.previous-' + [Guid]::NewGuid().ToString('N') + '.tmp'; changed = $false }
}
$rollbackFailed = $false
try {
    foreach ($target in $targets) {
        [IO.File]::Copy($target.source, $target.stage, $false)
        if ((Get-CoreHash $target.stage) -ne $target.hash) { throw 'Staged restore checksum mismatch.' }
    }
    foreach ($target in $targets) {
        [IO.File]::Replace($target.stage, $target.path, $target.previous)
        $target.changed = $true
        if ((Get-CoreHash $target.path) -ne $target.hash) { throw 'Restored file checksum mismatch.' }
    }
    Write-Host 'RESTORE COMPLETE'
    Write-Host 'Start MiaBot using its existing launcher.'
} catch {
    $reason = $_
    try {
        for ($i = $targets.Count - 1; $i -ge 0; $i--) {
            if ($targets[$i].changed) { [IO.File]::Replace($targets[$i].previous, $targets[$i].path, [NullString]::Value) }
        }
    } catch { $rollbackFailed = $true; throw 'Restore rollback failed; preserve the .previous temporary files for recovery.' }
    throw $reason
} finally {
    foreach ($target in $targets) {
        if (Test-Path -LiteralPath $target.stage) { Remove-Item -LiteralPath $target.stage -Force }
        if (-not $rollbackFailed -and (Test-Path -LiteralPath $target.previous)) { Remove-Item -LiteralPath $target.previous -Force }
    }
}
