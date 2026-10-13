# 精简版启动器排障：验证「exe 所在目录/文件名含非 ASCII」是否为 electron 启动即崩的根因
# 用法: powershell -NoProfile -ExecutionPolicy Bypass -File tools\probe-launcher.ps1
#
# 关键纪律：脚本内所有 GUI 进程启动一律走 Start-Process + -RedirectStandard*(文件)，
# 否则子进程会继承调用方的输出管道并一直持有，导致调用方永远等不到 EOF（"假挂起"）。
# 所有路径一律绝对路径（相对路径 + 中文目录在 PS 里不可靠）。

$ErrorActionPreference = 'Continue'
$root = 'D:\AI\工作区\novel-reader'
$node = 'C:\Users\Administrator\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$csc  = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$src  = Join-Path $root 'tools\launcher\Program.cs'
$man  = Join-Path $root 'tools\launcher\app.manifest'
$ico  = Join-Path $root 'build\app.ico'
$log  = Join-Path $root 'data\launcher.log'
$tmp  = Join-Path $env:TEMP 'probe-sr'
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

function Write-Both([string]$text) {
    Write-Host $text
    Add-Content -Path (Join-Path $tmp 'probe-result.txt') -Value $text -Encoding UTF8
}
Remove-Item (Join-Path $tmp 'probe-result.txt') -ErrorAction SilentlyContinue

function Kill-All {
    Get-Process electron -ErrorAction SilentlyContinue | ForEach-Object { try { $_.Kill() } catch {} }
    Get-Process -ErrorAction SilentlyContinue |
        Where-Object { $_.ProcessName -match 'ShuyuanReader|Probe|书源阅读器' } |
        ForEach-Object { try { Stop-Process -Id $_.Id -Force } catch {} }
    Start-Sleep -Milliseconds 1800
}

function Get-ElectronInfo {
    $p = Get-Process electron -ErrorAction SilentlyContinue
    $n = 0; if ($p) { $n = ($p | Measure-Object).Count }
    $t = ''
    if ($p) { $t = ($p | Where-Object { $_.MainWindowTitle } | Select-Object -First 1).MainWindowTitle }
    return ,@($n, $t)
}

function Last-LogLine {
    if (-not (Test-Path $log)) { return '(无日志)' }
    $lines = Get-Content $log -Encoding UTF8 -ErrorAction SilentlyContinue
    if (-not $lines) { return '(空日志)' }
    $hit = $lines | Select-String -Pattern '退出码|EXCEPTION_|启动失败'
    $first = ''
    if ($hit) { $first = ($hit | Select-Object -First 1).Line.Trim() }
    return ($first + '  ||  末行: ' + $lines[-1])
}

function Try-Run([string]$label, [string]$exe, [hashtable]$env) {
    Kill-All
    Remove-Item $log -ErrorAction SilentlyContinue
    $saved = @{}
    if ($env) {
        foreach ($k in $env.Keys) {
            $saved[$k] = [Environment]::GetEnvironmentVariable($k)
            Set-Item "env:$k" $env[$k]
        }
    }
    $wd = $root
    Start-Process -FilePath $exe -WorkingDirectory $wd `
        -RedirectStandardOutput (Join-Path $tmp 'o.txt') `
        -RedirectStandardError  (Join-Path $tmp 'e.txt') | Out-Null
    Start-Sleep -Seconds 12
    $r = Get-ElectronInfo
    $mark = 'FAIL'
    if ($r[0] -ge 1) { $mark = 'OK  ' }
    Write-Both ("{0} {1,-46} electron={2} title='{3}'" -f $mark, $label, $r[0], $r[1])
    if ($r[0] -lt 1) { Write-Both ("        -> " + (Last-LogLine)) }
    if ($env) {
        foreach ($k in $env.Keys) {
            if ($saved[$k] -ne $null) { Set-Item "env:$k" $saved[$k] }
            else { Remove-Item "env:$k" -ErrorAction SilentlyContinue }
        }
    }
    Kill-All
}

function Try-Baseline([string]$label) {
    Kill-All
    Remove-Item $log -ErrorAction SilentlyContinue
    Start-Process -FilePath $node -ArgumentList 'scripts\start.js' -WorkingDirectory $root `
        -RedirectStandardOutput (Join-Path $tmp 'b.out') `
        -RedirectStandardError  (Join-Path $tmp 'b.err') | Out-Null
    Start-Sleep -Seconds 12
    $r = Get-ElectronInfo
    $mark = 'FAIL'
    if ($r[0] -ge 1) { $mark = 'OK  ' }
    Write-Both ("{0} {1,-46} electron={2} title='{3}'" -f $mark, $label, $r[0], $r[1])
    if ($r[0] -lt 1) {
        $be = Get-Content (Join-Path $tmp 'b.err') -ErrorAction SilentlyContinue
        if ($be) { Write-Both ("        stderr: " + ($be -join ' / ')) }
    }
    Kill-All
}

Write-Both "=========== 0. 编译真实产物 ==========="
& $csc /nologo /target:winexe /utf8output /reference:System.dll `
    "/win32icon:$ico" "/win32manifest:$man" "/out:$root\书源阅读器.exe" $src 2>&1 | Out-Null
$real = Join-Path $root '书源阅读器.exe'
$sz = 0; if (Test-Path $real) { $sz = (Get-Item $real).Length }
Write-Both ("  编译完成: {0}  {1} 字节" -f (Test-Path $real), $sz)

# 准备各位置的副本
$asciiDir  = 'C:\Temp\probe-sr'
$asciiDir2 = 'D:\SR'
$cjkDir    = 'D:\中文测试'
foreach ($d in @($asciiDir, $asciiDir2, $cjkDir)) { New-Item -ItemType Directory -Force -Path $d | Out-Null }

Copy-Item $real (Join-Path $asciiDir  'Probe.exe')        -Force   # ASCII 目录 + ASCII 名
Copy-Item $real (Join-Path $asciiDir  '书源阅读器.exe')    -Force   # ASCII 目录 + 中文名
Copy-Item $real (Join-Path $asciiDir2 '书源阅读器.exe')    -Force   # 盘根 ASCII 目录 + 中文名
Copy-Item $real (Join-Path $cjkDir    'Probe.exe')        -Force   # 中文目录 + ASCII 名
Copy-Item $real (Join-Path $cjkDir    '书源阅读器.exe')    -Force   # 中文目录 + 中文名
Copy-Item $real (Join-Path $root      'SR.exe')           -Force   # 项目中文目录 + ASCII 名

Write-Both ""
Write-Both "=========== 1. 基线 ==========="
Try-Baseline "baseline  node scripts/start.js（中文目录）"

Write-Both ""
Write-Both "=========== 2. 位置矩阵（同一份二进制，只换位置/名字） ==========="
Try-Run "A ASCII目录 + ASCII名   C:\Temp\probe-sr\Probe.exe" (Join-Path $asciiDir 'Probe.exe') @{}
Try-Run "B ASCII目录 + 中文名    C:\Temp\probe-sr\书源阅读器.exe" (Join-Path $asciiDir '书源阅读器.exe') @{}
Try-Run "C ASCII盘根 + 中文名    D:\SR\书源阅读器.exe" (Join-Path $asciiDir2 '书源阅读器.exe') @{}
Try-Run "D 中文目录 + ASCII名    D:\中文测试\Probe.exe" (Join-Path $cjkDir 'Probe.exe') @{}
Try-Run "E 中文目录 + 中文名      D:\中文测试\书源阅读器.exe" (Join-Path $cjkDir '书源阅读器.exe') @{}
Try-Run "F 项目中文目录 + ASCII名 novel-reader\SR.exe" (Join-Path $root 'SR.exe') @{}
Try-Run "G 项目真实产物          novel-reader\书源阅读器.exe" $real @{}

Write-Both ""
Write-Both "=========== 3. 关掉可疑开关（真实产物） ==========="
Try-Run "M1 raw（不重建环境块/不删ELECTRON_RUN_AS_NODE）" $real @{ SHUYUAN_LAUNCH_MODE = 'raw' }
Try-Run "M2 window（去掉 CREATE_NO_WINDOW）"             $real @{ SHUYUAN_LAUNCH_MODE = 'window' }
Try-Run "M3 noredir（不重定向子进程 stdio）"             $real @{ SHUYUAN_LAUNCH_MODE = 'noredir' }

Write-Both ""
Write-Both "=========== 清理 ==========="
Kill-All
Remove-Item (Join-Path $root 'SR.exe') -Force -ErrorAction SilentlyContinue
Write-Both "完成。结果文件：$tmp\probe-result.txt"
