'use strict';
/**
 * 文件与配置管理。
 *
 * 沙箱：一切路径必须落在 settings.server.root 内 —— resolve 归一化 + 前缀校验 +
 *       realpath 二次校验（挡符号链接/junction 逃逸），含 NUL、盘符、.. 一律拒绝。
 * 上传：请求体直接 stream 到磁盘，堆里只留 64KB chunk，1GB 大地图包也不撑内存。
 * 编辑：文本读有上限（默认 2MB）；properties 采用「保注释、保顺序」的行模型回写，
 *       绝不做「parse → stringify」式的整文件重排（会丢掉模组写的注释与顺序）。
 */
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const config = require('../lib/config');

const TEXT_MAX = 2 * 1024 * 1024;
const LIST_MAX = 3000;
const BINARY_EXTS = new Set(['.jar', '.zip', '.gz', '.tar', '.7z', '.png', '.jpg', '.jpeg', '.gif', '.ico', '.dat', '.db', '.mca', '.bin', '.exe', '.dll', '.pdf', '.woff', '.woff2']);

function root() {
  const r = config.get().server.root;
  return r && fs.existsSync(r) ? path.resolve(r) : null;
}

/** 相对路径 → 沙箱内绝对路径；越界抛 403 语义错误 */
function resolveIn(rel, { allowMissingParent = false } = {}) {
  const base = root();
  if (!base) { const e = new Error('实例目录未配置或不存在，请先在设置里指定 server.root'); e.status = 409; throw e; }
  if (typeof rel !== 'string') { const e = new Error('路径必须为字符串'); e.status = 400; throw e; }
  if (rel.includes('\0')) { const e = new Error('路径含非法字符'); e.status = 400; throw e; }
  const cleaned = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = cleaned.split('/');
  for (const p of parts) {
    if (p === '..') { const e = new Error('禁止路径穿越（..）'); e.status = 400; throw e; }
    if (/^[a-zA-Z]:/.test(p) || p.startsWith('~')) { const e = new Error('禁止绝对路径'); e.status = 400; throw e; }
  }
  const abs = path.resolve(base, '.' + path.sep + cleaned);
  if (abs !== base && !abs.startsWith(base + path.sep)) { const e = new Error('路径越界'); e.status = 403; throw e; }
  try {
    const real = fs.realpathSync(abs);
    const realBase = fs.realpathSync(base);
    if (real !== realBase && !real.startsWith(realBase + path.sep)) { const e = new Error('检测到符号链接逃逸，已拒绝'); e.status = 403; throw e; }
  } catch (e) {
    if (e.code !== 'ENOENT' && e.code !== 'EPERM' && e.code !== 'ENOTDIR') throw e;
    if (!allowMissingParent) { /* 新文件/未创建目录：允许，写的时候自然校验 */ }
  }
  return { abs, base, rel: path.relative(base, abs).split(path.sep).join('/') };
}

function isBinary(abs) { return BINARY_EXTS.has(path.extname(abs).toLowerCase()); }

async function list(dirRel) {
  const { abs, base } = resolveIn(dirRel || '');
  const st = await fsp.stat(abs);
  if (!st.isDirectory()) throw Object.assign(new Error('不是目录'), { status: 400 });
  const names = await fsp.readdir(abs);
  const out = [];
  for (const name of names.slice(0, LIST_MAX)) {
    let s;
    try { s = await fsp.lstat(path.join(abs, name)); } catch { continue; }
    const isDir = s.isDirectory();
    const link = s.isSymbolicLink() || s.isJunction?.() === true;
    out.push({
      name,
      dir: isDir,
      link,
      size: isDir ? null : s.size,
      mtime: Math.floor(s.mtimeMs),
      binary: !isDir && isBinary(path.join(abs, name)),
      protected: !isDir && _isProtected(base, path.join(abs, name)),
    });
  }
  out.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }));
  return { dir: path.relative(base, abs).split(path.sep).join('/'), root: base, total: names.length, truncated: names.length > LIST_MAX, entries: out };
}

/** 服务端运行期必写文件：编辑前提示（避免热改被回写覆盖） */
function _isProtected(base, abs) {
  const rel = path.relative(base, abs).replace(/\\/g, '/');
  return /^(level\.dat|session\.lock|usercache\.json|ops\.json)$/.test(rel) || rel.startsWith('region/') || rel.endsWith('.mca');
}

async function readText(rel) {
  const { abs } = resolveIn(rel);
  const st = await fsp.stat(abs);
  if (st.isDirectory()) throw Object.assign(new Error('是目录'), { status: 400 });
  if (st.size > TEXT_MAX) throw Object.assign(new Error(`文件过大（${(st.size / 1048576).toFixed(1)}MB > 2MB），请走下载`), { status: 413 });
  const buf = await fsp.readFile(abs);
  // 服务端配置文件常见 UTF-8 / GBK 混杂：先试 UTF-8，失败按 GBK 解，并告知前端用了哪种
  let text, encoding = 'utf-8';
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch { text = new TextDecoder('gbk').decode(buf); encoding = 'gbk'; }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return { rel, size: st.size, mtime: Math.floor(st.mtimeMs), encoding, binary: isBinary(abs) && !text, text };
}

/** 原子写：临时文件 + rename；保留 CRLF 风格，避免整文件 diff 噪音 */
async function writeText(rel, text, { encoding } = {}) {
  const { abs } = resolveIn(rel);
  const s = String(text);
  if (Buffer.byteLength(s) > TEXT_MAX) throw Object.assign(new Error('内容过大（>2MB）'), { status: 413 });
  let orig = null, crlf = false;
  try { orig = await fsp.readFile(abs); crlf = /\r\n/.test(orig.toString('latin1')); } catch { /* 新文件 */ }
  // 新文件（或原文件无换行）时以「提交内容自身的风格」为准，别把用户粘进来的 CRLF 强行改成 LF
  const ownStyle = /\r\n/.test(s);
  if (!orig || (!crlf && ownStyle)) crlf = true;
  const normalized = crlf ? s.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n') : s;
  if (encoding === 'gbk' || encoding === 'gb2312' || encoding === 'big5') {
    // Node 的 TextDecoder 能解 GBK，但**没有对应的编码器**（TextEncoder 只出 UTF-8），
    // Buffer.from(s,'gbk') 会直接抛 Unknown encoding。与其静默写成 UTF-8 骗过调用方，
    // 不如明确拒绝：MC 的 .properties/.json 本来就要求 UTF-8，正常场景不会走到这里。
    if (/[^\x00-\x7f]/.test(s)) {
      throw Object.assign(new Error('无法按 GBK 写入：Node 不支持 GBK 编码（Minecraft 配置文件本应为 UTF-8，请去掉 encoding 参数或改用 utf-8）'), { status: 422 });
    }
  }
  const buf = Buffer.from(normalized.charCodeAt(0) === 0xfeff ? normalized.slice(1) : normalized, 'utf8');
  const tmp = abs + '.mcslite.tmp';
  await fsp.writeFile(tmp, buf);
  await fsp.rename(tmp, abs);
  return { rel, bytes: buf.length, lineEnding: crlf ? 'crlf' : 'lf' };
}

async function remove(rel, { recursive = false } = {}) {
  const { abs } = resolveIn(rel);
  const st = await fsp.lstat(abs);
  if (st.isDirectory()) {
    if (!recursive) throw Object.assign(new Error('目录非空，需显式 recursive'), { status: 409 });
    await fsp.rm(abs, { recursive: true, force: true });
  } else await fsp.unlink(abs);
  return { removed: rel };
}

async function mkdir(rel) { const { abs } = resolveIn(rel, { allowMissingParent: true }); await fsp.mkdir(abs, { recursive: true }); return { created: rel }; }

async function rename(from, to) {
  const a = resolveIn(from), b = resolveIn(to);
  await fsp.rename(a.abs, b.abs);
  return { from: a.rel, to: b.rel };
}

async function stat(rel) {
  const { abs } = resolveIn(rel);
  const st = await fsp.stat(abs);
  return { rel, size: st.size, mtime: Math.floor(st.mtimeMs), dir: st.isDirectory(), binary: isBinary(abs) };
}

function readStream(rel) {
  const { abs } = resolveIn(rel);
  const st = fs.statSync(abs);
  return { stream: fs.createReadStream(abs, { highWaterMark: 128 * 1024 }), size: st.size, name: path.basename(abs) };
}

/** 目录树统计（用于仪表盘「实例体积」），有界遍历，防大地图扫爆 CPU */
async function treeSize(rel = '', { maxEntries = 20000 } = {}) {
  const { abs } = resolveIn(rel);
  let bytes = 0, files = 0, entries = 0, truncated = false;
  const stack = [abs];
  while (stack.length) {
    const dir = stack.pop();
    let names;
    try { names = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of names) {
      if (++entries > maxEntries) { truncated = true; return { bytes, files, truncated }; }
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!e.name.startsWith('.')) stack.push(p); continue; }
      try { bytes += (await fsp.stat(p)).size; files++; } catch { /* 竞态删除 */ }
    }
  }
  return { bytes, files, truncated };
}

// ————————————————— server.properties 行模型 —————————————————
/** 解析成 {lines:[{kind:'kv'|'comment'|'blank', key?, value?, raw?}]}，回写时零信息损失 */
function parseProperties(text) {
  const lines = String(text).split(/\r?\n/).map((raw) => {
    if (!raw.trim()) return { kind: 'blank', raw };
    if (/^\s*[#!]/.test(raw)) return { kind: 'comment', raw };
    const eq = raw.indexOf('=');
    if (eq < 0) return { kind: 'comment', raw };
    return { kind: 'kv', key: raw.slice(0, eq).trim(), value: raw.slice(eq + 1).trim(), raw };
  });
  return { lines };
}

function serializeProperties(doc) {
  return doc.lines.map((l) => (l.kind === 'kv' ? `${l.key}=${l.value}` : l.raw)).join('\n');
}

function setProperty(doc, key, value) {
  const hit = doc.lines.find((l) => l.kind === 'kv' && l.key === key);
  if (hit) { hit.value = String(value); return 'updated'; }
  doc.lines.push({ kind: 'kv', key, value: String(value), raw: `${key}=${value}` });
  return 'added';
}

/** 常见键的中文说明与输入类型，供前端生成表单（不认识的键自动落到 string 文本框） */
const PROP_SCHEMA = {
  'motd': { label: '服务器标题 (MOTD)', type: 'string', hint: '§ 色码可用' },
  'max-players': { label: '最大玩家数', type: 'int', min: 1, max: 65536 },
  'view-distance': { label: '视距（区块）', type: 'int', min: 2, max: 32, perf: true },
  'simulation-distance': { label: '模拟距离', type: 'int', min: 1, max: 15, perf: true },
  'server-port': { label: '游戏端口', type: 'int', min: 1, max: 65535 },
  'server-ip': { label: '绑定 IP', type: 'string', hint: '留空 = 全部网卡' },
  'online-mode': { label: '正版验证', type: 'bool', risk: true },
  'white-list': { label: '白名单', type: 'bool' },
  'enforce-whitelist': { label: '强制白名单', type: 'bool' },
  'difficulty': { label: '难度', type: 'enum', values: ['peaceful', 'easy', 'normal', 'hard'] },
  'gamemode': { label: '默认游戏模式', type: 'enum', values: ['survival', 'creative', 'adventure', 'spectator'] },
  'level-name': { label: '世界名称', type: 'string', risk: true },
  'level-seed': { label: '世界种子', type: 'string' },
  'pvp': { label: 'PVP', type: 'bool' },
  'freeze-players-when-undefloaded': { label: '过载时冻结玩家', type: 'bool' },
  'enable-command-block': { label: '命令方块', type: 'bool' },
  'allow-nether': { label: '允许下界', type: 'bool' },
  'spawn-protection': { label: '出生点保护半径', type: 'int', min: 0, max: 512 },
  'max-world-size': { label: '最大世界边界', type: 'int', min: 1, max: 10000000 },
  'entity-broadcast-range-percentage': { label: '实体广播范围 %', type: 'int', min: 1, max: 1000, perf: true },
  'sync-chunk-writes': { label: '同步区块写入', type: 'bool', perf: true },
  'network-compression-threshold': { label: '网络压缩阈值', type: 'int', min: -1, max: 2147483647, perf: true },
  'enable-rcon': { label: '启用 RCON', type: 'bool' },
  'rcon.port': { label: 'RCON 端口', type: 'int', min: 1, max: 65535 },
  'rcon.password': { label: 'RCON 密码', type: 'secret' },
  'pause-when-empty-seconds': { label: '无人时暂停秒数', type: 'int', min: -1, max: 65536 },
  'force-players-to-chat-report': { label: '强制聊天举报', type: 'bool', risk: true },
  'query.port': { label: 'Query 端口', type: 'int', min: 1, max: 65535 },
  'server-properties-file-comment': { label: '', type: 'string' },
  'rate-limit': { label: '玩家包限速 (B/s)', type: 'int', min: -1, max: 2147483647 },
  'chunk-builder': { label: '区块生成线程', type: 'int', min: 1, max: 64, perf: true },
  'enable-jmx-monitoring': { label: '启用 JMX', type: 'bool' },
  'broadcast-console-to-ops': { label: '控制台消息广播给 OP', type: 'bool' },
  'broadcast-rcon-to-ops': { label: 'RCON 消息广播给 OP', type: 'bool' },
  'previews-chat': { label: '聊天预览', type: 'bool' },
  'hide-online-players': { label: '隐藏在线玩家', type: 'bool' },
  'initial-enabled-packs': { label: '默认启用资源包', type: 'string' },
  'resource-pack': { label: '资源包 URL', type: 'string' },
};

function propsSchema(key) {
  return PROP_SCHEMA[key] || { label: key, type: _guessType(key) };
}
function _guessType(key) {
  if (/^(enable|allow|pvp|force|use|sync|broadcast|white|hardcore|online|harden|prevent|generate|view|query)/.test(key)) return 'bool';
  return 'string';
}

/** 把 fs 错误码翻译成 HTTP 语义：ENOENT→404、EACCES→403、EISDIR/ENOTDIR→400。
 *  否则一次目录探测就变成 500 + 面板日志里刷一条无意义的堆栈。 */
function mapFsError(e, rel) {
  const code = e && e.code;
  if (code === 'ENOENT') return Object.assign(new Error(`文件不存在：${rel == null ? '' : rel}`), { status: 404 });
  if (code === 'EACCES' || code === 'EPERM') return Object.assign(new Error(`权限不足（Windows ACL 或文件被服务端占用）：${rel || ''}`), { status: 403 });
  if (code === 'EISDIR') return Object.assign(new Error('目标是一个目录'), { status: 400 });
  if (code === 'ENOTDIR') return Object.assign(new Error('路径中存在非目录段'), { status: 400 });
  if (code === 'EBUSY') return Object.assign(new Error('文件正被服务端占用，无法修改'), { status: 423 });
  if (code === 'ENOSPC') return Object.assign(new Error('磁盘空间不足'), { status: 507 });
  if (code === 'EROFS') return Object.assign(new Error('只读文件系统'), { status: 403 });
  return e;
}

/** 统一包装：已带 status 的领域错误原样抛，其余按 fs 语义翻译 */
function guarded(fn) {
  return async (...args) => {
    try { return await fn(...args); }
    catch (e) { throw (e && e.status) ? e : mapFsError(e, args[0]); }
  };
}

module.exports = {
  list: guarded(list), readText: guarded(readText), writeText: guarded(writeText),
  remove: guarded(remove), mkdir: guarded(mkdir), rename: guarded(rename),
  stat: guarded(stat), treeSize: guarded(treeSize),
  readStream: (rel) => { try { return readStream(rel); } catch (e) { throw (e && e.status) ? e : mapFsError(e, rel); } },
  resolveIn, root, parseProperties, serializeProperties, setProperty, propsSchema, PROP_SCHEMA,
  TEXT_MAX, isBinary, mapFsError,
};
