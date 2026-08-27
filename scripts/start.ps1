<#
.SYNOPSIS
  MCSLite 面板启动器（Windows Server 2016 友好，纯 PowerShell 5.1 语法）
.DESCRIPTION
  · 校验 Node 版本与实例目录，缺项直接说人话，不抛栈
  · 以固定堆上限启动面板，保证「面板永远比游戏省内存」
  · 崩溃自动拉起（带退避），退出写审计
  · -CheckOnly 只体检不启动（计划任务/探针复用）
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\start.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\start.ps1 -CheckOnly
#>
[CmdletBinding()]
param(
  [switch]$CheckOnly,
  [int]$HeapMB = 96,          # 面板堆上限：实测满载用不到 40MB，给足余量并防止意外膨胀
  [string]$Root = $env:MCSLITE_ROOT,
  [int]$Port = 0
)

$ErrorActionPreference = 'Stop'
$BASE = Split-Path -Parent $PSScriptRoot
$ENTRY = Join-Path $BASE 'server\index.js'

function Write-Line($msg, $color = 'Gray') { Write-Host "[mcslite] $msg" -ForegroundColor $color }

# ——— 1. 运行时体检 ———
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Line '未找到 node，请先安装 Node.js LTS（x64）并勾选 Add to PATH' 'Red'
  exit 3
}
$nodeVer = (& node -p 'process.versions.node')
$major = [int](($nodeVer -split '\.')[0])
Write-Line "Node $nodeVer @ $($node.Source)"
if ($major -lt 20) { Write-Line "Node $nodeVer 过老：面板需 >= 20（node:sqlite 需 22.5+，更低版本会自动降级 JSONL）" 'Yellow' }

if (-not (Test-Path $ENTRY)) { Write-Line "入口缺失：$ENTRY" 'Red'; exit 3 }

# ——— 2. 配置体检（不启动也能发现问题）———
$SETTINGS = Join-Path $BASE 'data\settings.json'
if ($Port -gt 0) { $env:MCSLITE_PORT = "$Port" }
if ($Root) { $env:MCSLITE_ROOT = $Root }

$cfgRoot = $null; $javaPath = $null; $jar = $null; $listenPort = 8787
if (Test-Path $SETTINGS) {
  try {
    $j = Get-Content $SETTINGS -Raw -Encoding UTF8 | ConvertFrom-Json
    $cfgRoot = $j.server.root
    $javaPath = $j.server.javaPath
    $jar = $j.server.jarName
    $listenPort = $j.panel.port
  } catch { Write-Line "settings.json 解析失败，将以默认配置启动：$($_.Exception.Message)" 'Yellow' }
} else {
  Write-Line '尚无 data/settings.json，首次启动会自动生成' 'Gray'
}

function Test-Java($p) {
  if (-not $p) { return $null }
  if ($p -notmatch '[\\/]') {
    $c = Get-Command $p -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    return $null
  }
  if (Test-Path -LiteralPath $p) { return $p }
  return $null
}

$problems = @()
if ($cfgRoot) {
  if (-not (Test-Path -LiteralPath $cfgRoot)) { $problems += "服务端目录不存在：$cfgRoot" }
  elseif ($jar -and -not (Test-Path -LiteralPath (Join-Path $cfgRoot $jar))) { $problems += "Jar 不存在：$(Join-Path $cfgRoot $jar)（可先把服务端文件放入，或用「完全托管命令」）" }
} else { $problems += '尚未配置服务端目录：登录后到「设置 → 服务端」填写，或启动前设 MCSLITE_ROOT' }

if ($javaPath) {
  $jp = Test-Java $javaPath
  if (-not $jp) { $problems += "Java 路径无效：$javaPath（在「设置」里改成绝对路径，如 C:\Program Files\Java\jdk-25\bin\java.exe）" }
  else { Write-Line "Java 可用：$jp" }
}

if ($CheckOnly) {
  if ($problems.Count) { Write-Line '体检发现问题：' 'Yellow'; $problems | ForEach-Object { Write-Host "  · $_" -ForegroundColor Yellow } }
  else { Write-Line '体检通过 ✔' 'Green' }
  # 注意：不能用三元 `? :` —— 那是 PowerShell 7 语法，Server 2016 自带的 PS 5.1 会直接解析失败
  if ($problems.Count -eq 0) { exit 0 } else { exit 1 }
}
foreach ($p in $problems) { Write-Line $p 'Yellow' }

# ——— 3. 端口占用检测（比等 Node 抛 EADDRINUSE 更直观）———
$effPort = if ($env:MCSLITE_PORT) { [int]$env:MCSLITE_PORT } else { $listenPort }
$listener = $null
try { $listener = Get-NetTCPConnection -LocalPort $effPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 } catch { }
if ($listener) {
  $who = try { (Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue).ProcessName } catch { '?' }
  Write-Line "端口 $effPort 已被 PID $($listener.OwningProcess)（$who）占用 —— 面板可能已在运行；若确需重跑请改 data/settings.json 的 panel.port" 'Red'
  exit 4
}

# ——— 4. 启动 + 崩溃退避重启 ———
$LOGDIR = Join-Path $BASE 'data\logs'
if (-not (Test-Path $LOGDIR)) { New-Item -ItemType Directory -Path $LOGDIR -Force | Out-Null }
$LOG = Join-Path $LOGDIR 'panel.log'
$backoff = @(2000, 5000, 15000, 60000)
$fail = 0
Write-Line "启动面板：http://127.0.0.1:$effPort/ （堆上限 ${HeapMB}MB）" 'Green'

while ($true) {
  $t0 = Get-Date
  # 关键：node 的 stderr 是正常输出通道（面板的 console.error 都走那儿）。
  # 外层 $ErrorActionPreference='Stop' 会把 stderr 行判成 NativeCommandError 并终止脚本 ——
  # 于是"面板出错"恰好导致"看门狗一起死掉"，自动重启形同虚设。这一段单独放宽。
  $prevEAP = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  & node --max-old-space-size=$HeapMB $ENTRY 2>&1 | ForEach-Object {
    $line = "$_"
    Write-Host $line
    try { Add-Content -LiteralPath $LOG -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $line" -Encoding UTF8 -ErrorAction SilentlyContinue } catch { }
  }
  $code = $LASTEXITCODE
  $ErrorActionPreference = $prevEAP
  $ran = ((Get-Date) - $t0).TotalSeconds
  if ($code -eq 0) { Write-Line '面板正常退出' 'Green'; break }
  # 存活超过 3 分钟说明不是启动即崩，退避计数归零
  if ($ran -gt 180) { $fail = 0 }
  $wait = $backoff[[Math]::Min($fail, $backoff.Count - 1)]
  $fail++
  if ($fail -gt 12) { Write-Line "连续失败 $fail 次，放弃自动重启（请查看 $LOG）" 'Red'; break }
  Write-Line "面板异常退出 code=$code（本次存活 $([int]$ran)s），$([int]($wait/1000))s 后第 $fail 次重启…" 'Yellow'
  Add-Content -LiteralPath $LOG -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') EXIT code=$code fail=$fail" -Encoding UTF8
  Start-Sleep -Milliseconds $wait
}
