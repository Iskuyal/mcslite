/**
 * REST + WebSocket 客户端。
 * 设计取向：面板是内网工具，鉴权走 httpOnly cookie，前端不存 token（XSS 拿不到东西）。
 * WS 断线指数退避重连；页面切到后台时自动 unsubscribe，省服务器也省本机 CPU。
 */

const BASE = '.';

async function req(method, path, body, { raw } = {}) {
  const opt = { method, credentials: 'same-origin', headers: {} };
  if (raw !== undefined) {
    opt.body = raw;
    opt.headers['content-type'] = 'application/octet-stream';
  } else if (body !== undefined) {
    opt.body = JSON.stringify(body);
    opt.headers['content-type'] = 'application/json';
    opt.headers['origin'] = location.origin;
  }
  const res = await fetch(BASE + path, opt);
  if (res.status === 401) { throw Object.assign(new Error('会话已过期，请重新登录'), { status: 401 }); }
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw Object.assign(new Error((data && data.error) || `HTTP ${res.status}`), { status: res.status, payload: data });
  return data;
}

export const api = {
  state: (n) => req('GET', `/api/state${n ? '?n=' + n : ''}`),
  login: (username, password) => req('POST', '/api/login', { username, password }),
  logout: () => req('POST', '/api/logout', {}),
  publicConfig: () => req('GET', '/api/public-config'),
  start: () => req('POST', '/api/server/start', {}),
  stop: () => req('POST', '/api/server/stop', {}),
  kill: () => req('POST', '/api/server/kill', {}),
  restart: () => req('POST', '/api/server/restart', {}),
  crashReset: () => req('POST', '/api/server/crash-reset', {}),
  send: (command) => req('POST', '/api/console/send', { command }),
  consoleTail: (lines) => req('GET', '/api/console?lines=' + (lines || 500)),
  metrics: (n) => req('GET', '/api/metrics?n=' + (n || 300)),
  players: () => req('GET', '/api/players'),
  rcon: (command) => req('POST', '/api/rcon', { command }),
  files: (dir) => req('GET', '/api/files?dir=' + encodeURIComponent(dir || '')),
  read: (p) => req('GET', '/api/files/content?path=' + encodeURIComponent(p)),
  write: (p, text) => req('PUT', '/api/files/content', { path: p, text }),
  rm: (p, recursive) => req('DELETE', '/api/files?path=' + encodeURIComponent(p) + (recursive ? '&recursive=1' : '')),
  mkdir: (p) => req('POST', '/api/files/mkdir', { path: p }),
  rename: (from, to) => req('POST', '/api/files/rename', { from, to }),
  uploadBytes: (p, buf) => req('PUT', '/api/files/upload?path=' + encodeURIComponent(p), undefined, { raw: buf }),
  downloadUrl: (p) => `${BASE}/api/files/download?path=` + encodeURIComponent(p),
  props: (file) => req('GET', '/api/properties?file=' + encodeURIComponent(file || 'server.properties')),
  writeProps: (file, changes) => req('PUT', '/api/properties', { file, changes }),
  settings: () => req('GET', '/api/settings'),
  saveSettings: (patch) => req('PUT', '/api/settings', patch),
  validateSettings: (patch) => req('POST', '/api/settings/validate', patch),
  setPassword: (current, password) => req('POST', '/api/settings/password', { current, password }),
  oplog: (limit, offset) => req('GET', `/api/oplog?limit=${limit || 100}&offset=${offset || 0}`),
  importDetect: () => req('GET', '/api/import/detect'),
  importRunbat: (file, apply) => req('POST', '/api/import/runbat', { file, apply: !!apply }),
};

/** 长连接：单条 WS 承载全部实时通道，避免多 EventSource 各占一个浏览器连接配额 */
export class Realtime {
  constructor() {
    this.sock = null;
    this.topics = new Set();
    this.handlers = new Map();      // type -> Set<fn>
    this.retry = 0;
    this.closed = false;
    this.status = 'idle';
    this.onStatus = null;
    this._pingTimer = null;
  }

  on(type, fn) {
    let s = this.handlers.get(type);
    if (!s) this.handlers.set(type, (s = new Set()));
    s.add(fn);
    return () => s.delete(fn);
  }

  _emit(type, data) {
    const s = this.handlers.get(type);
    if (!s) return;
    for (const fn of s) { try { fn(data); } catch (e) { console.error('[ws handler]', e); } }
  }

  connect() {
    if (this.sock && (this.sock.readyState === 1 || this.sock.readyState === 0)) return;
    this.closed = false;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    // WS 路径固定 /ws（服务端按精确路径匹配）；若挂在 Nginx 前缀下，见 nginx 配置里的
    // `location ^~ /ws { proxy_pass http://127.0.0.1:8787/ws; }` 显式映射。
    const url = `${proto}://${location.host}/ws`;
    let sock;
    try { sock = new WebSocket(url); } catch (e) { this._fail(e); return; }
    this.sock = sock;
    sock.onopen = () => {
      this.retry = 0;
      this._setStatus('online');
      if (this.topics.size) sock.send(JSON.stringify({ t: 'sub', topics: [...this.topics] }));
      this._pingTimer = setInterval(() => { if (sock.readyState === 1) sock.send(JSON.stringify({ t: 'ping' })); }, 25000);
    };
    sock.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      this._emit(m.t, m.d, m);
    };
    sock.onclose = () => { this._setStatus('offline'); this._reconnect(); };
    sock.onerror = () => { this._setStatus('error'); try { sock.close(); } catch { /* ignore */ } };
  }

  _fail(e) { this._setStatus('error'); console.error('[ws]', e); this._reconnect(); }

  _reconnect() {
    if (this.closed) return;
    clearInterval(this._pingTimer);
    const wait = Math.min(1000 * 2 ** this.retry++, 20000);
    this._setStatus('retry:' + wait);
    setTimeout(() => { if (!this.closed) this.connect(); }, wait);
  }

  _setStatus(s) { this.status = s; if (this.onStatus) this.onStatus(s); }

  sub(...topics) {
    let added = false;
    for (const t of topics) if (!this.topics.has(t)) { this.topics.add(t); added = true; }
    if (added && this.sock && this.sock.readyState === 1) this.sock.send(JSON.stringify({ t: 'sub', topics }));
  }

  unsub(...topics) {
    let removed = false;
    for (const t of topics) if (this.topics.delete(t)) removed = true;
    if (removed && this.sock && this.sock.readyState === 1) this.sock.send(JSON.stringify({ t: 'unsub', topics }));
  }

  command(text) {
    if (this.sock && this.sock.readyState === 1) { this.sock.send(JSON.stringify({ t: 'console', command: text })); return true; }
    return false;
  }

  /** 页面隐藏时挂起：省带宽、省面板侧 PowerShell 采样器 */
  pause() { this.unsub('metrics', 'players'); if (this.sock) { this.closed = true; try { this.sock.close(); } catch { /* ignore */ } } }
  resume() { this.closed = false; this.retry = 0; this.connect(); this.sub('metrics', 'players'); }

  close() { this.closed = true; clearInterval(this._pingTimer); if (this.sock) { try { this.sock.close(); } catch { /* ignore */ } } }
}

export const rt = new Realtime();
