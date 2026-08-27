# MCSLite —— 极简轻量 Minecraft 网页管理面板

单实例 / Windows / 零外部依赖的 Minecraft（含 NeoForge）服务端管理面板。
不需要 Docker、不需要 WSL2、不需要 MySQL/Redis、**后端不需要 `npm install`**。

```
  浏览器 ──HTTPS──▶ Nginx ─┬─▶ 静态 web/dist（Vue3 构建产物）
                           └─▶ 127.0.0.1:8787（Node 面板：REST + 手写 WebSocket）
                                      │ spawn(exe, argv[], {shell:false})
                                      ▼
                            java.exe -Xmx4G @win_args.txt -nogui   ← NeoForge 服务端
```

---

## 一、五分钟跑起来

> 📘 **完整上线流程（含开机自启、Nginx+HTTPS、防火墙、验收清单、备份回滚、故障排查表）见
> [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)**。下面只是最简路径。

```powershell
# 1) 自检 + 建目录（可选 -BuildWeb 顺带构建前端）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1 -BuildWeb

# 2) 启动面板（崩溃自动重启、日志写 data\logs\panel.log）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\start.ps1
#    或者直接双击 scripts\start.bat

# 3) 浏览器打开 http://127.0.0.1:8787/
#    用户名 admin，密码打印在第 2 步的控制台里（只打印一次，也存于 data\credentials.json）
```

登录后：**设置 → 服务端 → 从启动脚本导入**。面板会解析 NeoForge 安装器生成的
`run.bat`，把 `java.exe` / `-Xmx4G` / `@libraries/.../win_args.txt` / `-nogui` 拆成参数数组填好——
**面板不会去执行 .bat**（见 `docs/WINDOWS-SERVER-2016.md` 第 3 条）。

本机实测的 NeoForge 配置（MC 1.21.1 / NeoForge 21.1.235 / 67 模组 / JDK 25）：

| 字段 | 值 |
|---|---|
| 服务端目录 | `G:\服务端\NeoForge` |
| Java | `G:\Java\OpenJDK-25.03\bin\java.exe` |
| 完全托管命令 | `"…\java.exe" @user_jvm_args.txt -Xmx4G @libraries/net/neoforged/neoforge/21.1.235/win_args.txt -nogui` |

---

## 二、技术选型与理由

| 维度 | 选择 | 理由（含 Win2016 + 当前运行时的适配点） |
|---|---|---|
| 后端语言 | **Node.js 24** | 目标机已装 Node 24.19。Python 3.14 亦可，但 Node 的 `node:sqlite` + full-ICU GBK 解码 + 事件循环式 WS 推送，让**后端第三方依赖数为 0**；Python 侧要凑齐同等能力至少需要 FastAPI+uvicorn+websockets+pydantic 一整个树（空转 60–90MB），或退回标准库手搓 HTTP（工作量与风险都更高）。 |
| Web 框架 | **不用框架**：`node:http` + 自研 ~200 行路由（`server/lib/http.js`） | Express/Fastify 的路由 trie、中间件链、per-request 上下文是**固定常驻开销**。面板只有 20 来个固定路由，自研后空载 RSS 与裸 `node:http` 几乎无差（实测见第七章）。 |
| WebSocket | **自研 RFC6455 子集**（`server/lib/ws.js`） | 只需要「服务端→浏览器推文本帧」。自建实现顺手做掉了背压丢帧、心跳清理半开连接（Windows 上不会自己报错）、分片重组，且不给依赖升级留风险。 |
| 伪终端 | **不用 node-pty，纯 `child_process.spawn` + 管道** | ⚠ 决定性因素：node-pty 依赖 ConPTY（`CreatePseudoConsole`），该 API 自 Windows 10 build 17073 / **Server 2019(1809)** 才有；**Windows Server 2016 是 build 1607，没有 ConPTY**，node-pty 只能退回 winpty（需要交互桌面会话，在服务/计划任务的 Session 0 下经常直接失败，且官方 prebuild 不覆盖 Node 24 ABI）。而 MC 服务端以 `-nogui` 跑，stdin/stdout 本就是管道，ANSI 颜色码照样输出——**根本不需要 TTY**，还省掉 node-gyp/VS BuildTools 整条链。 |
| 进程内管理 | `execFile('taskkill.exe', ['/PID', pid, '/T', '/F'])` | 参数化传递、PID 是数字，不经 shell。`/T` 连子进程一起收（NeoForge 可能拉起 loader 子 JVM）。 |
| 数据库 | **内置 `node:sqlite`（Node ≥22.5）**，缺失时自动降级 JSONL | 零依赖、单文件、审计日志分页天然高效。避开 `better-sqlite3` 的原生编译——Server 2016 上没有 VS BuildTools 是硬伤。降级路径保证退回 Node 18.x 时功能不缺。 |
| 配置存储 | `data/settings.json`（人可编辑）+ `credentials.json`（scrypt 散列）+ `secret.key` | 分文件是为了能把 settings.json 单独拷去别台机器而不泄露口令散列。 |
| 前端框架 | **Vue 3 + Vite**（`web/`） | 满足需求。前端只影响浏览器内存，不影响服务器内存；构建产物 197KB JS（gzip ≈68KB）+ 22.5KB CSS，实测页面 JS 堆 3–7MB、DOM 180–370 节点。 |
| CSS | **TailwindCSS v4**（`@tailwindcss/vite`）+ 一层手写变量 | v4 按需生成、产物只剩用得到的原子类；控制台 ANSI 16 色调色板必须手写（`.fk/.fr/…`），Tailwind 帮不上。 |
| 图表 | **uPlot**（不用 ECharts/Chart.js） | 45KB vs ECharts 全量 ~1MB；canvas 渲染，DOM 里永远只有 1 个 `<canvas>`；数据面直接吃普通数组，不为每点建对象。600 点不掉帧。 |
| 打包 | **Node 官方 SEA**（不用 pkg/nexe） | pkg 实质停维护、打不动 Node 24；nexe 要现场编译对应版本 Node（依赖 Python + VS 工具链，正是 Server 2016 雷区）。详见第五章。 |
| 部署形态 | 计划任务（`-RegisterTask`）而非 NSSM/WinSW | 少一层第三方服务包装器；SYSTEM 账户无交互桌面恰好也是不用 node-pty 的又一个理由。 |

**为什么这套组合特别适配「Win2016 + Node 24 + JDK 25 + Nginx 已在」**
1. 面板不抢 80/443，只监听 `127.0.0.1:8787`，TLS 与暴露面交给已有 Nginx。
2. 零 npm 依赖 ⇒ Server 2016 上不需要编译工具链、不需要出网拉包、没有依赖投毒面。
3. 不用 ConPTY/node-pty ⇒ 1607 的 API 缺口不会被触发。
4. `node:sqlite` 是内置的 ⇒ 避开原生模块 ABI 与 VC++ Redistributable 版本问题。
5. full-ICU 的 `TextDecoder('gbk')` ⇒ 中文日志不乱码，且不用 iconv-lite。

---

## 三、目录结构

```
MCSLite/
├─ package.json                 # 后端：dependencies = {}（真的零依赖）
├─ server/
│  ├─ index.js                  # 入口：装配 HTTP/WS/生命周期/autostart/优雅退出
│  ├─ lib/
│  │  ├─ paths.js               # 源码运行 vs SEA 单文件运行的路径解析
│  │  ├─ config.js              # settings.json 读写 + validate + scrypt 凭据 + env 覆盖
│  │  ├─ http.js                # 自研路由：参数匹配、JSON 出入、体积上限、gzip、错误兜底
│  │  ├─ ws.js                  # 手写 WebSocket：握手/掩码/分片/ping-pong/close/背压丢帧
│  │  ├─ hub.js                 # 发布订阅 + 控制台帧批处理（60ms 或 300 行一帧）
│  │  ├─ auth.js                # HMAC token、cookie、Origin(CSRF)、登录限速、XFF 判定
│  │  ├─ store.js               # node:sqlite 操作日志，缺失自动降级 JSONL
│  │  ├─ static.js              # web/dist 托管：穿越防护、etag、immutable、有界 gzip 缓存
│  │  ├─ ansi.js                # ANSI SGR + § 色码 → 白名单 class 的受限 HTML；日志前缀解析
│  │  ├─ decode.js              # 流式解码器（auto / utf-8 / gbk），跨 TCP 包不断字
│  │  └─ ring.js                # 固定容量环形缓冲（内存可控的根基）
│  ├─ mc/
│  │  ├─ proc.js                # ★进程管理：启动/stdin 命令/优雅停止/强杀/崩溃退避重启/状态机
│  │  ├─ rcon.js                # Source RCON 客户端（含 1.19+ 多包响应重组）
│  │  ├─ importer.js            # ★run.bat / run.sh → argv 数组解析器
│  └─ sys/
│  │  ├─ monitor.js             # ★指标：内嵌 PowerShell 常驻采样器 + Node 侧 CPU 差值
│  │  └─ files.js               # 文件沙箱、properties 保注释回写、流式上传、fs 错误语义化
│  └─ api/routes.js             # REST 全量路由 + 审计埋点
├─ web/                         # Vue3 + Vite + Tailwind v4 + uPlot
│  ├─ index.html  vite.config.js  package.json
│  └─ src/
│     ├─ main.js  App.vue  api.js  store.js  style.css
│     ├─ components/{MetricChart,ControlBar}.vue
│     └─ views/{Login,Dashboard,ConsoleView,Files,Config,Settings,Audit}.vue
├─ scripts/
│  ├─ install.ps1               # 自检 + 建目录 +（可选）构建前端 +（可选）注册计划任务
│  ├─ start.ps1                 # 带体检/端口预检/崩溃退避重启的启动器
│  ├─ start.bat                 # 双击入口（刻意保持 ASCII+CRLF，见坑点第 6 条）
│  ├─ sea-build.js              # Node SEA 单文件打包
│  └─ fix-encoding.js           # 交付脚本编码规范化（.ps1 加 BOM/CRLF，.bat 保 ASCII）
├─ nginx/mcslite.conf           # 静态 + API + WebSocket 统一反代（含 WS 专用 location）
├─ test/
│  ├─ run.js                    # ★端到端 44 项（真起面板 + 真 WS 客户端 + 真子进程）
│  ├─ unit.js                   # ★纯函数 42 项（用真实服务端日志样本做用例）
│  ├─ mock-server.js            # 行为对齐真实服务端的假服务端（ANSI/§/中文/崩溃/stdin）
│  ├─ live-check.mjs            # 真机验收：对真实 NeoForge 核对日志管线与指标
│  ├─ sampler-check.mjs         # 采样器脚本单跑，验证 WMI 取数字段齐全
│  └─ diag.mjs                  # 指标连续性 + 级别分类抽样诊断
└─ data/                        # 运行期生成：settings.json / credentials.json / secret.key / mcslite.db / logs/
```

---

## 四、功能与实现要点

### 1. 核心管控
- **启动**：`spawn(javaPath, argv, { cwd: root, shell:false, windowsHide:true, detached:false })`。
  含空格的 Java 路径由 libuv 自动加引号，`@argfile` 原样交给 java 自己展开。
- **优雅停止**：向 stdin 写 `stop\n`（MC 自己存档并退出），`stopTimeoutMs`（默认 90s）内没退出才
  `taskkill /T /F`。真机验证：67 模组、223MB 世界的实例，`Saving chunks … All dimensions are saved → 退出码 0`。
- **强杀**：`taskkill /T /F`（整棵进程树），UI 二次确认并说明「不会存档，可能坏区块」。
- **崩溃自动重启**：区分 `intentionalStop` 与异常退出；退避 `[5s,15s,60s]`，连续 20 次后停手并留痕。
- **控制台流式输出**：stdout/stderr 合并 → 流式解码 → 按行切分（单行 8KB 截断、无换行 64KB 强制收口）
  → 环形缓冲 → 批量 WS 帧 → 前端 `v-html`（class 全白名单，无 XSS 面）。

### 2. 可视化
- CPU / 内存 / 磁盘吞吐三张 uPlot 图，20–30 分钟滚动窗口。
- **在线玩家**：优先 RCON `list`（权威，含人数上限与延迟）；未开 RCON 时从日志解析
  `joined the game` / `left the game` / `lost connection`（解析前先剥 ANSI，否则 `\x1b[32mSteve` 会取成 `eve`）。
- **仪表盘**：状态、PID、运行时长、退出码、日志编码判定结果、实例盘剩余、面板自身 RSS（自证轻量）。

### 3. 文件与配置
- 沙箱：所有路径 `resolve` 归一化 + 前缀校验 + **`realpath` 二次校验**（挡符号链接/junction 逃逸）；
  拒绝 `..`、盘符、NUL、`~`。`server.root` 是唯一边界。
- `server.properties` 用**行模型**解析（`{kind:'kv'|'comment'|'blank'}`），回写零信息损失——
  保留注释、保留顺序、新增键追加在末尾；按 schema 生成开关/下拉/数字框，并标注
  ⚡影响性能 与 ★涉安全；返回 `requiresRestart`（按热生效键白名单判定）。
- 文本写保留原文件 CRLF/LF 风格；fs 错误码语义化（ENOENT→404、EACCES→403、EBUSY→423…）。
- 上传：**请求体直接 stream 落盘**（`req.pipe(writeStream)`），堆里只留 chunk；前端把 `File`(Blob)
  交给 `fetch` 让浏览器自己流式读盘，两边都不进 JS 堆。

### 4. 安全
- scrypt(N=16384,r=8,p=1) 口令散列 + `timingSafeEqual`；明文不落盘、不进日志、不下发前端。
- 自签 HMAC-SHA256 token（`base64url(payload).base64url(mac)`），`httpOnly + SameSite=Strict`，
  改用户名即全体会话失效；也可 `Authorization: Bearer`（脚本用）。
- CSRF：非安全方法强制同源校验（Origin/Referer vs Host），与 SameSite 双保险。
- 登录限速（按 IP，固定 Map + 压实，杜绝 OOM 面）；失败尝试也进审计。
- 防命令注入：**全仓库无一处 `shell:true` / `exec(字符串)`**；控制台输入只写已运行进程的 stdin，
  并禁止换行（防一次注入多条指令）、限长 1000。
- WS 同源 + 同一 token 校验；只接受白名单 topic 订阅；单帧 ≤1MB。
- 审计：登录、启停、每条控制台/RCON 命令、每次文件写/删/上传/下载、每次配置修改全落库。

---

## 五、打包成单个可执行文件

```bash
node scripts/sea-build.js          # 产物 build/dist/MCSLite.exe + 同级 web/dist
```

用 **Node 官方 SEA**，不用 pkg / nexe：
- `pkg`：release 停在 Node 18 时代，Node 24 打不动，实质停维护。
- `nexe`：现场下载并编译对应版本 Node，依赖 Python + VS 工具链 —— Server 2016 上正是雷区。
- `SEA`：拿本机 `node.exe` 注入一段 blob，无第三方运行时。

`sea-build.js` 做四步：① 用 esbuild（复用前端构建链自带的那份，不额外装包）把**零依赖后端**
打成单个 CJS；② `node --experimental-sea-config` 生成 blob，并把
`execArgv: ["--max-old-space-size=96"]` 烘进 exe；③ 复制 `node.exe` → `MCSLite.exe`；
④ `postject` 注入 + 附带 `web/dist`。

**SEA 的三个必须知道的限制**（脚本输出里也会提示）：
1. 只内嵌单个入口脚本，`require` 相对文件会失败 ⇒ 必须先 bundle（本项目零依赖，打出来 ~140KB）。
2. exe 不能把自己当子进程 spawn；杀软对「自注入资源的 exe」误报率更高，所以默认**不**内嵌前端，
   而是 `MCSLite.exe` + 同级 `web/dist/`（数据自动落在 exe 同级 `data/`，见 `lib/paths.js`）。
3. Windows 上注入前可能要清残留数据流：`Remove-Item MCSLite.exe -Stream *`。

不想打包就分发整个目录 —— 后端零依赖 ⇒ 没有 `node_modules`，`start.bat` 双击即用，
这已经比「单文件」省不了多少，却少掉上面三条全部风险。

---

## 六、Nginx 反代要点（全文见 `nginx/mcslite.conf`）

| 要点 | 为什么 |
|---|---|
| `map $http_upgrade $connection_upgrade` | 写死 `Connection: upgrade` 会让普通 HTTP 请求也带 upgrade，keepalive 立刻劣化 |
| WS 单独 `location ^~ /ws` + `proxy_pass …/ws` | 后端按精确路径匹配 upgrade；显式带路径，挂在子前缀下也能对上 |
| `proxy_read_timeout 3600s` + `proxy_buffering off` | 否则表现为「日志卡住不动 / 每隔 60s 断线重连」 |
| `proxy_request_buffering off` + `client_max_body_size 512m` | 上传地图包时边收边传给 Node，不把 512MB 先攒进 nginx 缓冲 |
| `/assets/` immutable、`index.html` no-store | 哈希文件名可永久缓存；HTML 不缓存才不会改版后卡在旧版 |
| `geo` 白名单套在 `/api/` 与 `/ws` 上 | 管理面默认只对内网可见；公网只放 443 |
| 前端 `base:'./'` + 无 vue-router | 根路径或 `/panel/` 前缀下都不用重新构建 |

---

## 七、内存占用（实测）

同机同口径对照（Windows 11 26100 / Node 24.16 / 20 核 / 32GB，目标机 Server 2016 差异见文档）：

| 对象 | 工作集 RSS | 私有提交 | 说明 |
|---|---|---|---|
| **裸 `node:http` 空服务** | **55.3 MB** | — | 这是任何 Node 方案的**地板**，不是面板的开销 |
| MCSLite 面板（空闲，无浏览器订阅） | 20.8 MB | 60.6 MB | 采样器已被回收（`sampler=idle`），不养 PowerShell |
| MCSLite 面板（1 浏览器订阅 + 真实 NeoForge 在跑） | 58–62 MB | ~70 MB | 含 PowerShell/CIM 采样器 + 1100 行日志缓冲 + sqlite WAL |
| MCSLite 面板（堆使用 heapUsed） | **7.6 MB** | — | 真正的 JS 对象占用 |
| 浏览器侧（面板标签页） | JS 堆 3–7 MB，DOM 180–370 节点 | — | 切页签/后台时自动退订 |

> 口径提醒：任务管理器「内存」列是工作集（可被系统回收的共享页也算），「专用工作集/提交」才是私有量。
> 面板自身逻辑相对裸 Node 的增量只有 **~10 MB**；`start.ps1` 用 `--max-old-space-size=96` 给堆设硬上限。

**各模块的内存优化手段（已落地的）**

| 模块 | 手段 |
|---|---|
| 日志 | 固定容量环形缓冲（默认 3000 行 × 单行 8KB 截断）；无换行输出 64KB 强制收口；落盘异步 append + 4MB 轮转，**永不整文件读入**；历史回放用 `fd.read` 从尾部按 64KB 块回读 |
| WS | 60ms / 300 行批量成帧；**无人订阅时 publish 直接 return（零序列化开销）**；`writableLength > 512KB` 先丢帧、连续 8 次断开（1009），绝不让慢客户端把服务端堆吃穿 |
| 监控 | 采样器（PowerShell ~30MB）**按需拉起 + 空闲 2min 自动回收**；指标环形 900 点；面板每轮只查 4 个单实例 WMI 查询 |
| 路由 | 无中间件链、路由预编译成数组、每请求只分配 1 个 ctx；JSON >2KB 才 gzip（level 5） |
| 前端 | uPlot 而非 ECharts；控制台 DOM 上限 1200 行 + `content-visibility:auto`；页面不可见即退订并断 WS；KeepAlive 复用视图避免重建 DOM |
| 存储 | `PRAGMA cache_size=-600`（≈600KB 页缓存）；审计表保留 5000 行自动裁剪；WAL + `synchronous=NORMAL` |
| 交付 | 后端零依赖（没有 node_modules 常驻）；SEA 可把堆上限烘进 exe |

**再降一档的开关**（设置里就能改，不用改代码）
- 监控 → 磁盘采样器 = `off`：省掉 PowerShell 那 ~30MB，代价是没有磁盘 IO 与 java 进程级 CPU/RSS。
- 服务端 → 控制台缓冲行数：3000 → 800。
- 监控 → 历史点数：900 → 200。
- `data/settings.json` 的 `panel.serveStatic=false` + 全部交给 Nginx（省掉静态读文件与 gzip 缓存）。

---

## 八、API 一览

```
POST /api/login                 POST /api/logout            GET  /api/session
GET  /api/public-config         GET  /api/health            GET  /api/state
POST /api/server/{start,stop,kill,restart,crash-reset}
GET  /api/console?lines=        POST /api/console/send      POST /api/console/clear
GET  /api/console/history       GET  /api/metrics?n=        GET  /api/players
POST /api/rcon
GET  /api/files?dir=            GET/PUT /api/files/content  PUT  /api/files/upload?path=
DELETE /api/files?path=         POST /api/files/{mkdir,rename}   GET /api/files/download?path=
GET/PUT /api/properties         GET/PUT /api/settings       POST /api/settings/{validate,password}
GET  /api/oplog                 GET /api/import/detect      POST /api/import/runbat
WS   /ws   ← {"t":"sub","topics":["console","metrics","state","players","sampler"]}
```

---

## 九、已验证 / 未覆盖

**已验证**（`npm test` = 44 项端到端 + `node test/unit.js` = 42 项单测，全绿；
另用真实 Chromium 跑通全部 6 个页签、WS 实时推送与图表绘制，控制台零 JS 错误）：
零依赖后端、鉴权/CSRF/路径穿越/体积上限、启停/强杀/崩溃重启、ANSI+§ 渲染、GBK/UTF-8 自动判定、
流式上传 3MB 字节一致、properties 保注释回写、按需采样器、审计日志覆盖、WebSocket 握手/分片/心跳/背压、
以及**真实 NeoForge 1.21.1（67 模组、中文路径 `G:\服务端`、JDK 25）的完整启动—观测—优雅停止链路**。

**未在本机覆盖（目标机差异，见 `docs/WINDOWS-SERVER-2016.md`）**
- Windows Server 2016 实机运行（本机是 Win11）：1607 的 API 面、PS 5.1、WDAC/AppLocker 策略。
- RCON 真机往返（该实例 `enable-rcon=false`，未擅自改动生产配置；协议与多包重组已有单元覆盖 + mock 覆盖）。
- 真人进服时的玩家列表/加入退出日志解析（解析器有单测；面板已验证降级通道）。
- Node SEA 的 `postject` 注入步骤（需一次性 `npx postject`，脚本已把命令打印出来）。
