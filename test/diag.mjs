'use strict';
/** 诊断：指标连续性 + 日志级别分类抽样（真机用） */
const PORT = +(process.env.MCSLITE_PORT || 8787);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = process.env.MCSLITE_PASSWORD || '';
if (!PASSWORD) { console.error('缺少口令：$env:MCSLITE_PASSWORD=\'…\''); process.exit(2); }
let ck = '';
async function call(m, p, b) {
  const h = { origin: BASE };
  if (ck) h.cookie = ck;
  if (b !== undefined) h['content-type'] = 'application/json';
  const r = await fetch(BASE + p, { method: m, headers: h, body: b === undefined ? undefined : JSON.stringify(b) });
  const sc = r.headers.get('set-cookie'); if (sc) ck = sc.split(';')[0];
  const j = await r.json();
  if (!r.ok) throw new Error(`${p} → ${r.status} ${j.error}`);
  return j;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await call('POST', '/api/login', { username: 'admin', password: PASSWORD });

  console.log('—— 指标连续性：连续 24 次 /api/metrics（覆盖 ~72s）——');
  const seen = new Map();
  for (let i = 0; i < 24; i++) {
    const m = await call('GET', '/api/metrics?n=400');
    const pts = m.points;
    const last = pts[pts.length - 1];
    const withProc = pts.filter((p) => p.procRss != null).length;
    const key = last ? last.ts : 'none';
    if (!seen.has(key)) seen.set(key, 1);
    process.stdout.write(`\r  t=${(i * 3).toString().padStart(3)}s  总点=${String(pts.length).padStart(4)} 含java进程点=${String(withProc).padStart(4)} 最新rss=${last && last.procRss ? (last.procRss / 1048576).toFixed(0) + 'MB' : 'null'} cpu=${last ? last.procCpu : '-'} 采样器=${m.sampler.state} 唯一ts=${seen.size}   `);
    await sleep(3000);
  }
  console.log('\n  → 30 秒内应看到 ~10 个不同时间戳（3s 一次）；若唯一 ts 远小于轮询次数即说明冻结');

  console.log('\n—— 级别分类抽样 ——');
  const c = await call('GET', '/api/console?lines=3000');
  const L = c.lines;
  const by = (lv) => L.filter((l) => (l.level || 'null') === lv);
  for (const lv of ['error', 'warn', 'null']) {
    const rows = by(lv);
    console.log(`  [${lv}] 共 ${rows.length} 行，抽样 8 条：`);
    for (const r of rows.slice(0, 8)) console.log(`      ${r.raw.slice(0, 140)}`);
    console.log('');
  }
  console.log('  含 "Exception" 字样但被判非 error 的行数:', L.filter((l) => /Exception/.test(l.raw) && l.level !== 'error').length);
  console.log('  被判 error 但不含 Exception/ERROR 字样的行数:', by('error').filter((l) => !/ERROR|Exception|Caused by|\tat /.test(l.raw)).length);
  console.log('  无级别行里形如「带前缀却没解析出来」的:', by('null').filter((l) => /^\[/.test(l.raw)).length);
  console.log('  无级别行抽样（前缀未解析者）:');
  for (const r of by('null').filter((l) => /^\[/.test(l.raw)).slice(0, 6)) console.log('      ' + r.raw.slice(0, 140));
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
