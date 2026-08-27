'use strict';
/**
 * MCSLite 面板入口。
 * 启动序：读配置 → 确保凭据 → 建 http server → 挂 REST/WS → 可选 autostart。
 * 退出序：SIGINT/SIGTERM → 停采样器 → 优雅停 java（可配）→ 关监听 → 30s 硬退出兜底。
 */
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const config = require('./lib/config');
const auth = require('./lib/auth');
const store = require('./lib/store');
const staticSrv = require('./lib/static');
const { App } = require('./lib/http');
const { Hub } = require('./lib/hub');
const ws = require('./lib/ws');
const { MinecraftProcess, STATE } = require('./mc/proc');
const { Rcon } = require('./mc/rcon');
const { Monitor } = require('./sys/monitor');
const routes = require('./api/routes');
const { LOGS, WEB_DIST, SEA, ROOT } = require('./lib/paths');
const pkg = require('../package.json');

const meta = { version: pkg.version, startedAt: Date.now(), sea: SEA, root: ROOT, consoleLog: path.join(LOGS, 'panel-console.log') };
const proc = new MinecraftProcess();
const monitor = new Monitor();
const rcon = new Rcon();
const hub = new Hub();

// ————————————————————————— HTTP —————————————————————————
const app = new App();
routes.register(app, { proc, monitor, rcon, hub, meta });

const server = http.createServer((req, res) => {
  const url = req.url || '/';
  if (url.startsWith('/api/')) return app.handler()(req, res);
  const cfg = config.get().panel;
  if (req.method === 'GET' || req.method === 'HEAD') {
    if (cfg.serveStatic !== false && fs.existsSync(WEB_DIST)) return staticSrv.serve(req, res, url.split('?')[0]);
    if (!url.startsWith('/api/')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(BRANDING_HTML);
    }
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('not found');
});

// ————————————————————————— WebSocket —————————————————————————
ws.attach(server, {
  path: '/ws',
  verify: (req) => auth.authedUser(req),
  onConnection: (conn, user) => {
    hub.add(conn);
    conn._subs = new Set();
    conn.send('hello', { version: meta.version, user: user.user, state: proc.status(), ts: Date.now() });
    conn.on('message', (msg) => onWsMessage(conn, msg));
    store.record(user.user, 'ws.connect', conn.id);
  },
  onDisconnect: (conn) => {
    if (conn._subs?.has('metrics')) monitor.removeSubscriber();
    if (conn._subs?.has('players')) stopPlayerPoll();
  },
});

function onWsMessage(conn, msg) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.t === 'sub' || msg.t === 'unsub') {
    const topics = Array.isArray(msg.topics) ? msg.topics.slice(0, 8) : [msg.topic].filter(Boolean);
    for (const raw of topics) {
      const topic = String(raw).slice(0, 24);
      if (!ALLOWED_TOPICS.has(topic)) continue;
      if (msg.t === 'sub') {
        hub.subscribe(conn, topic);
        if (!conn._subs.has(topic)) {
          conn._subs.add(topic);
          if (topic === 'metrics') monitor.addSubscriber();
          if (topic === 'players') startPlayerPoll();
          sendTopicSnapshot(conn, topic);
        }
      } else {
        hub.unsubscribe(conn, topic);
        conn._subs.delete(topic);
        if (topic === 'metrics' && !hub.count('metrics')) monitor.removeSubscriber();
        if (topic === 'players' && !hub.count('players')) stopPlayerPoll();
      }
    }
    conn.send('subs', { topics: [...conn._subs] });
    return;
  }
  if (msg.t === 'ping') return conn.send('pong', { ts: Date.now() });
  // WS 通道内的控制台输入：与 REST 同一实现，避免两套语义
  if (msg.t === 'console') {
    try {
      const r = proc.sendCommand(msg.command);
      store.record(conn.user?.user || 'anon', 'console.send', r.sent);
    } catch (e) { conn.send('error', { message: e.message }); }
  }
}

const ALLOWED_TOPICS = new Set(['console', 'metrics', 'state', 'players', 'sampler']);

function sendTopicSnapshot(conn, topic) {
  if (topic === 'console') {
    conn.send('replay', { lines: proc.recent(Math.min(config.get().server.maxLines, 800)), seq: proc.seq });
  } else if (topic === 'metrics') {
    conn.send('series', { points: monitor.series(300), sampler: monitor.samplerStatus() });
  } else if (topic === 'state') {
    conn.send('state', proc.status());
  } else if (topic === 'players') {
    conn.send('players', { online: proc.players.size, names: [...proc.players], source: 'log', rcon: rcon.state });
  } else if (topic === 'sampler') {
    conn.send('sampler', monitor.samplerStatus());
  }
}

// 进程事件 → 广播（订阅为空时 hub 内部直接 return，无序列化开销）
proc.on('line', (item) => hub.publishLines('console', item));
proc.on('status', (s) => { hub.publish('state', 'state', s); monitor.setPid(s.pid); if (s.running) startPlayerPoll(); });
proc.on('exit', (info) => hub.publish('state', 'exit', info));
proc.on('players', (p) => hub.publish('players', 'players', { ...p, online: p.players.length, max: null }));
proc.on('clear', () => hub.publish('console', 'cleared', null));
monitor.on('sample', (s) => hub.publish('metrics', 'metrics', onePoint(s)));
monitor.on('sampler', (st) => hub.publish('sampler', 'sampler', st));

function onePoint(s) {
  return {
    ts: s.ts, cpu: s.cpu ?? null, procCpu: s.proc.cpu ?? null, sysCpu: s.sys.cpuCim ?? s.sys.cpu ?? null,
    mem: s.mem ?? null, procRss: s.proc.rss ?? null, sysMemUsed: s.sys.memUsed ?? null, sysMemTotal: s.sys.memTotal ?? null,
    ioRead: s.disk.read ?? null, ioWrite: s.disk.write ?? null, procIoRead: s.proc.ioRead ?? null,
    procIoWrite: s.proc.ioWrite ?? null, procIoStale: s.proc.ioStaleMs ?? null,
    threads: s.proc.threads ?? null, panelRss: s.sys.panelRss ?? null,
  };
}

// —— 玩家列表按需轮询：无人订阅就不打 RCON ——
let playerTimer = null;
function startPlayerPoll() {
  if (playerTimer) return;
  if (!config.get().rcon.enabled) return;
  playerTimer = setInterval(pollPlayers, 5000);
  playerTimer.unref?.();
  pollPlayers();
}
function stopPlayerPoll() { if (playerTimer) { clearInterval(playerTimer); playerTimer = null; } }
async function pollPlayers() {
  if (!config.get().rcon.enabled) return;
  try {
    const l = await rcon.list();
    proc.players = new Set(l.names);
    hub.publish('players', 'players', { online: l.online, max: l.max, names: l.names, source: 'rcon', rcon: rcon.state });
  } catch (e) {
    hub.publish('players', 'players', { online: proc.players.size, names: [...proc.players], source: 'log', error: e.message, rcon: rcon.state });
  }
}

// ————————————————————————— 配置联动 —————————————————————————
config.onChange((prev, next) => {
  rcon.configure(next.rcon);
  if (next.server.maxLines !== prev.server.maxLines) proc.resizeRing(next.server.maxLines);
  if (next.monitor.history !== prev.monitor.history) monitor.resizeRing(Math.min(Math.max(next.monitor.history, 60), 7200));
  if (next.rcon.enabled) startPlayerPoll(); else stopPlayerPoll();
});

function applyRconFromProperties() {
  // 用户在 server.properties 里开了 rcon 却忘了同步面板设置时给出提示，而不是静默失败
  const root = config.get().server.root;
  if (!root) return;
  const f = path.join(root, 'server.properties');
  try {
    const txt = fs.readFileSync(f, 'utf8');
    const enabled = /^\s*(enable-rcon|rcon)\s*=\s*true\s*$/im.test(txt);
    const pw = (/^\s*rcon\.password\s*=\s*(.*)$/im.exec(txt) || [])[1] || '';
    const port = +(/^\s*rcon\.port\s*=\s*(\d+)/im.exec(txt) || [])[1] || 25575;
    const cfg = config.get();
    if (enabled && !cfg.rcon.enabled) {
      proc.sysLine('<panel> 检测到 server.properties 已开启 rcon，可在「设置→RCON」一键同步');
      if (pw && !cfg.rcon.password) { rcon.configure({ enabled: true, host: cfg.rcon.host, port, password: pw }); }
    }
  } catch { /* 无配置文件 */ }
}

// ————————————————————————— 生命周期 —————————————————————————
function banner(addr, cred) {
  const lines = [
    '',
    '  ┌─ MCSLite · Minecraft 轻量管理面板 v' + meta.version + (SEA ? ' (单文件模式)' : '') + ' ─┐',
    '  │  面板地址   ' + addr.padEnd(40) + ' │',
    '  │  登录用户   ' + String(config.get().security.user).padEnd(40) + ' │',
    cred ? '  │  初始密码   ' + String(cred).padEnd(40) + ' │' : '  │  密码       已保存在 data/credentials.json'.padEnd(44) + ' │',
    '  │  实例目录   ' + String(config.get().server.root || '(未设置)').padEnd(40) + ' │',
    '  └─ 数据目录 data/ · 后端零依赖 · RSS 目标 <40MB ─┘',
    '',
  ];
  console.log(lines.join('\n'));
}

async function shutdown(sig) {
  if (global.__closing) return;
  global.__closing = true;
  console.log(`\n[mcslite] 收到 ${sig}，开始退出…`);
  // 硬兜底不 unref：WS/keep-alive 挂住时也要保证 25s 内一定退出
  const hardTimer = setTimeout(() => { console.error('[mcslite] 25s 未退出，强制结束'); process.exit(1); }, 25000);
  stopPlayerPoll();
  monitor.shutdown();
  rcon.close();
  if (proc.child && config.get().server.stopOnExit) {
    try { await proc.stop({ timeoutMs: 45000 }); } catch (e) { console.error('[mcslite] 停止服务端异常：', e.message); }
  } else if (proc.child) {
    console.log('[mcslite] 保留 java 进程（stopOnExit=false），面板与游戏进程解耦');
  }
  await new Promise((r) => server.close(r));
  try { server.closeAllConnections?.(); } catch { /* ignore */ }
  try { store.close(); } catch { /* ignore */ }
  clearTimeout(hardTimer);
  console.log('[mcslite] 已退出');
  process.exit(0);
}

function main() {
  const cfg = config.get();
  const created = !config.hasPassword();
  const cred = config.ensureCred(process.env.MCSLITE_PASSWORD);
  if (!cfg.server.root) {
    // 首启：建好默认实例目录再写配置，避免「目录不存在」把默认值一并拒掉
    const want = process.env.MCSLITE_ROOT || path.join(ROOT, 'instance');
    try { fs.mkdirSync(want, { recursive: true }); } catch { /* 只读介质 */ }
    try { config.update({ server: { root: want } }); }
    catch (e) { console.warn('[mcslite] 默认实例目录写入被拒：', e.errors?.join('；') || e.message); }
  }
  rcon.configure(config.get().rcon);

  const host = cfg.panel.host, port = +cfg.panel.port;
  server.listen({ host, port, exclusive: true }, () => {
    const addr = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}/`;
    banner(addr, created ? cred.password : null);
    if (created) {
      console.log('  ⚠ 首次启动：请立即登录并修改密码。');
      console.log('  ⚠ 初始密码仅在本次启动打印一次，也已写入 data/credentials.json。\n');
    }
    store.record('system', 'panel.start', addr, `node=${process.version} sea=${SEA}`);
    applyRconFromProperties();
    if (config.get().server.autostart) {
      setTimeout(() => {
        try { proc.start({ reason: 'autostart' }); console.log('[mcslite] autostart 已拉起服务端'); }
        catch (e) { console.error('[mcslite] autostart 失败：', e.message); }
      }, 1500).unref?.();
    }
  });
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') { console.error(`[mcslite] 端口 ${port} 已被占用（是否已有一个面板在跑？改 data/settings.json 的 panel.port）`); process.exit(2); }
    if (e.code === 'EACCES') { console.error(`[mcslite] 无权限绑定 ${host}:${port}（<1024 需管理员）`); process.exit(2); }
    console.error('[mcslite] 监听失败：', e);
    process.exit(2);
  });
  // WS 心跳：清理半开连接（Windows 不会主动报错）
  ws.startHeartbeat(hub.conns, 30000, 95000);
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGHUP', () => { config.load(); rcon.configure(config.get().rcon); console.log('[mcslite] 已重载 settings.json'); });
  process.on('unhandledRejection', (e) => console.error('[mcslite] unhandledRejection：', e));
  process.on('uncaughtException', (e) => { console.error('[mcslite] uncaughtException：', e.stack || e); store.record('system', 'panel.crash', null, String(e && e.stack).slice(0, 800), false); });
}

const BRANDING_HTML = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MCSLite 面板未构建</title><style>body{font:15px/1.7 -apple-system,"Microsoft YaHei",sans-serif;background:#0e1116;color:#c9d1d9;max-width:720px;margin:8vh auto;padding:0 20px}code{background:#1b2028;padding:2px 6px;border-radius:4px}h1{color:#58d68d;font-size:22px}</style>
<h1>MCSLite 后端已运行 ✔</h1>
<p>但前端资源尚未构建（<code>web/dist</code> 不存在），所以看到本页面。</p>
<p>二选一：</p>
<ol><li>本机已有 Nginx：把 <code>web/dist</code> 构建产物交给 Nginx 托管（推荐，见 <code>nginx/mcslite.conf</code>）。</li>
<li>快速体验：<code>cd web && npm install && npm run build</code>，之后刷新本页即可看到面板。</li></ol>
<p>API 直连可用：<a href="/api/health" style="color:#58a6ff">/api/health</a> · 面板 RSS：<code id="r"></code></p>
<script>fetch('/api/health').then(r=>r.json()).then(j=>r.textContent=(j.rss/1048576).toFixed(1)+' MB，状态 '+j.state)</script></html>`;

main();

module.exports = { server, proc, monitor, rcon, hub };
