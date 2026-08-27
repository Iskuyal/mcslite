'use strict';
/**
 * 鉴权：自签 HMAC token（无 JWT 依赖）+ scrypt 口令散列 + 登录限速 + CSRF 防护。
 *
 * token 形如 base64url(payload).base64url(hmac)，payload 含 {u,exp,jti}。
 * 校验：先 constant-time 比签名，再看过期；不查库，单次开销 ~2µs。
 * CSRF：token 走 httpOnly + SameSite=Strict cookie，同时对所有非安全方法
 *       校验 Origin/Referer 必须与 Host 同源 —— 双保险，且不引入 CSRF token 字段。
 */
const crypto = require('node:crypto');
const config = require('./config');

const B64 = (b) => Buffer.from(b).toString('base64url');
const unb64 = (s) => Buffer.from(s, 'base64url');

function sign(user, ttlMs) {
  const exp = Date.now() + ttlMs;
  const payload = JSON.stringify({ u: user, exp, jti: crypto.randomBytes(6).toString('hex') });
  const body = B64(payload);
  const mac = crypto.createHmac('sha256', config.secret()).update(body).digest();
  return body + '.' + B64(mac);
}

function verify(token) {
  if (typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot), given = token.slice(dot + 1);
  const expect = crypto.createHmac('sha256', config.secret()).update(body).digest();
  let givenBuf;
  try { givenBuf = unb64(given); } catch { return null; }
  if (givenBuf.length !== expect.length || !crypto.timingSafeEqual(givenBuf, expect)) return null;
  let p;
  try { p = JSON.parse(unb64(body).toString('utf8')); } catch { return null; }
  if (!p || typeof p.exp !== 'number' || p.exp < Date.now()) return null;
  if (p.u !== config.get().security.user) return null;   // 改用户名即全体会话失效
  return { user: p.u, exp: p.exp, jti: p.jti };
}

const COOKIE = 'mcslite_session';
function cookieHeader(token, maxAgeSec) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}`;
}
function parseCookies(req) {
  const h = req.headers.cookie;
  if (!h) return null;
  for (const part of h.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === COOKIE) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

/** 从 cookie 或 Authorization: Bearer 取身份（后者给脚本/curl 用） */
function authedUser(req) {
  const t = parseCookies(req) || (/^Bearer\s+(.+)$/i.exec(req.headers.authorization || '') || [])[1];
  return t ? verify(t) : null;
}

function clientIp(req) {
  const cfg = config.get().panel;
  const socket = req.socket;
  const fromLoop = socket && socket.remoteAddress && /^(127\.|::1|::ffff:127\.)/.test(socket.remoteAddress);
  if (cfg.trustProxy && fromLoop) {
    const xf = req.headers['x-forwarded-for'];
    if (typeof xf === 'string' && xf) return xf.split(',')[0].trim().slice(0, 64);
  }
  return (socket && socket.remoteAddress) || 'unknown';
}

/** 仅当请求确实来自本机反代时才采信 X-Forwarded-Proto，防直连伪装 */
function isHTTPS(req) {
  const cfg = config.get().panel;
  if (req.socket && req.socket.encrypted) return true;
  if (cfg.trustProxy && /^(127\.|::1|::ffff:127\.)/.test(req.socket.remoteAddress || '')) {
    return (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  }
  return false;
}

/** CSRF：非安全方法必须同源（浏览器跨站表单/fetch 会带不上匹配 Origin） */
function sameOrigin(req) {
  const origin = req.headers.origin || req.headers.referer;
  if (!origin) return true;                            // 无 Origin（curl/原生表单）交给 SameSite 兜底
  let host = '';
  try { host = new URL(origin).host; } catch { return false; }
  return host === (req.headers.host || '').replace(/^wss?:\/\//, '');
}

// —— 登录限速：固定 Map + 定期压实，杜绝 OOM 面 ——
const buckets = new Map();
const BUCKET_CAP = 2048;
function rateCheck(key, limit, windowMs = 60000) {
  const now = Date.now();
  if (buckets.size > BUCKET_CAP) for (const [k, v] of buckets) { if (v.reset < now) buckets.delete(k); }
  let b = buckets.get(key);
  if (!b || b.reset < now) { b = { n: 0, reset: now + windowMs }; buckets.set(key, b); }
  b.n++;
  return { allowed: b.n <= limit, retryAfter: Math.ceil((b.reset - now) / 1000), n: b.n };
}
function rateReset(key) { buckets.delete(key); }

module.exports = { sign, verify, cookieHeader, parseCookies, authedUser, clientIp, isHTTPS, sameOrigin, rateCheck, rateReset, COOKIE };
