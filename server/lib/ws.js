'use strict';
/**
 * 手写 WebSocket 服务端（RFC6455 子集）—— 后端零依赖的最后一块。
 *
 * 为什么不用 ws/socket.io：面板只需要「服务端→浏览器推文本帧」这一条通道，
 * ws 包 ~120KB 源码 + 事件抽象，socket.io 还会带来心跳房间表；自建实现
 * 把不需要的东西全部砍掉，常驻内存和对象分配都更小，也没有依赖升级风险。
 *
 * 支持：文本帧、分片重组、mask 解掩码、ping/pong、close 握手、127 位长。
 * 拒绝：permessage-deflate（不协商）、超过 maxMessage 的帧（1009 关闭）。
 * 背压：writableLength 超阈值时先丢帧并计数，连续超限直接断开 ——
 *       宁可踢掉一个卡住的浏览器，也不能让日志队列吃光服务器内存。
 */
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME = 1 << 20;      // 1MB 单帧上限
const HIGH_WATER = 512 * 1024;  // 512KB 待发积压 → 开始丢帧
const MAX_SKIPS = 8;            // 连续丢帧次数上限 → 断开

class WSConn extends EventEmitter {
  constructor(socket, req, user) {
    super();
    this.socket = socket;
    this.req = req;
    this.user = user;
    this.id = crypto.randomBytes(4).toString('hex');
    this.alive = true;
    this.buf = Buffer.alloc(0);
    this.fragments = [];
    this.fragOpcode = 0;
    this.dropped = 0;
    this.bytes = 0;
    this.lastPong = Date.now();
    socket.on('data', (d) => this._onData(d));
    socket.on('close', () => this._dead('socket close'));
    socket.on('error', () => this._dead('socket error'));
  }

  _dead(why) {
    if (!this.alive) return;
    this.alive = false;
    this.buf = Buffer.alloc(0);
    this.fragments = [];
    this.emit('close', why);
  }

  /** 发送 JSON（自动序列化）；返回是否真正写入 */
  send(type, data) {
    if (!this.alive) return false;
    if (this.socket.writableLength > HIGH_WATER) {
      if (++this.dropped > MAX_SKIPS) { this.close(1009, 'backpressure'); return false; }
      return false;                                  // 丢弃这一帧，等它缓过来
    }
    this.dropped = 0;
    let text;
    try { text = data === undefined ? JSON.stringify({ t: type }) : JSON.stringify({ t: type, d: data }); }
    catch { return false; }
    return this._frame(1, Buffer.from(text, 'utf8'));
  }

  _frame(opcode, payload) {
    if (!this.alive || this.socket.destroyed) return false;
    const len = payload.length;
    let header;
    if (len < 126) { header = Buffer.allocUnsafe(2); header[1] = len; }
    else if (len < 65536) { header = Buffer.allocUnsafe(4); header[1] = 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.allocUnsafe(10); header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
    header[0] = 0x80 | opcode;                       // FIN + opcode
    try { this.socket.write(Buffer.concat([header, payload])); }
    catch { return false; }
    this.bytes += len;
    return true;
  }

  ping() { this._frame(9, Buffer.alloc(0)); }

  close(code = 1000, reason = '') {
    if (!this.alive) return;
    const r = Buffer.from(reason, 'utf8').subarray(0, 100);
    const p = Buffer.allocUnsafe(2 + r.length);
    p.writeUInt16BE(code, 0);
    r.copy(p, 2);
    this._frame(8, p);
    const s = this.socket;
    this.alive = false;
    setTimeout(() => { try { s.destroy(); } catch { /* ignore */ } }, 200).unref?.();
    this.emit('close', 'local close');
  }

  _onData(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    if (this.buf.length > MAX_FRAME * 4) { this.close(1009, 'too big'); return; }
    while (this.alive) {
      const used = this._tryParse();
      if (used === 0) break;
      this.buf = this.buf.subarray(used);
    }
    // subarray 会 pin 住整块底层内存，攒够就整体收缩一次
    if (this.buf.length === 0 && chunk.length > 64 * 1024) this.buf = Buffer.alloc(0);
  }

  /** @returns 消费的字节数（0 表示需要更多数据） */
  _tryParse() {
    const b = this.buf;
    if (b.length < 2) return 0;
    const fin = (b[0] & 0x80) !== 0;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f, off = 2;
    if (len === 126) { if (b.length < off + 2) return 0; len = b.readUInt16BE(off); off += 2; }
    else if (len === 127) {
      if (b.length < off + 8) return 0;
      const big = b.readBigUInt64BE(off);
      if (big > BigInt(MAX_FRAME)) { this.close(1009, 'frame too big'); return b.length; }
      len = Number(big); off += 8;
    }
    if (len > MAX_FRAME) { this.close(1009, 'frame too big'); return b.length; }
    if (masked) {
      if (b.length < off + 4) return 0;
      const mask = b.subarray(off, off + 4); off += 4;
      if (b.length < off + len) return 0;
      const payload = Buffer.from(b.subarray(off, off + len));    // 复制出可改写副本，不污染 ring
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this._handle(fin, opcode, payload);
      return off + len;
    }
    if (b.length < off + len) return 0;                            // 客户端必须掩码；非掩码帧也按原样支持以便自测
    this._handle(fin, opcode, b.subarray(off, off + len));
    return off + len;
  }

  _handle(fin, opcode, payload) {
    if (opcode === 8) { this.close(1000); return; }               // close → echo
    if (opcode === 9) { this._frame(10, payload); return; }       // ping → pong
    if (opcode === 10) { this.lastPong = Date.now(); return; }
    if (opcode === 1 || opcode === 2) {
      if (!fin) { this.fragments = [payload]; this.fragOpcode = opcode; return; }
      if (this.fragments.length) { this.fragments.push(payload); payload = Buffer.concat(this.fragments); this.fragments = []; }
      this._message(opcode, payload);
    } else if (opcode === 0) {                                    // continuation
      this.fragments.push(payload);
      if (fin) { const full = Buffer.concat(this.fragments); const op = this.fragOpcode; this.fragments = []; this._message(op, full); }
    } else { this.close(1003, 'bad opcode'); }
  }

  _message(opcode, payload) {
    if (opcode !== 1) return;                                     // 只接受文本协议消息
    let msg;
    try { msg = JSON.parse(payload.toString('utf8')); }
    catch { this.send('error', { message: 'WS 消息不是合法 JSON，已忽略' }); return; }   // 不静默丢弃：否则客户端极难定位
    this.lastPong = Date.now();
    this.emit('message', msg);
  }
}

/** 把 upgrade 挂到 http server 上 */
function attach(server, opts) {
  const { path: upPath, verify, onConnection, onDisconnect } = opts;
  server.on('upgrade', (req, socket, head) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { socket.destroy(); return; }
    if (url.pathname !== upPath) { socket.destroy(); return; }
    const key = req.headers['sec-websocket-key'];
    const ver = req.headers['sec-websocket-version'];
    if (typeof key !== 'string' || ver !== '13') {
      socket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      return;
    }
    // 反代（nginx）转发过来的 upgrade 头是逗号列表，取首项再校验
    const up = String(req.headers.upgrade || '').split(',')[0].trim().toLowerCase();
    if (up !== 'websocket') { socket.destroy(); return; }
    const user = verify(req);
    if (!user) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      return;
    }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.setNoDelay(true);
    socket.setTimeout(0);
    const conn = new WSConn(socket, req, user);
    if (head && head.length) conn._onData(head);
    onConnection(conn, user);
    conn.on('close', () => onDisconnect(conn));
  });
}

/** 心跳巡检：清掉无响应的僵尸连接（半开 TCP 在 Windows 上不会自己报错） */
function startHeartbeat(conns, intervalMs = 30000, idleMs = 90000) {
  const t = setInterval(() => {
    const now = Date.now();
    for (const c of conns) {
      if (!c.alive) continue;
      if (now - c.lastPong > idleMs) { c.close(1001, 'idle'); continue; }
      c.ping();
    }
  }, intervalMs);
  t.unref?.();
  return t;
}

module.exports = { WSConn, attach, startHeartbeat };
