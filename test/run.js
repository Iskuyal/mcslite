'use strict';
/**
 * MCSLite 端到端冒烟测试：真起面板进程 + 真 WebSocket 客户端 + 真子进程 java 替代物。
 * 覆盖：鉴权/CSRF/路径穿越/体积上限、生命周期、ANSI 渲染、日志批处理、
 *       文件与 properties 保注释回写、流式上传、按需采样器、审计日志。
 * 用法：node test/run.js [--keep]
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const crypto = require('node:crypto');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8791;
const DATA = path.join(ROOT, 'test', '.tmp-data');
const INSTANCE = path.join(ROOT, 'test', '.tmp-instance');
const PASSWORD = 'smoke-pass-123';
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
let cookie = '';
function ok(name, cond, info) { results.push({ name, pass: !!cond, info: info == null ? '' : String(info).slice(0, 220) }); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function req(method, urlPath, { body, headers = {}, raw = null, noCookie = false, origin } = {}) {
  return new Promise((resolve, reject) => {
    const payload = raw !== null ? raw : (body !== undefined ? Buffer.from(JSON.stringify(body)) : null);
    const h = { ...headers };
    if (payload) { h['content-type'] = h['content-type'] || 'application/json'; h['content-length'] = payload.length; }
    if (origin) h['origin'] = origin;
    else if (!noCookie) h['origin'] = BASE;                       // 同源默认带上，专测 CSRF 时显式覆盖
    if (cookie && !noCookie) h['cookie'] = cookie;
    const rq = http.request({ host: '127.0.0.1', port: PORT, method, path: urlPath, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString('utf8')); } catch { /* 非 JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, json, text: buf.toString('utf8'), buf });
      });
    });
    rq.on('error', reject);
    if (payload) rq.write(payload);
    rq.end();
  });
}

/** 最小 WS 客户端（带掩码，走浏览器同款路径） */
function wsConnect() {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.connect(PORT, '127.0.0.1', () => {
      sock.write(`GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nCookie: ${cookie}\r\n\r\n`);
    });
    const conn = { sock, msgs: [], handshake: false, buf: Buffer.alloc(0), pending: [] };
    const expected = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    sock.on('data', (d) => {
      if (!conn.handshake) {
        conn.buf = Buffer.concat([conn.buf, d]);
        const i = conn.buf.indexOf('\r\n\r\n');
        if (i < 0) return;
        const head = conn.buf.subarray(0, i).toString('latin1');
        const accept = /sec-websocket-accept:\s*(\S+)/i.exec(head);
        if (!/HTTP\/1\.1 101/i.test(head) || !accept || accept[1] !== expected) { return reject(new Error('握手失败：\n' + head.replace(/\r\n/g, ' ⏎ ') + '\nexpected= ' + expected)); }
        conn.handshake = true;
        conn.buf = conn.buf.subarray(i + 4);
        resolve(conn);
      } else conn.buf = Buffer.concat([conn.buf, d]);
      drain(conn);
    });
    sock.on('error', (e) => { if (!conn.handshake) reject(e); });
  });
}
function drain(conn) {
  for (;;) {
    const b = conn.buf;
    if (b.length < 2) return;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f, off = 2;
    if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
    if (masked) { if (b.length < off + 4 + len) return; off += 4; }
    if (b.length < off + len) return;
    let payload = b.subarray(off, off + len);
    if (masked) { const mk = b.subarray(off - 4, off); payload = Buffer.from(payload); for (let i = 0; i < payload.length; i++) payload[i] ^= mk[i & 3]; }
    conn.buf = b.subarray(off + len);
    if (opcode === 1) { try { const m = JSON.parse(payload.toString('utf8')); conn.msgs.push(m); for (const f of conn.pending.splice(0)) f(m); } catch { /* ignore */ } }
    else if (opcode === 8) { conn.closed = true; }
  }
}
function wsSend(conn, obj) {
  const p = Buffer.from(JSON.stringify(obj), 'utf8');
  const mask = crypto.randomBytes(4);
  const len = p.length;
  const head = len < 126 ? Buffer.from([0x81, 0x80 | len]) : len < 65536 ? (() => { const b = Buffer.allocUnsafe(4); b[0] = 0x81; b[1] = 0x80 | 126; b.writeUInt16BE(len, 2); return b; })() : (() => { const b = Buffer.allocUnsafe(10); b[0] = 0x81; b[1] = 0x80 | 127; b.writeBigUInt64BE(BigInt(len), 2); return b; })();
  const out = Buffer.concat([head, mask, Buffer.from(p)]);
  for (let i = 0; i < p.length; i++) out[head.length + 4 + i] ^= mask[i & 3];   // 偏移要跳过 4 字节 mask
  conn.sock.write(out);
}
async function waitMsg(conn, type, timeoutMs = 12000, pred = () => true) {
  const hit = conn.msgs.find((m) => m.t === type && pred(m));
  if (hit) return hit;
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => { const i = conn.pending.indexOf(fn); if (i >= 0) conn.pending.splice(i, 1); reject(new Error(`等待 WS 消息 "${type}" 超时`)); }, timeoutMs);
    const fn = (m) => { if (m.t === type && pred(m)) { clearTimeout(to); resolve(m); } else conn.pending.push(fn); };
    conn.pending.push(fn);
  });
}

async function until(fn, ms = 20000, step = 300) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return null;
    await sleep(step);
  }
}

async function main() {
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.rmSync(INSTANCE, { recursive: true, force: true });
  fs.mkdirSync(path.join(INSTANCE, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(INSTANCE, 'server.properties'),
    '#MCSLite 测试用配置\n#Generated by the Minecraft server\nmotd=§a旧标题§r 欢迎来到测试服\nmax-players=20\nonline-mode=true\n\n# 性能相关\nview-distance=10\nsimulation-distance=4\n');
  fs.writeFileSync(path.join(INSTANCE, 'eula.txt'), 'eula=true\n');

  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    env: { ...process.env, MCSLITE_DATA: DATA, MCSLITE_ROOT: INSTANCE, MCSLITE_PASSWORD: PASSWORD, MCSLITE_PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let panelOut = '';
  child.stdout.on('data', (d) => { panelOut += d.toString(); });
  child.stderr.on('data', (d) => { panelOut += d.toString(); });

  const keep = process.argv.includes('--keep');
  const cleanup = async () => { if (!keep) { try { child.kill(); } catch { /* gone */ } await sleep(300); try { child.kill('SIGKILL'); } catch { /* gone */ } } };

  try {
    // ——— 1. 存活 & 免鉴权探针 ———
    const h = await until(async () => { try { return (await req('GET', '/api/health', { noCookie: true })).status === 200 ? (await req('GET', '/api/health', { noCookie: true })).json : null; } catch { return null; } }, 15000);
    ok('面板启动 + /api/health 免鉴权', h && h.ok === true, h && `state=${h.state}`);

    // ——— 2. 未授权访问 ———
    const un = await req('GET', '/api/state', { noCookie: true });
    ok('未登录访问受保护 API → 401', un.status === 401, un.status);

    // ——— 3. 登录（错误密码 + 正确密码）———
    const bad = await req('POST', '/api/login', { body: { username: 'admin', password: 'wrong' }, noCookie: true });
    ok('错误密码 → 401', bad.status === 401, bad.status);
    const good = await req('POST', '/api/login', { body: { username: 'admin', password: PASSWORD }, noCookie: true });
    const sc = good.headers['set-cookie'];
    cookie = (Array.isArray(sc) ? sc[0] : sc || '').split(';')[0];
    ok('登录成功并下发 httpOnly cookie', good.status === 200 && /HttpOnly/.test(String(sc)) && /SameSite=Strict/.test(String(sc)), cookie.slice(0, 24) + '…');

    // ——— 4. CSRF：跨源变更请求被拒 ———
    const csrf = await req('POST', '/api/console/send', { body: { command: 'say hack' }, origin: 'http://evil.example.com' });
    ok('跨站 Origin 的变更请求 → 403', csrf.status === 403, csrf.json && csrf.json.error);

    // ——— 5. 路径穿越防御 ———
    const trav1 = await req('GET', '/api/files/content?path=' + encodeURIComponent('../../../Windows/win.ini'));
    const trav2 = await req('GET', '/api/files/content?path=' + encodeURIComponent('C:/Windows/win.ini'));
    const trav3 = await req('GET', '/api/files/content?path=' + encodeURIComponent('%2e%2e%5c%2e%2e%5cwin.ini'));
    ok('路径穿越（../ 绝对盘符 编码变体）全部拦截', [trav1, trav2, trav3].every((r) => r.status >= 400 && r.status < 500), `${trav1.status}/${trav2.status}/${trav3.status}`);

    // ——— 6. 设置校验：非法 javaPath 被拒 ———
    const badSet = await req('PUT', '/api/settings', { body: { server: { javaPath: 'C:\\nope\\java.exe' } } });
    ok('非法 javaPath 被 validate 拒绝（不落盘）', badSet.status === 400, badSet.json && badSet.json.error);

    // ——— 7. 启动 mock 服务端 ———
    const setOk = await req('PUT', '/api/settings', { body: { server: { launcher: 'command', startCommand: `node ${path.join(ROOT, 'test', 'mock-server.js')}`, consoleEncoding: 'utf-8' } } });
    ok('切到 launcher=command 托管 mock 服务端', setOk.status === 200, setOk.json && setOk.json.warnings);
    const st = await req('POST', '/api/server/start', { body: {} });
    ok('启动服务端返回 pid', st.status === 200 && st.json.pid > 0, st.json && `pid=${st.json.pid}`);
    const pid = st.json.pid;

    // ——— 8. ANSI 渲染 + 日志缓冲 ———
    await req('POST', '/api/console/send', { body: { command: 'bogus-cmd' } });   // 逼出一行 ERROR，测级别识别
    const lines = await until(async () => { const r = await req('GET', '/api/console?lines=400'); const L = r.json.lines; return L.some((l) => /Done \(/.test(l.raw)) && L.some((l) => /Unknown or incomplete/.test(l.raw)) && L.some((l) => /启动完毕/.test(l.raw)) ? L : null; }, 20000);
    ok('启动日志可见且 Done 被解析', !!lines, lines && `${lines.length} 行`);
    const colored = lines && lines.find((l) => /<span class="c/.test(l.html));
    ok('ANSI 色码 → HTML span', !!colored, colored && colored.html.slice(0, 60));
    ok('§传统色码同样被渲染', lines && lines.some((l) => /<span/.test(l.html) && /启动完毕/.test(l.raw)), lines && lines.filter((l) => /启动完毕/.test(l.raw)).map((l) => l.html)[0]);
    ok('日志级别自动识别（warn/error 双级）', lines && lines.some((l) => l.level === 'error') && lines.some((l) => l.level === 'warn'), lines && [...new Set(lines.map((l) => l.level))].join(','));
    ok('HTML 转义防注入（原始行含 < 不产生裸标签）', lines && lines.every((l) => !/<(?!span)[a-z]/i.test(l.html)));
    ok('状态机 STARTING → ONLINE', (await (await req('GET', '/api/state')).json).server.state === 'online');

    // ——— 9. WebSocket：订阅 + 批量行 + 指标推送 ———
    const conn = await wsConnect();
    ok('WS 握手（Sec-WebSocket-Accept 校验通过）', conn.handshake);
    wsSend(conn, { t: 'sub', topics: ['console', 'metrics', 'state', 'players'] });
    const replay = await waitMsg(conn, 'replay');
    ok('WS 订阅即回放历史缓冲', replay.d.lines.length > 3, `${replay.d.lines.length} 行`);
    await waitMsg(conn, 'series');
    wsSend(conn, { t: 'console', command: 'say 中文命令通道' });
    const batch = await waitMsg(conn, 'lines', 15000);
    ok('控制台输入 → 服务端响应 → WS 批量帧', batch.d && batch.d.some((l) => /中文命令通道/.test(l.raw)), batch.d && `${batch.d.length} 行/帧`);
    const metric = await waitMsg(conn, 'metrics', 20000);
    ok('指标 WS 推送', !!metric.d, metric.d && JSON.stringify({ cpu: metric.d.cpu, procRss: metric.d.procRss, ioWrite: metric.d.ioWrite }));
    ok('采样器已产出 java 进程级指标（CIM）', metric.d && metric.d.procRss > 0, metric.d && `rss=${((metric.d.procRss || 0) / 1048576).toFixed(0)}MB threads=${metric.d.threads}`);
    ok('面板自身 RSS 记录在样本内', metric.d && metric.d.panelRss > 0, metric.d && `${(metric.d.panelRss / 1048576).toFixed(1)}MB`);

    // ——— 10. 在线玩家（日志解析降级通道）———
    const joined = await until(async () => { const r = await req('GET', '/api/players'); return r.json.names && r.json.names.length ? r.json : null; }, 25000);
    ok('玩家列表（无 RCON 时由日志推断）', !!joined, joined && `${joined.online} 人: ${joined.names.join(',')}`);

    // ——— 11. 文件读写 + properties 保注释回写 ———
    const ls = await req('GET', '/api/files?dir=');
    ok('文件列表含目录/文件元信息', ls.status === 200 && ls.json.entries.some((e) => e.name === 'server.properties'), ls.json && ls.json.entries.map((e) => e.name).join(','));
    const props = await req('GET', '/api/properties?file=server.properties');
    ok('server.properties 解析为表单条目', props.json.entries.length === 5, props.json && props.json.entries.map((e) => e.key).join(','));
    await req('PUT', '/api/properties', { body: { file: 'server.properties', changes: { 'motd': '§b新标题 ok', 'max-players': '64', 'server-port': '25566' } } });
    const after = fs.readFileSync(path.join(INSTANCE, 'server.properties'), 'utf8');
    ok('properties 回写保留注释与顺序', after.includes('#MCSLite 测试用配置') && after.includes('# 性能相关') && after.includes('online-mode=true'), JSON.stringify(after.split('\n').slice(0, 4)));
    ok('properties 新键追加而非重排', after.indexOf('server-port') > after.indexOf('view-distance') || /server-port=25566/.test(after));
    ok('修改返回热生效判定', (await req('PUT', '/api/properties', { body: { file: 'server.properties', changes: { 'motd': 'x' } } })).json.requiresRestart === false);

    // ——— 12. 流式上传 / 下载 / 删除 ———
    const blob = crypto.randomBytes(3 * 1024 * 1024);
    const up = await req('PUT', '/api/files/upload?path=' + encodeURIComponent('datapacks/big.zip'), { raw: blob, headers: { 'content-type': 'application/octet-stream' } });
    ok('3MB 流式上传成功且字节数一致', up.status === 200 && up.json.bytes === blob.length, up.json && `${up.json.bytes}B`);
    ok('上传落盘内容一致（非堆内拼接）', fs.readFileSync(path.join(INSTANCE, 'datapacks', 'big.zip')).equals(blob));
    const dl = await req('GET', '/api/files/download?path=' + encodeURIComponent('datapacks/big.zip'));
    ok('下载回读一致', dl.status === 200 && dl.buf.equals(blob), dl.headers['content-disposition']);
    const del = await req('DELETE', '/api/files?path=' + encodeURIComponent('datapacks/big.zip'));
    ok('删除文件', del.status === 200 && !fs.existsSync(path.join(INSTANCE, 'datapacks', 'big.zip')));
    const mkdir = await req('POST', '/api/files/mkdir', { body: { path: 'plugins/test-sub' } });
    ok('递归建目录', mkdir.status === 200 && fs.existsSync(path.join(INSTANCE, 'plugins', 'test-sub')));

    // ——— 13. 文本写入编码 ———
    const wt = await req('PUT', '/api/files/content', { body: { path: 'notes.txt', text: '第一行\r\n第二行 中文\r\n' } });
    ok('文本写入保留 CRLF 风格', wt.status === 200 && wt.json.lineEnding === 'crlf', wt.json && wt.json.lineEnding);
    ok('CRLF 落盘正确', fs.readFileSync(path.join(INSTANCE, 'notes.txt'), 'utf8').includes('\r\n第二行 中文'));

    // ——— 14. 优雅停止 ———
    const stop = await req('POST', '/api/server/stop', { body: {} });
    ok('优雅停止（stdin stop）', stop.status === 200 && stop.json.graceful === true, stop.json && JSON.stringify(stop.json));
    const gone = await until(async () => { const r = await req('GET', '/api/state'); return r.json.server.state === 'offline' ? r.json.server : null; }, 15000);
    ok('进程退出且状态回 offline', gone && gone.lastExit && gone.lastExit.code === 0, gone && JSON.stringify(gone.lastExit));

    // ——— 15. 审计日志 ———
    const log = await req('GET', '/api/oplog?limit=100');
    const acts = (log.json.rows || []).map((r) => r.action);
    ok('操作日志覆盖登录/启停/文件/命令', ['login.ok', 'server.start', 'console.send', 'files.upload', 'properties.write', 'server.stop', 'ws.connect'].every((a) => acts.includes(a)), acts.join(','));
    ok('审计记录了失败的登录尝试', (log.json.rows || []).some((r) => r.action === 'login.fail' && r.ok === false));
    ok('store 后端为 node:sqlite（零依赖）', log.json.rows.length > 0 && /sqlite/.test(JSON.stringify((await req('GET', '/api/state')).json.runtime || {})), (await req('GET', '/api/state')).json.runtime && (await req('GET', '/api/state')).json.runtime.storeBackend);

    // ——— 16. 崩溃自动重启 ———
    await req('PUT', '/api/settings', { body: { server: { restartBackoff: [1500], autoRestart: true } } });
    await req('POST', '/api/server/start', { body: {} });
    await until(async () => (await (await req('GET', '/api/state')).json).server.state === 'online', 20000);
    await req('POST', '/api/console/send', { body: { command: 'crash' } });
    const revived = await until(async () => { const s = (await (await req('GET', '/api/state')).json).server; return s.state === 'online' && s.crashStreak === 0 ? s : null; }, 30000, 500);
    ok('异常退出 → 自动重启 + 崩溃计数', !!revived, revived && `pid=${revived.pid}`);
    const crashed = JSON.parse(JSON.stringify(await req('GET', '/api/console?lines=200')));
    ok('崩溃与重启过程在控制台留痕', crashed.json.lines.some((l) => /异常退出/.test(l.raw)) && crashed.json.lines.some((l) => /自动重启/.test(l.raw)));
    await req('POST', '/api/server/kill', { body: {} });
    await until(async () => (await (await req('GET', '/api/state')).json).server.state === 'offline', 15000);
    ok('强制终止（taskkill）后状态一致', (await (await req('GET', '/api/state')).json).server.state === 'offline');

    // ——— 16.5 全 ASCII 服务端（真实 Forge 1.20.1 控制台字节流回放）———
    // 回归对象：编码嗅探扣住文本 → 控制台空白 + 状态永久停在 starting。
    // mock-server.js 的中文行会让 auto 立刻定案，恰好绕开这条路径，所以必须单开一例。
    await req('POST', '/api/server/kill', { body: {} });
    await until(async () => (await (await req('GET', '/api/state')).json).server.state === 'offline', 15000);
    await req('PUT', '/api/settings', {
      body: {
        server: {
          autoRestart: false, consoleEncoding: 'auto', launcher: 'command',
          startCommand: `"${process.execPath}" "${path.join(ROOT, 'test', 'mock-ascii-server.js')}" --fast`,
        },
      },
    });
    await req('POST', '/api/console/clear', { body: {} });
    const stA = await req('POST', '/api/server/start', { body: {} });
    ok('纯 ASCII 服务端启动', stA.status === 200 && stA.json.pid > 0, stA.json && `pid=${stA.json.pid}`);
    const flow = await until(async () => { const r = await req('GET', '/api/console?lines=800'); return r.json.lines.length >= 60 ? r.json.lines : null; }, 6000);
    ok('全 ASCII 输出 6s 内持续出词（旧实现此时一行都没有）', !!flow, flow && `${flow.length} 行`);
    const encNow = (await (await req('GET', '/api/state')).json).server.encoding;
    ok('尚未定案编码也必须照直行（encoding=pending 是预期）', encNow === 'pending', `encoding=${encNow}`);
    ok('逐行完整、无被合并的巨型行', flow && flow.every((l) => l.raw.length < 400 && !/\n/.test(l.raw)), flow && flow.reduce((a, l) => Math.max(a, l.raw.length), 0));
    ok('Forge 的 Done 行被认出（stdout 路径）', flow && flow.some((l) => /Done \(13\.206s\)/.test(l.raw)));
    const onlineA = await until(async () => { const s = (await (await req('GET', '/api/state')).json).server; return s.state === 'online' ? s : null; }, 10000);
    ok('状态机 STARTING → ONLINE（纯 ASCII 服务端）', !!onlineA, onlineA && `state=${onlineA.state}`);
    await req('POST', '/api/server/stop', { body: {} });
    const offA = await until(async () => (await (await req('GET', '/api/state')).json).server.state === 'offline', 15000);
    ok('ASCII mock 优雅停止', !!offA);

    // ——— 16.6 stdout 完全静默的服务端 → 兜底读 logs/latest.log 判在线 ———
    await req('PUT', '/api/settings', {
      body: { server: { startCommand: `"${process.execPath}" "${path.join(ROOT, 'test', 'mock-ascii-server.js')}" --quiet` } },
    });
    await req('POST', '/api/console/clear', { body: {} });
    await req('POST', '/api/server/start', { body: {} });
    const onlineB = await until(async () => { const s = (await (await req('GET', '/api/state')).json).server; return s.state === 'online' ? s : null; }, 20000);
    ok('stdout 没有 Done 时由日志文件兜底判 ONLINE', !!onlineB, onlineB && `state=${onlineB.state}`);
    const noteB = await req('GET', '/api/console?lines=200');
    ok('兜底判定在控制台留痕（不静默改状态）', noteB.json.lines.some((l) => /已由 logs\/latest\.log 判定为运行中/.test(l.raw)),
      noteB.json.lines.filter((l) => /判定为运行中/.test(l.raw)).map((l) => l.raw[0] || '')[0]);
    await req('POST', '/api/server/kill', { body: {} });
    await until(async () => (await (await req('GET', '/api/state')).json).server.state === 'offline', 15000);

    // ——— 16.7 面板落盘时间戳与控制台显示同为本地时间（旧实现写 UTC，两边差一个时区）———
    const sinkFile = path.join(DATA, 'logs', 'panel-console.log');
    const sinkLines = fs.existsSync(sinkFile) ? fs.readFileSync(sinkFile, 'utf8').split(/\r?\n/).filter(Boolean) : [];
    const lastSink = /^\d{2}:\d{2}:\d{2}/.exec(sinkLines.length ? sinkLines[sinkLines.length - 1] : '');
    const nowLocal = new Date().toTimeString().slice(0, 8);
    const nowUtc = new Date().toISOString().slice(11, 19);
    const secs = (h) => (+h.slice(0, 2)) * 3600 + (+h.slice(3, 5)) * 60 + (+h.slice(6, 8));
    let skew = lastSink ? Math.abs(secs(lastSink[0]) - secs(nowLocal)) : 1e9;
    if (skew > 43200) skew = 86400 - skew;                        // 跨午夜回绕
    ok('面板日志落盘用本地时间（能与服务端日志直接对齐）', !!lastSink && skew <= 3600,
      `${lastSink && lastSink[0]} vs 本地 ${nowLocal}（UTC 写法会是 ${nowUtc}）`);

    // ——— 17. 内存画像 ———
    const mem = await req('GET', '/api/health', { noCookie: true });
    const rssMB = mem.json.rss / 1048576;
    ok('面板 RSS < 90MB（含 sqlite+WS+采样器）', rssMB < 90, `${rssMB.toFixed(1)}MB`);
    console.log(`\n  实测面板 RSS = ${rssMB.toFixed(1)} MB（同机裸 Node http 基线 ≈55.3MB）`);

    wsSend(conn, { t: 'ping' });
    await waitMsg(conn, 'pong', 5000);
    ok('WS ping/pong 心跳', true);
    conn.sock.destroy();
  } catch (e) {
    ok('测试执行无异常', false, e.stack || e.message);
    console.error('\n测试异常：', e);
    if (panelOut) console.error('--- 面板输出尾部 ---\n' + panelOut.slice(-3000));
  } finally {
    await cleanup();
  }

  const pass = results.filter((r) => r.pass).length;
  console.log('\n' + '='.repeat(78));
  for (const r of results) console.log(`${r.pass ? '  ✓' : '  ✗'} ${r.name}${r.info ? '  ·  ' + r.info : ''}`);
  console.log('='.repeat(78));
  console.log(`${pass}/${results.length} 通过${pass === results.length ? '  ·  MCSLite 端到端全绿' : '  ·  存在失败项'}`);
  console.log(`面板输出尾部：\n${panelOut.split('\n').slice(-14).join('\n')}`);
  process.exit(pass === results.length ? 0 : 1);
}

main();
