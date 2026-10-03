param(
    [string]$TargetRoot = 'C:\MiaBot\deploy-windows-server',
    [Parameter(Mandatory=$true)][string]$BackupPath
)
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
if ($metadata.kind -ne 'core-only' -or [string]$metadata.originalSha256 -notmatch '^[a-fA-F0-9]{64}$') { throw 'Invalid core backup metadata.' }
if ([string]::IsNullOrWhiteSpace([string]$metadata.coreRelative) -or [IO.Path]::IsPathRooted([string]$metadata.coreRelative)) { throw 'Invalid relative core target.' }
$core = [IO.Path]::GetFullPath([IO.Path]::Combine($root, [string]$metadata.coreRelative))
if (-not $core.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetExtension($core) -ne '.exe') { throw 'Backup target must stay inside TargetRoot.' }
if (-not (Test-Path -LiteralPath $core -PathType Leaf)) { throw 'Current core not found.' }
foreach ($file in @($core, $backup)) {
    $ancestor = Get-Item -LiteralPath $file -Force
    while ($null -ne $ancestor -and $ancestor.FullName.Length -ge $root.Length) {
        if ($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse points are not supported in restore paths.' }
        if ($ancestor.PSIsContainer) { $ancestor = $ancestor.Parent } else { $ancestor = $ancestor.Directory }
    }
}
$source = Join-Path $backup 'original-core.exe'
if ((Get-CoreHash $source) -ne $metadata.originalSha256) { throw 'Backup checksum mismatch.' }
if ((Get-CoreHash $core) -ne $metadata.installedSha256) { throw 'Current core differs from this update; restore the most recent update first.' }
$handle = [IO.File]::Open($core, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
$handle.Dispose()
$stage = $core + '.restore-' + [Guid]::NewGuid().ToString('N') + '.tmp'
try {
    [IO.File]::Copy($source, $stage, $false)
    if ((Get-CoreHash $stage) -ne $metadata.originalSha256) { throw 'Staged restore checksum mismatch.' }
    [IO.File]::Replace($stage, $core, [NullString]::Value)
    Write-Host 'RESTORE COMPLETE'
    Write-Host 'Start MiaBot using its existing launcher.'
} finally {
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Force }
}
