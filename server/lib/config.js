'use strict';
/**
 * 配置层：data/settings.json —— 人可直接编辑、可热改，是「开箱即用」的关键。
 * 所有写入都过一遍校验（validate），非法值直接拒绝而不是带病运行。
 * 密码散列独立放 data/credentials.json，避免随手分享 settings.json 时泄露。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DATA } = require('./paths');

const FILE = path.join(DATA, 'settings.json');
const CRED = path.join(DATA, 'credentials.json');

const DEFAULTS = {
  version: 1,
  panel: {
    host: '127.0.0.1',          // 默认只监听回环：外部访问必须经 Nginx 反代
    port: 8787,
    trustProxy: true,           // 反代后信任 X-Forwarded-For（仅当 host 是回环时生效）
    serveStatic: true,          // 无 Nginx 时面板自带静态托管（单文件分发场景）
  },
  server: {
    root: '',                   // 服务端实例目录（留空 = data/instance）
    javaPath: 'java',           // 支持手动指定绝对路径（含空格的 Windows 路径已处理）
    jarName: 'server.jar',      // 相对 root；NeoForge 通常是 win.bat 指向的那个 universal jar
    launcher: 'jar',            // 'jar' | 'command'：command 模式下用 startCommand 全量托管
    startCommand: '',           // launcher=command 时的 argv 数组（绝不过 shell）
    jvmArgs: '-Xms2G -Xmx4G -XX:+UseG1GC -XX:MaxGCPauseMillis=50 -XX:+AlwaysPreTouch -Dfile.encoding=UTF-8 -Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8',
    mcArgs: 'nogui',
    autostart: false,
    autoRestart: true,          // 崩溃自动拉起（正常 stop 不触发）
    restartBackoff: [5000, 15000, 60000],
    stopCommand: 'stop',
    stopTimeoutMs: 90000,       // 优雅停止等待上限，超时后强杀
    stopOnExit: false,          // 面板退出时是否顺带停服：默认否（面板与游戏进程解耦，升级面板不掉线）
    consoleEncoding: 'auto',    // auto | utf-8 | gbk
    maxLines: 3000,             // 控制台环形缓冲行数（内存上限的直接旋钮）
    logFile: 'logs/latest.log', // 用于历史回放的文件（相对 root）
  },
  rcon: { enabled: false, host: '127.0.0.1', port: 25575, password: '' },
  monitor: {
    intervalMs: 3000,
    history: 900,               // 指标环形容量：900×3s ≈ 45 分钟
    diskSampler: 'auto',        // auto | powershell | off —— 磁盘 IO 采样器
    samplerIdleMs: 120000,      // 无人订阅超时后停掉 PowerShell 子进程（省 ~30MB）
  },
  security: {
    user: 'admin',
    tokenTtlHours: 24,
    loginMaxPerMin: 10,
    allowLANPlayersView: true,
  },
};

const clone = (o) => JSON.parse(JSON.stringify(o));

/** 深度合并：数组整体覆盖（不做 push 合并，避免语义歧义） */
function merge(base, patch) {
  const out = clone(base);
  for (const k of Object.keys(patch || {})) {
    const v = patch[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = merge(base[k], v);
    } else if (v !== undefined) out[k] = clone(v);
  }
  return out;
}

/** 安全分词：只处理引号分组，永不调用 shell */
function tokenize(s) {
  const out = []; let cur = '', q = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) { q = null; } else cur += c; }
    else if (c === '"' || c === "'") q = c;
    else if (/\s/.test(c)) { if (cur) { out.push(cur); cur = ''; } }
    else cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function isFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }

/** 返回 {ok, errors[], warnings[], resolvedRoot} */
function validate(cfg) {
  const errors = [], warnings = [];
  const s = cfg.server;
  const root = s.root && s.root.trim() ? path.resolve(s.root.trim()) : path.join(DATA, 'instance');
  if (!isDir(root)) errors.push(`服务端目录不存在：${root}`);
  if (!s.jarName || /[\r\n]/.test(s.jarName)) errors.push('jarName 非法');
  else if (path.isAbsolute(s.jarName) || s.jarName.includes('..')) errors.push('jarName 必须是 root 内的相对路径');
  else if (s.launcher !== 'command' && isDir(root) && !isFile(path.join(root, s.jarName))) warnings.push(`jar 尚未存在：${s.jarName}（请先把服务端放入目录）`);

  if (s.launcher === 'command') {
    const argv = tokenize(s.startCommand || '');
    if (!argv.length) errors.push('launcher=command 时 startCommand 不能为空');
  } else {
    const jp = (s.javaPath || '').trim();
    if (!jp) errors.push('javaPath 不能为空');
    else if (jp !== path.basename(jp) && !isFile(jp)) errors.push(`javaPath 不存在：${jp}`);
    if (!/\bfile\.encoding\s*=/.test(s.jvmArgs || '')) warnings.push('jvmArgs 未含 -Dfile.encoding=UTF-8：中文日志可能乱码');
  }
  if (cfg.rcon.enabled && !cfg.rcon.password) warnings.push('rcon 已启用但密码为空');
  if (cfg.rcon.enabled && cfg.rcon.host !== '127.0.0.1' && cfg.rcon.host !== 'localhost') warnings.push('rcon 指向远端且面板未强制 TLS，建议仅内网使用');
  if (Number(cfg.panel.port) < 1 || Number(cfg.panel.port) > 65535) errors.push('panel.port 越界');
  if (!['auto', 'utf-8', 'gbk'].includes(s.consoleEncoding)) errors.push('consoleEncoding 只允许 auto|utf-8|gbk');
  const ml = Number(s.maxLines);
  if (!(ml >= 200 && ml <= 50000)) errors.push('maxLines 需在 200~50000');
  return { errors, warnings, root };
}

let current = null;
const listeners = new Set();

function load() {
  let file = {};
  try { file = JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch (e) { if (fs.existsSync(FILE)) console.error('[config] settings.json 解析失败，使用默认值：', e.message); }
  current = merge(DEFAULTS, file);
  // 环境变量覆盖：便于容器/计划任务/测试改端口而不碰 settings.json
  if (process.env.MCSLITE_PORT) current.panel.port = +process.env.MCSLITE_PORT || current.panel.port;
  if (process.env.MCSLITE_HOST) current.panel.host = process.env.MCSLITE_HOST;
  if (process.env.MCSLITE_ROOT) current.server.root = process.env.MCSLITE_ROOT;
  if (process.env.MCSLITE_JAVA) current.server.javaPath = process.env.MCSLITE_JAVA;
  return current;
}

function get() { return current || load(); }

/** 局部更新（PATCH 语义）；校验不过则抛错并带 errors */
function update(patch) {
  const next = merge(get(), patch);
  const { errors, warnings, root } = validate(next);
  const v = { ok: errors.length === 0, errors, warnings, root };
  if (errors.length) { v.cfg = null; return v; }
  save(next, v.root);
  for (const fn of listeners) { try { fn(current, next); } catch { /* 订阅者异常不影响配置生效 */ } }
  return v;
}

function save(cfg, resolvedRoot) {
  const out = clone(cfg);
  if (resolvedRoot) out.server.root = resolvedRoot;   // 归一化，避免相对路径漂移
  current = out;
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
  try { fs.renameSync(tmp, FILE); } catch { fs.rmSync(FILE, { force: true }); fs.renameSync(tmp, FILE); }
}

/** 凭据：scrypt 散列，防时序攻击比较 */
function readCred() {
  try { return JSON.parse(fs.readFileSync(CRED, 'utf8')); } catch { return null; }
}
function ensureCred(defaultPassword) {
  let c = readCred();
  if (c && c.hash) return c;
  const salt = crypto.randomBytes(16);
  const password = defaultPassword || randomPassword();
  const hash = crypto.scryptSync(String(password), salt, 32, { N: 16384, r: 8, p: 1 });
  c = { salt: salt.toString('hex'), hash: hash.toString('hex'), algorithm: 'scrypt:N=16384,r=8,p=1', createdAt: new Date().toISOString() };
  fs.writeFileSync(CRED, JSON.stringify(c, null, 2));
  try { fs.chmodSync(CRED, 0o600); } catch { /* Windows 无 POSIX 位 */ }
  return { ...c, password };
}
function verifyPassword(pwd) {
  const c = readCred();
  if (!c || !c.hash) return false;
  const h = crypto.scryptSync(String(pwd), Buffer.from(c.salt, 'hex'), 32, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(h, Buffer.from(c.hash, 'hex'));
}
function setPassword(pwd) {
  if (!pwd || String(pwd).length < 6) return { ok: false, error: '密码至少 6 位' };
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pwd), salt, 32, { N: 16384, r: 8, p: 1 });
  fs.writeFileSync(CRED, JSON.stringify({ salt: salt.toString('hex'), hash: hash.toString('hex'), algorithm: 'scrypt:N=16384,r=8,p=1', createdAt: new Date().toISOString() }, null, 2));
  return { ok: true };
}
function hasPassword() { const c = readCred(); return !!(c && c.hash); }
function randomPassword() {
  return crypto.randomBytes(9).toString('base64url');
}
/** 会话签名密钥：与凭据同源，改密不踢会话；单独存，绝不写进 settings.json */
function secret() {
  const f = path.join(DATA, 'secret.key');
  try { const s = fs.readFileSync(f, 'utf8').trim(); if (s.length >= 32) return s; } catch { /* 首次生成 */ }
  const s = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(f, s);
  try { fs.chmodSync(f, 0o600); } catch { /* ignore */ }
  return s;
}

function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

load();

module.exports = { get, load, update, save, DEFAULTS, merge, tokenize, validate, ensureCred, verifyPassword, setPassword, hasPassword, secret, randomPassword, onChange, FILE, CRED };
