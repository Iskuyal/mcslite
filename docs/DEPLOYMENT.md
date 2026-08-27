# MCSLite 完整部署流程（Windows Server 2016 / NeoForge 单实例）

从一台干净的服务器到「浏览器可管、开机自启、HTTPS 可达」的全流程。
全程**不需要 Docker、WSL2、MySQL、Redis、Visual Studio、node-gyp**。

> 时间预估：首装 25–40 分钟（含下载与前端构建）。
> 权限：安装 Node/Nginx/注册计划任务需要管理员；面板本体不需要。

---

## 阶段 0 · 规划（先填这张表，后面全是照它执行）

| 项 | 建议值 | 说明 |
|---|---|---|
| 面板安装目录 | `G:\MCSLite` | 路径含中文/空格都可以（已实测），但**别放系统盘根** |
| 服务端实例目录 | `G:\服务端\NeoForge` | 面板文件管理以此为唯一沙箱边界 |
| 面板监听 | `127.0.0.1:8787` | **只监听回环**，对外一律走 Nginx |
| 对外域名 | `mc.example.com` | 无域名就只用内网 IP + 自签证书 |
| Nginx 端口 | `443`（80 仅跳转） | 管理面绝不走明文 HTTP |
| 游戏端口 | `25565` | 与面板无关，但要单独放行防火墙 |
| 运行账户 | `SYSTEM`（计划任务） | 面板不需要桌面，见坑点第 1 条 |
| 备份目标 | `data\` + 世界目录 | 见阶段 8 |

端口矩阵：

| 端口 | 谁监听 | 暴露给谁 |
|---|---|---|
| 443 | Nginx | 公网/内网用户 |
| 8787 | MCSLite 面板 | **仅 127.0.0.1** |
| 25565/TCP | Minecraft | 玩家 |
| 25575/TCP | RCON（若启用） | **仅 127.0.0.1，绝不对外** |

---

## 阶段 1 · 安装运行时

### 1.1 Node.js（x64 MSI，别用 zip 版）

装 **Node 22.x 或 24.x LTS x64**。目标机已有 24.19.0 就跳过。

```powershell
# 校验（三项都该有输出）
node -v
npm -v
node -e "require('node:sqlite');console.log('node:sqlite OK')"
node -e "console.log(new TextDecoder('gbk').decode(Buffer.from([0xd6,0xd0,0xce,0xc4])))"   # 应输出：中文
```

- 第 3 项失败（Node < 22.5）：**不阻塞**，面板会把审计日志降级为 JSONL。
- 第 4 项失败（精简 ICU）：中文 GBK 日志会乱码 → 换官方完整 MSI 安装包。

### 1.2 JDK

面板在「设置 → 服务端 → Java 路径」里**手动指定绝对路径**，不依赖 PATH：

```powershell
& "G:\Java\OpenJDK-25.03\bin\java.exe" -version
```

### 1.3 Nginx（已部署则跳过）

解压到 `C:\nginx`，确认 `C:\nginx\nginx.exe -v` 能跑。Windows 版 nginx 自带 OpenSSL，
TLS 与系统 SChannel 无关（不要为此改注册表）。

### 1.4 一次性环境体检

```powershell
cd G:\MCSLite
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1
```

它会检查 Node/sqlite/ICU/Java/防火墙并建好目录骨架，输出「下一步」。

---

## 阶段 2 · 部署面板文件（三选一）

> **最短路径就是字面意思：拷目录 → 双击根目录的「启动面板.bat」。**
> `web\dist` 已随仓库分发，所以一次 `npm install` 都不需要（实测：拷到全新目录后
> 直接启动，`/api/health` 正常、首页 200、哈希产物 196KB immutable 命中）。
> 该脚本会依次做：运行时体检 → 前端产物检查（缺了才构建）→ 建 `data\` →
> 探测服务端实例目录（认 `server.properties` / `run.bat`）→ 可选注册计划任务 → 启动并健康检查。

```powershell
# 双击等价命令（幂等，可反复跑，不会覆盖已有 data\settings.json 与密码）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy.ps1 -Root 'G:\服务端\NeoForge' -RegisterTask
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\deploy.ps1 -CheckOnly   # 只体检
```

下面是三种取代码的方式：

### 方式 A：`git clone`（推荐，升级最方便）
```powershell
cd G:\
git clone git@github.com:Iskuyal/mcslite.git MCSLite     # 或 https://github.com/Iskuyal/mcslite.git
cd MCSLite
```
私有仓库需先配置凭据：`gh auth login`，或 `git config --global credential.helper manager`
后首次输入 PAT（scope: `repo`）。

### 方式 B：直接拷贝目录
把整个 `MCSLite\` 目录拷过去即可 —— **后端零依赖，没有 `node_modules` 要带**。
只需额外带上 `web\dist\`（前端构建产物）或按阶段 3 现场构建。

### 方式 C：单文件 exe（分发/救急用）
在**开发机**上：
```powershell
cd web; npm install; npm run build; cd ..
node scripts\sea-build.js
```
把 `build\dist\` 整个目录（`MCSLite.exe` + `web\dist\`）拷到目标机，双击/命令行运行。
数据目录自动落在 exe 同级 `data\`。
限制见 `scripts/sea-build.js` 头部注释与 README 第五章（不能自我 spawn、杀软可能误报）。

---

## 阶段 3 · 构建前端（一次性）

```powershell
cd G:\MCSLite\web
npm install --no-audit --no-fund
npm run build              # 产物 web\dist\，197KB JS（gzip ≈68KB）+ 22.5KB CSS
cd ..
# 构建完可以删掉构建链，运行期不需要：
Remove-Item -Recurse -Force web\node_modules
```

> `web\node_modules`（约 250MB）只在构建时用。删掉后仓库/目录立刻变轻，
> 面板照常工作 —— 它只需要 `web\dist\`。

不想构建也可以：`git clone` 后直接用别人构建好的 `web\dist\`，或把 dist 单独归档分发。

---

## 阶段 4 · 首次启动与初始化

### 4.1 启动
```powershell
cd G:\MCSLite
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\start.ps1
```
或用 `start.ps1 -CheckOnly` 先只体检。**首次启动控制台会打印一次性初始密码**（同时写入
`data\credentials.json`）。想指定密码启动：
```powershell
$env:MCSLITE_PASSWORD = '你的强口令'; powershell -NoProfile -File scripts\start.ps1
```

### 4.2 登录并立刻改密
浏览器开 `http://127.0.0.1:8787/` → 用初始密码登录 → **设置 → 账号安全 → 修改密码**。
用户名默认 `admin`，可在此页改（改完所有已发 token 立即失效）。

### 4.3 指向你的 NeoForge 服务端
1. **设置 → 服务端**，填「服务端目录」= `G:\服务端\NeoForge`；
2. 页面下方会出现 **「从启动脚本导入」** → 预览 `run.bat` → 应用导入。
   面板会解析出（不会执行 bat）：
   ```
   G:\Java\OpenJDK-25.03\bin\java.exe  @user_jvm_args.txt  -Xmx4G
   @libraries/net/neoforged/neoforge/21.1.235/win_args.txt  -nogui
   ```
3. 点「保存本组」→ 回「仪表盘」点 **▶ 启动**。

> 为什么面板不直接跑 `run.bat`：bat 末尾有 `pause`（进程永远等按键）、`%*`/`&` 是注入面、
> 且多包一层 cmd 会让强杀只杀掉壳、java 变孤儿。见 `docs/WINDOWS-SERVER-2016.md` 第 3 条。

### 4.4 建议顺手确认的几项
| 位置 | 项 | 建议 |
|---|---|---|
| 设置→服务端 | 异常退出自动重启 | 开 |
| 设置→服务端 | 面板退出时一并停止服务端 | **按需**：默认关（升级面板不踢玩家）；用计划任务托管则建议开 |
| 设置→服务端 | 控制台缓冲行数 | 3000（低内存机器 800） |
| 设置→监控 | 磁盘采样器 | 内存紧张设 `off`（省 ~30MB） |
| 设置→面板 | 监听地址 | 保持 `127.0.0.1` |
| 设置→面板 | serveStatic | 阶段 5 配好 Nginx 后可关 |
| 配置页 | `online-mode` | 公网服务必 `true` |

### 4.5 验收（此时就该全绿）
```powershell
curl.exe -s http://127.0.0.1:8787/api/health
# 期望：{"ok":true,"state":"online","uptime":<秒>,"rss":<字节>}
$env:MCSLITE_PASSWORD='你的密码'; node test\live-check.mjs
```

---

## 阶段 5 · 开机自启（计划任务，不用装服务包装器）

```powershell
cd G:\MCSLite
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1 -RegisterTask
```
等价手工命令（`install.ps1` 内部就是这么做的）：
```powershell
$action    = New-ScheduledTaskAction -Execute 'powershell.exe' `
             -Argument '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "G:\MCSLite\scripts\start.ps1"' `
             -WorkingDirectory 'G:\MCSLite'
$trigger   = New-ScheduledTaskTrigger -AtStartup
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
             -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
             -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName 'MCSLite-Panel' -Action $action -Trigger $trigger `
             -Settings $settings -Principal $principal -Description 'MCSLite Minecraft 面板'
```

要点：
- `start.ps1` 自带**崩溃退避重启循环 + 端口预检**，所以计划任务的"失败重启"只是第二层保险。
- SYSTEM 账户无交互桌面：面板用管道驱动 java，不需要桌面（这正是不用 node-pty 的又一个理由）。
- 想以普通账户跑（便于读网络盘）：把 `-UserId` 换成账户名并加 `-LogonType Password`。
- 面板与游戏进程解耦，**重启面板会失去对已有 java 的 stdin 句柄** → 用计划任务托管时建议
  把「面板退出时一并停止服务端」打开，避免留下孤儿 java。

立即启动/停止/删除任务：
```powershell
Start-ScheduledTask  -TaskName 'MCSLite-Panel'
Stop-ScheduledTask   -TaskName 'MCSLite-Panel'
Unregister-ScheduledTask -TaskName 'MCSLite-Panel' -Confirm:$false
Get-ScheduledTaskInfo    -TaskName 'MCSLite-Panel'      # 看 LastTaskResult / NumberOfMissedRuns
```

---

## 阶段 6 · Nginx + HTTPS + 防火墙

### 6.1 放 Nginx 配置
把 `nginx\mcslite.conf` 拷成 `C:\nginx\conf\conf.d\mcslite.conf`（或并入 `nginx.conf` 的 `http{}`），
然后把里面的 `server_name` / 证书路径 / `root` 改成你的实际值：

```nginx
root  G:/MCSLite/web/dist;                    # 注意：正斜杠
ssl_certificate      C:/nginx/cert/mcslite.crt;
ssl_certificate_key  C:/nginx/cert/mcslite.key;
```

内网无证书时，最快出自签证书（PowerShell 5.1 可用）：
```powershell
$c = New-SelfSignedCertificate -DnsName mc.internal -CertStoreLocation Cert:\LocalMachine\My -NotAfter (Get-Date).AddYears(5)
Export-Certificate -Cert $c -FilePath C:\nginx\cert\mcslite.crt | Out-Null
$m = Get-ChildItem "Cert:\LocalMachine\My\$($c.Thumbprint)"; $p = ConvertTo-SecureString -String 'pass' -Force -AsPlainText
Export-PfxCertificate -Cert $m -FilePath C:\nginx\cert\mcslite.pfx -Password $p | Out-Null
# 用 openssl 从 pfx 导出 key： openssl pkcs12 -in mcslite.pfx -nocerts -out mcslite.key -nodes
```
并把 `mcslite.crt` 作为受信任根导入每台管理机（否则浏览器拦你）。

### 6.2 生效
```powershell
cd C:\nginx
.\nginx.exe -t                 # 必须先通过语法检查
Start-Process .\nginx.exe
.\nginx.exe -s reload          # 之后改配置用 reload，不要重启机器
```

### 6.3 防火墙（三条规则，各司其职）
```powershell
# ① 玩家进服
New-NetFirewallRule -DisplayName 'Minecraft Server' -Direction Inbound -Protocol TCP -LocalPort 25565 -Action Allow
# ② 管理员访问面板（收窄到你的管理网段！）
New-NetFirewallRule -DisplayName 'MCSLite HTTPS' -Direction Inbound -Protocol TCP -LocalPort 443 -Action Allow -RemoteAddress 192.168.1.0/24
# ③ 明确挡住面板端口与 RCON（即使 Nginx 配错也兜底）
New-NetFirewallRule -DisplayName 'Block Panel Direct'  -Direction Inbound -Protocol TCP -LocalPort 8787 -Action Block
New-NetFirewallRule -DisplayName 'Block RCON'          -Direction Inbound -Protocol TCP -LocalPort 25575 -Action Block
```

> `8787` 默认只绑 `127.0.0.1`，第③条是防"有人手改 settings.json 成 0.0.0.0"。

### 6.4 验证反代与 WebSocket
```powershell
curl.exe -sI https://mc.internal/ -k                 # 期望 200，content-type: text/html
curl.exe -s  https://mc.internal/api/health -k       # 期望 {"ok":true,...}
# WS 握手应返回 101（--head 模式模拟）
curl.exe -s -o NUL -w "%{http_code}\n" -k -i `
  -H "Connection: Upgrade" -H "Upgrade: websocket" `
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" -H "Sec-WebSocket-Version: 13" `
  https://mc.internal/ws
# 期望：101（若 401 = 未登录 cookie；若 502 = 面板没起；若 200 = nginx 没转发 Upgrade 头）
```

---

## 阶段 7 · 上线前验收清单

```powershell
cd G:\MCSLite
$env:MCSLITE_PASSWORD='你的密码'
node test\unit.js            # 期望：42 通过 / 0 失败
node test\run.js             # 期望：44/44 通过（自带 RSS 断言）
node test\live-check.mjs     # 真机核对：日志管线 + 指标（对着真实服务端）
node test\sampler-check.mjs (Get-Process java).Id 5   # 采样器取数字段齐全
```

浏览器侧人工确认（真实 Chromium 已跑过，这里是给你的核对表）：

- [ ] 顶栏状态徽标 = 运行中 + PID；「实时」绿点亮（= WS 已连）
- [ ] 控制台页能看到彩色启动日志，滚动到底不自动跟随时会显示「已暂停滚动 +N」
- [ ] 输入 `list` 回车有响应；快捷按钮可用
- [ ] 三张图表数值在动（CPU/内存/磁盘），「采样器」显示 CIM 正常运行
- [ ] 「文件」能进 `mods\`、`logs\`；预览 `server.properties` 正常
- [ ] 「配置」按分组显示键值，改一项 → 「应用」→ 提示是否需要重启
- [ ] 「审计」里能看到你刚才的每一次操作（含失败项）
- [ ] 手机/另一台机通过 **HTTPS** 能访问，直连 `:8787` 被防火墙挡住
- [ ] 重启服务器后计划任务自动拉起面板（`Get-ScheduledTaskInfo` 看 LastTaskResult=0）

---

## 阶段 8 · 日常运维

### 8.1 升级面板（**用脚本，别手工**）

```powershell
# 推荐：双击根目录「更新面板.bat」，或命令行
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\update.ps1 -Test
```

`update.ps1` 的五步，每一步都不碰你的游戏世界：

| 步 | 动作 | 关键保障 |
|---|---|---|
| 1 | 备份**当前代码 + data\** 到 `.rollback\<时间戳>\` | 只保留最近 5 个快照，不会越攒越大 |
| 2 | 可选 `-StopServer`：通过面板 API 优雅停服（会存档） | 不给就明确警告"面板会重启，java 会脱离管理" |
| 3 | 取新代码：`git pull --ff-only`，或 `-From <解压目录>` 用 robocopy 镜像替换 | 替换时 `/XD data .git .rollback node_modules` —— **数据目录结构上不可能被覆盖** |
| 4 | 校验交付脚本编码不变量（`.ps1` 必须仍是 UTF-8 BOM + CRLF），可选跑 42 单测 / 44 端到端 | 编码守护不通过会**自动修**而不是留个坏脚本 |
| 5 | 重启面板并轮询 `/api/health`；**20 秒内不健康就自动回滚第 1 步的代码** | 不会留下"更新到一半起不来"的砖 |

常用组合：

```powershell
# 只更新代码、跑单测、重启（游戏不掉线，但更新后需重新点「启动」接管）
update.ps1 -Test

# 更新前先优雅停服（最干净，玩家会被请下线）
update.ps1 -Test -StopServer

# 不能用 git（网络被阻断）：下载 GitHub ZIP 解压后本地替换
update.ps1 -From 'G:\dl\mcslite-main' -Test

# 只体检不装
update.ps1 -NoRestart

# 更新出问题了，退回上一个快照
update.ps1 -Rollback
```

### 关于"更新会不会影响我的服务器/世界"

不会。三层隔离：
1. **代码与数据物理分离**：可执行文件全在 `server\`、`web\`、`scripts\`，状态全在 `data\`；
   更新用 `robocopy /XD data` 镜像，结构上就覆盖不到。
2. **面板与游戏进程解耦**（`stopOnExit` 默认 false）：更新面板不会把 java 一起带走。
3. **Java/Minecraft 实例目录只被"沙箱内的文件 API"访问**，更新流程完全不碰它。

唯一的真实副作用：**面板重启后会失去对当前 java 进程的 stdin 句柄**，
于是那一刻 UI 显示"已停止"而游戏其实还在跑。三种应对：

| 做法 | 适用 |
|---|---|
| `update.ps1 -StopServer`（先优雅停服再更新） | 最干净，推荐给在意存档完整性的场合 |
| 更新后在仪表盘点「启动」重新拉起 | 玩家会经历一次掉线→重连 |
| 打开「面板退出时一并停止服务端」 | 让"面板停 = 服务停"成为恒定语义，不留孤儿 java |

> 长期正解是启动时"认领"已存在的 java 进程（按命令行匹配实例目录，标记为外部接管、
> 只能监控与强杀）。面板当前未实现，理由见 `docs/WINDOWS-SERVER-2016.md` 第 10 条。

### 8.1.1 手工升级（不用脚本时的等价步骤）

```powershell
Stop-ScheduledTask -TaskName 'MCSLite-Panel'          # 或结束面板进程（注意：只结束自己的 PID）
Copy-Item data "D:\bak\data-$(Get-Date -f yyyyMMdd-HHmmss)" -Recurse   # 先备份数据
# git pull 或用新版本目录覆盖 server\ web\ scripts\ docs\（保留 data\）
powershell -NoProfile -File scripts\start.ps1 -CheckOnly                # 体检
Start-ScheduledTask -TaskName 'MCSLite-Panel'
curl.exe -s http://127.0.0.1:8787/api/health                            # 验证
```


### 8.2 回滚
```powershell
git log --oneline -5; git checkout <上一个可用提交>
```
或最粗暴：把整个 `MCSLite\` 目录换成上一版备份 + 保留 `data\`。

### 8.3 备份
| 内容 | 命令 | 频率建议 |
|---|---|---|
| 面板配置与审计 | `Compress-Archive data\* backup\data-(Get-Date -f yyyyMMdd).zip` | 每日 |
| 世界存档 | 先面板发 `save-all` 或直接 `save-off/save-on` 包一层，再 `robocopy world D:\bak\world /MIR /R:1 /W:1` | 每小时–每日 |
| 完整快照 | `vssadmin` / 磁盘快照 | 每周 |

> 世界目录在服务器运行时直接拷贝可能拿到半写状态，稳妥做法是用面板控制台依次发
> `save-off` → 备份 → `save-on`，或用卷影复制。

### 8.4 日志与数据位置
| 路径 | 内容 |
|---|---|
| `data\logs\panel.log` | 面板自身输出（`start.ps1` 落盘） |
| `data\logs\panel-console.log` | 服务端控制台镜像，4MB 轮转（面板重启后仍可回放） |
| `<实例>\logs\latest.log` `debug.log` | MC 自己的日志（面板不改写它们） |
| `data\mcslite.db` | 审计日志（自动裁剪至 5000 行） |

### 8.5 故障排查速查表

| 症状 | 先看哪里 | 常见原因与处置 |
|---|---|---|
| 面板起不来 | `data\logs\panel.log` | `端口 8787 已被占用` → 改 `settings.json` 的 `panel.port`；`无权限绑定` → 换 ≥1024 端口 |
| 界面打不开、显示"MCSLite 后端已运行" | — | `web\dist` 没构建 → 回阶段 3，或让 Nginx 托管 |
| 顶栏显示「重连中」 | F12 → Network → WS | Nginx 没转 `Upgrade` 头 / `proxy_read_timeout` 太短 → 用阶段 6.4 那条 curl 定位 |
| 日志中文乱码 | 仪表盘「日志编码」字段 | 显示 `gbk` 却仍乱码 → 设置里强制 `utf-8`/`gbk` 试；或给 jvmArgs 补 `-Dfile.encoding=UTF-8` |
| 启动报「找不到主类/argfile」 | 控制台 | 实例目录不对（`@win_args.txt` 是相对路径）→ 确认「服务端目录」+ 重新导入 run.bat |
| 点启动没反应/立即退出 | 控制台末行 | `javaPath` 无效 → 设置里填绝对路径；EULA 未同意 → 检查 `eula.txt` |
| 图表是空的 / 显示"已降级" | 仪表盘「采样器」 | PowerShell 被 AppLocker/WDAC 拦 → 单独跑 `data\sampler.ps1` 验证；不行就 `diskSampler=off` |
| CPU% 明显不对 | `test\sampler-check.mjs` | 核数/100ns 单位换算类问题，跑该脚本比对原始 ticks |
| 启动报 `Address already in use` | `Get-NetTCPConnection -LocalPort 25565` | 上一次 java 变孤儿（面板被强杀）→ 结束它；长期方案：开 `stopOnExit` |
| Nginx 413 | — | `client_max_body_size` 太小（配置里默认 512m） |
| 上传大文件失败 | 审计页有无 `files.upload` | 面板侧上限 1GB；网络侧查 Nginx 与防火墙超时 |
| 忘了面板密码 | `data\credentials.json` | 删掉该文件 → 重启面板会打印新初始密码（`secret.key` 保留则旧 token 仍有效，介意的话一起删） |

### 8.6 卸载
```powershell
Stop-ScheduledTask -TaskName 'MCSLite-Panel'; Unregister-ScheduledTask -TaskName 'MCSLite-Panel' -Confirm:$false
Get-NetFirewallRule | Where-Object { $_.DisplayName -like 'MCSLite*' -or $_.DisplayName -like 'Minecraft*' } | Remove-NetFirewallRule
# ⚠ 只删面板。游戏世界在实例目录，与面板无关；先确认已停服再操作
Remove-Item -Recurse -Force G:\MCSLite\data\logs      # 需要清日志的话
```

---

## 附录 A · 环境变量（不改 settings.json 也能覆盖）

| 变量 | 作用 |
|---|---|
| `MCSLITE_PORT` / `MCSLITE_HOST` | 覆盖监听地址端口 |
| `MCSLITE_ROOT` | 覆盖服务端实例目录 |
| `MCSLITE_JAVA` | 覆盖 javaPath |
| `MCSLITE_DATA` | 数据目录（多实例并跑/测试用） |
| `MCSLITE_PASSWORD` | 首次启动直接指定初始密码 |
| `MCSLITE_HEAP` | `start.bat` 传给 `start.ps1` 的堆上限（默认 96MB） |

## 附录 B · 关键设计决定（部署时被问起就看这里）

- **不用 node-pty**：ConPTY 需 build ≥17073，Server 2016(1607) 没有 → 详见坑点第 1 条。
- **不执行 .bat**：注入面 + `pause` 挂死 + 孤儿进程 → 坑点第 3 条。
- **WMI 用 CIM 英文类名而非 `Get-Counter`**：计数器路径会被系统语言本地化 → 坑点第 7 条。
- **`.ps1` 带 UTF-8 BOM**：PowerShell 5.1 无 BOM 时按 GBK 解码，会静默吃掉代码 → 坑点第 2 条。
- **面板与游戏进程解耦**（`stopOnExit` 默认 false）：升级面板不应该踢玩家。

---

## 附录 C · git push 被网络阻断时怎么办

本仓库首次上传就遇到了：`gh`（走 `api.github.com`）建仓库成功，但 `git push`（走 `github.com`
的 git 协议通道）连续报 `Recv failure: Connection was reset` / `Failure when receiving data from the peer`。

按成本从低到高：

```powershell
# 1) 换 HTTP/1.1 与小包重试（对某些中间设备有效）
git -c http.version=HTTP/1.1 -c http.postBuffer=524288 push -u origin main

# 2) 有代理就显式给 git 用
git config --global http.proxy http://127.0.0.1:7890
git config --global https.proxy http://127.0.0.1:7890

# 3) 走 SSH over 443（需已在 GitHub 添加过公钥）
#    ~/.ssh/config:  Host github.com
#                      HostName ssh.github.com
#                      Port 443
#                      User git
#    然后把 remote 改成 git@github.com:Iskuyal/mcslite.git

# 4) 兜底：直接用 GitHub Objects API 把本地提交推上去（本项目自带，实测可用）
node scripts\gh-push-api.mjs --owner Iskuyal --repo mcslite --branch main
node scripts\gh-verify.mjs          # 从远端读回来逐文件比对 blob SHA
```

第 4 步的原理与边界：
- 内容取自 `git cat-file`（**索引规范化后的字节**），所以推上去的 blob 与本地仓库完全一致；
  脚本最后比对 **tree SHA**，不同就中止，绝不留下一个"看起来推上去了"的错误提交。
- 一次性提交（`parents: []`）适合根提交；若远端已有历史，需要先把远端 sha 填进 parents，
  否则会创建孤儿提交 —— 这也是脚本默认在远端已有不同提交时**拒绝执行**（除非 `--no-empty-guard`）的原因。
- 文本文件走 `trees` 的 `content` 内联（一次 API 调用），含 NUL 或非 UTF-8 的文件自动退回
  `blobs` 的 base64 通道，所以二进制也不会被损坏。
- 它绕不过去的是 **git 协议本身**，所以克隆（`git clone`）仍需要 1–3 中某条通道能用；
  实在不行就在目标机用「下载 ZIP」或方式 B（拷目录）部署。

> 顺带一条同源经验：**测量工具坏掉时不要相信它的结论**。第一次我用
> `gh api --jq '.tree[] | select(.type=="blob")'` 核验，PowerShell 把引号与 `==` 吞了，
> jq 报错却只输出一行，看上去像"远端只有 1 个文件"。换成 Node 脚本拉完整 tree 做集合比对，
> 才拿到真实结论（60/60，SHA 全等）。

## 附录 D · 文档索引

| 文件 | 内容 |
|---|---|
| `README.md` | 选型理由、目录结构、功能实现要点、API 一览、内存实测表 |
| `docs/DEPLOYMENT.md` | 本文件：从零到上线、自启、反代、验收、备份回滚、排障 |
| `docs/WINDOWS-SERVER-2016.md` | 12 条 Windows 坑点（区分「已实测」与「待真机复验」） |
| `docs/MEMORY.md` | 内存口径、预算分解、有界三件套、按需负载、可调旋钮 |
