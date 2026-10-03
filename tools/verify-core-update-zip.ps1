param([Parameter(Mandatory=$true)][string]$Name)
$ErrorActionPreference = 'Stop'
if ($Name -notmatch '^[A-Za-z0-9._-]+$') { throw 'Invalid package name.' }
$workspace = Split-Path -Parent $PSScriptRoot
$package = Join-Path $workspace ('server-updates\' + $Name)
$zipPath = $package + '.zip'
$manifest = Get-Content -LiteralPath (Join-Path $package 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.liveVerified -or $manifest.verificationStatus -ne 'pending-server-validation') { throw 'Expected pending server validation package.' }
function Get-StreamHash($Stream) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($Stream))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}
function Get-FileChecksum([string]$File) {
    $stream = [IO.File]::OpenRead($File)
    try { return Get-StreamHash $stream }
    finally { $stream.Dispose() }
}
$expected = @{}
foreach ($file in Get-ChildItem -LiteralPath $package -File -Recurse) {
    $relative = $file.FullName.Substring($package.Length + 1).Replace('\', '/')
    $expected[$Name + '/' + $relative] = $file
}
# The builder creates six files. A separately generated validation note is optional.
if ($expected.Count -lt 6 -or $expected.Count -gt 7) { throw 'Unexpected package file count; inspect for extra files.' }
[Reflection.Assembly]::LoadWithPartialName('System.IO.Compression.FileSystem') | Out-Null
$archive = [IO.Compression.ZipFile]::OpenRead($zipPath)
$seen = @{}
try {
    foreach ($entry in $archive.Entries) {
        $entryName = $entry.FullName.Replace('\', '/')
        if ($entryName.EndsWith('/')) { continue }
        if (-not $expected.ContainsKey($entryName) -or $seen.ContainsKey($entryName)) { throw ('Unexpected or duplicate ZIP entry: ' + $entry.FullName) }
        $seen[$entryName] = $true
        $file = $expected[$entryName]
        if ($entry.Length -ne $file.Length) { throw ('ZIP size mismatch: ' + $entry.FullName) }
        $stream = $entry.Open()
        try { $entryHash = Get-StreamHash $stream }
        finally { $stream.Dispose() }
        if ($entryHash -ne (Get-FileChecksum $file.FullName)) { throw ('ZIP checksum mismatch: ' + $entry.FullName) }
        if ($entryName -eq ($Name + '/payload/qq-official/ongeki-core.exe') -and $entryHash -ne $manifest.files[0].sha256) { throw 'ZIP core differs from manifest.' }
    }
    if ($seen.Count -ne $expected.Count) { throw 'ZIP has missing files.' }
} finally { $archive.Dispose() }
$zipHash = Get-FileChecksum $zipPath
Set-Content -LiteralPath ($zipPath + '.sha256') -Encoding ASCII -Value ($zipHash + '  ' + [IO.Path]::GetFileName($zipPath))
$report = @{ passed = $true; files = $seen.Count; zipBytes = (Get-Item -LiteralPath $zipPath).Length; sha256 = $zipHash; liveVerified = $false; serverValidation = 'pending' }
$report | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $workspace 'output\core-update-zip-verification.json') -Encoding UTF8
$report | ConvertTo-Json
