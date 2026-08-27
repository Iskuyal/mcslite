# 内存优化手册（MCSLite）

首要目标是**低内存占用**。这篇讲三件事：数字怎么读、钱花在哪、以及怎么让它长期不涨。

---

## 一、先统一口径：Windows 上「内存」有四种

面板 UI、任务管理器、性能计数器说的经常不是同一件事：

| 名称 | 含义 | 面板里的位置 |
|---|---|---|
| `rss` / WorkingSet | 当前驻留在物理内存的页，**含可被系统回收的共享页**，会随负载波动 | 顶栏紫色徽章、`/api/health` |
| Private bytes / 专用工作集 | 进程独占提交量，更接近「真正要付的钱」 | 指标样本 `panelRss` 对照用（WMI `PrivatePageCount`） |
| `heapUsed` | V8 JS 堆中活对象 | `/api/state.runtime.heapUsed` |
| `--max-old-space-size` | 老生代上限，是**天花板**不是占用 | 由 `start.ps1` / SEA execArgv 设定 |

**本项目实测**（同机 Win11 26100 / Node 24.16 / 32GB）：

| 场景 | WorkingSet | Private | heapUsed |
|---|---|---|---|
| 裸 `node:http` 空服务（地板） | 55.3 MB | — | 4.7 MB |
| 面板空闲、无浏览器订阅（采样器已回收） | **20.8 MB** | 60.6 MB | ~7 MB |
| 面板 + 1 个浏览器订阅 + 真实 NeoForge 在跑 | 58–62 MB | ~70 MB | 7.6 MB |

结论：**面板自身逻辑的增量只有 ~10 MB**。空闲时 WorkingSet 反而低于刚启动的裸 Node，
是因为 V8 GC 后把空闲页归还给了系统 —— 这也是为什么用单一数字比大小容易骗自己，
要么三个口径一起看，要么和「同机裸进程地板」对照看。

---

## 二、预算怎么分（面板总开销的构成）

```
Node 运行时地板            ~20–55 MB   ← 任何 Node 方案都躲不掉
JS 堆（缓冲/订阅表/语句）   ~5–12 MB   ← 唯一真正可控的部分，靠"有界"三件套
PowerShell 采样器子进程      ~30 MB    ← 按需拉起、空闲 2min 回收 ⇒ 平时为 0
node:sqlite / WAL 页         ~1 MB    ← PRAGMA cache_size=-600
```

Python 方案对照：FastAPI + uvicorn + websockets + pydantic 树空转 60–90 MB，
且没有内置 SQLite 之外的"零依赖"退路 —— 这是选型时放弃它的主要原因之一。

---

## 三、"有界"三件套（所有长期运行服务的必修课）

内存不涨的关键不是"少用"，而是**每一条可能变长的路径都必须有硬上限**。本项目逐条：

| 路径 | 不封顶的后果 | 封顶手段 | 位置 |
|---|---|---|---|
| 控制台日志 | 服务端刷 10 万行 ⇒ OOM | 环形缓冲（默认 3000 行）+ 单行 8KB 截断 + 无换行 64KB 强制收口 + 单块 >400 行合并 | `lib/ring.js`、`mc/proc.js` |
| 历史日志回放 | 有人 `readFile(debug.log)`（真机 16MB，常见数百 MB） | 从文件尾按 64KB 块回读，最多 5000 行 / 8MB | `api/routes.js#tailFile` |
| WS 慢客户端 | 一个卡死的浏览器让写队列无限增长 | `writableLength > 512KB` 先丢帧，连续 8 次直接断开（1009） | `lib/ws.js` |
| WS 广播风暴 | 每行一帧 ⇒ 序列化与 syscall 打满 | 60ms / 300 行批量成帧；**无人订阅直接 return** | `lib/hub.js` |
| 文件上传 | 一个 2GB 地图包进堆 | `req.pipe(writeStream)`，堆里只有 chunk | `lib/http.js#pipeToFile` |
| 指标序列 | 跑一周图表变几 MB | 环形 900 点，`series()` 只导出 600，渲染层再切 400 | `sys/monitor.js` |
| 解码暂存 | auto 判定期间无限缓存 | 64KB 未判定即强制按 UTF-8 定案 | `lib/decode.js` |
| 审计日志 | sqlite 无限增长 | 每次插入后裁剪到 5000 行 | `lib/store.js` |
| 登录限速表 | 被刷 IP 撑爆 Map | 容量 2048 + 过期压实 | `lib/auth.js` |
| gzip 缓存 | 每个 etag 一份压缩结果 | LRU 20 条上限 | `lib/static.js` |
| 目录列表 | 一个 10 万文件的目录 | 截断 3000 条 + `truncated` 标记 | `sys/files.js` |
| 递归统计体积 | 大世界扫爆 CPU/堆 | 有界遍历 20000 条 + 提前返回 | `sys/files.js#treeSize` |
| 文件路径解析 | symlink 逃逸后读任意文件 | resolve + 前缀校验 + realpath 二次校验 | `sys/files.js#resolveIn` |

---

## 四、按需负载（第二有效的省法）

不是"优化得更快"，而是"没人看的时候什么都不做"：

1. **采样器子进程按需启停** —— 第一个浏览器订阅才 spawn PowerShell；
   最后一个退订后空闲 `samplerIdleMs`(默认 120s) 才回收。空闲面板不养 30MB 的 PS。
2. **topic 订阅制** —— 只订阅 `console` 的客户端，永远不会触发指标序列化和玩家轮询。
3. **RCON 轮询与订阅绑定** —— `players` 无人订阅就不发 `list`（服务端零打扰）。
4. **页面可见性联动** —— 标签页切后台 → 前端 `unsub('metrics','players')`，
   服务器侧随之自动进入回收倒计时。手机切走 = 全链路停手。
5. **浏览器侧自保** —— 控制台 DOM 上限 1200 行 + `content-visibility: auto`；
   图表只喂最近 400 点；`KeepAlive` 复用视图避免整棵子树重建（实测切页 JS 堆稳定在 3–7MB）。

---

## 五、可调旋钮（不改代码）

| 旋钮 | 默认 | 影响 |
|---|---|---|
| 服务端 → 控制台缓冲行数 `maxLines` | 3000 | 3000 行约 1–2MB；50000 行约 30MB |
| 监控 → 磁盘采样器 `diskSampler` | auto | 设 `off` 直接省掉 ~30MB PS 子进程（代价：无 java 进程级 CPU/RSS/磁盘 IO） |
| 监控 → 历史点数 `history` | 900 | 每点约 200B，砍到 200 省 ~140KB（意义不大，主要是别让它无界） |
| 监控 → 采样间隔 `intervalMs` | 3000 | 拉长到 5000 降低 WMI 查询频率与 CPU |
| 面板 → `serveStatic` | true | 关掉后静态文件全交 Nginx，省掉读文件 + 有界 gzip 缓存 |
| 启动参数 | `--max-old-space-size=96` | 堆硬上限。出问题宁可 OOM 快速失败重启，也不让面板吃掉游戏服务器的内存 |

---

## 六、怎么验证它确实没在漏

```powershell
# 1) 面板自报：连续观察 panelRss 与 heapUsed（UI 顶栏也有紫色 MB 徽章）
curl.exe -s http://127.0.0.1:8787/api/health      # rss / uptime

# 2) 压力回归：刷日志 + 反复开关订阅，看 WorkingSet 是否回落
node test\run.js                                   # 44 项端到端内含 RSS 断言

# 3) 外部对照（别只信面板自己说的）
Get-Process -Id <面板PID> | Select WorkingSet64,PrivateMemorySize64
```

判据：**空载 → 订阅 → 取消订阅 → 空载**，第三次空载的 WorkingSet 应与第一次同量级
（本项目实测都会回落，因为环形缓冲与 PS 子进程都是定容/可回收的）。
真实服务端 67 模组启动期 1181 行日志灌进来，面板 RSS 稳定在 58–62MB 不继续爬升。

---

## 七、如果还要更省

- 换**更少的订阅**：仪表盘页不订 `console`，日志按需拉 `/api/console?lines=`。
- `diskSampler='off'` + `maxLines=800` + `history=200`：面板回到"只当遥控器"的状态。
- 极端路线（本项目未做，收益/风险比不划算）：把面板写成纯 `node:sqlite` + HTTP 长轮询、
  去掉 PowerShell 采样器，只留 `node:os` 的 CPU/内存 —— 可再省 ~30MB，但失去 java 进程级指标。
