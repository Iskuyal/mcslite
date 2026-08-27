'use strict';
/**
 * Source RCON 客户端（纯 TCP，零依赖）。
 *
 * 用途：在线玩家列表（`list`）——面板重启后日志解析的在线集合会丢，且拿不到
 * 服务端真实人数上限；RCON 是权威来源。未开启时上层自动降级为日志解析。
 *
 * 包结构（小端）：int32 length | int32 requestId | int32 type | body | \0 | \0
 * 现代 MC（1.19+）大响应切成 SERVERDATA_MULTI_PACKET(60)：
 *   body = int32 requestId(原始) | int32 packetId | int32 status | text | \0 | \0
 *   外层 id 恒为 -2；服务端最后再补一个 type=0 的空响应表示结束。
 *   这里按 requestId 归并分片，收到原始 id 的 0 型响应即结算。
 * 安全：密码只存在 settings.json，不写日志、不回传前端。
 */
const net = require('node:net');
const { EventEmitter } = require('node:events');

const TYPE_RESPONSE = 0, TYPE_EXEC = 2, TYPE_AUTH = 3, TYPE_MULTI = 60, AUTH_FAIL = -1;
const MULTI_ID = -2;
const MAX_PACKET = 8 * 1024 * 1024;

function enc(id, type, body) {
  const p = Buffer.from(String(body), 'utf8');
  const len = 4 + 4 + p.length + 2;                 // requestId + type + body + 两个 \0
  const b = Buffer.allocUnsafe(4 + len);
  b.writeInt32LE(len, 0);
  b.writeInt32LE(id, 4);
  b.writeInt32LE(type, 8);
  p.copy(b, 12);
  b[12 + p.length] = 0;
  b[13 + p.length] = 0;
  return b;
}

class Rcon extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.host = opts.host || '127.0.0.1';
    this.port = +opts.port || 25575;
    this.password = opts.password || '';
    this.enabled = false;
    this.sock = null;
    this.authed = false;
    this._id = 0;
    this.buf = Buffer.alloc(0);
    this.waiters = new Map();     // 原始 requestId -> {resolve,reject,timer,chunks}
    this.multi = new Map();       // 原始 requestId -> [text...]
    this.queue = [];
    this.busy = false;
    this.reconnectTimer = null;
    this.lastError = null;
  }

  configure({ enabled, host, port, password }) {
    const changed = this.host !== host || this.port !== (+port || this.port) || this.password !== password;
    this.enabled = !!enabled;
    if (changed) {
      if (host) this.host = host;
      if (port) this.port = +port;
      if (password != null) this.password = password;
      this.close();
    }
    if (!this.enabled) this.close();
    return changed;
  }

  connect() {
    if (!this.enabled || this.sock) return;
    const sock = net.connect({ host: this.host, port: this.port, noDelay: true });
    this.sock = sock;
    sock.setTimeout(8000);
    sock.on('connect', () => {
      sock.setTimeout(0);
      this._raw(enc(++this._id, TYPE_AUTH, this.password));
    });
    sock.on('data', (d) => this._onData(d));
    sock.on('error', (e) => { this.lastError = e.message; this.emit('error', e); });
    sock.on('close', () => this._onClosed());
    sock.on('timeout', () => { try { sock.destroy(); } catch { /* ignore */ } });
  }

  _onClosed() {
    this.sock = null;
    this.authed = false;
    this._failAll(new Error('RCON 连接已关闭'));
    if (this.enabled && !this.reconnectTimer) {
      this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; if (this.enabled) this.connect(); }, 5000);
      this.reconnectTimer.unref?.();
    }
    this.emit('close');
  }

  _raw(b) { try { this.sock.write(b); return true; } catch { return false; } }

  _onData(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      if (this.buf.length < 4) return;
      const len = this.buf.readInt32LE(0);
      if (len < 10 || len > MAX_PACKET) { this.buf = Buffer.alloc(0); this._failAll(new Error('RCON 包长异常')); return; }
      if (this.buf.length < len + 4) return;
      const body = this.buf.subarray(4, 4 + len);
      this.buf = this.buf.subarray(len + 4);        // 零拷贝偏移；超限由上面的收缩处理
      try { this._dispatch(body); } catch (e) { this._failAll(new Error('RCON 解析失败：' + e.message)); return; }
    }
  }

  _dispatch(body) {
    const id = body.readInt32LE(0);
    const type = body.readInt32LE(4);
    if (type === TYPE_MULTI) {
      const reqId = body.readInt32LE(8);
      const status = body.readInt32LE(16);
      const text = body.subarray(20, body.length - 2).toString('utf8');
      const acc = this.multi.get(reqId) || [];
      acc.push({ pid: body.readInt32LE(12), text });
      this.multi.set(reqId, acc);
      if (!(status & 0x01) || (status & 0x02)) {    // 无 MORE_BUFFERS 或带 IS_LAST  → 直接结算
        this._settle(reqId);
      }
      return;
    }
    const text = body.subarray(8, body.length - 2).toString('utf8');
    if (type === TYPE_AUTH) {
      if (id === AUTH_FAIL) {
        this.lastError = 'RCON 认证失败（rcon.password 不匹配）';
        this.emit('error', new Error(this.lastError));
        this.close();
      } else { this.authed = true; this.emit('ready'); }
      return;
    }
    if (type === TYPE_RESPONSE) {
      const w = this.waiters.get(id);
      if (!w) return;                                // 认证后的多余空响应：忽略
      if (this.multi.has(id)) { this._settle(id); return; }  // 结束标记：用已收分片
      if (text) w.chunks.push(text);
      clearTimeout(w.timer);
      w.timer = setTimeout(() => this._settle(id), 200);      // 静默 200ms → 收口（兼容非分包多响应）
    }
  }

  _settle(id) {
    const w = this.waiters.get(id);
    if (!w) { this.multi.delete(id); return; }
    this.waiters.delete(id);
    clearTimeout(w.timer);
    let text;
    const parts = this.multi.get(id);
    if (parts && parts.length) {
      parts.sort((a, b) => a.pid - b.pid);
      text = parts.map((p) => p.text).join('');
      this.multi.delete(id);
    } else {
      const acc = (w.chunks || []);
      text = acc.filter(Boolean).join('\n');
    }
    this.busy = false;
    w.resolve(text);
    this._drain();
  }

  _failAll(err) {
    for (const [, w] of this.waiters) { clearTimeout(w.timer); w.reject(err); }
    this.waiters.clear();
    this.multi.clear();
    this.busy = false;
    this._drain();
  }

  /** 串行执行（RCON 无语义并发，乱并发必然错位）；队列有界，防止卡死时堆积 */
  command(cmd, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      if (!this.enabled) return reject(new Error('RCON 未启用'));
      if (this.queue.length >= 16) return reject(new Error('RCON 队列已满，稍后重试'));
      this.queue.push({ cmd, timeoutMs, resolve, reject });
      if (!this.sock) this.connect();
      this._drain();
    });
  }

  _drain() {
    if (this.busy || !this.queue.length) return;
    if (!this.sock) { this.connect(); setTimeout(() => this._drain(), 400).unref?.(); return; }
    if (!this.authed) {
      const t = setTimeout(() => { if (!this.authed && this.queue.length) { const q = this.queue.splice(0); q.forEach((x) => x.reject(new Error('RCON 未认证（服务端 rcon.enabled 或端口配置有误）'))); } }, 8000);
      t.unref?.();
      return;
    }
    const task = this.queue.shift();
    this.busy = true;
    const id = ++this._id;
    const timer = setTimeout(() => {
      if (!this.waiters.has(id)) return;
      this.waiters.delete(id);
      this.multi.delete(id);
      this.busy = false;
      task.resolve('');                               // 超时不抛错：控制台命令常无响应
      this._drain();
    }, task.timeoutMs);
    this.waiters.set(id, { resolve: task.resolve, reject: task.reject, timer, chunks: [] });
    if (!this._raw(enc(id, TYPE_EXEC, task.cmd))) {
      clearTimeout(timer);
      this.waiters.delete(id);
      this.busy = false;
      task.reject(new Error('RCON 写入失败'));
      this._drain();
    }
  }

  /** 权威在线列表 */
  async list() {
    const text = await this.command('list', 4000);
    return parseList(text);
  }

  get state() { return { enabled: this.enabled, connected: !!(this.sock && this.authed), host: this.host, port: this.port, lastError: this.lastError }; }

  close() {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.sock) { try { this.sock.destroy(); } catch { /* ignore */ } }
    this.sock = null;
    this.authed = false;
    this._failAll(new Error('RCON 已关闭'));
    this.queue.length = 0;
  }
}

/** "There are 3/20 players online: A, B, C" → {online,max,names} */
function parseList(text) {
  const s = String(text || '').trim();
  const names = [];
  const m = /players online:?\s*(.*)$/is.exec(s);
  if (m && m[1]) for (const n of m[1].split(',')) { const t = n.replace(/\([^)]{0,40}\)\s*$/, '').trim(); if (t) names.push(t); }
  const mm = /There are (\d+)\/(\d+) players? online/i.exec(s);
  return { online: mm ? +mm[1] : names.length, max: mm ? +mm[2] : null, names, raw: s };
}

module.exports = { Rcon, parseList };
