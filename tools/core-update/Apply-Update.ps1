#requires -version 5
<#
  MiaBot 出图核心更新 —— 双击 Apply-Update.cmd 就能装完，别的都不用管。

  双击时它会自己做这几件事：
    1. 自己找部署目录：计划任务 MiaBot 的启动路径 → 上次装过的位置 → 常见默认位置 → 盘符浅层扫描
    2. 停掉正在跑的美亚（连同她开的出图核心和无头浏览器），等文件不再被占用
    3. 校验更新包（大小 + SHA256），备份旧文件，替换 corePath 指向的核心和 mia-entry.cjs；
       中途任何一步失败都会把两个文件一起换回去，并且把美亚重新启动起来
    4. 把美亚重新启动起来，等 mia.log 里出现「已就绪，等待消息」再收工

  参数（一般都用不到）：
    -TargetRoot <目录>  手工指定部署目录；自动找错了才用，也兼容旧的双击参数写法
    -SearchRoot <目录>  只在指定目录下找（0～2 层深度），排查时用
    -CheckOnly          只检查能不能装，不动任何文件，也不停美亚
    -NoService          只换文件，不碰美亚（在别处自动调用时用）
    -NoStart            装完不启动美亚；它本来是跑着的话，装完也会先停着

  退出码：0 装好且美亚已就绪；1 没装成（文件已恢复原样）；2 文件装好了但美亚没起来/没确认就绪。
#>
param(
    [string]$TargetRoot = '',
    [string]$SearchRoot = '',
    [switch]$CheckOnly,
    [switch]$NoService,
    [switch]$NoStart
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }

$PackageRoot = $PSScriptRoot
$TaskName = 'MiaBot'
$TaskScriptName = 'mia-task.cmd'
$ReadyLine = '已就绪，等待消息'
$LogFileName = 'mia.log'
$ErrorFileName = 'mia-stderr.log'
$MemoryFile = ''
if ($env:MIA_UPDATE_TARGET_FILE) {
    # 测试用：把「上次装过的位置」挪到临时目录，别写到真机上的 %LOCALAPPDATA%
    $MemoryFile = $env:MIA_UPDATE_TARGET_FILE
} elseif ($env:LOCALAPPDATA) {
    $MemoryFile = Join-Path $env:LOCALAPPDATA 'MiaBot\update-target.txt'
}
# 盘符扫描时跳过的目录：系统目录、其它程序、回收站之类，翻它们没用还慢
$SkipNames = @(
    'windows', 'program files', 'program files (x86)', 'programdata', 'users', '$recycle.bin',
    'system volume information', 'recovery', 'perflogs', 'config.msi', 'msocache',
    '$windows.~bt', '$windows.~ws', 'node_modules', '.git', 'appdata', 'intel', 'amd64', 'nvidia'
)

function Write-Step([string]$Text) {
    Write-Host ''
    Write-Host ('== ' + $Text) -ForegroundColor Cyan
}
function Write-Detail([string]$Text) { Write-Host ('   ' + $Text) }
function Write-Warn([string]$Text) { Write-Host ('   ! ' + $Text) -ForegroundColor Yellow }

function Get-CoreHash([string]$File) {
    $stream = [IO.File]::OpenRead($File)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '') }
    finally { $sha.Dispose(); $stream.Dispose() }
}

function Get-FileLength([string]$File) {
    try { return (Get-Item -LiteralPath $File -ErrorAction Stop).Length } catch { return 0 }
}

# 读 offset 之后新写的内容（最多 256 KB，日志再大也不怕）。文件比 offset 还短，说明它被换成了新的一份，从头读。
function Get-NewText([string]$File, [long]$Offset) {
    try {
        $stream = [IO.File]::Open($File, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
        try {
            $start = if ($stream.Length -le $Offset) { 0 } else { $Offset }
            $length = [int][Math]::Min($stream.Length - $start, 262144)
            if ($length -le 0) { return '' }
            $stream.Seek($start, [IO.SeekOrigin]::Begin) | Out-Null
            $buffer = New-Object byte[] $length
            $read = $stream.Read($buffer, 0, $length)
            return [Text.Encoding]::UTF8.GetString($buffer, 0, $read)
        } finally { $stream.Dispose() }
    } catch { return '' }
}

# ------------------------------------------------------------------
# 找部署目录
# ------------------------------------------------------------------

# 像不像一个部署目录：qq-official\config.local.json 里 corePath 是 .exe，mia-entry.cjs 也在
function Test-DeploymentShape([string]$Root) {
    if (-not $Root) { return $false }
    $qq = Join-Path $Root 'qq-official'
    $configFile = Join-Path $qq 'config.local.json'
    if (-not (Test-Path -LiteralPath $configFile -PathType Leaf)) { return $false }
    if (-not (Test-Path -LiteralPath (Join-Path $qq 'mia-entry.cjs') -PathType Leaf)) { return $false }
    try { $config = Get-Content -LiteralPath $configFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch { return $false }
    $corePath = [string]$config.corePath
    if ([string]::IsNullOrWhiteSpace($corePath)) { return $false }
    if ([IO.Path]::GetExtension($corePath) -ne '.exe') { return $false }
    return $true
}

function Get-NormalPath([string]$Path) {
    if (-not $Path) { return '' }
    try { return [IO.Path]::GetFullPath($Path).TrimEnd('\', '/') } catch { return '' }
}

# 计划任务 MiaBot 的「操作」指着的目录：服务器上开机自启的就是它，最靠得住
function Get-TaskRoots {
    $roots = New-Object System.Collections.Generic.List[string]
    try { $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop | Select-Object -First 1 } catch { return $roots }
    if (-not $task) { return $roots }
    foreach ($action in @($task.Actions)) {
        $blob = [string]$action.Execute + ' ' + [string]$action.Arguments
        # ""D:\mia\qq-official\mia-task.cmd" task" 这种里，把 \qq-official 前面那段取出来当根目录
        foreach ($match in [regex]::Matches($blob, '[A-Za-z]:\\[^"<>|]*')) {
            $text = $match.Value
            $at = $text.IndexOf('\qq-official\', [StringComparison]::OrdinalIgnoreCase)
            if ($at -gt 0) { $roots.Add($text.Substring(0, $at)) }
        }
        $working = [string]$action.WorkingDirectory
        if ($working) {
            $trimmed = $working.TrimEnd('\', '/')
            if ($trimmed.ToLowerInvariant().EndsWith('\qq-official')) { $trimmed = $trimmed.Substring(0, $trimmed.Length - '\qq-official'.Length) }
            if ($trimmed) { $roots.Add($trimmed) }
        }
    }
    return $roots
}

# 在目录下按 0～2 层找 qq-official\config.local.json，找到就不再往下钻
function Find-DeploymentsUnder([string]$Base, [int]$MaxDepth) {
    $found = New-Object System.Collections.Generic.List[string]
    $basePath = Get-NormalPath $Base
    if (-not $basePath -or -not (Test-Path -LiteralPath $basePath -PathType Container)) { return $found }
    $queue = New-Object System.Collections.Generic.Queue[object]
    $queue.Enqueue(@{ path = $basePath; depth = 0 })
    $seen = 0
    while ($queue.Count -gt 0 -and $seen -lt 3000) {
        $item = $queue.Dequeue()
        $seen++
        if (Test-Path -LiteralPath (Join-Path $item.path 'qq-official\config.local.json') -PathType Leaf) {
            $found.Add($item.path)
            continue
        }
        if ($item.depth -ge $MaxDepth) { continue }
        try { $children = @(Get-ChildItem -LiteralPath $item.path -Directory -Force -ErrorAction Stop) } catch { continue }
        foreach ($child in $children) {
            if ($child.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
            if ($SkipNames -contains $child.Name.ToLowerInvariant()) { continue }
            $queue.Enqueue(@{ path = $child.FullName; depth = $item.depth + 1 })
        }
    }
    return $found
}

# 候选按可靠程度排：手工指定 > 计划任务 > 上次装的位置 > 常见默认位置 > 指定目录/盘符浅层扫描。
# 前几档找到像样的就不再扫盘，所以服务器上（有计划任务）基本是秒开。
function Resolve-DeploymentRoot {
    $candidates = New-Object System.Collections.Generic.List[string]
    $sources = @{}
    $add = {
        param([string]$Path, [string]$From)
        $normal = Get-NormalPath $Path
        if (-not $normal) { return }
        $key = $normal.ToLowerInvariant()
        if ($sources.ContainsKey($key)) { return }
        $sources[$key] = $From
        $candidates.Add($normal)
    }
    if ($TargetRoot) {
        # 手工给了目录就以它为准：不对就当场报错，不要偷偷去扫盘
        if (-not (Test-DeploymentShape (Get-NormalPath $TargetRoot))) { throw ('指定的目录不像 MiaBot 的部署目录：' + $TargetRoot + "`r`n  里面要有 qq-official\config.local.json，并且 corePath 指向一个 .exe。") }
        & $add $TargetRoot '手工指定'
    }
    foreach ($root in @(Get-TaskRoots)) { & $add $root '计划任务' }
    if ($MemoryFile -and (Test-Path -LiteralPath $MemoryFile -PathType Leaf)) {
        try { & $add ((Get-Content -LiteralPath $MemoryFile -Raw -Encoding UTF8).Trim()) '上次安装' } catch { }
    }
    foreach ($root in @('C:\MiaBot\deploy-windows-server', 'C:\MiaBot', 'C:\mia', 'D:\mia', 'D:\MiaBot\deploy-windows-server', 'D:\MiaBot')) {
        & $add $root '常见位置'
    }
    $known = @($candidates | Where-Object { Test-DeploymentShape $_ })
    if ($SearchRoot) {
        foreach ($root in @(Find-DeploymentsUnder $SearchRoot 2)) { & $add $root '指定目录扫描' }
    } elseif ($known.Count -eq 0) {
        $drives = @()
        try { $drives = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' -ErrorAction Stop | ForEach-Object { [string]$_.DeviceID }) } catch { }
        foreach ($drive in $drives) {
            foreach ($root in @(Find-DeploymentsUnder ($drive + '\') 2)) { & $add $root '盘符扫描' }
        }
    }

    $valid = New-Object System.Collections.Generic.List[object]
    foreach ($root in $candidates) {
        if (Test-DeploymentShape $root) {
            $valid.Add(@{ root = $root; from = $sources[$root.ToLowerInvariant()]; log = (Get-FileLength (Join-Path $root 'qq-official\mia.log')) })
        }
    }
    if ($valid.Count -eq 0) {
        $hint = ''
        if ($candidates.Count -gt 0) { $hint = '  找到这些但都不像部署目录：' + ($candidates -join '；') + "`r`n" }
        throw ("找不到 MiaBot 的部署目录。`r`n" + $hint + '  确认她装在哪个目录（里面要有 qq-official\config.local.json），' +
            "然后把这个目录拖到 Apply-Update.cmd 上，或者双击后在弹出来的提示里选。`r`n" +
            '  也可以这样运行：Apply-Update.cmd "D:\实际部署目录"')
    }
    if ($valid.Count -eq 1) { return $valid[0] }
    $newest = $valid[0]
    foreach ($item in $valid) { if ($item.log -gt $newest.log) { $newest = $item } }
    if ($newest.log -le 0) {
        throw ("找到多个可能的部署目录，分不出该装哪个：`r`n  " + (($valid | ForEach-Object { $_.root }) -join "`r`n  ") +
            "`r`n  用 Apply-Update.cmd `"目录`" 指定其中一个。")
    }
    $others = @($valid | Where-Object { $_.root -ne $newest.root } | ForEach-Object { $_.root })
    if ($others.Count -gt 0) { Write-Warn ('另外这些位置也有部署目录，这次不动：' + ($others -join '；')) }
    return $newest
}

function Save-DeploymentRoot([string]$Root) {
    if (-not $MemoryFile) { return }
    try {
        $dir = Split-Path -Parent $MemoryFile
        if (-not (Test-Path -LiteralPath $dir -PathType Container)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        [IO.File]::WriteAllText($MemoryFile, $Root)
    } catch { }
}

# ------------------------------------------------------------------
# 停 / 启动美亚
# ------------------------------------------------------------------

# 认法跟 mia-background.cjs、mia-task.cmd 一致：命令行里带 mia-entry 的 node 进程
function Get-MiaProcesses {
    try {
        return @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop |
            Where-Object { $_.CommandLine -and ($_.CommandLine -match 'mia-entry') })
    } catch {
        return @()
    }
}

function Stop-MiaBot {
    $procs = @(Get-MiaProcesses)
    if ($procs.Count -eq 0) {
        Write-Detail '美亚本来就没在运行，直接换文件。'
        return $false
    }
    $ids = @($procs | ForEach-Object { [int]$_.ProcessId })
    Write-Detail ('停美亚（进程 ' + ($ids -join '、') + '，连同出图核心和无头浏览器）…')
    foreach ($processId in $ids) { & taskkill.exe /PID $processId /T /F 2>&1 | Out-Null }
    $deadline = (Get-Date).AddSeconds(25)
    while ((Get-Date) -lt $deadline) {
        if (@(Get-MiaProcesses).Count -eq 0) {
            Start-Sleep -Milliseconds 400
            Write-Detail '美亚已停止。'
            return $true
        }
        Start-Sleep -Milliseconds 300
    }
    $left = @(Get-MiaProcesses | ForEach-Object { [int]$_.ProcessId })
    throw ('美亚停不下来（进程 ' + ($left -join '、') + '）。先双击「停止美亚.vbs」再试，或者重启这台机器后再装。')
}

# 优先交给计划任务 MiaBot 启动（跟开机自启一模一样，注销远程桌面也不会停），
# 没有就照 mia-task.cmd 起，再没有就直接 node mia-entry.cjs。
function Start-MiaBot([string]$Root) {
    $qq = Join-Path $Root 'qq-official'
    $taskScript = Join-Path $qq $TaskScriptName
    $viaTask = $false
    try {
        $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop | Select-Object -First 1
        if ($task -and [string]$task.State -ne 'Disabled') {
            foreach ($action in @($task.Actions)) {
                $blob = [string]$action.Execute + ' ' + [string]$action.Arguments
                if ($blob.IndexOf($taskScript, [StringComparison]::OrdinalIgnoreCase) -ge 0) { $viaTask = $true }
            }
        }
    } catch { }
    if ($viaTask) {
        Start-ScheduledTask -TaskName $TaskName
        Write-Detail ('已交给计划任务 ' + $TaskName + ' 启动。')
        return
    }
    if (Test-Path -LiteralPath $taskScript -PathType Leaf) {
        Start-Process -FilePath 'cmd.exe' -ArgumentList ('/d /s /c ""' + $taskScript + '" task"') -WorkingDirectory $qq -WindowStyle Hidden
        Write-Detail ('已用 ' + $TaskScriptName + ' 在后台启动。')
        return
    }
    Start-Process -FilePath 'node.exe' -ArgumentList 'mia-entry.cjs' -WorkingDirectory $qq -WindowStyle Hidden
    Write-Detail '已直接启动 node mia-entry.cjs。'
}

# 等 mia.log 里出现「已就绪，等待消息」。mia-stderr.log 冒出新报错就早点收工，把话带回来。
function Wait-MiaBotReady([string]$Root, [int]$TimeoutSeconds) {
    $qq = Join-Path $Root 'qq-official'
    $logFile = Join-Path $qq $LogFileName
    $errFile = Join-Path $qq $ErrorFileName
    $logOffset = Get-FileLength $logFile
    $errOffset = Get-FileLength $errFile
    $started = Get-Date
    $deadline = $started.AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 500
        if ((Get-NewText $logFile $logOffset).Contains($ReadyLine)) { return @{ ok = $true; text = '' } }
        $errors = (Get-NewText $errFile $errOffset).Trim()
        if ($errors) {
            $head = (@($errors -split "`r?`n") | Where-Object { $_.Trim() } | Select-Object -First 6) -join "`r`n"
            return @{ ok = $false; text = ('mia-stderr.log 里出现了新报错：' + "`r`n" + $head) }
        }
        if ((Get-Date) -gt $started.AddSeconds(12) -and @(Get-MiaProcesses).Count -eq 0) {
            return @{ ok = $false; text = ('美亚起来了又退了，' + $LogFileName + ' 里没有「已就绪」。看看 ' + $LogFileName + ' 和 ' + $ErrorFileName + '。') }
        }
    }
    return @{ ok = $false; text = ('等了 ' + $TimeoutSeconds + ' 秒还没看到「已就绪，等待消息」。看看 ' + $LogFileName + '：' + $logFile) }
}

# ------------------------------------------------------------------
# 主流程
# ------------------------------------------------------------------

$root = ''
$core = ''
$prefix = ''
$backupPath = ''
$stoppedByUs = $false
$installed = $false
$serviceControl = -not $NoService
$failure = ''
$failureRolledBack = $false
$startReport = $null
$startMode = 'skipped'

# 部署目录里的文件才动；路径上有符号链接也不动
function Assert-DeploymentFile([string]$File, [string]$Root, [string]$Prefix) {
    if (-not $File.StartsWith($Prefix, [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $File -PathType Leaf)) { throw ('这个文件不在部署目录里，或者不存在：' + $File) }
    $ancestor = Get-Item -LiteralPath $File -Force
    while ($null -ne $ancestor -and $ancestor.FullName.Length -ge $Root.Length) {
        if ($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '部署路径上有符号链接，不装。' }
        if ($ancestor.PSIsContainer) { $ancestor = $ancestor.Parent } else { $ancestor = $ancestor.Directory }
    }
}

try {
    Write-Host '══════════════════════════════════════'
    Write-Host '  MiaBot 更新安装程序'
    Write-Host '══════════════════════════════════════'

    $manifestFile = Join-Path $PackageRoot 'manifest.json'
    if (-not (Test-Path -LiteralPath $manifestFile -PathType Leaf)) { throw '这个目录里没有 manifest.json，不是完整的更新包。' }
    $manifest = Get-Content -LiteralPath $manifestFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $files = @($manifest.files)
    $withEntry = $manifest.kind -eq 'core-and-entry'
    if (($manifest.kind -ne 'core-only' -and -not $withEntry) -or $files.Count -ne (1 + [int]$withEntry) -or $files[0].path -ne 'qq-official/ongeki-core.exe' -or ($withEntry -and $files[1].path -ne 'qq-official/mia-entry.cjs')) { throw '更新包的清单（manifest.json）不对。' }

    Write-Step '1/5 找部署目录'
    $picked = Resolve-DeploymentRoot
    $root = $picked.root
    $prefix = $root + [IO.Path]::DirectorySeparatorChar
    Write-Detail ('部署目录：' + $root + '（来源：' + $picked.from + '）')
    $configFile = Join-Path $root 'qq-official\config.local.json'
    $config = Get-Content -LiteralPath $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([string]::IsNullOrWhiteSpace([string]$config.corePath)) { throw 'config.local.json 里没配 corePath。' }
    $core = [IO.Path]::GetFullPath([IO.Path]::Combine((Join-Path $root 'qq-official'), [string]$config.corePath))
    if ([IO.Path]::GetExtension($core) -ne '.exe') { throw 'corePath 不是 .exe。' }
    Write-Detail ('出图核心：' + $core)

    Write-Step '2/5 校验更新包'
    $targets = @()
    foreach ($item in $files) {
        $path = if ($item.path -eq 'qq-official/ongeki-core.exe') { $core } else { Join-Path $root 'qq-official\mia-entry.cjs' }
        Assert-DeploymentFile $path $root $prefix
        if ([string]$item.sha256 -notmatch '^[a-fA-F0-9]{64}$' -or [long]$item.bytes -le 0) { throw '清单里的 SHA256 或大小不合法。' }
        $source = Join-Path (Join-Path $PackageRoot 'payload') $item.path
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw ('更新包里少了文件：' + $source) }
        if ((Get-Item -LiteralPath $source).Length -ne [long]$item.bytes -or (Get-CoreHash $source) -ne $item.sha256) { throw ('更新包里的 ' + $item.path + ' 大小或 SHA256 对不上，一个字节都没改。') }
        $originalFile = if ($item.path -eq 'qq-official/ongeki-core.exe') { 'original-core.exe' } else { 'original-entry.cjs' }
        $targets += @{ path = $path; relative = [string]$item.path; source = $source; hash = [string]$item.sha256; originalFile = $originalFile; stage = $path + '.update-' + [Guid]::NewGuid().ToString('N') + '.tmp'; changed = $false }
    }
    Write-Detail ('新核心 SHA256：' + ([string]$files[0].sha256).Substring(0, 12) + '…（' + [math]::Round([long]$files[0].bytes / 1MB, 1) + ' MB）')
    if ($withEntry) { Write-Detail '入口 mia-entry.cjs 也一并更新。' }

    $locked = $false
    foreach ($target in $targets) {
        try {
            $handle = [IO.File]::Open($target.path, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
            $handle.Dispose()
        } catch { $locked = $true }
    }
    if ($locked) {
        if ($CheckOnly) { Write-Warn '有文件正被占用（美亚在跑就是这样）。正式安装会先把她停掉，不影响。' }
        elseif (-not $serviceControl) { throw '目标文件正被占用，美亚大概还在跑。去掉 -NoService 让它自己停，或者先手动停美亚。' }
    }

    if ($CheckOnly) {
        Write-Step '3/5 只检查'
        Write-Detail '包和部署目录都对得上。没有改动任何文件，也没有碰美亚。'
        Write-Host ''
        Write-Host 'CHECK OK; deployment files were not changed.' -ForegroundColor Green
        exit 0
    }

    if ($serviceControl) {
        Write-Step '3/5 停美亚'
        $stoppedByUs = Stop-MiaBot
        # 停完再确认文件能独占打开：出图核心和无头浏览器退出要一点时间
        $deadline = (Get-Date).AddSeconds(20)
        while ($true) {
            $stillLocked = $false
            foreach ($target in $targets) {
                try {
                    $handle = [IO.File]::Open($target.path, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
                    $handle.Dispose()
                } catch { $stillLocked = $true }
            }
            if (-not $stillLocked) { break }
            if ((Get-Date) -gt $deadline) { throw '美亚停了，但文件还被占用着。可能还有出图任务没结束，等一会儿再装一次。' }
            Start-Sleep -Milliseconds 500
        }
    } else {
        Write-Step '3/5 停美亚'
        Write-Detail '按 -NoService 跳过：不碰美亚，直接换文件。'
    }

    Write-Step '4/5 备份并替换'
    $backupRoot = Join-Path $root 'update-backups'
    if (Test-Path -LiteralPath $backupRoot) {
        $backupRootItem = Get-Item -LiteralPath $backupRoot -Force
        if (-not $backupRootItem.PSIsContainer -or ($backupRootItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'update-backups 必须是部署目录里的普通文件夹。' }
    }
    $stamp = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
    $backupPath = Join-Path $backupRoot ('server-constants-' + $stamp)
    [IO.Directory]::CreateDirectory($backupPath) | Out-Null
    $backupItems = @()
    foreach ($target in $targets) {
        $target.original = Join-Path $backupPath $target.originalFile
        [IO.File]::Copy($target.path, $target.original, $false)
        $target.oldHash = Get-CoreHash $target.original
        $backupItems += @{ coreRelative = $target.path.Substring($prefix.Length); originalFile = $target.originalFile; originalSha256 = $target.oldHash; installedSha256 = $target.hash }
    }
    $metadata = @{ kind = $manifest.kind; targetRoot = $root; files = $backupItems; status = 'prepared' }
    $metadataFile = Join-Path $backupPath 'backup.json'
    $metadata | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $metadataFile -Encoding UTF8
    Write-Detail ('旧文件备份在：' + $backupPath)
    try {
        foreach ($target in $targets) {
            [IO.File]::Copy($target.source, $target.stage, $false)
            if ((Get-CoreHash $target.stage) -ne $target.hash) { throw '暂存文件校验失败。' }
        }
        foreach ($target in $targets) {
            $attempts = 0
            while ($true) {
                try {
                    [IO.File]::Replace($target.stage, $target.path, [NullString]::Value)
                    break
                } catch [System.IO.IOException] {
                    $attempts++
                    if ($attempts -ge 10) { throw }
                    Start-Sleep -Milliseconds 500
                }
            }
            $target.changed = $true
            if ((Get-CoreHash $target.path) -ne $target.hash) { throw '装好的文件校验失败。' }
            # 从网上下载来的更新包会带「来自网络」标记，去掉它，免得双击核心时被拦
            try { Unblock-File -LiteralPath $target.path -ErrorAction SilentlyContinue } catch { }
            Write-Detail ('换好：' + $target.relative)
        }
        $metadata.status = 'installed'
        $metadata | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $metadataFile -Encoding UTF8
        $installed = $true
    } catch {
        $reason = $_
        for ($i = $targets.Count - 1; $i -ge 0; $i--) {
            $target = $targets[$i]
            if ($target.changed) {
                [IO.File]::Copy($target.original, $target.stage, $false)
                [IO.File]::Replace($target.stage, $target.path, [NullString]::Value)
                if ((Get-CoreHash $target.path) -ne $target.oldHash) { throw ('自动回滚失败，备份在：' + $backupPath) }
            }
        }
        $metadata.status = 'failed-original-preserved'
        $metadata | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $metadataFile -Encoding UTF8
        $failureRolledBack = $true
        throw $reason
    } finally {
        foreach ($target in $targets) { if (Test-Path -LiteralPath $target.stage) { Remove-Item -LiteralPath $target.stage -Force } }
    }
} catch {
    $failure = $_.Exception.Message
} finally {
    if (-not $CheckOnly -and $serviceControl) {
        $wasStopped = $stoppedByUs
        $wantRunning = -not $NoStart -and ($wasStopped -or $installed)
        Write-Step '5/5 启动美亚'
        if (-not $wantRunning) {
            if ($NoStart -and $wasStopped) { $startMode = 'stopped-by-flag'; Write-Detail '按 -NoStart 停着，没有启动美亚。' }
            else { $startMode = 'was-not-running'; Write-Detail '美亚本来没在运行，这次也没有替你启动。' }
        } else {
            try {
                Start-MiaBot $root
                $startReport = Wait-MiaBotReady $root 120
            } catch {
                $startReport = @{ ok = $false; text = $_.Exception.Message }
            }
            if ($startReport.ok) {
                $startMode = 'ready'
                $ids = @(Get-MiaProcesses | ForEach-Object { [int]$_.ProcessId })
                Write-Detail ('美亚已启动，连上 QQ 了（进程 ' + ($ids -join '、') + '，mia.log 里出现「已就绪，等待消息」）。')
            } else {
                $startMode = 'not-ready'
                Write-Warn ('美亚没能确认启动：' + $startReport.text)
            }
        }
    }
}

Write-Host ''
if ($failure) {
    Write-Host ('UPDATE FAILED: ' + $failure) -ForegroundColor Red
    if ($failureRolledBack) { Write-Host ('已经恢复成原来的文件：' + $backupPath) -ForegroundColor Yellow }
    if ($startReport -and -not $startReport.ok) { Write-Host ('美亚那边：' + $startReport.text) -ForegroundColor Yellow }
    exit 1
}

Write-Host 'UPDATE COMPLETE' -ForegroundColor Green
Write-Host ('  部署目录：' + $root)
Write-Host ('  备份：' + $backupPath)
if (-not $serviceControl) { Write-Host '  美亚：按 -NoService 没有动她，用原来的启动器启动。' }
elseif ($startMode -eq 'ready') { Write-Host '  美亚：已重新启动并连上 QQ。' }
elseif ($startMode -eq 'stopped-by-flag') { Write-Host '  美亚：按 -NoStart 停着，没有启动。' }
elseif ($startMode -eq 'was-not-running') { Write-Host '  美亚：本来就没在运行，装完没有替你启动。' }
else {
    Write-Host '  美亚：文件装好了，但没确认连上 QQ。' -ForegroundColor Yellow
    if ($startReport) { Write-Host ('  ' + $startReport.text) -ForegroundColor Yellow }
    Write-Host '  先看 mia.log / mia-stderr.log；实在不行用 Restore-Backup.ps1 回退。' -ForegroundColor Yellow
    exit 2
}
exit 0
