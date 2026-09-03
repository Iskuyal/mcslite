# Windows Server 2016 坑点清单与解法

> 图例：`[已实测]` = 本项目开发过程中在这台机器上真实撞到并修掉的；
> `[目标机]` = Server 2016 特有、需在真机复验的（**本项目在 Windows 11 26100 上开发，未能上真机**）。
> 所有 `[已实测]` 项都有对应的回归用例（`test/unit.js` / `test/run.js`）。

---

## 1. `[目标机]` ConPTY 不存在 → node-pty 不可用（**决定性架构约束**）

**症状**：在 Server 2016 上装 `node-pty`，要么 `npm install` 阶段就编译失败，要么运行时
`createPseudoConsole` 找不到入口点，或者退化成 winpty 后在服务/计划任务（Session 0）里直接起不来。

**根因**：`CreatePseudoConsole` 自 Windows 10 **build 17073** / Server version **1809** 才引入。
Windows Server 2016 = **build 1607**，没有这个 API。node-pty 在缺 ConPTY 时退回 winpty，
而 winpty 需要交互桌面会话，Session 0 / 无人值守场景不可靠。

**解法（本项目的选择）**：**根本不用伪终端**。Minecraft 服务端跑 `-nogui`，它的 stdin/stdout 就是普通管道，
ANSI 颜色码在管道里照样输出（Log4j2 console appender 自己决定颜色）。于是：

```js
spawn(javaPath, argv, { cwd: root, shell: false, windowsHide: true, stdio: ['pipe','pipe','pipe'] });
```

附带三个好处：不需要 node-gyp / VS BuildTools（Server 2016 上通常是空的）、不需要 VC++ 可再发行组件、
不依赖任何预编译二进制。**这是这个面板能在纯 Server 2016 上「开箱即用」的第一原因。**

如果确实需要真 TTY 语义（比如要跑交互式 `command` 界面），替代路径是 `winpty` 手工封装或
改用 `screen`-式行编辑，收益远小于成本 —— 不建议。

---

## 2. `[已实测]` PowerShell 5.1 读无 BOM 的 UTF-8 `.ps1` → **静默吃掉一行代码**

**症状**：这是本项目最疼的一个坑。面板的指标里 `procRss`、`procThreads` 全都在，
唯独 `procTicks` **偶尔整个字段消失**，不报错、不打日志。

**根因**：`fs.writeFileSync(path, psText, 'utf8')` 写出的是 **UTF-8 无 BOM**。
Windows PowerShell 5.1 用 `-File` 加载脚本时，**没有 BOM 就按系统 ANSI 码页解码**（中文机 = GBK）。
脚本里的中文注释因此变乱码，而乱码字节序列把**换行也吞了**，于是：

```powershell
# 累计 CPU 时间片（100ns）；…      $o.procTicks = [int64]$pr.UserModeTime + …
^-- 整行变成注释，赋值语句被一起注释掉
```

**解法（双保险，两条都做）**：
1. 写出 `.ps1` 时带 UTF-8 BOM：`fs.writeFileSync(f, '\ufeff' + PS, 'utf8')`；
2. **内嵌在 JS 里的 PowerShell 载荷保持纯 ASCII**（注释写英文），并在写盘前做一次非 ASCII 检查告警。

同理，交付的 `scripts/*.ps1` 必须带 BOM + CRLF —— 用 `node scripts/fix-encoding.js` 统一规范化，
并可用 `--check` 当 CI 断言。**这条对任何要在中文 Windows 上分发 .ps1 的项目都成立。**

---

## 3. `[已实测]` 绝不能用 `shell:true` 去跑 `run.bat`（命令注入 + 进程挂死）

**症状**：NeoForge 安装器给的 `run.bat` 长这样：

```bat
"G:\Java\OpenJDK-25.03\bin\java.exe" -Xmx4G @libraries/net/neoforged/neoforge/21.1.235/win_args.txt %* -nogui
pause
```

如果面板「为了方便」直接 `spawn('cmd.exe', ['/c','run.bat'])`：
- 网页控制台里的一个输入框就可能变成任意命令执行（`%*`、`&`、`||` 全部有效）；
- 末尾的 `pause` 让进程**永远等一个按键**，面板表现为「停止按钮点了没反应」；
- 多一层 cmd.exe ⇒ `taskkill` 只杀掉壳，java 变孤儿，下次启动报 `Address already in use`。

**解法**：把 bat **解析成 argv 数组**，然后仍然 `spawn(java, argv, {shell:false})`。
见 `server/mc/importer.js`：`@argfile` 原样保留（java 自己展开，不需要 shell）、
含空格的 exe 路径按引号分组、剔除 `%* / %1 / %~dp0 / goto / pause / 2>&1`、
自动补上未被引用的 `@user_jvm_args.txt`。UI 上是「设置 → 从启动脚本导入」，可预览 argv 再应用。

顺带：`start.bat` 保持 **ASCII + CRLF** —— cmd.exe 按 OEM 码页解析 .bat，UTF-8 中文会变乱码，
而带 BOM 的 .bat 第一行直接炸。中文提示信息放在 `.ps1` 里。

---

## 4. `[已实测]` 中文日志的三件事：GBK 解码、中文日期前缀、中文实例路径

### 4a. 服务端 stdout 编码
中文 Windows 的 ACP 是 936(GBK)。JVM 若不带 `-Dfile.encoding=UTF-8`，日志里的中文
（模组名、玩家名、崩溃报告）全是 GBK 字节；按 UTF-8 强解 → 乱码且 `U+FFFD` 不可逆。

**解法**：
- Node 24 官方 Windows 包是 **full-ICU**，`new TextDecoder('gbk')` 开箱可用 ⇒ 不需要 iconv-lite。
  （`test/unit.js` 断言了本机 ICU 与 GBK 解码；`install.ps1` 会在目标机上主动探测这两点。）
- 面板用**流式解码**（`stream:true`）+ 「只有遇到高位字节才判定编码」的策略，
  避免纯 ASCII 前缀被误判成 UTF-8；判定完把暂存块一并吐出，不丢日志开头。
- 同时向子进程注入 `JAVA_TOOL_OPTIONS=-Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8`，
  并让 `jvmArgs` 默认含 `-Dfile.encoding=UTF-8`（校验时缺省会给出警告）。
- 真机结果：**1181 行、其中 146 行中文，乱码 0 行**（`node test/live-check.mjs`）。

**注意方向不对称**：Node 能**解** GBK，但**没有 GBK 编码器**（`Buffer.from(s,'gbk')` 抛
`Unknown encoding`）。所以 `writeText` 遇到「要求按 GBK 写且内容含非 ASCII」时**明确拒绝（422）**
而不是偷偷写成 UTF-8 —— MC 的 `.properties/.json` 本来就该是 UTF-8。

### 4b. Log4j2 的日期前缀跟随系统语言（**真机踩到**）
真实 NeoForge 日志前缀不是 vanilla 那种 `[12:00:01]`，而是：

```
[278月2026 23:42:26.189] [main/INFO] [cpw.mods.modlauncher.Launcher/MODLAUNCHER]: ModLauncher running: …
```

按 `^\[(\d\d:\d\d:\d\d)\] \[(\w+)/(\w+)\]:` 写的解析器在真机上**一行都匹配不到**，
时间列与日志级别全丢（面板上表现为「所有行都是无色无级别」）。

**解法**：改成「吃掉行首连续的 `[...]` 段，再从各段里分别认时间 / `xxx/LEVEL` / 线程名」，
并要求**至少两段方括号**才认定是前缀（否则 `[Server] 玩家聊天`、`[Mouse Tweaks] Disabled…`
这类正文会被误剥）。真机结果：**时间戳抽取 583/583 = 100%**。

另一条路是让日志格式与语言无关：给 JVM 加 `-Duser.language=en -Duser.country=US`
（会让 ModLauncher 的日期变回英文）。面板两种都吃得下，但**解析器必须默认按本地化格式写**，
因为你不能假设客户的服务器上有这个参数。

### 4c. 中文实例路径
`G:\服务端\NeoForge` 这类路径本身没问题：libuv 走 `CreateProcessW`，Node 侧全程 UTF-8/UTF-16 转换。
但要注意两处：
- `win_args.txt` 里必须是**相对路径**（本项目实测该文件 0 个非 ASCII 字节）。有人手改成绝对路径、
  把 `服务端` 写进去，就会被「argfile 按平台码读」的行为坑到 —— 保持相对路径最稳。
- JSON 配置文件里的中文没问题（UTF-8），但**别用 PowerShell 去 POST 中文**（见第 5 条）。

---

## 5. `[已实测]` PowerShell 5.1 调 API：中文请求体变成 `?`

**症状**：`Invoke-RestMethod -Method Put -Body (… | ConvertTo-Json)` 设置中文目录，服务端收到的是

```
服务端目录不存在：G:\???\NeoForge
```

**根因**：PS 5.1 在 `-ContentType 'application/json'`（无 charset）时按 **ISO-8859-1** 编码请求体，
CJK 全部退化成 `?`。**服务端没问题**，浏览器 `fetch` 也没问题（本项目 Web UI 实测中文正常）。

**解法**（写给要用脚本调面板 API 的人）：
```powershell
$json = $body | ConvertTo-Json -Depth 6
$bytes = [Text.Encoding]::UTF8.GetBytes($json)
Invoke-RestMethod -Uri $u -Method Put -Body $bytes -ContentType 'application/json; charset=utf-8'
```
或者干脆用 Node/curl 发请求。面板文档与脚本里都提醒了这一点。

---

## 6. `[目标机]` Node 24 在 Server 2016 上的支持边界

- 本项目 `engines: node >= 20`，并明确以目标机已确认的 **v24.19.0** 为基准开发；
  开发机是 v24.16.0（同为 24.x，ABI 一致）。
- 若目标机上 `node -v` 都起不来（典型报错：`The procedure entry point … could not be located in
  api-ms-win-core-…dll`），说明该 Node 版本的 Windows 下限高于 1607。**退路**：装 22.x LTS；
  再不行退 18.20.x —— 面板仍能跑，只是 `node:sqlite` 没了（Node <22.5），
  此时 `server/lib/store.js` 会**自动降级为 JSONL 审计日志**并打一行 warn，功能不缺。
  `install.ps1` 会主动探测并明确告诉你当前是哪条路径。
- **不要**为了「兼容老系统」引入原生模块（sqlite3/better-sqlite3/node-pty）：
  那会把 VC++ Redistributable + node-gyp 工具链问题一起带上 2016。

---

## 7. `[已实测]` WMI/CIM 与 `Get-Counter` 的语言本地化陷阱

**症状**：`\Processor(_Total)\% Processor Time` 这类 `Get-Counter` 路径在英文系统能跑，
中文系统上真实名字是 `\处理器(_Total)\% 处理器时间`，硬编码英文直接 `Cannot find path`。

**解法**：本项目一律走 **CIM 的英文类名/属性名**（`Win32_PerfFormattedData_PerfOS_Processor` 等），
这些在所有语言版本里恒定。同时**刻意不用 `wmic`**：它在 Win11 24H2 已移除、
Server 2016 上有，但用 CIM 可以一套代码通吃两端。

另外 `[已实测]` 的性能事实：`Win32_PerfFormattedData_PerfProc_Process` 要枚举全系统几百个进程实例，
单次查询 ~660ms 且**高负载下经常静默返回空**（导致「一半样本没有进程数据」）；
而 `Win32_Process -Filter "ProcessId=N"` 只要 ~300ms 且稳定。所以：
- 进程 CPU/RSS/线程数 → `Win32_Process`（CPU 用 `UserModeTime+KernelModeTime` 做差值，
  注意单位是 **100ns**，墙钟 ms 换算要 **×10000**，本项目就在这儿把 CPU% 算成了 20 亿）；
- 差值计算放 Node 侧而不是 PowerShell 侧（PowerShell 里的跨轮状态实测会整轮丢失，Node 侧可单测）；
- 每进程磁盘 IO 在 Windows 上只能从那张慢表拿 → 面板**不依赖**它，只展示整机磁盘 IO。

**单位换算口诀**：`100ns 时间片 → ms` 除以 10000；`ms → 100ns` 乘以 10000。写反一次，
CPU% 就差 1e8 倍（真发生了）。

---

## 8. `[目标机]` 无人值守运行的会话与权限

| 事项 | 说明 |
|---|---|
| Session 0 / 无桌面 | 用计划任务以 SYSTEM 跑面板时，java 没有控制台窗口可弹 ⇒ `windowsHide: true` 是必需的（否则每次启动弹一个黑框，且黑框里 `pause` 会挡住退出）。这也是不用 winpty 的又一个理由。 |
| 端口 < 1024 | 别把面板放 80/443，那是 Nginx 的；面板用 8787 就不需要管理员权限。 |
| 文件被服务端占用 | `session.lock`、`level.dat`、正在写的 `region/*.mca` 会 `EBUSY/EPERM` ⇒ 统一映射成 423/403 并给出人话提示，别抛 500。 |
| 路径 > 260 字符 | 模组与资源包容易踩 MAX_PATH。Server 2016 支持 `LongPathsEnabled` 注册表项：`HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem\LongPathsEnabled = 1`（需程序声明支持；面板侧用长路径前缀 `\\?\` 兜底）。 |
| Defender / 杀软 | `mods\`、`world\`、`libraries\` 的实时扫描会明显拖慢区块保存；建议对实例目录加排除项。对 `MCSLite.exe`（SEA 自注入）也可能误报，白名单更省事。 |
| WDAC / AppLocker | 若被策略锁死 PowerShell，面板的采样器会拿不到数据。本项目为此做了**降级路径**：采样器失败 ⇒ 仍用 `node:os` 出系统级指标，UI 上明确显示「已降级（仅系统级）」并带原因，而不是画一条假线。可在「设置 → 监控 → 磁盘采样器 = 关闭」彻底放弃这条通道。 |
| 时区 | 日志时间戳是服务端进程本地时间；面板显示用浏览器本地时区。跨时区访问会「对不上表」，仪表盘底部展示了面板进程的 `timezone` 以便排查。 |

---

## 9. `[已实测]` 半开 TCP 连接在 Windows 上不会自己报错

浏览器被 kill / 网络抖动后，服务端的 socket 不会收到 RST，`onclose` 不触发 ⇒
订阅集合里留僵尸连接，日志继续往不存在的客户端序列化，白烧 CPU。

**解法**：服务端每 30s 主动 `ping`，超过 95s 没有 `pong` 就以 1001 关闭（`server/lib/ws.js`
`startHeartbeat`）。同时前端也有 25s 应用层 ping + 指数退避重连（`web/src/api.js`）。

---

## 10. `[已实测]` Windows 上「孤儿 java」与 `taskkill /T`

面板被强杀（`Stop-Process -Force`）时，子 java **不一定**跟着死；后果是下次启动
`bind failed: Address already in use` 或世界目录被 `session.lock` 占住。

**当前处置**：
- 所有终止路径都用 `taskkill /T /F`（进程树），优雅停止则走 stdin；
- 面板异常退出（`uncaughtException`）会写审计，方便事后定位；
- `settings.server.stopOnExit`（默认 **false**）：默认让面板与游戏进程解耦 ——
  **升级面板不应该把玩家踢下线**。要求「面板停 = 服务停」的场景再打开。

**已知限制（诚实说明）**：面板重启后**不会认领**已经在跑的 java 进程，
所以那一刻 UI 显示「已停止」而游戏其实还在跑。要彻底解决有两条路：
① 开 `stopOnExit`，让面板退出时一定把服务带走；
② 启动时用一次性 CIM 查询按 `CommandLine` 匹配实例根目录，认领为「外部进程」
（只能监控与强杀，stdin 已不可写，UI 需明确标注「外部接管」徽标）。
本项目未实现 ②，因为它带来的「半功能状态」比它解决的问题更多 —— 需要时可以按上述思路补。

---

## 11. `[目标机]` Nginx on Windows 的常见摩擦

- `nginx.conf` 里路径用**正斜杠**（`G:/MCSLite/web/dist`），反斜杠要写两条；路径含空格必须整串引号。
- 改完先 `nginx -t`，再 `nginx -s reload`；Windows 下 nginx 是多进程，reload 失败会留下旧 worker 占端口。
- 开了 `proxy_request_buffering off`（本项目建议开，用于大文件流式上传）就不需要 `client_body_temp_path`，
  否则要确认该目录所在盘有空间且 nginx 账户可写。
- `ssl_protocols TLSv1.3` 要求 nginx 是 OpenSSL 1.1.1+ 构建（官方 Windows 包满足）；
  若用很旧的 Windows 包，只留 TLSv1.2 —— Server 2016 的 SChannel 与 nginx 无关（nginx 自带 OpenSSL），
  别去改注册表开 TLS1.3，那是给 IIS 用的。

---

## 12. 上真机时的最小复验清单

```powershell
# 1) 环境体检（含 node:sqlite / full-ICU GBK / Java 探测 / 端口 / 防火墙）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1

# 2) 只体检不启动
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\start.ps1 -CheckOnly

# 3) 起面板 + 端到端回归 + 纯函数单测
node server\index.js
node test\run.js
node test\unit.js

# 4) 真机指标与日志管线核对（对着真实服务端）
node test\live-check.mjs --start
node test\sampler-check.mjs <javaPid> 5      # 采样器取数字段是否齐全
node test\diag.mjs                            # 指标连续性 + 级别抽样

# 5) 若「采样器：已降级」→ 单独验证 PowerShell 是否被策略拦下
powershell -NoProfile -ExecutionPolicy Bypass -File data\sampler.ps1 0 2000
```
