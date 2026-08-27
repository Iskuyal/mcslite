<#
.SYNOPSIS
  MCSLite 一键更新面板代码，数据与游戏世界零影响，失败自动回滚。
.DESCRIPTION
  更新流程（全程不动 data\ 与 Minecraft 实例目录）：
    1) 记录当前版本，备份 data\ 与当前面板代码到 .rollback\<时间戳>\
    2) 取新代码：git 仓库 → git pull；给了 -From <新目录> → robocopy 镜像替换（保留 data 等）
    3) 校验交付脚本编码不变量（.ps1 必须仍是 UTF-8 BOM + CRLF）
    4) 可选跑测试（-Test 单测 / -FullTest 再加端到端）
    5) 重启面板并健康检查；不健康则自动回滚到第 1 步的备份
.PARAMETER From
  新版本目录（例如解压 GitHub ZIP 后的目录）。不给且本地是 git 仓库时执行 git pull。
.PARAMETER StopServer
  更新前通过面板 API 优雅停止 Minecraft（会存档）。不给则只重启面板，
  游戏进程继续运行但会脱离面板管理（面板重启后需要重新启动服务端才能接管）。
.PARAMETER KeepServer
  与 StopServer 相反：明确保留游戏进程（默认行为，仅作可读性开关）。
.PARAMETER Test
  更新后运行 42 项纯函数单测（离线、几秒完成）。
.PARAMETER FullTest
  额外运行 44 项端到端回归（会另起一个临时面板实例与 mock 服务端，不动你的配置）。
.PARAMETER NoRestart
  只更新文件，不重启面板。
.PARAMETER Rollback
  不做更新，直接把代码回滚到最近一次 .rollback 备份。
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\update.ps1 -Test
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\update.ps1 -From 'G:\dl\mcslite-main' -StopServer
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\update.ps1 -Rollback
#>
[CmdletBinding()]
param(
  [string]$From,
  [switch]$StopServer,
  [switch]$KeepServer,
  [switch]$Test,
  [switch]$FullTest,
  [switch]$NoRestart,
  [switch]$Rollback,
  [string]$Password
)

$ErrorActionPreference = 'Stop'
$BASE = Split-Path -Parent $PSScriptRoot
$ROLL = Join-Path $BASE '.rollback'
$TASK = 'MCSLite-Panel'

function Step($m) { Write-Host "`n── $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "   [OK] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "   [!!] $m" -ForegroundColor Yellow }
function Info($m) { Write-Host "   · $m" -ForegroundColor DarkGray }
function Bad($m)  { Write-Host "   [XX] $m" -ForegroundColor Red; Write-Host ''; exit 1 }

# 外部命令（git/node/robocopy）写 stderr 是常态；$ErrorActionPreference='Stop' 下
# PowerShell 5.1 会把 stderr 判成 terminating error，实测会打断脚本。统一走包装器。
function Invoke-Native([scriptblock]$Block) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $out = ''; $code = 0
  try { $out = (& $Block 2>&1 | Out-String); $code = $LASTEXITCODE }
  finally { $ErrorActionPreference = $prev }
  if ($null -eq $code) { $code = 0 }
  return [pscustomobject]@{ Out = "$out".Trim(); Code = [int]$code }
}

function Read-Settings {
  $f = Join-Path $BASE 'data\settings.json'
  if (Test-Path -LiteralPath $f) { try { return Get-Content -LiteralPath $f -Raw | ConvertFrom-Json } catch { return $null } }
  return $null
}
function Panel-Version {
  try { return ((Get-Content -LiteralPath (Join-Path $BASE 'package.json') -Raw | ConvertFrom-Json).version) } catch { return '?' }
}
function Git-Describe {
  $r = Invoke-Native { & git -C $BASE rev-parse --short HEAD }
  if ($r.Code -eq 0 -and $r.Out) { return ($r.Out -split "`n" | Select-Object -First 1) }
  return $null
}
function Port-Owner([int]$Port) {
  try {
    $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($c) { return $c.OwningProcess }
  } catch { }
  return 0
}
# 只有当监听者确实是「本目录的面板进程」时才允许停止它。
# 否则在临时副本里跑这个脚本，会因为默认端口相同而把生产面板杀掉。
function Test-OwnerIsMine([int]$Pid2) {
  if ($Pid2 -le 0) { return $false }
  try {
    $p = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$Pid2" -ErrorAction SilentlyContinue
    if (-not $p) { return $false }
    $cl = "$($p.CommandLine)"
    if ($cl -like "*$BASE*") { return $true }
    Warn "端口持有者 PID=$Pid2 的命令行不指向本目录，拒绝停止它：$cl"
    return $false
  } catch { return $false }
}

Write-Host ''
Write-Host '════ MCSLite 更新 ════' -ForegroundColor Cyan
Info "面板目录：$BASE"

$cfg = Read-Settings
$port = 8787
if ($cfg -and $cfg.panel) { $port = [int]$cfg.panel.port }
$oldVer = Panel-Version
$oldSha = Git-Describe
Info "当前版本：v$oldVer$(if ($oldSha) { "  commit $oldSha" })"
Info "监听端口：$port"

$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$snap = Join-Path $ROLL $ts

function Stop-Panel([int]$Port) {
  Info '停止面板…'
  try { $t = Get-ScheduledTask -TaskName $TASK -ErrorAction SilentlyContinue; if ($t) { Stop-ScheduledTask -TaskName $TASK } } catch { }
  $owner = Port-Owner -Port $Port
  if ($owner -gt 0) {
    if (Test-OwnerIsMine -Pid2 $owner) {
      try { Stop-Process -Id $owner -Force -ErrorAction Stop; Info "已结束面板进程 PID=$owner" } catch { Warn "结束 PID=$owner 失败：$($_.Exception.Message)" }
    } else {
      Warn '端口被别的面板实例占用，本次不结束它；请确认是否有两份面板在跑'
    }
  } else { Info '面板当前未运行' }
  Start-Sleep -Milliseconds 700
}

function Start-Panel([int]$Port) {
  Info '启动面板…'
  $t = $null
  try { $t = Get-ScheduledTask -TaskName $TASK -ErrorAction SilentlyContinue } catch { }
  if ($t) { Start-ScheduledTask -TaskName $TASK }
  else {
    Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-WindowStyle','Hidden','-ExecutionPolicy','Bypass','-File',(Join-Path $BASE 'scripts\start.ps1') -WorkingDirectory $BASE | Out-Null
  }
  $wantData = (Join-Path $BASE 'data')
  for ($i = 0; $i -lt 25; $i++) {
    Start-Sleep -Milliseconds 800
    try {
      $h = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 3
      if (-not $h.ok) { continue }
      # 身份核验：回答我的必须是我刚启动的那个实例（比 data 目录）。
      # 只看 ok 会被同机另一个面板冒领 —— 那样「不健康就自动回滚」就永远不触发。
      if ($h.data -and ($h.data.TrimEnd('\') -ine $wantData.TrimEnd('\'))) {
        Warn "端口 $Port 上的面板 data=$($h.data)，不是本目录 $wantData —— 有另一个实例在应答，判定为不健康"
        return $false
      }
      if (-not $h.data) { Warn '该面板版本未上报 data 身份字段，跳过身份核验（建议升级面板）' }
      Ok "健康检查通过：pid=$($h.pid)  data=$($h.data)  state=$($h.state)  RSS=$([math]::Round($h.rss/1MB,1))MB  uptime=$($h.uptime)s"
      return $true
    } catch { }
  }
  return $false
}

function Restore-Code([string]$SnapDir) {
  $codeDir = Join-Path $SnapDir 'code'
  if (-not (Test-Path -LiteralPath $codeDir)) { Bad "快照缺少 code：$codeDir" }
  # 反向镜像：把快照里的代码放回 BASE，同样排除 data / 依赖 / 回滚区，绝不碰数据与游戏文件
  & robocopy $codeDir $BASE /MIR /XD "$BASE\data" "$BASE\.git" "$BASE\.rollback" 'node_modules' /NFL /NDL /NJH /NJS /NP /R:1 /W:1 | Out-Null
  if ($LASTEXITCODE -ge 8) { Bad "robocopy 回滚失败 exit=$LASTEXITCODE" }
  Info '代码已按快照恢复'
}

# ————————————————— 回滚模式 —————————————————
if ($Rollback) {
  Step '回滚'
  if (-not (Test-Path -LiteralPath $ROLL)) { Bad "没有 $ROLL 目录，无从回滚" }
  $latest = @(Get-ChildItem -LiteralPath $ROLL -Directory | Sort-Object Name -Descending) | Select-Object -First 1
  if (-not $latest) { Bad '回滚目录为空' }
  Write-Host "   回滚到快照：$($latest.Name)"
  Stop-Panel -Port $port
  Restore-Code -SnapDir $latest.FullName
  $up = Start-Panel -Port $port
  if (-not $up) { Bad '回滚后面板未通过健康检查，查 data\logs\panel.log' }
  Ok "已回滚（回滚前版本 v$oldVer）"
  exit 0
}

# ————————————————— 1. 备份 —————————————————
Step '1/5 备份（数据 + 当前代码）'
New-Item -ItemType Directory -Path $ROLL -Force | Out-Null
New-Item -ItemType Directory -Path $snap -Force | Out-Null
$codeBak = Join-Path $snap 'code'
Invoke-Native { & robocopy $BASE $codeBak /MIR /XD "$BASE\data" "$BASE\.git" "$BASE\.rollback" 'node_modules' /XF '*.log' /NFL /NDL /NJH /NJS /NP /R:1 /W:1 } | Out-Null
if ($LASTEXITCODE -ge 8) { Bad "代码备份失败 exit=$LASTEXITCODE（未做任何改动）" }
Ok "已备份当前代码 → .rollback\$ts\code"

$dataSrc = Join-Path $BASE 'data'
if (Test-Path -LiteralPath $dataSrc) {
  Invoke-Native { & robocopy $dataSrc (Join-Path $snap 'data') /E /XD 'logs' /NFL /NDL /NJH /NJS /NP /R:1 /W:1 } | Out-Null
  if ($LASTEXITCODE -ge 8) { Warn "data\ 备份失败 exit=$LASTEXITCODE（代码仍可回滚，但配置备份缺失）" }
  else { Ok '已备份 data\（设置/凭据/审计，不含日志）' }
}
# 只保留最近 5 个快照，避免 .rollback 无限增长
$snapList = @(Get-ChildItem -LiteralPath $ROLL -Directory | Sort-Object Name -Descending)
if ($snapList.Count -gt 5) {
  foreach ($old in $snapList[5..($snapList.Count - 1)]) {
    try { Remove-Item -LiteralPath $old.FullName -Recurse -Force -ErrorAction Stop; Info "清理旧快照 $($old.Name)" } catch { }
  }
}

# ————————————————— 2. 停服（可选）——————————————————
Step '2/5 Minecraft 进程'
if ($StopServer) {
  $pwd2 = $Password
  if (-not $pwd2) {
    $secure = Read-Host "输入面板密码以优雅停止 Minecraft（回车跳过 = 只重启面板）" -AsSecureString
    if ($secure) { $pwd2 = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)) }
  }
  if ($pwd2) {
    try {
      $login = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/login" -Method Post -ContentType 'application/json; charset=utf-8' -Headers @{ origin = "http://127.0.0.1:$port" } -Body ([Text.Encoding]::UTF8.GetBytes((@{ username = $cfg.security.user; password = $pwd2 } | ConvertTo-Json))) -SessionVariable sess
      $r = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/server/stop" -Method Post -ContentType 'application/json' -Headers @{ origin = "http://127.0.0.1:$port" } -WebSession $sess -Body '{}'
      Ok "已请求优雅停止（存档中，graceful=$($r.graceful)）"
      for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Seconds 2
        $s = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/state" -WebSession $sess
        if (-not $s.server.running) { Ok "Minecraft 已退出（exit=$($s.server.lastExit.code)）"; break }
      }
    } catch { Warn "停止服务端失败：$($_.Exception.Message) —— 继续更新面板" }
  } else { Warn '未提供密码，跳过停服' }
} else {
  Warn '未指定 -StopServer：面板会重启，Java 游戏进程继续运行但会脱离面板管理。'
  Info  '更新完成后需在面板里重新点「启动」才能重新接管（或先手动结束旧 java）。'
  Info  '要彻底避免这种脱离，把「设置 → 服务端 → 面板退出时一并停止服务端」打开。'
}

# ————————————————— 3. 取新代码 —————————————————
Step '3/5 更新代码'
Stop-Panel -Port $port

$isGit = $false
try { & git -C $BASE rev-parse --is-inside-work-tree 2>$null | Out-Null; if ($LASTEXITCODE -eq 0) { $isGit = $true } } catch { }

if ($From) {
  $srcIndex = Join-Path $From 'server\index.js'
  if (-not (Test-Path -LiteralPath $srcIndex)) { Bad "-From 目录里没有 server\index.js，不像是 MCSLite 新版本：$From" }
  # 注意：robocopy 的返回值要看 $LASTEXITCODE（0-7 都算成功，>=8 才是错误）。
  # 把 stdout 捕获进变量再拿它比 8 是错的 —— PowerShell 会做数组过滤，永远不会触发。
  Invoke-Native { & robocopy $From $BASE /MIR /XD "$BASE\data" "$BASE\.git" "$BASE\.rollback" "$From\.git" "$From\.rollback" 'node_modules' /XF '*.log' /NFL /NDL /NJH /NJS /NP /R:1 /W:1 } | Out-Null
  if ($LASTEXITCODE -ge 8) { Bad "robocopy 更新失败 exit=$LASTEXITCODE" }
  Ok "已从 $From 镜像替换代码"
}
elseif ($isGit) {
  Info 'git pull --ff-only …'
  $before = Git-Describe
  $pull = Invoke-Native { & git -C $BASE pull --ff-only }
  foreach ($l in ($pull.Out -split "`n")) { if ($l.Trim()) { Write-Host "     $l" -ForegroundColor DarkGray } }
  if ($pull.Code -ne 0) {
    Warn 'git pull 失败（网络或分叉）。两条退路：'
    Write-Host '     1) 下载 ZIP 后：powershell -File scripts\update.ps1 -From <解压目录>'
    Write-Host '     2) 配好代理/SSH 再试（见 docs\DEPLOYMENT.md 附录 C）'
    Bad '更新中止（已备份，代码未改动）'
  }
  $after = Git-Describe
  if ($before -eq $after) { Ok "已是最新（commit $after）" } else { Ok "已更新：$before → $after" }
}
else {
  Bad '既不是 git 仓库也没给 -From：请用 -From <新版本目录>，或先 git clone'
}

$newVer = Panel-Version
$newSha = Git-Describe
Info "新版本：v$newVer$(if ($newSha) { "  commit $newSha" })"

# ————————————————— 4. 校验 —————————————————
Step '4/5 校验'
$fe = Join-Path $BASE 'scripts\fix-encoding.js'
if (Test-Path -LiteralPath $fe) {
  $chk = Invoke-Native { & node $fe --check }
  foreach ($l in ($chk.Out -split "`n")) { if ($l.Trim()) { Write-Host "     $l" -ForegroundColor DarkGray } }
  if ($chk.Code -ne 0) { Warn '交付脚本行尾/BOM 被改动，正在自动修复' ; Invoke-Native { & node $fe } | Out-Null }
}
if ($Test -or $FullTest) {
  Info '运行纯函数单测（42 项，离线）…'
  Push-Location $BASE
  $ut = Invoke-Native { & node test\unit.js }
  Write-Host "     $(($ut.Out -split "`n" | Select-Object -Last 1))"
  $u = $ut.Code
  if ($FullTest) {
    Info '运行端到端回归（44 项，会另起临时实例）…'
    $et = Invoke-Native { & node test\run.js }
    Write-Host "     $(($et.Out -split "`n" | Select-Object -Last 2) -join '  ')"
    if ($et.Code -ne 0) { Pop-Location; Bad '端到端回归失败，执行回滚： scripts\update.ps1 -Rollback' }
  }
  Pop-Location
  if ($u -ne 0) { Bad '单测失败，执行回滚： scripts\update.ps1 -Rollback' }
  Ok '测试通过'
} else {
  Info '未指定 -Test，跳过测试（建议至少加 -Test，几秒完成）'
}

# ————————————————— 5. 重启 + 健康检查 —————————————————
Step '5/5 重启面板'
if ($NoRestart) { Ok '代码已更新（-NoRestart：未重启面板）'; exit 0 }
$healthy = Start-Panel -Port $port
if (-not $healthy) {
  Warn '面板 20 秒内未通过健康检查，自动回滚到更新前版本'
  Stop-Panel -Port $port
  Restore-Code -SnapDir $snap
  $back = Start-Panel -Port $port
  if ($back) { Ok "已回滚并恢复服务（版本 v$oldVer）" } else { Bad "回滚后面板仍起不来，查 data\logs\panel.log" }
  Bad '本次更新失败（已自动回滚，无数据损失）'
}

Write-Host ''
Write-Host '════════ 更新完成 ════════' -ForegroundColor Green
Write-Host "  版本：v$oldVer → v$newVer$(if ($newSha) { "   commit $newSha" })"
Write-Host "  回滚点：.rollback\$ts（如需回退：powershell -File scripts\update.ps1 -Rollback）"
Write-Host "  地址：http://127.0.0.1:$port/"
if (-not $StopServer) { Write-Host '  提醒：未停服，Java 进程已脱离面板管理 —— 去仪表盘点「启动」重新接管' -ForegroundColor Yellow }
Write-Host ''
