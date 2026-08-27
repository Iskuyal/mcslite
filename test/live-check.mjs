'use strict';
/**
 * 真机验收：针对「真实服务端实例」跑一轮面板能力核对（只读 + 生命周期由参数控制）。
 * 用法：
 *   node test/live-check.mjs                 # 只观察当前状态与日志管线
 *   node test/live-check.mjs --start         # 若未运行则启动后再观察
 *   node test/live-check.mjs --stop          # 观察完优雅停止
 *   node test/live-check.mjs --port 8787 --password xxx
 */
const PORT = +(process.argv.find((a, i) => process.argv[i - 1] === '--port') || 8787);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = process.env.MCSLITE_PASSWORD || process.env.MCSLITE_PANEL_PASSWORD || '';
if (!PASSWORD) {
  console.error('缺少面板口令：请用环境变量提供，不写死在源码里\n  PowerShell:  $env:MCSLITE_PASSWORD=\'…\'; node test/live-check.mjs');
  process.exit(2);
}
const wantStart = process.argv.includes('--start');
const wantStop = process.argv.includes('--stop');

let ck = '';
async function call(method, path, body) {
  const headers = { origin: BASE };
  if (ck) headers.cookie = ck;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const sc = r.headers.get('set-cookie');
  if (sc) ck = sc.split(';')[0];
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(`${method} ${path} → ${r.status} ${j.error || ''}`), { status: r.status });
  return j;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function line(l) { return `[${(l.level || '-').padEnd(5)}|${l.time || '    -    '}] ${l.raw.slice(0, 130)}`; }

(async () => {
  const t0 = Date.now();
  await call('POST', '/api/login', { username: 'admin', password: PASSWORD });
  console.log('登录 OK');

  if (wantStart) {
    const s = await call('GET', '/api/state');
    if (!s.server.running) { const r = await call('POST', '/api/server/start', {}); console.log(`已启动 pid=${r.pid}`); }
    else console.log('服务端已在运行');
  }

  // 轮询直到 Done / 退出 / 超时
  let last = null, lines = [];
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    const s = await call('GET', '/api/state');
    const c = await call('GET', '/api/console?lines=1500');
    last = s; lines = c.lines;
    process.stdout.write(`\r${((Date.now() - t0) / 1000).toFixed(0)}s  state=${s.server.state.padEnd(8)} lines=${String(lines.length).padStart(5)}  enc=${s.server.encoding}  rss=${((s.metrics?.procRss || 0) / 1048576).toFixed(0)}MB  cpu=${s.metrics?.procCpu}%   `);
    if (s.server.state === 'online') { console.log('\n✔ 已进入 online'); break; }
    if (s.server.state === 'offline' && s.server.lastExit) { console.log('\n✘ 进程已退出', JSON.stringify(s.server.lastExit)); break; }
    await sleep(3000);
  }
  console.log('');

  const m = last.metrics || {};
  const lv = {};
  for (const l of lines) lv[l.level || 'null'] = (lv[l.level || 'null'] || 0) + 1;
  const withTime = lines.filter((l) => l.time).length;
  const withThread = lines.filter((l) => /\[/.test(l.raw) && l.time).length;
  const spans = lines.filter((l) => /<span class="c/.test(l.html)).length;
  const sects = lines.filter((l) => /§[0-9a-fk-or]/i.test(l.raw)).length;
  const sectsRendered = lines.filter((l) => /§[0-9a-fk-or]/i.test(l.raw) && /<span/.test(l.html)).length;
  const cjk = lines.filter((l) => /[一-鿿]/.test(l.raw));
  const cjkGarbled = cjk.filter((l) => /[\uFFFD\u00a3\u00b2\u2550]/.test(l.raw) || /\?\?\?/.test(l.raw));
  const longest = lines.reduce((a, l) => Math.max(a, l.raw.length), 0);

  console.log('── 日志管线核对 ──');
  console.log(`  级别分布        : ${JSON.stringify(lv)}`);
  console.log(`  时间戳抽取      : ${withTime}/${lines.length} 行`);
  console.log(`  ANSI 着色       : ${spans} 行含 <span class="c …">`);
  console.log(`  §传统色码       : ${sects} 行原始含 §，其中 ${sectsRendered} 行已渲染成 span`);
  console.log(`  中文行          : ${cjk.length} 行，疑似乱码 ${cjkGarbled.length} 行`);
  console.log(`  最长行          : ${longest} 字符`);
  console.log(`  解码判定编码    : ${last.server.encoding}`);
  console.log('── 指标核对 ──');
  console.log(`  java 进程 CPU=${m.procCpu}% RSS=${((m.procRss || 0) / 1048576).toFixed(0)}MB 线程=${m.threads} 私有=${((m.procPrivate || 0) / 1048576).toFixed(0)}MB`);
  console.log(`  整机 CPU=${m.sysCpu}% 已用=${((m.sysMemUsed || 0) / 1073741824).toFixed(1)}GB/${((m.sysMemTotal || 0) / 1073741824).toFixed(1)}GB`);
  console.log(`  磁盘 IO 读=${((m.ioRead || 0) / 1024).toFixed(0)}KB/s 写=${((m.ioWrite || 0) / 1024).toFixed(0)}KB/s`);
  console.log(`  面板自身 RSS=${((m.panelRss || 0) / 1048576).toFixed(1)}MB  采样器=${last.sampler.state}`);
  console.log(`  实例盘剩余=${((last.disk.free || 0) / 1073741824).toFixed(1)}GB/${((last.disk.total || 0) / 1073741824).toFixed(0)}GB`);
  console.log('── 采样 15 秒观察实时性 ──');
  const n0 = (await call('GET', '/api/state')).server.lineCount;
  const rt = await new Promise(async (res) => {
    const before = (await call('GET', '/api/metrics?n=3')).points.length;
    await sleep(15000);
    const after = (await call('GET', '/api/metrics?n=3')).points.length;
    res({ before, after });
  });
  const n1 = (await call('GET', '/api/state')).server.lineCount;
  console.log(`  15s 内新增日志行: ${n1 - n0}   指标点: ${rt.before} → ${rt.after}`);

  console.log('\n── 关键日志片段 ──');
  const interesting = lines.filter((l) => /(Done \(|Exception|ERROR|WARN|For help|reloading|Loading|mod|NeoForge|Forge|DFU|世界|服务器)/i.test(l.raw)).slice(-14);
  for (const l of interesting) console.log('  ' + line(l));

  if (wantStop) {
    console.log('\n发送优雅停止…');
    const r = await call('POST', '/api/server/stop', {});
    console.log('  结果:', JSON.stringify(r));
    for (let i = 0; i < 40; i++) {
      const s = await call('GET', '/api/state');
      if (!s.server.running) { console.log(`  ✔ ${(i * 2)}s 后完全退出，exit=${JSON.stringify(s.server.lastExit)}`); break; }
      await sleep(2000);
    }
  }
  console.log(`\n总耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
})().catch(async (e) => {
  console.error('\nFAIL:', e.message);
  try {
    const s = await call('GET', '/api/state');
    const c = await call('GET', '/api/console?lines=40');
    console.error('当前状态:', JSON.stringify(s.server));
    for (const l of c.lines.slice(-20)) console.error('  ' + line(l));
  } catch { /* 未登录 */ }
  process.exit(1);
});
