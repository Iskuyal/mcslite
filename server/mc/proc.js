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
    this.decoder = null;
    this.partial = '';
    this.partialBytes = 0;
    this.seq = 0;
    this.intentionalStop = false;
    this.restartTimer = null;
    this.crashStreak = 0;
    this.players = new Set();          // 日志解析降级用的在线玩家集合
    this.lineSink = null;              // 面板侧日志落盘
    this.lastErrorTail = '';
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
    this.partial = '';
    this.partialBytes = 0;
    this._attachStdio(child, root);
    this._openSink();
    this._pushLine(`<panel> 启动：${file} ${args.join(' ')}`.trim(), { sys: true, level: 'sys' });
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
    const onData = (buf) => {
      let text;
      try { text = this.decoder.push(buf); } catch { text = buf.toString('utf8'); }
      if (!text) return;
      this.partialBytes += buf.length;
      let s = this.partial + text;
      let nl;
      let count = 0;
      while ((nl = s.indexOf('\n')) >= 0) {
        let line = s.slice(0, nl);
        s = s.slice(nl + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        this._pushLine(line);
        if (++count >= 400) {                     // 单块过多行：剩余直接聚合，防事件风暴
          if (s) { this._pushLine(s); s = ''; }
          break;
        }
      }
      this.partial = s;
      if (this.partial.length > PARTIAL_CAP) {    // 长期无换行 → 强制收口，保内存
        this._pushLine(this.partial.slice(0, LINE_MAX) + ' …[截断]');
        this.partial = '';
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (b) => {
      // 老写法 stderr 会绕过统一缓冲；这里显式合并，保证 UI 上「所有输出可见」
      const tag = Buffer.from('[stderr] ');
      onData(Buffer.concat([tag, b]));
    });
    child.stdout.on('end', () => { const t = this.decoder.end(); if (t) this._pushLine(t); });
  }

  /** 一行日志的完整管线：环形缓冲 + 事件广播 + 落盘 + 状态/玩家解析 */
  _pushLine(raw, meta = {}) {
    if (raw === undefined || raw === null) return;
    const stripped = stripPrefix(raw);
    const clean = (stripped ? stripped.rest : raw).replace(/\0/g, '');
    const time = stripped ? stripped.time : new Date().toTimeString().slice(0, 8);
    // 级别优先取 MC 前缀里的 [thread/LEVEL]（否则剥掉前缀后再 detectLevel 就永远看不到 INFO/WARN 了）
    const level = meta.level || (stripped && stripped.level ? stripped.level.toLowerCase() : null) || detectLevel(clean) || null;
    const item = {
      i: ++this.seq,
      t: meta.sys ? Date.now() : (this.startedAt ? Date.now() : Date.now()),
      time,
      level,
      raw: clean.length > LINE_MAX ? clean.slice(0, LINE_MAX) + ' …[截断]' : clean,
      html: ansiToHtml(clean.length > LINE_MAX ? clean.slice(0, LINE_MAX) + ' …[截断]' : clean),
    };
    this.ring.push(item);
    this._emit('line', item);
    if (this.lineSink) {
      try { this.lineSink.write(new Date().toISOString().slice(11, 23) + ' ' + item.raw.replace(/[\r\n]+/g, ' ') + '\n'); }
      catch { this._closeSink(); }
    }
    this._track(raw, clean, level);
    return item;
  }

  /** 从日志推断运行状态与在线玩家（无 RCON 时的降级通道） */
  _track(raw, clean, level) {
    const c = clean;
    if (this.state === STATE.STARTING && /(Done \(\d+(\.\d+)?s\)! For help|Done.*type "help"|Done \(Service|§[0-9a-f]Done|Start finished|Done\(For help)/i.test(c)) {
      this.state = STATE.ONLINE;
      this.crashStreak = 0;
      this._emit('status', this.status());
    }
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
      if (this.state === STATE.ONLINE) { this.state = STATE.STOPPING; this._emit('status', this.status()); }
    }
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
    const tail = this.decoder ? this.decoder.end() : '';
    if (tail) this._pushLine(tail);
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
  env.JAVA_TOOL_OPTIONS = (env.JAVA_TOOL_OPTIONS ? env.JAVA_TOOL_OPTIONS + ' ' : '') + '-Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8';
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

module.exports = { MinecraftProcess, STATE };
