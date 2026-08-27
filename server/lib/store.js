'use strict';
/**
 * 持久层：操作日志 / 审计。
 * 首选 Node 22.5+ 内置 node:sqlite —— 零依赖、单文件、查询分页天然高效，
 * 比 better-sqlite3 省掉整个原生编译链（Server 2016 上无 VS BuildTools 是硬伤）。
 * 若运行在更老的 Node（比如为兼容 Server 2016 退回 18.20），自动降级为 JSONL
 * 追加文件 + 内存索引，API 完全一致，业务层无感。
 */
const fs = require('node:fs');
const path = require('node:path');
const { DATA } = require('./paths');

const MAX_ROWS = 5000;
let db = null, jsonlPath = null, stInsert = null, stPrune = null, stCount = null;
const stmts = new Map();          // 条件组合 → 预编译语句（仅几种过滤形态，不泄漏）
let backend = 'memory';
const mem = [];   // JSONL / memory 降级时的行缓存（有上限）

function init() {
  const file = path.join(DATA, 'mcslite.db');
  try {
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA synchronous=NORMAL');
    db.exec('PRAGMA cache_size=-600');            // 约 600KB 页缓存，够用了
    db.exec(`CREATE TABLE IF NOT EXISTS oplog(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL, user TEXT NOT NULL, action TEXT NOT NULL,
      target TEXT, detail TEXT, ok INTEGER NOT NULL DEFAULT 1)
    `);
    db.exec('CREATE INDEX IF NOT EXISTS ix_oplog_ts ON oplog(ts DESC)');
    stInsert = db.prepare('INSERT INTO oplog(ts,user,action,target,detail,ok) VALUES(?,?,?,?,?,?)');
    stPrune = db.prepare('DELETE FROM oplog WHERE id < (SELECT COALESCE(MAX(id),0)-? FROM oplog)');
    backend = 'sqlite';
  } catch (e) {
    jsonlPath = path.join(DATA, 'oplog.jsonl');
    backend = 'jsonl';
    try {
      const lines = fs.readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean).slice(-MAX_ROWS);
      for (const l of lines) { try { mem.push(JSON.parse(l)); } catch { /* 丢弃坏行 */ } }
    } catch { /* 首次启动无文件 */ }
    console.warn('[store] node:sqlite 不可用，操作日志降级为 JSONL：', e.message);
  }
  return backend;
}

function record(user, action, target, detail, ok = true) {
  const row = { id: null, ts: new Date().toISOString(), user: String(user || 'anon'), action: String(action),
                target: target == null ? null : String(target).slice(0, 512), detail: detail == null ? null : String(detail).slice(0, 2000), ok: ok ? 1 : 0 };
  if (backend === 'sqlite') {
    try { stInsert.run(row.ts, row.user, row.action, row.target, row.detail, row.ok); stPrune.run(MAX_ROWS); }
    catch (e) { mem.push(row); if (!global.__oplogErr) { global.__oplogErr = 1; console.error('[store] 写日志失败：', e.message); } }
  } else {
    row.id = mem.length + 1;
    mem.push(row);
    if (mem.length > MAX_ROWS) mem.splice(0, mem.length - MAX_ROWS);
    if (jsonlPath) {
      // 追加写；超过 2 倍上限时整写一次压实，避免文件无限膨胀
      fs.appendFile(jsonlPath, JSON.stringify(row) + '\n', (e) => { if (e) return; });
      if (mem.length === MAX_ROWS) compact();
    }
  }
  return row;
}

let compacting = false;
function compact() {
  if (compacting || !jsonlPath) return;
  compacting = true;
  const body = mem.map((r) => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFile(jsonlPath, body, () => { compacting = false; });
}

function query({ limit = 100, offset = 0, user = null, action = null } = {}) {
  const lim = Math.min(Math.max(+limit || 100, 1), 500);
  const off = Math.max(+offset || 0, 0);
  if (backend === 'sqlite') {
    const where = [];
    const args = [];
    if (user) { where.push('user=?'); args.push(user); }
    if (action) { where.push('action=?'); args.push(action); }
    const w = where.length ? ' WHERE ' + where.join(' AND ') : '';
    // 语句按条件组合缓存：面板只有少数几种过滤形态，不会造成语句泄漏
    const key = w + '|q';
    let sq = stmts.get(key);
    if (!sq) { sq = db.prepare(`SELECT id,ts,user,action,target,detail,ok FROM oplog${w} ORDER BY id DESC LIMIT ? OFFSET ?`); stmts.set(key, sq); }
    const ck = w + '|c';
    let sc = stmts.get(ck);
    if (!sc) { sc = db.prepare(`SELECT COUNT(*) AS n FROM oplog${w}`); stmts.set(ck, sc); }
    const rows = sq.all(...args, lim, off);
    const c = sc.get(...args);
    return { rows: rows.map(normalize), total: Number(c && c.n) };
  }
  return { rows: memFilter(lim, off, user, action), total: memCount(user, action) };
}

function memFilter(lim, off, user, action) {
  let src = mem;
  if (user || action) src = src.filter((r) => (!user || r.user === user) && (!action || r.action === action));
  return src.slice().reverse().slice(off, off + lim);
}
function memCount(user, action) {
  if (!user && !action) return mem.length;
  return mem.filter((r) => (!user || r.user === user) && (!action || r.action === action)).length;
}
function normalize(r) { return { ...r, ok: !!r.ok }; }

function close() { try { if (db) db.close(); } catch { /* ignore */ } }

init();
module.exports = { record, query, close, backend: () => backend, MAX_ROWS };
