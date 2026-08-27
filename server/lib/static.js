'use strict';
/**
 * 静态资源托管（仅在未配 Nginx / 单文件分发时启用；生产由 Nginx 直接吐文件）。
 * 要点：路径穿越防护 + realpath 二次校验（挡符号链接逃逸）、
 *       Vite 哈希资源 immutable 长缓存、HTML no-store、有界 gzip 缓存。
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { WEB_DIST } = require('./paths');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8', '.map': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
};
const GZIP_CACHE = new Map();
const GZIP_CACHE_MAX = 20;
const TEXTUAL = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg', '.txt', '.map']);

function remember(key, val) {
  if (GZIP_CACHE.size >= GZIP_CACHE_MAX) GZIP_CACHE.delete(GZIP_CACHE.keys().next().value);
  GZIP_CACHE.set(key, val);
  return val;
}

/** 把相对路径安全解析到 root 内；越界返回 null */
function safeJoin(root, rel) {
  if (typeof rel !== 'string' || rel.includes('\0')) return null;
  const cleaned = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  if (cleaned.split('/').some((p) => p === '..' || /^[a-zA-Z]:/.test(p) || p.startsWith('~'))) return null;
  const abs = path.resolve(root, '.' + path.sep + cleaned);
  const normRoot = path.resolve(root);
  if (abs !== normRoot && !abs.startsWith(normRoot + path.sep)) return null;
  try {                                                  // 符号链接指向外面也拦掉
    const real = fs.realpathSync(abs);
    const realRoot = fs.realpathSync(normRoot);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null;
    return real;
  } catch { return null; }
}

function serve(req, res, urlPath, rootOverride) {
  const root = rootOverride || WEB_DIST;
  let rel = decodeURIComponent(urlPath || '/');
  let abs = safeJoin(root, rel);
  if (!abs) { res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('forbidden'); }

  let st = null;
  try { st = fs.statSync(abs); } catch { /* 不存在 */ }
  if (st && st.isDirectory()) { abs = safeJoin(root, path.relative(root, abs) + '/index.html'); st = null; }
  if (!abs) { res.writeHead(403); return res.end('forbidden'); }
  try { st = fs.statSync(abs); } catch { st = null; }

  // SPA 回退：非资源路径（无扩展名）交给 index.html，前端路由自己处理
  if (!st && !path.extname(abs) && !abs.endsWith('favicon.ico')) {
    abs = path.join(root, 'index.html');
    try { st = fs.statSync(abs); } catch { st = null; }
  }
  if (!st || !st.isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    return res.end('404 Not Found：前端尚未构建？执行 npm run build:web（或直接用 Nginx 托管 web/dist）');
  }

  const ext = path.extname(abs).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const etag = `W/"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, { etag }); return res.end(); }
  const hashed = /[.-][0-9a-zA-Z_]{6,}\.(js|css|woff2?|png|jpg|svg)$/.test(abs) || abs.includes(`${path.sep}assets${path.sep}`);
  const cc = ext === '.html' || !hashed ? 'no-cache' : 'public, max-age=31536000, immutable';

  const acceptsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  if (acceptsGzip && TEXTUAL.has(ext) && st.size > 1400) {
    const key = abs + etag;
    let gz = GZIP_CACHE.get(key);
    if (!gz) { gz = zlib.gzipSync(fs.readFileSync(abs), { level: 6 }); remember(key, gz); }
    res.writeHead(200, { 'content-type': type, 'content-encoding': 'gzip', vary: 'Accept-Encoding', 'cache-control': cc, etag, 'x-content-type-options': 'nosniff' });
    return res.end(req.method === 'HEAD' ? undefined : gz);
  }
  res.writeHead(200, { 'content-type': type, 'content-length': st.size, 'cache-control': cc, etag, 'x-content-type-options': 'nosniff' });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(abs, { highWaterMark: 64 * 1024 }).pipe(res);
}

module.exports = { serve, safeJoin, WEB_DIST };
