<#
.SYNOPSIS
  MCSLite 安装/自检脚本（幂等，可重复执行）
.DESCRIPTION
  1) 体检 Node / Java / 端口 / 防火墙
  2) 建目录骨架（data、instance、logs）
  3) 可选：构建前端 web/dist（-BuildWeb）
  4) 可选：注册开机自启计划任务（-RegisterTask）
  5) 输出下一步操作指引
.NOTES
  仅用 PowerShell 5.1 语法，Windows Server 2016 自带版本可直接运行。
#>
[CmdletBinding()]
param(
  [switch]$BuildWeb,
  [switch]$RegisterTask,
  [string]$TaskName = 'MCSLite-Panel',
  [string]$JavaPath,
  [string]$ServerRoot,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$BASE = Split-Path -Parent $PSScriptRoot
function Out-Step($m) { Write-Host "  → $m" -ForegroundColor DarkGray }
function Out-Ok($m)   { Write-Host "[OK] $m" -ForegroundColor Green }
function Out-Warn($m) { Write-Host "[!!] $m" -ForegroundColor Yellow }
function Out-Bad($m)  { Write-Host "[XX] $m" -ForegroundColor Red }

Write-Host ''
Write-Host '════ MCSLite 安装自检 ════' -ForegroundColor Cyan
Write-Host " 安装位置：$BASE"
Write-Host ''

# ——— 1. Node ———
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Out-Bad '未找到 Node.js。请装 Node 20/22/24 x64 LTS，安装时勾选 Add to PATH。'; exit 3 }
$nv = & node -p 'process.versions.node'
$nmaj = [int](($nv -split '\.')[0])
if ($nmaj -lt 20) { Out-Bad "Node $nv 过老（需 ≥20）。当前：$($node.Source)" } else { Out-Ok "Node.js $nv" }
& node -e "try{require('node:sqlite');process.exit(0)}catch(e){process.exit(1)}"
if ($LASTEXITCODE -eq 0) { Out-Ok '内置 node:sqlite 可用（操作日志走 SQLite 单文件，零依赖）' }
else { Out-Warn 'node:sqlite 不可用（需 Node ≥22.5）→ 操作日志自动降级 JSONL，功能不受影响' }
& node -e "const d=new TextDecoder('gbk');process.exit(d.decode(Buffer.from([0xd6,0xd0,0xce,0xc4]))==='中文'?0:1)"
if ($LASTEXITCODE -eq 0) { Out-Ok 'full-ICU 可用（GBK 中文日志可正确解码）' } else { Out-Warn 'ICU 精简版，中文 GBK 日志可能乱码：请换官方完整安装包' }

# ——— 2. Java ———
$foundJava = $null
if ($JavaPath -and (Test-Path -LiteralPath $JavaPath)) { $foundJava = $JavaPath }
else {
  $cmd = Get-Command java -ErrorAction SilentlyContinue
  if ($cmd) { $foundJava = $cmd.Source }
  else {
    foreach ($hint in @('C:\Program Files\Java\*\bin\java.exe', 'C:\Program Files\Microsoft\*\jdk*\bin\java.exe', 'C:\Eclipse Adoptium\*\bin\java.exe', 'G:\Java\*\bin\java.exe')) {
      $hit = Get-ChildItem -Path $hint -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($hit) { $foundJava = $hit.FullName; break }
    }
  }
}
if ($foundJava) {
  # java -version 输出走 stderr；$ErrorActionPreference='Stop' 下会被判成终止错误打断脚本
  $prevEAP = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $verRaw = (& "$foundJava" -version 2>&1 | Out-String)
  $ErrorActionPreference = $prevEAP
  $ver = (($verRaw -split "`n") | Select-Object -First 1)
  $maj = 0
  $m = [regex]::Match($verRaw, 'version\s+"(\d+)(?:\.(\d+))?')
  if ($m.Success) { $maj = [int]$m.Groups[1].Value; if ($maj -eq 1 -and $m.Groups[2].Success) { $maj = [int]$m.Groups[2].Value } }
  Out-Ok "Java：$foundJava"
  Out-Step "$ver"
  if ($maj -gt 0 -and $maj -lt 17) {
    Out-Warn "PATH 上的 java 是 $maj，而 MC 1.18+ 需 Java 17+、1.20.5+ 需 21+；面板里请填高版本 JDK 的绝对路径（deploy.ps1 会自动挑版本最高的候选）"
  }
} else { Out-Warn '未自动找到 java.exe —— 登录面板后在「设置 → 服务端」手动填写绝对路径' }

# ——— 3. 目录骨架 ———
foreach ($d in @('data', 'data\logs', 'instance', 'web\dist')) {
  $p = Join-Path $BASE $d
  if (-not (Test-Path -LiteralPath $p)) { New-Item -ItemType Directory -Path $p -Force | Out-Null; Out-Step "创建 $d" }
}
Out-Ok '目录就绪'

# ——— 4. 后端依赖（应为零） ———
$depCount = 0
$pkgPath = Join-Path $BASE 'package.json'
if (Test-Path -LiteralPath $pkgPath) {
  $pkg = Get-Content -LiteralPath $pkgPath -Raw | ConvertFrom-Json
  $depCount = (@($pkg.dependencies.PSObject.Properties).Count)
}
if ($depCount -eq 0) { Out-Ok '后端零第三方依赖：无需 npm install，无 node_modules，无原生编译链' }
else { Out-Step "后端有 $depCount 个依赖，执行 npm install"; Push-Location $BASE; & npm install --omit=dev; Pop-Location }

# ——— 5. 前端构建 ———
if ($BuildWeb) {
  $web = Join-Path $BASE 'web'
  if (-not (Test-Path -LiteralPath $web)) { Out-Bad 'web 目录不存在'; exit 3 }
  Out-Step '安装前端构建依赖（仅构建期需要，产物是纯静态文件）'
  Push-Location $web
  & npm install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { Pop-Location; Out-Bad 'npm install 失败（检查网络或换镜像：npm config set registry https://registry.npmmirror.com）'; exit 4 }
  Out-Step '构建 web/dist'
  & npm run build
  $bc = $LASTEXITCODE
  Pop-Location
  if ($bc -ne 0) { Out-Bad '前端构建失败'; exit 5 } else { Out-Ok 'web/dist 已生成' }
  Out-Warn '构建后 web\node_modules（约 200MB）即可删除，只保留 web\dist —— 面板运行期不需要它'
} else {
  if (-not (Test-Path -LiteralPath (Join-Path $BASE 'web\dist\index.html'))) {
    Out-Warn 'web\dist 尚未构建：面板能启动，但界面不可用。执行 `powershell -File scripts\install.ps1 -BuildWeb`'
  } else { Out-Ok 'web/dist 已就绪' }
}

# ——— 6. 写初始配置（不覆盖已有） ———
$SETTINGS = Join-Path $BASE 'data\settings.json'
if ((-not (Test-Path -LiteralPath $SETTINGS)) -or $Force) {
  $root = if ($ServerRoot) { $ServerRoot } else { Join-Path $BASE 'instance' }
  $cfg = @{
    version = 1
    panel   = @{ host = '127.0.0.1'; port = 8787; trustProxy = $true; serveStatic = $true }
    server  = @{ root = $root; javaPath = $(if ($foundJava) { $foundJava } else { 'java' }); jarName = 'server.jar'; launcher = 'jar'; autostart = $false; autoRestart = $true; consoleEncoding = 'auto'; maxLines = 3000 }
  } | ConvertTo-Json -Depth 6
  Set-Content -LiteralPath $SETTINGS -Value $cfg -Encoding UTF8
  Out-Ok "已生成 data/settings.json（实例目录：$root）"
} else { Out-Step '保留现有 data/settings.json（-Force 可覆盖）' }

# ——— 7. 防火墙 / 端口 ———
try {
  $fw = Get-NetFirewallProfile -ErrorAction SilentlyContinue | Where-Object { $_.Enabled }
  if ($fw) {
    Out-Step "防火墙已启用（$($fw.Name -join ', ')）。只监听 127.0.0.1 无需开板端口；对外请走 Nginx + 仅放行 443"
    $game = Get-NetFirewallRule -DisplayName 'Minecraft Server*' -ErrorAction SilentlyContinue
    if (-not $game) { Out-Warn '尚未放行游戏端口：`New-NetFirewallRule -DisplayName "Minecraft Server" -Direction Inbound -Protocol TCP -LocalPort 25565 -Action Allow`' }
  }
} catch { Out-Step '跳过防火墙检查（模块不可用）' }

# ——— 8. 计划任务（开机自启） ———
if ($RegisterTask) {
  $ps = Join-Path $BASE 'scripts\start.ps1'
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$ps`"" -WorkingDirectory $BASE
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -MultipleInstances IgnoreNew
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($existing) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
  Register-ScheduledTask -TaskName $TaskName -Action $action -Settings $settings -Trigger $trigger -Principal $principal -Description 'MCSLite Minecraft 管理面板' | Out-Null
  Out-Ok "已注册开机自启计划任务：$TaskName（SYSTEM 账户，含崩溃重启）"
  Out-Warn '以 SYSTEM 运行时 java 无交互桌面；面板以管道驱动 stdin/stdout，恰好不需要桌面 —— 这也是不用 node-pty 的原因之一'
}

Write-Host ''
Write-Host '════ 下一步 ════' -ForegroundColor Cyan
Write-Host '  1. 双击 scripts\start.bat（或 powershell -File scripts\start.ps1）'
Write-Host '  2. 记下控制台打印的初始密码，浏览器开 http://127.0.0.1:8787/ 登录并改密'
Write-Host '  3. 把 NeoForge 服务端文件放入实例目录，在「设置 → 服务端」确认 Java 路径与 Jar 名'
Write-Host '  4. 对外访问：按 nginx\mcslite.conf 配反向代理（只暴露 443）'
Write-Host ''
