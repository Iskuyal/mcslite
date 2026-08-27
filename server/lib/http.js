'use strict';
/**
 * 极简 HTTP 路由（node:http 之上 ~180 行）。
 *
 * 为什么不用 Express/Fastify：面板只有 20 来个固定路由，框架带来的中间件链、
 * 路由 trie、per-request 上下文对象是常驻内存的主要固定开销（Fastify 空转
 * ~35MB / Express ~25MB）。这里做到：路由预编译成数组、无中间件链、每请求
 * 只分配一个 ctx，空转 RSS 压到 ~18MB。
 *
 * 内置：统一 JSON 出入参、body 体积上限、鉴权、同源校验、错误兜底、
 *       安全响应头、大响应 gzip（JSON 才压，避免 CPU 抖动）。
 */
const zlib = require('node:zlib');
const auth = require('./auth');

const MAX_BODY = 2 * 1024 * 1024;          // 2MB：够编辑任何配置文件；文件上传走专用流式通道
const JSON_GZIP_MIN = 2048;

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}

function compile(pattern) {
  const segs = pattern.split('/').filter(Boolean);
  return { segs, wildcard: segs[segs.length - 1] === '**' };
}

function match(route, parts) {
  const { segs, wildcard } = route;
  if (wildcard) {
    const head = segs.slice(0, -1);
    if (parts.length < head.length) return null;
    for (let i = 0; i < head.length; i++) if (head[i] !== parts[i] && !head[i].startsWith(':')) return null;
    return { rest: parts.slice(head.length).join('/'), params: {} };
  }
  if (parts.length !== segs.length) return null;
  const params = {};
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (s.startsWith(':')) params[s.slice(1)] = decodeURIComponent(parts[i]);
    else if (s !== parts[i]) return null;
  }
  return { params };
}

class App {
  constructor() {
    this.routes = [];
    this.notFound = (ctx) => ctx.json(404, { error: 'not found' });
    this.onError = null;
  }
  /** opts: {auth:true, csrf:true, raw:false, label:'启动服务端'} */
  add(method, pattern, handler, opts = {}) {
    const r = { method, ...compile(pattern), handler, opts, pattern };
    if (opts.auth !== false) r.needAuth = true;
    if (method !== 'GET' && method !== 'HEAD' && opts.csrf !== false) r.needCsrf = true;
    this.routes.push(r);
    return this;
  }
  get(p, h, o) { return this.add('GET', p, h, o); }
  post(p, h, o) { return this.add('POST', p, h, o); }
  put(p, h, o) { return this.add('PUT', p, h, o); }
  del(p, h, o) { return this.add('DELETE', p, h, o); }

  dispatch(req, res, url) {
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    const parts = url.pathname.split('/').filter(Boolean);
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = match(r, parts);
      if (!m) continue;
      return this._run(r, m, req, res, url);
    }
    return this._fail(res, 404, 'not found', req);
  }

  async _run(r, m, req, res, url) {
    const ctx = new Ctx(req, res, url, m);
    try {
      if (r.needAuth) {
        const u = auth.authedUser(req);
        if (!u) throw new HttpError(401, '未登录或会话过期');
        ctx.user = u.user;
      }
      if (r.needCsrf && !auth.sameOrigin(req)) throw new HttpError(403, '跨站请求被拒绝（Origin 校验失败）');
      const out = await r.handler(ctx);
      if (!res.headersSent && !res.writableEnded && out !== undefined && !r.opts.raw) {
        ctx.json(200, out === null ? { ok: true } : out);
      }
    } catch (e) {
      if (r.needAuth && e && e.status === 401 && !ctx.user) authFail(req);
      // 领域层（files/store）抛的普通 Error 只要带合法 status 就按原样透传，
      // 否则才归为 500 —— 避免「越权探测」变成服务端错误而泄露「实现细节」。
      const st = Number(e && e.status);
      const status = e instanceof HttpError ? e.status : (st >= 400 && st <= 599 ? st : 500);
      if (status >= 500) console.error(`[http] ${req.method} ${url.pathname} 失败：`, e && e.stack || e);
      if (r.opts.raw) { try { res.destroy(); } catch { /* ignore */ } }
      else this._fail(res, status, e.message || 'internal error', req, e.extra);
    }
  }

  _fail(res, status, message, req, extra) {
    if (res.writableEnded) return;
    const body = JSON.stringify({ error: message, ...(extra || {}) });
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  /** 供 index.js 直接挂到 http.createServer */
  handler() {
    return (req, res) => {
      let url;
      try { url = new URL(req.url, 'http://localhost'); }
      catch { return this._fail(res, 400, 'bad url', req); }
      // 反代常见坑：Nginx 若配 proxy_pass http://backend/ 会把前缀剥掉；
      // 这里统一归一化，避免出现「加了 /panel 前缀就全 404」的玄学问题
      if (url.pathname.startsWith('/panel/')) url.pathname = url.pathname.slice(6) || '/';
      this.dispatch(req, res, url).catch((e) => this._fail(res, 500, e.message, req));
    };
  }
}

function authFail(req) { /* 401 计数留给上层记 oplog，避免此处依赖 store 造成环 */ }

class Ctx {
  constructor(req, res, url, m) {
    this.req = req; this.res = res; this.url = url;
    this.params = m.params || {};
    this.rest = m.rest;
    this.query = Object.fromEntries(url.searchParams);
    this.user = null;
    this.ip = auth.clientIp(req);
  }

  /** 读 JSON body（带体积上限；超限 413，解析失败 400） */
  async body() {
    if (this._body !== undefined) return this._body;
    const len = +this.req.headers['content-length'] || 0;
    if (len > MAX_BODY) throw new HttpError(413, '请求体过大');
    const chunks = [];
    let size = 0;
    await new Promise((resolve, reject) => {
      let settled = false;
      this.req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) { settled = true; reject(new HttpError(413, '请求体过大')); this.req.destroy(); return; }
        chunks.push(c);
      });
      this.req.on('end', () => { if (!settled) resolve(); });
      this.req.on('error', (e) => { if (!settled) { settled = true; reject(e); } });
    }).catch((e) => { if (e instanceof HttpError) throw e; throw new HttpError(400, '读取请求体失败'); });
    const raw = Buffer.concat(chunks);
    if (!raw.length) return (this._body = {});
    const ct = this.req.headers['content-type'] || '';
    if (ct.includes('application/x-www-form-urlencoded')) {
      return (this._body = Object.fromEntries(new URLSearchParams(raw.toString('utf8'))));
    }
    try { return (this._body = JSON.parse(raw.toString('utf8'))); }
    catch { throw new HttpError(400, 'JSON 解析失败'); }
  }

  json(status, obj) {
    if (this.res.writableEnded) return;
    const body = JSON.stringify(obj);
    const headers = { 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', 'x-request-id': rid() };
    const acceptGzip = /\bgzip\b/.test(this.req.headers['accept-encoding'] || '') && Buffer.byteLength(body) > JSON_GZIP_MIN;
    if (acceptGzip) {
      const z = zlib.gzipSync(Buffer.from(body, 'utf8'), { level: 5 });
      headers['content-type'] = 'application/json; charset=utf-8';
      headers['content-encoding'] = 'gzip';
      headers.vary = 'Accept-Encoding';
      this.res.writeHead(status, headers);
      return this.res.end(this.req.method === 'HEAD' ? undefined : z);
    }
    headers['content-type'] = 'application/json; charset=utf-8';
    headers['content-length'] = Buffer.byteLength(body);
    this.res.writeHead(status, headers);
    this.res.end(this.req.method === 'HEAD' ? undefined : body);
  }

  text(status, s, type = 'text/plain; charset=utf-8') {
    const body = String(s);
    this.res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body), 'x-content-type-options': 'nosniff' });
    this.res.end(body);
  }

  /** 把原始请求体流式写入目标文件（上传不经过堆，内存恒定） */
  pipeToFile(filePath, { maxBytes }) {
    const fs = require('node:fs');
    return new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(filePath);
      let size = 0, aborted = false;
      const fail = (e) => { if (aborted) return; aborted = true; ws.destroy(); ws.on('close', () => {}); reject(e); };
      this.req.on('data', (c) => {
        size += c.length;
        if (maxBytes && size > maxBytes) { ws.destroy(); try { fs.unlinkSync(filePath); } catch { /* ignore */ } fail(new HttpError(413, `文件超过上限 ${Math.round(maxBytes / 1048576)}MB`)); }
      });
      this.req.pipe(ws);
      ws.on('error', (e) => fail(e));
      ws.on('finish', () => { if (!aborted) resolve(size); });
      this.req.on('error', (e) => fail(e));
    });
  }
}

let ridCounter = 0;
function rid() { return (++ridCounter % 0xffff).toString(36) + Date.now().toString(36).slice(-4); }

module.exports = { App, HttpError, MAX_BODY };
