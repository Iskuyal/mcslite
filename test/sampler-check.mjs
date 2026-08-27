/** 单独验证采样器脚本：直接对指定 PID 跑 PowerShell，打印每轮取到的指标。
 *  用法：node test/sampler-check.mjs <pid> [轮数] */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { SAMPLER_PS } = require('../server/sys/monitor.js');

const pid = Number(process.argv[2]);
if (!pid) { console.error('用法：node test/sampler-check.mjs <pid>'); process.exit(2); }
const want = Number(process.argv[3] || 7);
const script = path.resolve('test/.sampler-check.ps1');
writeFileSync(script, SAMPLER_PS);

const c = spawn('powershell.exe', [
  '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
  '-File', script, String(pid), '2000',
], { windowsHide: true });

let buf = '', n = 0, last = null, prev = null;
const cores = (await import('node:os')).cpus().length;
const bad = [];
const mb = (v) => ((v || 0) / 1048576).toFixed(0) + 'MB';
c.stdout.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!l.startsWith('{')) continue;
    let o;
    try { o = JSON.parse(l); } catch { bad.push('JSON 解析失败: ' + l.slice(0, 80)); continue; }
    last = o; n++;
    // 复刻 monitor.js 的 Node 侧算法，验证原始 procTicks 序列能算出合理 CPU
    let cpu = null;
    if (typeof o.procTicks === 'number' && prev && o.ts > prev.ts) {
      const d = o.procTicks - prev.procTicks, e = (o.ts - prev.ts) * 1e4;
      if (d >= 0 && e > 0) cpu = Math.round(Math.min((d / e) * 100 / cores, 100) * 10) / 10;
    }
    if (typeof o.procTicks === 'number') prev = o;
    console.log(`#${n} 整机cpu=${o.cpu}%  进程cpu=${cpu ?? 'n/a'}%  rss=${mb(o.procRss)}  私页=${mb(o.procPriv)}  线程=${o.procThreads}  句柄=${o.procHandle}  ticks=${o.procTicks}`);
    console.log(`    盘读=${((o.diskRead || 0) / 1024).toFixed(0)}KB/s 盘写=${((o.diskWrite || 0) / 1024).toFixed(0)}KB/s 系统内存=${mb((o.memTotal || 0) - (o.memFree || 0))}/${mb(o.memTotal)}`);
    if (cpu != null && (cpu < 0 || cpu > 100)) bad.push(`procCpu 越界: ${cpu}`);
    if (o.procRss != null && o.procRss < 1e6) bad.push(`procRss 过小: ${o.procRss}`);
    if (o.procTicks == null) bad.push('procTicks 缺失');
    if (n >= want) {
      c.kill();
      const okRun = bad.length === 0 && cpu != null && last.procRss > 1e6;
      console.log(okRun ? `\n✔ 采样器输出正常（${n} 轮；procs 字段齐全，CPU 差值 ${cpu}% 落在 0~100）` : `\n✗ 问题：${bad.join('; ') || '字段缺失'}`);
      process.exit(okRun ? 0 : 1);
    }
  }
});
c.stderr.on('data', (d) => { const s = d.toString().trim(); if (s) console.log('PS-STDERR:', s.slice(0, 300)); });
c.on('exit', (code) => { if (n < want) console.log(`采样器提前退出 code=${code}，共 ${n} 轮`); });
setTimeout(() => { console.log('超时'); c.kill(); process.exit(1); }, 60000).unref();
