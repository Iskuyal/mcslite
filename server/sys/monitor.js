'use strict';
/**
 * 系统指标采样器。
 *
 * 【为什么走 CIM 而不是 Get-Counter】
 * Get-Counter 的计数器路径会被系统语言本地化：中文 Windows Server 2016 上
 * `\Processor(_Total)\% Processor Time` 实际叫 `\处理器(_Total)\% 处理器时间`，
 * 硬编码英文路径直接抛「Cannot find path」。而 Win32_PerfFormattedData_* 这些
 * WMI/CIM 类名与属性名在所有语言版本里恒定 —— 这是 Windows 上唯一稳的中立做法。
 *
 * 【为什么单独养一个 PowerShell 子进程】
 * 每次采样 spawn 一个新 powershell.exe 会造成 CPU/内存锯齿（单次 ~35MB、启动 700ms）。
 * 这里改为常驻单进程循环输出 JSON 行，Node 侧只做增量读取；并且在
 * 「没有浏览器订阅」空闲若干分钟后自动回收，把这块内存还给系统。
 *
 * 【降级路径】PowerShell 不可用/被策略锁定时，仅用 node:os + fs.statfs 出系统级
 * 指标（CPU 需要 CIM，此时留空并把原因透出到 UI，而不是画一条假线）。
 */
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('../lib/config');
const { Ring } = require('../lib/ring');
const { DATA } = require('../lib/paths');

/** PS 脚本正文内嵌在 JS 里：Node SEA 单文件分发时外部 .ps1 不存在，必须自带。
 *
 * 分工原则（实测调优的结果）：
 *   PowerShell 只当「一次性 WMI 取数器」——每轮查四个单实例查询并吐一行 JSON，
 *   不持有任何跨轮状态；CPU% 需要两次采样差值，那个状态放在 Node 侧算
 *   （可单测、可跨采样器重启保持一致，实测放 PS 里时 procCpu 会整轮丢失）。
 *
 * 取值来源：
 *   · 整机 CPU / 磁盘 IO：PerfOS_Processor(_Total)、PerfDisk_PhysicalDisk(_Total) —— 单实例，毫秒级
 *   · 进程 CPU 时间片与内存：Win32_Process（按 ProcessId 过滤，稳且便宜）
 *     UserModeTime/KernelModeTime 单位是 100ns，累加成 procTicks 交给 Node 做差值
 *   · 每进程磁盘 IO 只能从 Win32_PerfFormattedData_PerfProc_Process 拿，而它要枚举全系统
 *     几百个进程实例、高负载下经常静默返回空 → 面板不依赖它（见 docs 的 Windows 限制说明），
 *     只展示整机磁盘 IO。要恢复可把下面 ioEvery 段打开。
 */
const SAMPLER_PS = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$out = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput())
$out.AutoFlush = $true
$targetPid = 0; $interval = 3000
if ($args.Count -ge 1) { [void][int]::TryParse([string]$args[0], [ref]$targetPid) }
if ($args.Count -ge 2) { [void][int]::TryParse([string]$args[1], [ref]$interval) }
$cores = 1
$cs = Get-CimInstance -ClassName Win32_ComputerSystem
if ($cs -and $cs.NumberOfLogicalProcessors) { $cores = [int]$cs.NumberOfLogicalProcessors }
while ($true) {
  $o = [ordered]@{ ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
  $p = Get-CimInstance -ClassName Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'"
  if ($p) { $o.cpu = [math]::Round([double]$p.PercentProcessorTime, 1) }
  $mem = Get-CimInstance -ClassName Win32_OperatingSystem
  if ($mem) { $o.memTotal = [int64]$mem.TotalVisibleMemorySize * 1024; $o.memFree = [int64]$mem.FreePhysicalMemory * 1024 }
  $disk = Get-CimInstance -ClassName Win32_PerfFormattedData_PerfDisk_PhysicalDisk -Filter "Name='_Total'"
  if ($disk) { $o.diskRead = [int64]$disk.DiskReadBytesPersec; $o.diskWrite = [int64]$disk.DiskWriteBytesPersec }
  if ($targetPid -gt 0) {
    $pr = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId=$targetPid"
    if ($pr) {
      # cumulative CPU time slices in 100ns units; deltas are computed on the Node side
      $o.procTicks = [int64]$pr.UserModeTime + [int64]$pr.KernelModeTime
      $o.procRss = [int64]$pr.WorkingSetSize
      $o.procPriv = [int64]$pr.PrivatePageCount
      $o.procThreads = [int]$pr.ThreadCount
      $o.procHandle = [int]$pr.HandleCount
    }
  }
  $out.WriteLine((ConvertTo-Json -InputObject $o -Compress))
  Start-Sleep -Milliseconds $interval
}
`;

const SAMPLER_FILE = path.join(DATA, 'sampler.ps1');

class Monitor extends EventEmitter {
  constructor() {
    super();
    const m = config.get().monitor;
    this.ring = new Ring(Math.min(Math.max(m.history | 0, 60), 7200));
    this.pid = null;
    this.subs = 0;
    this.child = null;
    this.stdoutBuf = '';
    this.timer = null;
    this.idleTimer = null;
    this.samplerState = 'idle';       // idle | starting | running | degraded | off
    this.samplerError = null;
    this._lastCimTs = 0;              // 最近一次真正拿到采样器数据的时间（冻结检测）
    this.interval = Math.max(+m.intervalMs || 3000, 1000);
    this.last = null;
    this.fallbackTimer = null;
    this._cores = os.cpus().length;
    this._prevCpu = os.cpus();        // 复用数组，避免每次采样重新分配
    this._prevTicks = null;           // 进程 CPU 时间片基准（100ns）
    this._prevTicksTs = 0;
    this._diskTotal = 0;
  }

  setPid(pid) {
    const changed = (this.pid || 0) !== (pid || 0);
    this.pid = pid || null;
    this._prevTicks = null;           // 换进程必须重建基准，否则第一遍会算出天文数字
    if (changed && this.child) this._restartSampler();   // PID 变了要重传参数
  }

  addSubscriber() {
    this.subs++;
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    this._ensureRunning();
  }

  removeSubscriber() {
    this.subs = Math.max(0, this.subs - 1);
    if (this.subs === 0) {
      const idleMs = config.get().monitor.samplerIdleMs || 120000;
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => { this.idleTimer = null; if (this.subs === 0) this._stopSampler(); }, idleMs);
      this.idleTimer.unref?.();
    }
  }

  resizeRing(cap) {
    const keep = this.ring.toArray().slice(-cap);
    this.ring = new Ring(cap);
    for (const k of keep) this.ring.push(k);
  }

  _ensureRunning() {
    if (!this.timer) {
      this.timer = setInterval(() => this._tick(), this.interval);
      this.timer.unref?.();
    }
    const mode = config.get().monitor.diskSampler;
    if (mode === 'off') { this.samplerState = 'off'; return; }
    if (!this.child && this.subs > 0) this._startSampler();
  }

  _restartSampler() { if (this.child) { this._stopSampler(true); this._startSampler(); } }

  /** 轻量系统级采样：os 模块即可，无需外部进程 */
  _tick(source = 'timer') {
    // 采样器活着且**确实在吐数据**时以 CIM 为准（避免同周期出两条、时间轴疏密不均）。
    // 关键：只看 state 不够 —— PowerShell 卡住时 state 仍是 running，指标就会永久冻结，
    // 所以再加一个「最近一次拿到数据的时间」兜底，超时则由本地计时器继续出点。
    const cimFresh = this.samplerState === 'running' && (Date.now() - this._lastCimTs) < this.interval * 3;
    if (source === 'timer' && cimFresh) return;
    try {
      const sample = { ts: Date.now(), sys: {}, proc: {}, disk: {} };
      sample.sys.memTotal = os.totalmem();
      sample.sys.memFree = os.freemem();
      sample.sys.memUsed = os.totalmem() - os.freemem();
      sample.sys.cpu = this._cpuFromOs();
      sample.sys.load = os.loadavg ? os.loadavg()[0] : null;   // Windows 恒为 0，不参与展示
      sample.sys.panelRss = process.memoryUsage.rss();          // 面板自身占用，便于自证「低内存」
      const free = this._diskSpace();
      if (free) { sample.disk.free = free.free; sample.disk.total = free.total; sample.disk.usedPct = free.pct; }
      this._flush(sample);
    } catch (e) {
      this.samplerError = e.message;
    }
  }

  /** os.cpus() 差值法算系统 CPU（Windows 上比 loadavg 可靠） */
  _cpuFromOs() {
    const cur = os.cpus();
    let idle = 0, total = 0;
    for (let i = 0; i < cur.length; i++) {
      const a = cur[i].times, b = this._prevCpu[i] && this._prevCpu[i].times;
      if (!b) continue;
      idle += a.idle - b.idle;
      total += (a.user - b.user) + (a.nice - b.nice) + (a.sys - b.sys) + (a.idle - b.idle) + (a.irq - b.irq);
    }
    this._prevCpu = cur;
    if (total <= 0) return null;
    return Math.round((1 - idle / total) * 1000) / 10;
  }

  _diskSpace() {
    const root = config.get().server.root;
    try {
      const st = fs.statfsSync ? fs.statfsSync(root || process.cwd()) : null;
      if (!st) return null;
      const total = st.bsize * st.blocks, free = st.bsize * st.bavail;
      return { free, total, pct: total ? Math.round((1 - free / total) * 1000) / 10 : null };
    } catch { return null; }
  }

  _flush(sample) {
    // 合并采样器侧的字段（procCpu / procRss / diskRead…）到统一结构
    const c = this._cim || {};
    sample.sys.cpuCim = c.cpu ?? null;
    if (c.memTotal) { sample.sys.memTotal = c.memTotal; sample.sys.memFree = c.memFree; sample.sys.memUsed = c.memTotal - c.memFree; }
    sample.proc.pid = this.pid || null;
    sample.proc.cpu = c.procCpu ?? null;
    sample.proc.rss = c.procRss ?? null;
    sample.proc.private = c.procPriv ?? null;
    sample.proc.threads = c.procThreads ?? null;
    sample.proc.handles = c.procHandle ?? null;
    sample.proc.ioRead = c.procRead ?? null;
    sample.proc.ioWrite = c.procWrite ?? null;
    sample.proc.ioStaleMs = c.procIoStaleMs ?? null;
    sample.disk.read = c.diskRead ?? null;
    sample.disk.write = c.diskWrite ?? null;
    sample.meta = { cimAgeMs: this._lastCimTs ? Date.now() - this._lastCimTs : null };
    // 顶层 cpu/mem 是图表的「主指标」：优先服务端进程，取不到再退整机
    // （0 是合法值，必须用 ?? 而不是 ||，否则 0% CPU 会被当成缺失）
    sample.cpu = sample.proc.cpu ?? sample.sys.cpuCim ?? sample.sys.cpu;
    sample.mem = sample.proc.rss ?? sample.sys.memUsed;
    this.ring.push(sample);
    this.last = sample;
    this.emit('sample', sample);
  }

  // ————————————— PowerShell 常驻子进程 —————————————
  _startSampler() {
    if (this.child) return;
    // 【Windows 大坑】PowerShell 5.1 读 .ps1 时，没有 UTF-8 BOM 就按系统 ANSI(中文机=GBK) 解析。
    // 一旦脚本里有非 ASCII 字符，注释会乱码并可能吞掉换行，把下一行代码一起注释掉
    // ——实测就是这样悄悄丢掉了 procTicks 字段。因此：载荷保持纯 ASCII + 写盘带 BOM，双保险。
    if (/[^\x00-\x7f]/.test(SAMPLER_PS)) console.warn('[monitor] 采样器脚本含非 ASCII 字符，已带 BOM 写出以避免 PS 5.1 误码');
    try { fs.writeFileSync(SAMPLER_FILE, '\ufeff' + SAMPLER_PS, 'utf8'); }
    catch (e) { this._degrade('无法写出采样脚本：' + e.message); return; }
    let child;
    try {
      child = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', SAMPLER_FILE, String(this.pid || 0), String(this.interval),
      ], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });
    } catch (e) { this._degrade('powershell 启动失败：' + e.message); return; }

    this.child = child;
    this.samplerState = 'starting';
    this.stdoutBuf = '';
    child.stdout.on('data', (d) => this._onSamplerData(d));
    let stderrText = '';
    child.stderr.on('data', (d) => { stderrText = (stderrText + d.toString('utf8')).slice(-4000); });
    child.on('error', (e) => { this.child = null; this.samplerState = 'degraded'; this._degrade('采样器进程错误：' + e.message); });
    child.on('exit', (code) => {
      this.child = null;
      if (this.subs > 0 && this.samplerState !== 'off') {
        this.samplerState = 'degraded';
        this._degrade(`采样器退出(code=${code})${stderrText ? '：' + stderrText.slice(-200) : ''}`);
        setTimeout(() => { if (this.subs > 0 && !this.child) this._startSampler(); }, 15000).unref?.();
      } else this.samplerState = 'idle';
    });
    setTimeout(() => {
      if (this.child === child && this.samplerState === 'starting') this._degrade('采样器 12s 内无数据（可能被 AppLocker/WDAC 或组策略拦下 PowerShell）');
    }, 12000).unref?.();
  }

  _onSamplerData(d) {
    this.stdoutBuf += d.toString('utf8');
    if (this.stdoutBuf.length > 256 * 1024) this.stdoutBuf = this.stdoutBuf.slice(-32 * 1024);   // 有界，防单块爆炸
    let nl;
    while ((nl = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, nl).replace(/\r$/, '');
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      if (!line || line[0] !== '{') continue;
      let obj = null;
      try { obj = JSON.parse(line); } catch { continue; }
      this._cim = obj;
      this._applyCpuDelta(obj);
      this._lastCimTs = Date.now();
      if (this.samplerState !== 'running') { this.samplerState = 'running'; this.samplerError = null; this.emit('sampler', this.samplerStatus()); }
      this._tick('cim');                              // CIM 数据到达即产出一条完整样本
    }
  }

  /** 进程 CPU% = Δ(100ns 时间片) / Δ墙钟(100ns)，先算「占满几核」再除以核数归一到整机 0~100%。
   *  放在 Node 侧而不是 PowerShell 里：状态可测、采样器重启也不会丢第一轮的基准。 */
  _applyCpuDelta(o) {
    const now = o.ts || Date.now();
    if (typeof o.procTicks !== 'number' || !Number.isFinite(o.procTicks)) { this._prevTicks = null; return; }
    if (typeof this._prevTicks === 'number' && now > this._prevTicksTs) {
      const dTicks = o.procTicks - this._prevTicks;
      const d100ns = (now - this._prevTicksTs) * 1e4;        // ms → 100ns
      if (dTicks >= 0 && d100ns > 0) {
        const pct = (dTicks / d100ns) * 100 / (this._cores || 1);
        o.procCpu = Math.round(Math.min(Math.max(pct, 0), 100) * 10) / 10;
      }
    }
    this._prevTicks = o.procTicks;
    this._prevTicksTs = now;
  }

  _degrade(msg) {
    this.samplerError = msg;
    this.samplerState = 'degraded';
    this.emit('sampler', this.samplerStatus());
  }

  _stopSampler(silent) {
    if (!this.child) { this.samplerState = 'idle'; return; }
    const c = this.child;
    this.child = null;
    this.samplerState = this.subs > 0 ? 'starting' : 'idle';
    try { c.kill(); } catch { /* 已退出 */ }
    if (!silent) this.emit('sampler', this.samplerStatus());
  }

  samplerStatus() {
    return {
      state: this.samplerState, error: this.samplerError, subs: this.subs, cores: this._cores,
      lastDataMs: this._lastCimTs ? Date.now() - this._lastCimTs : null,   // >3×间隔即说明采样器哑了
      pid: this.pid || null,
    };
  }

  /** 供 /api/metrics 首屏与 WS 订阅初始同步 */
  series(n = 300) {
    const rows = this.ring.last(Math.min(n, this.ring.cap));
    return rows.map((s) => ({
      ts: s.ts, cpu: s.cpu ?? null, procCpu: s.proc.cpu ?? null, sysCpu: s.sys.cpuCim ?? s.sys.cpu ?? null,
      mem: s.mem ?? null, procRss: s.proc.rss ?? null, sysMemUsed: s.sys.memUsed ?? null, sysMemTotal: s.sys.memTotal ?? null,
      ioRead: s.disk.read ?? null, ioWrite: s.disk.write ?? null,
      procIoRead: s.proc.ioRead ?? null, procIoWrite: s.proc.ioWrite ?? null,
      diskFree: s.disk.free ?? null, diskTotal: s.disk.total ?? null, panelRss: s.sys.panelRss ?? null,
    }));
  }

  latest() { return this.last; }

  shutdown() { this._stopSampler(true); if (this.timer) clearInterval(this.timer); this.timer = null; }
}

module.exports = { Monitor, SAMPLER_FILE, SAMPLER_PS };
