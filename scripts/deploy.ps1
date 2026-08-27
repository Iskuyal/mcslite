<#
.SYNOPSIS
  MCSLite 一键部署：把整个文件夹拷到目标机 → 跑这一个脚本就能用。
.DESCRIPTION
  按顺序做六件事，全部幂等（可反复执行，不会破坏已有配置）：
    1) 运行时体检（Node / node:sqlite / full-ICU GBK / Java）
    2) 前端产物检查：web\dist 已随仓库分发，正常无需构建；缺失且有 npm 时自动构建
    3) 建 data\ 目录骨架
    4) 首次运行时探测服务端实例目录（找 run.bat / server.properties），并写入配置
    5) 可选：注册开机自启计划任务（-RegisterTask）
    6) 启动面板并做健康检查，最后打印访问地址与初始密码
.PARAMETER Root
  直接指定 Minecraft 服务端目录（跳过探测）。
.PARAMETER Java
  指定 java.exe 绝对路径。
.PARAMETER Password
  首次启动时直接指定面板密码（否则随机生成并打印一次）。
.PARAMETER RegisterTask
  注册开机自启计划任务（并以后台方式启动，不在本窗口运行）。
.PARAMETER NoRun
  只部署不启动。
.PARAMETER CheckOnly
  只体检，不改任何文件。
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy.ps1
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy.ps1 -Root 'G:\服务端\NeoForge' -RegisterTask
#>
[CmdletBinding()]
param(
  [string]$Root,
  [string]$Java,
  [string]$Password,
  [switch]$RegisterTask,
  [switch]$NoBuild,
  [switch]$NoRun,
  [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
$BASE = Split-Path -Parent $PSScriptRoot
$TASK = 'MCSLite-Panel'

function Step($m) { Write-Host "`n── $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "   [OK] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "   [!!] $m" -ForegroundColor Yellow }
function Bad($m)  { Write-Host "   [XX] $m" -ForegroundColor Red; exit 1 }
function Info($m) { Write-Host "   · $m" -ForegroundColor DarkGray }

# 原生命令写 stderr 是常态（java -version 本身就输出到 stderr）。
# 在 $ErrorActionPreference='Stop' 下 PowerShell 5.1 会把 stderr 判成 NativeCommandError
# 并中断脚本 —— 实测这样会直接打断部署，也会让 start.ps1 的守护循环在面板报错那一刻崩掉。
# 所有外部调用一律走这个包装器。
function Invoke-Native([scriptblock]$Block) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $out = ''
  try {
    $out = (& $Block 2>&1 | Out-String)
    $code = $LASTEXITCODE
  } finally { $ErrorActionPreference = $prev }
  if ($null -eq $code) { $code = 0 }
  return [pscustomobject]@{ Out = "$out".Trim(); Code = [int]$code }
}

# "1.8.0_491" 要读成 8，否则会把古董 Java 当成新版本写进配置
function Java-Major([string]$Line) {
  $m = [regex]::Match($Line, 'version\s+"(\d+)(?:\.(\d+))?')
  if (-not $m.Success) { return 0 }
  $maj = [int]$m.Groups[1].Value
  if ($maj -eq 1 -and $m.Groups[2].Success) { $maj = [int]$m.Groups[2].Value }
  return $maj
}

Write-Host ''
Write-Host '══════════════════════════════════════════' -ForegroundColor Cyan
Write-Host ("   MCSLite 一键部署   " + (Get-Date -Format 'yyyy-MM-dd HH:mm')) -ForegroundColor Cyan
Write-Host '══════════════════════════════════════════' -ForegroundColor Cyan
Info "面板目录：$BASE"

# ————————————————— 1. 运行时体检 —————————————————
Step '1/6 运行时体检'
if (-not (Test-Path -LiteralPath (Join-Path $BASE 'server\index.js'))) { Bad "入口缺失：$BASE\server\index.js（拷贝的是完整目录吗？）" }
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Bad '未找到 Node.js。装 Node 22/24 x64 LTS，安装时勾选 "Add to PATH"，然后重跑本脚本' }

# 探测逻辑全在 scripts\probe-env.js 里，PS 只传一个文件路径 ——
# 因为 PowerShell 5.1 会把 `node -e '…("x")…'` 里的双引号吃掉，导致误判（实测踩过）。
$pv = Join-Path $BASE 'scripts\probe-env.js'
$pr = Invoke-Native { & node $pv }
$env2 = @{}
foreach ($line in ($pr.Out -split "`n")) {
  $t = $line.Trim()
  if ($t -match '^(\w+)=(.*)$') { $env2[$matches[1]] = $matches[2] }
}
if ($env2.Count -eq 0) { Bad "环境探测无输出（exit=$($pr.Code)）：$($pr.Out)" }

$major = 0
if ($env2['major']) { $major = [int]$env2['major'] }
if ($major -lt 20) { Bad "Node $($env2['node']) 过老或缺失（需 >= 20）。装 Node 22/24 x64 LTS 后重跑" }
Ok "Node.js $($env2['node'])  $($node.Source)  [$($env2['platform']) $($env2['arch'])]"

if ($env2['sqlite'] -eq 'yes') { Ok 'node:sqlite 可用（审计日志走内置 SQLite）' }
else { Warn "node:sqlite 不可用（需 Node >= 22.5）→ 审计日志自动降级 JSONL，功能不受影响$(if ($env2['sqlite_err']) { "  [" + $env2['sqlite_err'] + "]" })" }

if ($env2['icu_gbk'] -eq 'yes') { Ok 'full-ICU 可用（中文 GBK 日志可正确解码）' }
else { Warn "ICU 不完整（icu_small=$($env2['icu_small'])）：中文日志可能乱码，建议换官方完整 MSI 安装包" }
if ($env2['gbk_encode'] -ne 'yes') { Info 'Node 无 GBK 编码器（只影响「按 GBK 写文件」，面板会明确拒绝而非偷偷写 UTF-8）' }
if ($env2['statfs'] -ne 'yes') { Warn 'fs.statfsSync 缺失 → 磁盘余量指标不可用（需 Node >= 19）' }

# Java 探测：PATH 上的 java 很可能是古董（Oracle 安装器会往 PATH 塞 javapath，实测是 1.8），
# 而 MC 1.18+ 要 Java 17+、1.20.5+ 要 21+。所以要「收集所有候选 → 各读版本 → 选最新」，
# 而不是拿第一个找到的就用。
$javaFound = $null
$javaNote = ''
if ($Java) {
  if (-not (Test-Path -LiteralPath $Java)) { Bad "-Java 指向的文件不存在：$Java" }
  $javaFound = $Java
  $javaNote = '命令行 -Java 指定'
} else {
  $cands = @()
  $cmd = Get-Command java -ErrorAction SilentlyContinue
  if ($cmd) { $cands += $cmd.Source }
  $hints = @('C:\Program Files\Java\*\bin\java.exe','C:\Program Files\Microsoft\*\jdk*\bin\java.exe',
             'C:\Program Files\Eclipse Adoptium\*\bin\java.exe','C:\Program Files\Zulu\*\bin\java.exe',
             'C:\Program Files\Amazon Corretto\*\bin\java.exe','G:\Java\*\bin\java.exe','D:\Java\*\bin\java.exe')
  foreach ($h in $hints) {
    foreach ($hit in @(Get-ChildItem -Path $h -ErrorAction SilentlyContinue)) { $cands += $hit.FullName }
  }
  # 若面板旁边就摆着 run.bat，优先照抄它里面写的 java 路径（最贴合该实例的真实需求）
  $cands = @($cands | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -Unique)
  $best = $null; $bestMaj = 0; $bestLine = ''
  foreach ($c in $cands) {
    $jp = Invoke-Native { & node $pv --java $c }
    $jv = @{}
    foreach ($line in ($jp.Out -split "`n")) { if ($line.Trim() -match '^(\w+)=(.*)$') { $jv[$matches[1]] = $matches[2] } }
    $maj = 0
    if ($jv['java_major']) { $maj = [int]$jv['java_major'] }
    if ($maj -gt $bestMaj) { $bestMaj = $maj; $best = $c; $bestLine = $jv['java_line'] }
  }
  if ($best) {
    $javaFound = $best
    $javaNote = "候选 $($cands.Count) 个中版本最高（Java $bestMaj）"
    $javaLine = $bestLine
    if ($bestMaj -lt 17) { Warn "本机只找到 Java $bestMaj：MC 1.18+ 需 17+、1.20.5+ 需 21+。请装新版 JDK 或用 -Java 指定绝对路径" }
  } elseif ($cands.Count -gt 0) {
    # 读不到任何版本时宁可留空，也不要随手挑第一个 —— PATH 里排前的常常是 Oracle
    # 的 java8path 兼容壳，拿它跑 NeoForge 会直接起不来（实测就被这样选中过一次）。
    Warn "找到 $($cands.Count) 个 java.exe 但都读不到版本，不自动采用；请用 -Java 指定绝对路径"
  }
}
if ($javaFound) {
  Ok "Java：$javaFound   （$javaNote）"
  if ($javaLine) { Info "$javaLine" }
} else { Warn '未自动找到 java.exe —— 部署完在「设置 → 服务端」手填绝对路径即可' }

if ($CheckOnly) { Write-Host ''; Ok '体检完成（-CheckOnly，未做任何改动）'; exit 0 }

# ————————————————— 2. 前端产物 —————————————————
Step '2/6 前端资源'
$dist = Join-Path $BASE 'web\dist\index.html'
if (Test-Path -LiteralPath $dist) {
  $assetCount = @(Get-ChildItem (Join-Path $BASE 'web\dist') -Recurse -File -ErrorAction SilentlyContinue).Count
  Ok "web\dist 已就绪（$assetCount 个文件，随仓库分发，无需构建）"
}
else {
  if ($NoBuild) { Bad 'web\dist 缺失且指定了 -NoBuild —— 请带上 web\dist 目录或去掉 -NoBuild' }
  $npm = Get-Command npm -ErrorAction SilentlyContinue
  if (-not $npm) { Bad 'web\dist 缺失且没有 npm：请重新完整拷贝目录（含 web\dist），或安装 Node 后重跑以自动构建' }
  Warn 'web\dist 缺失，开始构建前端（需联网装构建依赖，约 1-3 分钟）'
  Push-Location (Join-Path $BASE 'web')
  $i = Invoke-Native { & npm install --no-audit --no-fund }
  if ($i.Code -ne 0) { Pop-Location; Bad "npm install 失败(exit=$($i.Code))：检查网络，或先执行 npm config set registry https://registry.npmmirror.com" }
  $b = Invoke-Native { & npm run build }
  Pop-Location
  if ($b.Code -ne 0 -or -not (Test-Path -LiteralPath $dist)) { Bad "前端构建失败(exit=$($b.Code))，见上方 vite 输出" }
  Ok 'web\dist 构建完成（构建完可删除 web\node_modules，运行期不需要）'
}

# ————————————————— 3. 数据目录 —————————————————
Step '3/6 数据目录'
foreach ($d in @('data', 'data\logs')) {
  $p = Join-Path $BASE ($d -replace '/', '\')
  if (-not (Test-Path -LiteralPath $p)) { New-Item -ItemType Directory -Path $p -Force | Out-Null; Info "创建 $d" }
}
Ok "data\ 就绪：$((Join-Path $BASE 'data'))"
$hasSettings = Test-Path -LiteralPath (Join-Path $BASE 'data\settings.json')
$hasCred = Test-Path -LiteralPath (Join-Path $BASE 'data\credentials.json')
if ($hasSettings) { Info '已存在 data\settings.json → 保留现有配置（本脚本不会覆盖）' }
if ($hasCred) { Info '已存在 data\credentials.json → 保留现有登录密码' }

# ————————————————— 4. 服务端实例目录探测 —————————————————
Step '4/6 服务端实例目录'
$detected = $null
if ($Root) {
  if (-not (Test-Path -LiteralPath $Root)) { Bad "-Root 指向的目录不存在：$Root" }
  $detected = $Root
  Info "使用命令行指定的 -Root"
}
elseif ($hasSettings) {
  try {
    $cur = (Get-Content -LiteralPath (Join-Path $BASE 'data\settings.json') -Raw | ConvertFrom-Json).server.root
    if ($cur -and (Test-Path -LiteralPath $cur)) { $detected = $cur; Info "沿用已有配置：$cur" }
  } catch { Info 'settings.json 读取失败，稍后在界面里配置' }
}
else {
  # 只在「确定是 Minecraft 服务端」的地方探测：必须有 server.properties 或 run.bat
  $cands = @()
  $parent = Split-Path -Parent $BASE
  foreach ($probe in @($BASE, $parent)) {
    if (Test-Path -LiteralPath (Join-Path $probe 'server.properties')) { $cands += $probe }
  }
  foreach ($sib in @(Get-ChildItem -LiteralPath $parent -Directory -ErrorAction SilentlyContinue)) {
    if ($sib.FullName -eq $BASE) { continue }
    if ((Test-Path -LiteralPath (Join-Path $sib.FullName 'server.properties')) -or (Test-Path -LiteralPath (Join-Path $sib.FullName 'run.bat'))) { $cands += $sib.FullName }
  }
  $cands = @($cands | Select-Object -Unique)
  if ($cands.Count -eq 1) { $detected = $cands[0]; Info "探测到唯一候选：$detected" }
  elseif ($cands.Count -gt 1) {
    Warn "发现 $($cands.Count) 个候选目录，不自动写入，请用 -Root 指定其一："
    foreach ($c in $cands) { Write-Host "     · $c" -ForegroundColor Yellow }
  }
  else { Info '附近没发现 Minecraft 服务端目录（需要 server.properties 或 run.bat）' }
}

# 写一份最小 settings.json（只在没有时写，且不覆盖）
if (-not $hasSettings) {
  $cfg = [ordered]@{
    version = 1
    panel   = [ordered]@{ host = '127.0.0.1'; port = 8787; trustProxy = $true; serveStatic = $true }
    monitor = [ordered]@{ intervalMs = 3000; history = 900; diskSampler = 'auto'; samplerIdleMs = 120000 }
  }
  if ($detected) {
    $cfg.server = [ordered]@{ root = $detected; javaPath = $(if ($javaFound) { $javaFound } else { 'java' }); jarName = 'server.jar'; launcher = 'jar'; autostart = $false; autoRestart = $true; consoleEncoding = 'auto'; maxLines = 3000; stopOnExit = $false }
  }
  $j = $cfg | ConvertTo-Json -Depth 6
  # UTF-8 带 BOM：路径里可能有中文，PowerShell 5.1 读无 BOM 文件会按 GBK 解码
  [IO.File]::WriteAllText((Join-Path $BASE 'data\settings.json'), $j, (New-Object Text.UTF8Encoding $true))
  Ok '已生成 data\settings.json'
  if ($detected) { Info "服务端目录：$detected" } else { Info '服务端目录留空，登录界面后在「设置 → 服务端」填写' }
}

# ————————————————— 5. 计划任务（可选） —————————————————
Step '5/6 开机自启'
if ($RegisterTask) {
  $ps1 = Join-Path $BASE 'scripts\start.ps1'
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$ps1`"" -WorkingDirectory $BASE
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -MultipleInstances IgnoreNew
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $old = Get-ScheduledTask -TaskName $TASK -ErrorAction SilentlyContinue
  if ($old) { Unregister-ScheduledTask -TaskName $TASK -Confirm:$false }
  Register-ScheduledTask -TaskName $TASK -Action $action -Settings $settings -Trigger $trigger -Principal $principal -Description 'MCSLite Minecraft 管理面板' | Out-Null
  Ok "已注册计划任务 $TASK（SYSTEM，开机自启 + 失败重启）"
} else {
  Info '未注册计划任务（需要开机自启请加 -RegisterTask，或事后跑 scripts\install.ps1 -RegisterTask）'
}

# ————————————————— 6. 启动 —————————————————
Step '6/6 启动面板'
if ($NoRun) { Info '-NoRun：跳过启动'; Write-Host ''; Ok '部署完成'; exit 0 }

if ($RegisterTask) {
  Start-ScheduledTask -TaskName $TASK
  Info '已通过计划任务后台启动'
}
else {
  $portHint = 8787
  try { $portHint = (Get-Content -LiteralPath (Join-Path $BASE 'data\settings.json') -Raw | ConvertFrom-Json).panel.port } catch { }
  $env:MCSLITE_PORT = "$portHint"
  if ($Password) { $env:MCSLITE_PASSWORD = $Password }
  Info "前台启动（关闭本窗口即停止面板；要常驻请用 -RegisterTask）"
  Write-Host ''
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $BASE 'scripts\start.ps1')
  exit $LASTEXITCODE
}

# 后台模式：等健康检查
$port = 8787
try { $port = (Get-Content -LiteralPath (Join-Path $BASE 'data\settings.json') -Raw | ConvertFrom-Json).panel.port } catch { }
$ready = $false
for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Milliseconds 800
  try {
    $h = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 3
    if ($h.ok) { $ready = $true; break }
  } catch { }
}
if (-not $ready) { Bad "面板 16 秒内没起来，查看 data\logs\panel.log" }
Ok "健康检查通过（state=$($h.state)，RSS $([math]::Round($h.rss/1MB,1))MB）"

Write-Host ''
Write-Host '════════ 部署完成 ════════' -ForegroundColor Green
Write-Host "  地址：http://127.0.0.1:$port/   （对外请访问 Nginx 的 443，见 docs\DEPLOYMENT.md 阶段 6）"
Write-Host "  密码：见 data\credentials.json 对应的初始密码（首次启动时打印在 data\logs\panel.log）"
if (-not $hasCred) {
  try {
    $log = Get-Content -LiteralPath (Join-Path $BASE 'data\logs\panel.log') -Raw -ErrorAction SilentlyContinue
    if ($log -match '初始密码\s+(\S+)') { Write-Host "         从日志读到初始密码：$($matches[1])  ← 登录后请立即修改" -ForegroundColor Yellow }
  } catch { }
}
Write-Host "  下一步：登录 → 设置 → 服务端 → 「从启动脚本导入」run.bat → 保存 → 仪表盘点「启动」"
Write-Host ''
