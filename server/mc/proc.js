'use strict';
/**
 * Minecraft 服务端进程管理 —— 整个面板的心脏。
 *
 * 【为什么不用 node-pty（关键决策）】
 * node-pty 依赖 Windows ConPTY（CreatePseudoConsole），该 API 自 Windows 10
 * build 17073 / Server version 1809 起才有。Windows Server 2016 是 build 1607，
 * **不存在 ConPTY**，node-pty 只能退回 winpty 老实现：需要交互桌面会话、在
 * 服务/计划任务(Session 0)下经常直接失败，且官方 prebuild 不覆盖 Node 24 ABI。
 * 而 Minecraft 服务端根本不需要 TTY：它以 `nogui` 运行，stdin/stdout 就是普通
 * 管道，日志里的 ANSI 颜色码照样输出。所以这里用纯 child_process.spawn + 管道，
 * 兼容性 100%，还省掉 node-gyp 工具链。
 *
 * 【命令注入防线】
 * 全文件不存在任何 shell:true / exec(字符串) 路径：
 *   - 启动 = spawn(exePath, argvArray, {shell:false})
 *   - 强杀 = execFile('taskkill.exe', ['/PID', pid, ...])（pid 是数字，参数化传递）
 *   - 控制台输入只写入已运行进程的 stdin，永不落进 shell
 */
const { EventEmitter } = require('node:events');
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const config = require('../lib/config');
const { StreamDecoder } = require('../lib/decode');
const { Ring } = require('../lib/ring');
const { ansiToHtml, detectLevel, stripPrefix, stripAnsi } = require('../lib/ansi');
const { LOGS } = require('../lib/paths');

const PARTIAL_CAP = 64 * 1024;   // 单行未收口的上限，防无换行输出把堆撑爆
const LINE_MAX = 8 * 1024;       // 单行长度上限（崩溃报告里的超长堆栈截断即可）
const LINE_BATCH = 2000;         // 一次事件循环最多切这么多行；超出就让出循环继续切（绝不合并）
const PROBE_EVERY_MS = 3000;     // 「还在启动」时对服务端日志文件的兜底轮询间隔
const PROBE_MAX_MS = 30 * 60 * 1000;
const PROBE_WINDOW = 64 * 1024;  // 兜底轮询每次最多回看的字节数

/** 面板注入给 java 的 JVM 选项（java 会把它回显成一行 Picked up 噪声，见下） */
const INJECTED_JVM_OPTS = '-Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8';
/** java 自己打印的「我收到了环境变量」回显行 —— bat 启动时不存在，属面板造成的差异 */
const PICKED_UP_RE = /^Picked up (?:JAVA_TOOL_OPTIONS|JDK_JAVA_OPTIONS|_JAVA_OPTIONS|JAVA_OPTS):/i;

/**
 * 「启动完成」标记。样本全部来自真实服务端：
 *   vanilla/Forge/NeoForge: Done (13.206s)! For help, type "help"
 *   部分核心本地化分支把括号/秒数改了形；Bukkit 系另有一句 Start finished
 * 匹配前一律先 stripAnsi —— 带色服务端的 \x1b 会插在词中间，不剥就永远匹配不上。
 */
const ONLINE_MARKS = [
  /Done[ (（]*\(\s*\d+(?:[.,]\d+)?\s*s?\s*[)）]\s*!?\s*For help/i,
  /Done[^\n"]{0,32}type\s+["']?help/i,
  /Done\s*[（(]\s*[\d.,]+\s*(?:s|秒)?\s*[)）]/i,
  /Start finished/i,
];
function looksStarted(line) {
  if (!line) return false;
  // 先做两次 indexOf 廉价排除，别对每一行日志都跑 4 个正则
  if (line.indexOf('one') < 0 && line.indexOf('inished') < 0) return false;
  const t = stripAnsi(line);
  for (const re of ONLINE_MARKS) if (re.test(t)) return true;
  return false;
}

const STATE = { OFFLINE: 'offline', STARTING: 'starting', ONLINE: 'online', STOPPING: 'stopping' };

class MinecraftProcess extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(64);
    this.child = null;
    this.state = STATE.OFFLINE;
    this.startedAt = 0;
    this.exitInfo = null;
    this.ring = new Ring(config.get().server.maxLines);
    this.decoder = null;                 // stdout 解码器（两条流各自一条，绝不共用）
    this.decoderErr = null;              // stderr 解码器
    this.partialOut = '';                // stdout 未收口的半行
    this.partialErr = '';                // stderr 未收口的半行
    this.partialBytes = 0;
    this.seq = 0;
    this.intentionalStop = false;
    this.restartTimer = null;
    this.crashStreak = 0;
    this.players = new Set();          // 日志解析降级用的在线玩家集合
    this.lineSink = null;              // 面板侧日志落盘
    this.lastErrorTail = '';
    this._probe = null;                // 「卡在启动中」的兜底轮询状态
    this._probeTimer = null;
  }

  /** 环形缓冲按配置重建（改 maxLines 后调用） */
  resizeRing(cap) {
    const old = this.ring.toArray().slice(-cap);
    this.ring = new Ring(cap);
    for (const l of old) this.ring.push(l);
  }

  status() {
    const cfg = config.get().server;
    return {
      state: this.state,
      running: this.state !== STATE.OFFLINE,
      pid: this.child ? this.child.pid : null,
      uptimeMs: this.child ? Date.now() - this.startedAt : 0,
      startedAt: this.startedAt || null,
      lastExit: this.exitInfo,
      jar: cfg.jarName,
      root: cfg.root || '(未配置)',
      encoding: this.decoder ? this.decoder.encoding : null,
      lineCount: this.ring.size,
      crashStreak: this.crashStreak,
      onlinePlayers: this.players.size,
    };
  }

  recent(n = 300) { return this.ring.last(n); }

  clearBuffer() { this.ring.clear(); this._emit('clear', null); }

  /** 面板自己产生的系统行（不来自 java，用于提示/告警） */
  sysLine(text, level = 'sys') {
    return this._pushLine(text, { sys: true, level });
  }

  // —————————————————————— 启动 ——————————————————————
  start({ reason = 'manual' } = {}) {
    if (this.child) throw new Error('服务端已在运行');
    const cfg = config.get().server;
    const root = cfg.root && fs.existsSync(cfg.root) ? cfg.root : config.get().server.root;
    if (!root || !fs.existsSync(root)) throw new Error(`服务端目录不存在：${root || '(未配置)'}（请到「设置」里指定实例目录）`);

    let file, args;
    if (cfg.launcher === 'command') {
      const argv = config.tokenize(cfg.startCommand);
      file = argv.shift();
      args = argv;
    } else {
      file = cfg.javaPath;
      args = [...config.tokenize(cfg.jvmArgs), '-jar', cfg.jarName, ...config.tokenize(cfg.mcArgs)];
    }
    if (!file) throw new Error('启动命令为空');

    // 注意：windowsHide 阻止黑框弹窗；cwd 决定相对 jar 路径的解析基准
    let child;
    try {
      child = spawn(file, args, {
        cwd: root,
        shell: false,                       // ← 绝不过 shell（含空格路径由 libuv 自动加引号）
        windowsHide: true,
        detached: false,                    // 与面板同生命周期，避免孤儿 java 进程
        env: buildEnv(cfg),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      throw new Error(`spawn 失败：${e.message}`);
    }

    this.child = child;
    this.state = STATE.STARTING;
    this.startedAt = Date.now();
    this.exitInfo = null;
    this.intentionalStop = false;
    this.decoder = new StreamDecoder(cfg.consoleEncoding);
    this.decoderErr = new StreamDecoder(cfg.consoleEncoding);
    this.partialOut = '';
    this.partialErr = '';
    this.partialBytes = 0;
    this._attachStdio(child, root);
    this._openSink();
    this._pushLine(`<panel> 启动：${file} ${args.join(' ')}`.trim(), { sys: true, level: 'sys' });
    // java 收到 JAVA_TOOL_OPTIONS 会回显一行 Picked up…（bat 启动时没有这行）。面板把那句
    // 回显折叠掉，改成启动时这一条说明 —— 不隐瞒注入，也不让它混进服务端正文。
    this._pushLine(`<panel> 注入 JAVA_TOOL_OPTIONS=${INJECTED_JVM_OPTS}（java 的 Picked up 回显行已折叠，不计入服务端日志）`, { sys: true, level: 'sys' });
    this._armStartProbe(root, cfg);
    this._emit('status', this.status());

    child.on('error', (e) => {
      // ENOENT（javaPath 写错）在这里报到，不会抛未捕获异常拖垮面板
      this._pushLine(`<panel> 进程错误：${e.message}（检查 javaPath 与实例目录）`, { sys: true, level: 'error' });
      this.lastErrorTail = e.message;
    });
    child.on('exit', (code, signal) => this._onExit(code, signal, reason, file, args));
    return { pid: child.pid, command: [file, ...args] };
  }

  _attachStdio(child, root) {
    // stdout / stderr 各自一条解码器 + 一条半行缓冲：
    // 两条管道交替到达，共用缓冲会把「stderr 的前半句」和「stdout 的后半句」焊成一行，
    // 这正是面板日志与服务端控制台正文对不上的原因之一（实测 Java 25 的 Unsafe 警告就被切断）。
    const feed = (isErr, buf) => {
      const dec = isErr ? this.decoderErr : this.decoder;
      let text;
      try { text = dec ? dec.push(buf) : buf.toString('utf8'); } catch { text = buf.toString('utf8'); }
      this.partialBytes += buf.length;
      if (!text) { this._drain(isErr); return; }
      if (isErr) this.partialErr += text; else this.partialOut += text;
      this._drain(isErr);
    };
    child.stdout.on('data', (b) => feed(false, b));
    child.stderr.on('data', (b) => feed(true, b));
    const finish = (isErr) => {
      const dec = isErr ? this.decoderErr : this.decoder;
      let t = '';
      try { t = dec ? dec.end() : ''; } catch { /* 已收尾 */ }
      if (t) { if (isErr) this.partialErr += t; else this.partialOut += t; }
      this._drain(isErr);
    };
    child.stdout.on('end', () => finish(false));
    child.stderr.on('end', () => finish(true));
  }

  /** 把缓冲里的完整行逐条推出去；一次太多就让出事件循环接着切，绝不把剩余合并成一行 */
  _drain(isErr) {
    let s = isErr ? this.partialErr : this.partialOut;
    const src = isErr ? 'stderr' : 'stdout';
    let nl;
    let count = 0;
    while ((nl = s.indexOf('\n')) >= 0) {
      let line = s.slice(0, nl);
      s = s.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      this._pushLine(line, { src });
      if (++count >= LINE_BATCH) {
        if (isErr) this.partialErr = s; else this.partialOut = s;
        setImmediate(() => this._drain(isErr));           // 剩余留在缓冲里排队，顺序不变
        return;
      }
    }
    if (isErr) this.partialErr = s; else this.partialOut = s;
    if (s.length > PARTIAL_CAP) {                        // 长期无换行 → 强制收口，保内存
      this._pushLine(s.slice(0, LINE_MAX) + ' …[截断]', { src });
      if (isErr) this.partialErr = ''; else this.partialOut = '';
    }
  }

  /** 进程收尾：把两条流各自残留的半行吐干净（否则最后一行会静默消失） */
  _flushPartials() {
    for (const isErr of [false, true]) {
      const key = isErr ? 'partialErr' : 'partialOut';
      const rest = this[key];
      if (rest) {
        this[key] = '';
        this._pushLine(rest.replace(/\r/g, ''), { src: isErr ? 'stderr' : 'stdout' });
      }
    }
  }

  /** 一行日志的完整管线：环形缓冲 + 事件广播 + 落盘 + 状态/玩家解析 */
  _pushLine(raw, meta = {}) {
    if (raw === undefined || raw === null) return;
    const stripped = stripPrefix(raw);
    // java 对面板注入的 JAVA_TOOL_OPTIONS 的回显：不是服务端输出，折叠掉（启动时已用一条
    // <panel> 行说明过，做到不隐瞒；bat 启动没有这行，留着就成了面板特有的噪声）
    if (!meta.sys && PICKED_UP_RE.test(stripAnsi((stripped && stripped.rest) || raw))) return;
    // 正文一字不动：前缀 [时间] [线程/级别] [logger/] 只用于抽 time/level 元数据。
    // 旧实现在这里把前缀从文本里删掉，于是「面板显示的日志」天然比 bat 控制台的少一截，
    // 排查时对不上号 —— 抽元数据和改正文是两件事，不能混着做。
    const clean = String(raw).replace(/\0/g, '');
    const time = stripped ? stripped.time : new Date().toTimeString().slice(0, 8);
    // 级别优先取显式 meta，再取 MC 前缀里的 [thread/LEVEL]，最后兜底正文关键字
    const level = meta.level || (stripped && stripped.level ? stripped.level.toLowerCase() : null) || detectLevel(clean) || null;
    const body = clean.length > LINE_MAX ? clean.slice(0, LINE_MAX) + ' …[截断]' : clean;
    const item = {
      i: ++this.seq,
      t: Date.now(),
      time,
      level,
      src: meta.sys ? 'panel' : (meta.src || 'stdout'),   // 流来源：文本里不再插 [stderr] 标记
      raw: body,
      html: ansiToHtml(body),
    };
    this.ring.push(item);
    this._emit('line', item);
    if (this.lineSink) {
      try { this.lineSink.write(localStamp() + ' ' + item.raw.replace(/[\r\n]+/g, ' ') + '\n'); }
      catch { this._closeSink(); }
    }
    this._track(clean, level);
    return item;
  }

  /** 从日志推断运行状态与在线玩家（无 RCON 时的降级通道） */
  _track(clean) {
    const c = clean;
    if (this.state === STATE.STARTING && looksStarted(c)) this._markOnline();
    // 解析名字前必须剥掉 ANSI —— 带色服务端日志形如 "\x1b[32mSteve[/1.2.3.4:5] logged in"
    const p = stripAnsi(c);
    if (/\bleft the game\b|\blost connection\b|\bexceeded keepalive\b|\bKicked /i.test(p)) {
      const n = _name(p, /left the game|lost connection|exceeded keepalive|Kicked/i);
      if (n) { this.players.delete(n); this._emit('players', { players: [...this.players], source: 'log', who: n, ev: 'leave' }); }
    }
    if (/\bjoined the game\b|\blogged in\b|\bentered the game\b/i.test(p)) {
      const n = _name(p, /joined the game|logged in|entered the game/i);
      if (n) { this.players.add(n); this._emit('players', { players: [...this.players], source: 'log', who: n, ev: 'join' }); }
    }
    if (/\bStopping server\b|\bStops the game and saves the players\b/i.test(c)) {
      if (this.state === STATE.ONLINE) { this.state = STATE.STOPPING; this._clearStartProbe(); this._emit('status', this.status()); }
    }
  }

  /** STARTING → ONLINE 的唯一出口 */
  _markOnline(why) {
    if (this.state !== STATE.STARTING) return;
    this.state = STATE.ONLINE;
    this.crashStreak = 0;
    this._clearStartProbe();
    if (why) this._pushLine(`<panel> 未在 stdout 看到启动完成标记，已由 ${why} 判定为运行中`, { sys: true, level: 'sys' });
    this._emit('status', this.status());
  }

  // ———————— 「一直显示正在启动」的兜底 ————————
  /**
   * stdout 万一没把 Done 送到面板（包装脚本吞了输出、log4j pattern 被改、编码判定失败、
   * 管道被第三方启动器截走），状态机就会永远停在 starting —— 用户看到的是
   * 「服务端 logs/latest.log 明明写起来了，面板还在转圈」。这里只读服务端自己写的
   * 日志文件（settings.server.logFile，默认 logs/latest.log）判定，不重复灌正文。
   */
  _armStartProbe(root, cfg) {
    this._clearStartProbe();
    const rel = String(cfg.logFile || '');
    // 与 jarName 同一口径：只接受实例根内的相对路径，别让一个填错的设置把面板指到系统文件上
    if (!root || !rel || path.isAbsolute(rel) || rel.includes('..')) return;
    const file = path.join(root, rel);
    let size = 0;
    try { size = fs.statSync(file).size; } catch { /* 首启还没有该文件 = 从 0 读 */ }
    this._probe = { file, since: size, deadline: Date.now() + PROBE_MAX_MS };
    this._probeTimer = setInterval(() => this._pollLogFile(), PROBE_EVERY_MS);
    this._probeTimer.unref?.();
  }

  _pollLogFile() {
    const p = this._probe;
    if (!p) return;
    if (this.state !== STATE.STARTING || Date.now() > p.deadline) { this._clearStartProbe(); return; }
    let st;
    try { st = fs.statSync(p.file); } catch { return; }                    // 还没生成
    if (st.size < p.since) p.since = 0;                                    // 轮转/重建：本次输出从头算
    if (st.size <= p.since) return;                                        // 启动后还没有新内容
    const from = Math.max(p.since, st.size - PROBE_WINDOW);
    const len = Math.min(st.size - from, PROBE_WINDOW);
    let fd;
    try { fd = fs.openSync(p.file, 'r'); } catch { return; }
    let text = '';
    try {
      const b = Buffer.allocUnsafe(len);
      fs.readSync(fd, b, 0, len, from);
      text = b.toString('utf8');
    } catch { return; }
    finally { try { fs.closeSync(fd); } catch { /* ignore */ } }
    for (const line of text.split(/\r?\n/)) {
      if (line && looksStarted(line)) { this._markOnline(`${path.basename(path.dirname(p.file))}/${path.basename(p.file)}`); return; }
    }
  }

  _clearStartProbe() {
    if (this._probeTimer) { clearInterval(this._probeTimer); this._probeTimer = null; }
    this._probe = null;
  }

  // —————————————————————— 停止 / 强杀 ——————————————————————
  /** 优雅停止：优先 stdin `stop`（MC 会存档后退出），超时再 taskkill */
  async stop({ force = false, timeoutMs } = {}) {
    if (!this.child) return { already: true };
    const cfg = config.get().server;
    const timeout = timeoutMs || cfg.stopTimeoutMs || 90000;
    this.intentionalStop = true;
    const prev = this.state;
    this.state = STATE.STOPPING;
    this._emit('status', this.status());

    if (force) {
      this._pushLine('<panel> 强制终止服务端进程树', { sys: true, level: 'warn' });
      await this._taskkill('/F');
      return { forced: true, from: prev };
    }
    const cmd = (cfg.stopCommand || 'stop').trim();
    let sent = false;
    if (cmd && this.child.stdin && !this.child.stdin.destroyed) {
      try { this.child.stdin.write(cmd + '\n'); sent = true; } catch { sent = false; }
    }
    if (!sent) {
      this._pushLine('<panel> stdin 不可写，转 taskkill 终止', { sys: true, level: 'warn' });
      await this._taskkill('/F');
      return { forced: true, from: prev };
    }
    this._pushLine(`<panel> 已发送优雅停止指令：${cmd}（最长等待 ${Math.round(timeout / 1000)}s）`, { sys: true, level: 'sys' });
    const pid = this.child.pid;
    const ok = await this._waitExit(timeout);
    if (!ok) {
      this._pushLine('<panel> 优雅停止超时，进程树强制终止', { sys: true, level: 'error' });
      await this._taskkill('/T', '/F', pid);
      await this._waitExit(8000);
      return { forced: true, timeout: true, from: prev };
    }
    return { graceful: true, from: prev };
  }

  kill() { return this.stop({ force: true }); }

  async restart({ reason = 'manual' } = {}) {
    const wasRunning = !!this.child;
    if (wasRunning) await this.stop({ timeoutMs: Math.min(config.get().server.stopTimeoutMs, 45000) });
    if (this.child) { await this._taskkill('/T', '/F', this.child && this.child.pid); await this._waitExit(5000); }
    // 存档/端口释放需要一点时间，否则 java 会以 "Address already in use" 失败
    await delay(1200);
    return this.start({ reason });
  }

  _taskkill(...flags) {
    return new Promise((resolve) => {
      if (!this.child) return resolve(false);
      const pid = this.child.pid;
      // /T 连同子进程（NeoForge 可能拉起 loader 子 JVM）；/F 强制
      execFile('taskkill.exe', ['/PID', String(pid), ...flags.filter((f) => typeof f === 'string')],
        { windowsHide: true, timeout: 15000 }, (err) => {
          if (err) this._pushLine(`<panel> taskkill 失败：${err.message}`, { sys: true, level: 'error' });
          resolve(!err);
        });
    });
  }

  _waitExit(ms) {
    return new Promise((resolve) => {
      if (!this.child) return resolve(true);
      const c = this.child;
      const t = setTimeout(() => { c.off('exit', onExit); resolve(false); }, ms);
      const onExit = () => { clearTimeout(t); resolve(true); };
      c.once('exit', onExit);
    });
  }

  _onExit(code, signal, reason, file, args) {
    this._clearStartProbe();
    this._flushPartials();                                 // 两条流各自的最后一行不能丢
    const expected = this.intentionalStop;
    this.child = null;
    this.state = STATE.OFFLINE;
    this.exitInfo = { code, signal, at: Date.now(), expected, reason };
    this.players.clear();
    this._closeSink();
    const desc = signal ? `信号 ${signal}` : `退出码 ${code}`;
    this._pushLine(`<panel> 服务端进程结束（${desc}${expected ? '，正常停止' : '，异常退出'}）`, { sys: true, level: expected ? 'sys' : 'error' });
    this._emit('status', this.status());
    this._emit('exit', this.exitInfo);

    const cfg = config.get().server;
    if (!expected && cfg.autoRestart) {
      const backoffs = Array.isArray(cfg.restartBackoff) && cfg.restartBackoff.length ? cfg.restartBackoff : [5000];
      const wait = backoffs[Math.min(this.crashStreak, backoffs.length - 1)];
      this.crashStreak++;
      if (this.crashStreak > 20) {
        this._pushLine('<panel> 连续崩溃超过 20 次，暂停自动重启（请查看日志修复）', { sys: true, level: 'error' });
        return;
      }
      this._pushLine(`<panel> ${Math.round(wait / 1000)}s 后自动重启（第 ${this.crashStreak} 次）`, { sys: true, level: 'warn' });
      clearTimeout(this.restartTimer);
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        try { this.start({ reason: 'autorestart' }); }
        catch (e) { this._pushLine(`<panel> 自动重启失败：${e.message}`, { sys: true, level: 'error' }); }
      }, wait);
      this.restartTimer.unref?.();
    } else if (!expected) {
      this.crashStreak = 0;
    }
  }

  // —————————————————————— 控制台输入 ——————————————————————
  /** 把命令写入服务端 stdin。校验：无换行（防一次注入多条指令）、长度上限 */
  sendCommand(text) {
    if (!this.child || !this.child.stdin || this.child.stdin.destroyed) throw new Error('服务端未运行，控制台不可写');
    const s = String(text == null ? '' : text).replace(/[\r\n]+/g, ' ').trim();
    if (!s) throw new Error('命令为空');
    if (s.length > 1000) throw new Error('命令过长（>1000 字符）');
    this.child.stdin.write(s + '\n');
    this._pushLine('§e> ' + s, { sys: true, level: 'cmd' });
    return { sent: s };
  }

  // —————————————————————— 面板侧日志落盘（可回放历史） ——————————————————————
  _openSink() {
    if (this.lineSink) return;
    try {
      const file = path.join(LOGS, 'panel-console.log');
      rotateIfNeeded(file, 4 * 1024 * 1024, 1);
      this.lineSink = fs.createWriteStream(file, { flags: 'a' });
      this.lineSink.on('error', () => this._closeSink());
    } catch { this.lineSink = null; }
  }
  _closeSink() {
    if (!this.lineSink) return;
    try { this.lineSink.end(); } catch { /* ignore */ }
    this.lineSink = null;
  }

  _emit(type, data) { this.emit(type, data); }
}

/** 从 "Notch[/1.2.3.4:1234] logged in" / "Notch left the game" / "<Notch> joined" 取玩家名。
 *  传入的 line 必须已经 stripAnsi，否则控制码会混进捕获组。 */
function _name(line, keywordRe) {
  const idx = line.search(keywordRe);
  if (idx <= 0) return null;
  const before = line.slice(0, idx).replace(/[\s,]+$/, '');
  // 尾锚定：name 后面可能跟 [/ip:port] 或 [uuid]，逐层剥掉
  let m = /([A-Za-z0-9_]{2,16})(?:\[[^\]]*\])?$/.exec(before);
  if (m) return m[1];
  m = /<([A-Za-z0-9_]{2,16})>(?:\[[^\]]*\])?$/.exec(before);
  if (m) return m[1];
  // 离线模式/中文名兜底：MC 正版名只允许 [A-Za-z0-9_]，但离线服常见自定义名
  m = /([^\s,<>[\]]{2,16})(?:\[[^\]]*\])?$/.exec(before);
  return m ? m[1] : null;
}

function buildEnv(cfg) {
  const env = { ...process.env };
  // 强制子进程 stdout/stderr 走 UTF-8（JDK 18+ 生效；JDK 8/11 靠 jvmArgs 的 file.encoding）
  env.JAVA_TOOL_OPTIONS = (env.JAVA_TOOL_OPTIONS ? env.JAVA_TOOL_OPTIONS + ' ' : '') + INJECTED_JVM_OPTS;
  env.MC_PANEL = 'mcslite';
  env.FORCE_COLOR = '1';                 // 让服务端保留 ANSI 颜色（否则 JLine 探测到非 TTY 会去色）
  env.TERM = env.TERM || 'xterm-256color';
  return env;
}

function rotateIfNeeded(file, maxBytes, keep) {
  try {
    const st = fs.statSync(file);
    if (st.size < maxBytes) return;
    for (let i = keep; i >= 1; i--) {
      const src = i === 1 ? file : `${file}.${i - 1}`;
      try { if (i === keep) fs.rmSync(`${file}.${i}`, { force: true }); } catch { /* ignore */ }
      try { fs.renameSync(src, `${file}.${i}`); } catch { /* ignore */ }
    }
  } catch { /* 文件不存在 */ }
}

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 面板落盘时间戳用「本地」时间：toISOString() 是 UTC，与游戏日志和控制台显示差一个时区，
 *  排查问题时两边根本对不齐（「面板日志和 bat 日志不符」的一半来源）。 */
function localStamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

module.exports = { MinecraftProcess, STATE };
