'use strict';
/**
 * REST API 路由表。
 * 约定：所有变更类操作一律写操作日志（谁/何时/动作/目标/结果）；
 *       所有错误响应只回 message，不外泄堆栈（堆栈进面板自身日志）。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const config = require('../lib/config');
const auth = require('../lib/auth');
const store = require('../lib/store');
const files = require('../sys/files');
const importer = require('../mc/importer');
const { HttpError } = require('../lib/http');
const { STATE } = require('../mc/proc');

function requireStr(v, name, max = 4096) {
  if (typeof v !== 'string' || !v.length) throw new HttpError(400, `${name} 不能为空`);
  if (v.length > max) throw new HttpError(400, `${name} 过长`);
  return v;
}

function register(app, ctx) {
  const { proc, monitor, rcon, hub, meta } = ctx;
  const audit = (ctx2, action, target, detail, ok = true) => store.record(ctx2.user || 'anon', action, target, detail, ok);

  // ————————————————— 鉴权 —————————————————
  app.post('/api/login', async (c) => {
    const b = await c.body();
    const key = 'login:' + c.ip;
    const rl = auth.rateCheck(key, config.get().security.loginMaxPerMin);
    if (!rl.allowed) throw new HttpError(429, `尝试过于频繁，${rl.retryAfter}s 后重试`);
    const okPwd = config.verifyPassword(b.password);
    const okUser = String(b.username || config.get().security.user) === config.get().security.user;
    if (!okPwd || !okUser) {
      store.record(String(b.username || '?'), 'login.fail', c.ip, null, false);
      throw new HttpError(401, '用户名或密码错误');
    }
    auth.rateReset(key);
    const ttl = Math.max(1, +config.get().security.tokenTtlHours || 24) * 3600;
    const token = auth.sign(config.get().security.user, ttl * 1000);
    c.res.setHeader('set-cookie', auth.cookieHeader(token, ttl));
    store.record(config.get().security.user, 'login.ok', c.ip);
    c.json(200, { ok: true, user: config.get().security.user, token });   // token 同时回传，便于脚本用 Bearer
  }, { auth: false, csrf: false });

  app.post('/api/logout', (c) => {
    c.res.setHeader('set-cookie', auth.cookieHeader('', 0));
    return { ok: true };
  }, { csrf: true });

  app.get('/api/session', (c) => ({ user: c.user, ip: c.ip, ts: Date.now() }));

  /** 免鉴权引导端点：把 authed 一并告知，前端据此决定要不要拉状态，
   *  避免首屏必然产生一次 401（浏览器控制台会留下难看的红色报错）。 */
  app.get('/api/public-config', (c) => ({
    needLogin: !hasPasswordYet(), authed: !!auth.authedUser(c.req), user: config.get().security.user, version: meta.version,
  }), { auth: false, csrf: false });

  // ————————————————— 聚合状态（首屏一次拉齐，避免 7 个并发请求） —————————————————
  app.get('/api/state', (c) => ({
    server: proc.status(),
    metrics: monitor.latest() ? onePoint(monitor.latest()) : null,
    series: monitor.series(+c.query.n || 200),
    players: playersSnapshot(proc, rcon),
    sampler: monitor.samplerStatus(),
    hub: hub.stats(),
    disk: diskInfo(),
    settings: publicSettings(),
    runtime: runtimeInfo(meta),
  }));

  // ————————————————— 服务端生命周期 —————————————————
  app.post('/api/server/start', async (c) => {
    const b = await c.body();
    if (b.force && proc.child) throw new HttpError(409, '服务端已在运行');
    const r = proc.start({ reason: 'manual' });
    audit(c, 'server.start', r.command.join(' '), `pid=${r.pid}`);
    return { ok: true, ...r };
  });

  app.post('/api/server/stop', async (c) => {
    const r = await proc.stop({});
    audit(c, 'server.stop', null, JSON.stringify(r));
    return { ok: true, ...r };
  });

  app.post('/api/server/kill', async (c) => {
    const r = await proc.kill();
    audit(c, 'server.kill', null, JSON.stringify(r), !r.forcedTimeout);
    return { ok: true, ...r };
  });

  app.post('/api/server/restart', async (c) => {
    const r = await proc.restart({ reason: 'manual' });
    audit(c, 'server.restart', null, `pid=${r.pid}`);
    return { ok: true, ...r };
  });

  app.post('/api/server/crash-reset', (c) => { proc.crashStreak = 0; audit(c, 'server.crash-reset'); return { ok: true }; });

  // ————————————————— 控制台 —————————————————
  app.get('/api/console', (c) => {
    const n = Math.min(Math.max(+c.query.lines || 500, 1), config.get().server.maxLines);
    return { lines: proc.recent(n), total: proc.ring.size, seq: proc.seq };
  });

  app.post('/api/console/send', async (c) => {
    const b = await c.body();
    const r = proc.sendCommand(b.command ?? b.text);
    audit(c, 'console.send', r.sent, null, true);
    return { ok: true, ...r };
  });

  app.post('/api/console/clear', (c) => { proc.clearBuffer(); audit(c, 'console.clear'); return { ok: true }; });

  /** 历史回放：读面板侧落盘日志尾部（有界，最多 5000 行 / 8MB） */
  app.get('/api/console/history', async (c) => {
    const n = Math.min(Math.max(+c.query.lines || 1000, 1), 5000);
    const file = path.join(config.get().panel.historyFile || meta.consoleLog);
    const lines = await tailFile(file, n);
    return { lines, file };
  });

  // ————————————————— 指标 —————————————————
  app.get('/api/metrics', (c) => ({ points: monitor.series(+c.query.n || 300), sampler: monitor.samplerStatus(), latest: monitor.latest() ? onePoint(monitor.latest()) : null }));

  // ————————————————— 玩家 / RCON —————————————————
  app.get('/api/players', async (c) => {
    if (config.get().rcon.enabled) {
      try {
        const l = await rcon.list();
        proc.players = new Set(l.names);
        const snap = { ...playersSnapshot(proc, rcon), ...l, source: 'rcon' };
        hub.publish('players', 'players', snap);
        return snap;
      } catch (e) {
        return { ...playersSnapshot(proc, rcon), rconError: e.message };
      }
    }
    return playersSnapshot(proc, rcon);
  });

  app.post('/api/rcon', async (c) => {
    const b = await c.body();
    const cmd = requireStr(b.command, 'command', 800);
    if (!config.get().rcon.enabled) throw new HttpError(409, 'RCON 未启用（设置里打开并填密码）');
    const out = await rcon.command(cmd, +b.timeoutMs || 6000);
    audit(c, 'rcon.exec', cmd, out ? String(out).slice(0, 500) : null);
    return { ok: true, output: String(out || '') };
  });

  // ————————————————— 文件 —————————————————
  app.get('/api/files', async (c) => {
    const r = await files.list(c.query.dir || '');
    audit(c, 'files.list', c.query.dir || '/');
    return r;
  });

  app.get('/api/files/content', async (c) => {
    const rel = requireStr(c.query.path, 'path', 1024);
    const r = await files.readText(rel);
    audit(c, 'files.read', rel);
    return r;
  });

  app.put('/api/files/content', async (c) => {
    const b = await c.body();
    const rel = requireStr(b.path, 'path', 1024);
    const r = await files.writeText(rel, b.text ?? '', { encoding: b.encoding });
    audit(c, 'files.write', rel, `${r.bytes}B`);
    return { ok: true, ...r };
  });

  /** 流式上传：请求体原样落盘，堆内存恒定 */
  app.put('/api/files/upload', async (c) => {
    const rel = requireStr(c.query.path, 'path', 1024);
    const { abs } = files.resolveIn(rel, { allowMissingParent: true });
    const maxBytes = 1024 * 1024 * 1024;
    try { fs.mkdirSync(path.dirname(abs), { recursive: true }); } catch { /* 已存在 */ }
    const tmp = abs + '.upload';
    const bytes = await c.pipeToFile(tmp, { maxBytes });
    fs.renameSync(tmp, abs);
    audit(c, 'files.upload', rel, `${bytes}B`);
    c.json(200, { ok: true, path: rel, bytes });
  }, { raw: true });

  app.del('/api/files', async (c) => {
    const rel = requireStr(c.query.path, 'path', 1024);
    const r = await files.remove(rel, { recursive: c.query.recursive === '1' });
    audit(c, 'files.delete', rel);
    return { ok: true, ...r };
  });

  app.post('/api/files/mkdir', async (c) => {
    const b = await c.body();
    const r = await files.mkdir(requireStr(b.path, 'path', 1024));
    audit(c, 'files.mkdir', b.path);
    return { ok: true, ...r };
  });

  app.post('/api/files/rename', async (c) => {
    const b = await c.body();
    const r = await files.rename(requireStr(b.from, 'from', 1024), requireStr(b.to, 'to', 1024));
    audit(c, 'files.rename', `${b.from} → ${b.to}`);
    return { ok: true, ...r };
  });

  app.get('/api/files/download', (c) => {
    const rel = requireStr(c.query.path, 'path', 1024);
    const { stream, size, name } = files.readStream(rel);
    audit(c, 'files.download', rel);
    c.res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': size,
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      'cache-control': 'no-store',
    });
    stream.pipe(c.res);
  }, { raw: true });

  // ————————————————— server.properties 等键值配置 —————————————————
  app.get('/api/properties', async (c) => {
    const rel = c.query.file || 'server.properties';
    const f = files.resolveIn(rel);
    if (!fs.existsSync(f.abs)) throw new HttpError(404, `文件不存在：${rel}`);
    const { text } = await files.readText(rel);
    const doc = files.parseProperties(text);
    return {
      file: rel,
      entries: doc.lines.filter((l) => l.kind === 'kv').map((l) => ({ key: l.key, value: l.value, schema: files.propsSchema(l.key) })),
      comments: doc.lines.filter((l) => l.kind === 'comment').length,
    };
  });

  app.put('/api/properties', async (c) => {
    const b = await c.body();
    const rel = b.file || 'server.properties';
    const changes = b.changes && typeof b.changes === 'object' ? b.changes : {};
    const keys = Object.keys(changes);
    if (!keys.length) return { ok: true, changed: 0 };
    if (keys.length > 200) throw new HttpError(400, '一次修改项过多');
    const f = files.resolveIn(rel);
    if (!fs.existsSync(f.abs)) throw new HttpError(404, `文件不存在：${rel}`);
    const { text } = await files.readText(rel);
    const doc = files.parseProperties(text);
    const applied = [];
    for (const k of keys) {
      if (!/^[\w.\-]{1,80}$/.test(k)) throw new HttpError(400, `非法键名：${k}`);
      const v = changes[k];
      if (v === null || v === undefined) continue;
      if (/[\r\n]/.test(String(v))) throw new HttpError(400, `值不能含换行：${k}`);
      applied.push({ key: k, before: (doc.lines.find((l) => l.kind === 'kv' && l.key === k) || {}).value, after: String(v) });
      files.setProperty(doc, k, String(v));
    }
    await files.writeText(rel, files.serializeProperties(doc));
    audit(c, 'properties.write', rel, applied.map((a) => `${a.key}=${a.after}`).join(' ').slice(0, 500));
    const running = proc.state !== STATE.OFFLINE;
    return { ok: true, changed: applied.length, applied, requiresRestart: running && _needsRestart(applied.map((a) => a.key)) };
  });

  // ————————————————— 设置 —————————————————
  app.get('/api/settings', (c) => publicSettings(true));

  app.put('/api/settings', async (c) => {
    const patch = await c.body();
    const v = config.update(patch);
    if (!v.ok) { audit(c, 'settings.update', null, v.errors.join('; '), false); throw new HttpError(400, v.errors.join('；'), { errors: v.errors }); }
    audit(c, 'settings.update', Object.keys(patch).join(','), v.warnings.join('; ') || null, true);
    // 缓冲上限变更即时生效
    if (patch.server?.maxLines) proc.resizeRing(v.cfg.server.maxLines);
    if (patch.monitor?.history) monitor.resizeRing(Math.min(Math.max(patch.monitor.history, 60), 7200));
    return { ok: true, warnings: v.warnings, settings: publicSettings(true) };
  });

  app.post('/api/settings/validate', async (c) => {
    const patch = await c.body();
    const v = config.validate(config.merge(config.get(), patch));
    return { ok: v.errors.length === 0, errors: v.errors, warnings: v.warnings, root: v.root };
  });

  app.post('/api/settings/password', async (c) => {
    const b = await c.body();
    if (!config.verifyPassword(b.current ?? '')) throw new HttpError(403, '当前密码不正确');
    const r = config.setPassword(b.password);
    if (!r.ok) throw new HttpError(400, r.error);
    audit(c, 'settings.password', null, '密码已修改，其它设备需重新登录');
    return { ok: true };
  });

  // ————————————————— 审计 —————————————————
  app.get('/api/oplog', (c) => store.query({ limit: +c.query.limit || 100, offset: +c.query.offset || 0, user: c.query.user || null, action: c.query.action || null }));

  // ————————————————— run.bat / run.sh 导入 —————————————————
  /** 先看实例根里有哪些可导入的启动脚本 */
  app.get('/api/import/detect', (c) => {
    const root = config.get().server.root;
    const scripts = root ? importer.findScripts(root) : [];
    return { root, scripts, currentLauncher: config.get().server.launcher };
  });

  /** 解析（默认不写入）；body.apply=true 才落到 settings */
  app.post('/api/import/runbat', async (c) => {
    const b = await c.body();
    const root = config.get().server.root;
    if (!root || !fs.existsSync(root)) throw new HttpError(409, '请先在设置里指定服务端目录');
    const file = String(b.file || 'run.bat').replace(/[\\/:*?"<>|]/g, '');
    const abs = path.join(root, file);
    if (!fs.existsSync(abs)) {
      const avail = importer.findScripts(root);
      throw new HttpError(404, `找不到 ${file}` + (avail.length ? `；可用：${avail.join(', ')}` : '；该目录下没有任何已知启动脚本'));
    }
    const text = importer.readScript(root, file);
    const r = importer.parseRunScript(text, { root, fileName: file });
    if (!r.ok) { audit(c, 'import.runbat', file, r.error, false); throw new HttpError(422, r.error); }
    if (b.apply) {
      const v = config.update(r.patch);
      if (!v.ok) { audit(c, 'import.runbat', file, v.errors.join('; '), false); throw new HttpError(400, v.errors.join('；'), { errors: v.errors }); }
      audit(c, 'import.runbat', file, r.argv.join(' '));
      return { ok: true, applied: true, argv: r.argv, notes: r.notes, patch: r.patch, warnings: v.warnings, settings: publicSettings(true) };
    }
    audit(c, 'import.runbat.preview', file, r.argv.join(' '));
    return { ok: true, applied: false, argv: r.argv, notes: r.notes, patch: r.patch };
  });

  // ————————————————— 健康检查（Nginx / 监控探针用，免鉴权） —————————————————
  // 带 pid + data 身份字段：更新脚本靠它判断「回答我的确实是我刚拉起的那个实例」。
  // 否则同机跑两份面板时（比如测试副本），健康检查会被另一个实例冒领，
  // 导致「不健康就自动回滚」在最需要的时候不触发 —— 实测踩过。
  app.get('/api/health', (c) => c.json(200, {
    ok: true, state: proc.state, uptime: Math.round(process.uptime()), rss: process.memoryUsage.rss(),
    pid: process.pid, data: require('../lib/paths').DATA, panel: meta.version, sea: meta.sea,
  }), { auth: false, csrf: false });
}

function _needsRestart(keys) {
  const hot = new Set(['motd', 'max-players', 'white-list', 'enforce-whitelist', 'enable-rcon', 'rcon', 'rcon.password', 'rcon.port', 'broadcast-console-to-ops', 'broadcast-rcon-to-ops', 'hide-online-players', 'pause-when-empty-seconds', 'force-gamemode', 'spawn-protection']);
  return keys.some((k) => !hot.has(k));
}

function onePoint(s) {
  return {
    ts: s.ts, cpu: s.cpu ?? null, procCpu: s.proc.cpu ?? null, sysCpu: s.sys.cpuCim ?? s.sys.cpu ?? null,
    mem: s.mem ?? null, procRss: s.proc.rss ?? null, procPrivate: s.proc.private ?? null,
    sysMemUsed: s.sys.memUsed ?? null, sysMemTotal: s.sys.memTotal ?? null,
    ioRead: s.disk.read ?? null, ioWrite: s.disk.write ?? null,
    procIoRead: s.proc.ioRead ?? null, procIoWrite: s.proc.ioWrite ?? null,
    procIoStale: s.proc.ioStaleMs ?? null, threads: s.proc.threads ?? null, panelRss: s.sys.panelRss ?? null,
  };
}

function playersSnapshot(proc, rcon) {
  const names = [...proc.players];
  return { online: names.length, max: null, names, source: config.get().rcon.enabled ? 'rcon(last)' : 'log', rcon: rcon.state };
}

function diskInfo() {
  const root = config.get().server.root;
  try {
    const st = fs.statfsSync(root || process.cwd());
    return { root, total: st.bsize * st.blocks, free: st.bsize * st.bavail };
  } catch { return { root, total: null, free: null }; }
}

/** 面向前端的设置视图：剥掉密码/密钥类字段 */
function publicSettings(full = false) {
  const cfg = JSON.parse(JSON.stringify(config.get()));
  if (!full) {
    delete cfg.rcon.password;
    cfg.security = { user: cfg.security.user, tokenTtlHours: cfg.security.tokenTtlHours };
  } else {
    cfg.rcon.passwordSet = !!cfg.rcon.password;
    cfg.rcon.password = '';                       // 明文密码永不下发；留空 + 已设置标记
  }
  cfg.hasPassword = hasPasswordYet();
  return cfg;
}

function hasPasswordYet() { return config.hasPassword(); }

function runtimeInfo(meta) {
  return {
    node: process.version, v8: process.versions.v8, platform: `${os.platform()} ${os.release()}`,
    arch: os.arch(), hostname: os.hostname(), cpus: os.cpus().length, totalMem: os.totalmem(),
    panelRss: process.memoryUsage.rss(), heapUsed: process.memoryUsage().heapUsed,
    startedAt: meta.startedAt, uptime: Math.round(process.uptime()), sea: meta.sea,
    storeBackend: store.backend(), panelVersion: meta.version, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

/** 读文件尾部 n 行（从末尾分块回读，不把整个文件读进内存） */
async function tailFile(file, n) {
  const MAX_CHUNK = 8 * 1024 * 1024;
  let fd;
  try { fd = await fs.promises.open(file, 'r'); } catch { return []; }
  try {
    const { size } = await fd.stat();
    if (!size) return [];
    let pos = size, collected = Buffer.alloc(0);
    while (pos > 0 && countLines(collected) <= n) {
      const len = Math.min(64 * 1024, pos);
      pos -= len;
      const buf = Buffer.allocUnsafe(len);
      await fd.read(buf, 0, len, pos);
      collected = Buffer.concat([buf, collected]);
      if (collected.length > MAX_CHUNK) break;
    }
    return new TextDecoder('utf-8', { fatal: false }).decode(collected).split(/\r?\n/).filter((l) => l.length).slice(-n);
  } finally { await fd.close(); }
}
function countLines(buf) { let c = 0; for (const b of buf) if (b === 10) c++; return c; }

module.exports = { register };
