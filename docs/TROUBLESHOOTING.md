# 排障手册：控制台显示与服务端日志不一致

面向两类反馈：

1. **「面板控制台和 bat 双击出来的日志不一样」**（少一段 / 多一行 / 没有时间前缀 / 时间差 8 小时）
2. **「切换服务端后一直显示启动中，但 `<实例>\logs\latest.log` 明明写着 Done」**

---

## 一、一分钟定位

| 现象 | 大概率原因 | 怎么确认 |
|---|---|---|
| 控制台一片空白/长时间不刷新，日志文件却在写 | 解码/切行链路把文本扣住了（v1.0.0 前：`auto` 嗅探要攒满 64KB 才吐字） | `node test/capture-console-bytes.js <实例目录> <java.exe>`，看报告里的 `firstHighByteOffset`：`-1` = 整段输出零高位字节（纯英文服务端），旧实现就在这里卡死 |
| 状态一直「启动中」，但人已能进服 | 面板没在 stdout 里看到启动完成标记 | 控制台应有一条 `<panel> 未在 stdout 看到启动完成标记，已由 logs/latest.log 判定为运行中`；没有就说明 `settings.server.logFile` 指错了 |
| 面板比 bat 少 `[时间] [线程/级别] [logger/]:` | 面板旧实现把前缀从正文里删了（只留元数据） | 现在正文一字不改，前缀只**额外**抽成 `time`/`level`/`thread` 字段 |
| 面板比 bat 多一行 `Picked up JAVA_TOOL_OPTIONS: …` | 面板注入 JVM 选项后 java 的回显 | 已折叠，改为启动时一条 `<panel> 注入 JAVA_TOOL_OPTIONS=…` 说明 |
| 面板里出现 `WARNING: [stderr] java.lang.System::load …` 这种半行 | stdout/stderr 旧实现共用一条缓冲，两路输出被焊进行 | 现在两条流各自解码、各自留半行，来源记在 `src` 字段，正文不再插标记 |
| 中文模组名乱码 | 判定成 gbk 而实际输出 utf-8（或反之） | `/api/state` 的 `server.encoding`；不确定就在「设置」里显式选 `utf-8`，并在 `jvmArgs` 保留 `-Dstdout.encoding=UTF-8` |
| 切个标签页/上滚看一下，回来少了一段日志 | 前端「暂停滚动」旧实现只计数不缓存（行被丢弃） | 现在暂停期间的行进缓存，恢复滚动时并回 |
| 面板 `data/logs/panel-console.log` 与游戏日志时间差一个时区 | 落盘用 `toISOString()`（UTC） | 现在写本地时间，可与 `latest.log` 直接对齐 |

---

## 二、状态机怎么判断「已经起来了」

```
spawn → STARTING
   ├─ 每一行服务端输出 → looksStarted()（先剥 ANSI 再匹配）→ ONLINE
   │     匹配样本：Done (13.206s)! For help, type "help"（含中文月份前缀的文件日志行、
   │     带色服务端、Done（2.5秒）本地化形、Done (3,2s) 逗号小数、Bukkit 的 Start finished）
   ├─ 兜底：STARTING 期间每 3s 只读 server.logFile 中「本次启动之后新增」的尾部（≤64KB 窗口），
   │     命中同一批标记 → ONLINE，并打一条 <panel> 说明。文件比 start 时更小 = 已轮转，从头算。
   └─ 见到 Stopping server → STOPPING；进程退出 → OFFLINE（异常退出按退避自动重启）
```

要点：

- **兜底只读、不灌正文**。它只负责把状态推对，绝不把 `latest.log` 再打印一遍（否则控制台会双倍刷屏）。
- 兜底改状态一定在控制台留痕，不静默生效 —— 否则用户无法区分「真起来了」和「面板猜的」。
- 若实例的日志文件名不是默认的 `logs/latest.log`（例如自定义了 `logging.properties`），
  去「设置 → 服务端 → 日志文件」填对，否则兜底这条路等于关掉。

---

## 三、哪些差异是面板有意为之

看控制台时把这两类分开，能省掉大半「日志对不上」的困惑：

| 前缀 | 来源 | 说明 |
|---|---|---|
| `<panel> …` | 面板自己 | 启动命令、注入的 JVM 选项、优雅停止倒计时、崩溃重启退避、状态兜底说明 |
| `> 命令`（黄色） | 面板回显 | 你在网页里敲下去、写进服务端 stdin 的指令 |

除此之外，服务端 stdout/stderr 的每一行都与 bat 控制台逐字一致（含前缀、含色码渲染）。
面板的落盘文件 `data/logs/panel-console.log` 则是「面板视角的完整时间线」：每行行首再带一列
本地毫秒时间戳，便于与 WS 帧、审计日志对齐排查。

---

## 四、取证工具

```powershell
# 1) 按面板的方式拉起真实服务端，把 stdout/stderr 原始字节逐块落盘 + 出 JSON 报告
node test/capture-console-bytes.js E:\Desktop\1.20.1Forge G:\Java\openjdk-25.0.2\bin\java.exe
#    产物：test/out/console-probe/{stdout.bin,report.json}
#    世界目录被 --world 重定向到 probe-world，不碰实例里的 world/；端口用 25599 不抢 25565

# 2) 面板自身的端到端冒烟（含全 ASCII 启动、stdout 静默兜底两条回归）
node test/run.js
node test/unit.js
```

`report.json` 里最值钱的三个数：

- `bytesBeforeFirstHighByte`：多大字节之后才可能出现编码歧义。英文服务端常常是 `-1`（全程没有）。
- `ansiEscapeBytes`：这个环境到底有没有吐色码（JLine 探测到非 TTY 时全黑，`FORCE_COLOR=1` 也不保证生效）。
- `doneLines`：`Done` 行的**原文**，面板的匹配正则就是照它写的。
