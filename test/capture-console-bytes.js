'use strict';
/**
 * 控制台原始字节取证工具 —— 专治「面板显示的日志和 bat 双击出来的不一样」。
 *
 * 用法：
 *   node test/capture-console-bytes.js [实例目录] [java.exe 路径]
 *   例：node test/capture-console-bytes.js E:\Desktop\1.20.1Forge G:\Java\openjdk-25.0.2\bin\java.exe
 *
 * 它做三件事：
 *   1. 完全按面板的方式（同一套 env / JAVA_TOOL_OPTIONS / 管道 / shell:false）拉起服务端，
 *      把 stdout+stderr 的**原始字节**逐块写到 out/stdout.bin —— 这就是「面板本该看到的输入」；
 *   2. 看到 Done 标记后自动发 `stop` 优雅退出（默认最长 4 分钟，PROBE_HOLD_MS 可调）；
 *   3. 出一份 JSON 报告：字节数、行数、首个高位字节位置、ANSI 行数、Picked up 噪声行、
 *      Done 行原文、结尾若干行 —— 高位字节位置直接决定 auto 编码嗅探何时定案，
 *      是这个工具最值钱的一个数字。
 *
 * 安全：世界目录用 `--world` 重定向到本目录下的 out/probe-world，绝不碰实例里的 world/；
 *       端口固定 --port 25599，避免和正在运行的服务端抢 25565。
 *       ⚠ 服务端自己仍会写 <实例>\logs\latest.log 并规范化 server.properties —— 属正常启动副作用。
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(process.argv[2] || process.env.PROBE_ROOT || process.cwd());
const JAVA = process.argv[3] || process.env.PROBE_JAVA || 'java';
const ARGFILE = process.env.PROBE_ARGS || '';           // 覆盖参数（留空则自动找 win_args.txt）
const HOLD_MS = +process.env.PROBE_HOLD_MS || 240000;
const OUT = path.join(__dirname, 'out', 'console-probe');

function findArgfile(root) {
  if (ARGFILE) return ARGFILE;
  const hit = [];
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let es; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'world' && e.name !== 'logs') walk(p, depth + 1); }
      else if (/win_args\.txt$/i.test(e.name)) hit.push(p.replace(/\\/g, '/'));
    }
  };
  walk(path.join(root, 'libraries'), 0);
  return hit.sort((a, b) => a.length - b.length)[0] || '';
}

fs.mkdirSync(OUT, { recursive: true });
const worldDir = path.join(OUT, 'probe-world').replace(/\\/g, '/');
const argfile = findArgfile(ROOT);
const args = ['@user_jvm_args.txt', ...(process.env.PROBE_XMX ? [`-Xmx${process.env.PROBE_XMX}`] : ['-Xmx4G'])];
if (argfile) args.push('@' + path.relative(ROOT, argfile).replace(/\\/g, '/'));
else args.push('-jar', process.env.PROBE_JAR || 'server.jar');
args.push('-nogui', '--world', worldDir, '--port', process.env.PROBE_PORT || '25599');

const env = { ...process.env };
env.JAVA_TOOL_OPTIONS = (env.JAVA_TOOL_OPTIONS ? env.JAVA_TOOL_OPTIONS + ' ' : '') + '-Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8';
env.FORCE_COLOR = '1';
env.TERM = env.TERM || 'xterm-256color';

console.log(`[probe] cwd=${ROOT}\n[probe] java=${JAVA}\n[probe] argv=${args.join(' ')}\n[probe] out=${OUT}`);
const raw = fs.openSync(path.join(OUT, 'stdout.bin'), 'w');
const t0 = Date.now();
let total = 0, firstHighAt = -1, chunks = 0, doneAt = 0, ansiBytes = 0;

const child = spawn(JAVA, args, { cwd: ROOT, shell: false, windowsHide: true, detached: false, env, stdio: ['pipe', 'pipe', 'pipe'] });
function feed(buf) {
  total += buf.length; chunks++;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x1b) ansiBytes++;
    if (firstHighAt < 0 && buf[i] > 0x7f) firstHighAt = total - buf.length + i;
  }
  fs.writeSync(raw, buf);
  if (!doneAt && /Done \(.*\)! For help/.test(buf.toString('latin1'))) {
    doneAt = Date.now() - t0;
    console.log(`[probe] 看到启动完成标记 @${doneAt}ms（此前累计 ${total} 字节）→ 4s 后优雅 stop`);
    setTimeout(() => { try { child.stdin.write('stop\n'); } catch { /* gone */ } }, 4000);
  }
}
child.stdout.on('data', feed);
child.stderr.on('data', feed);
child.on('error', (e) => { console.error('[probe] 启动失败：', e.message); process.exitCode = 2; finish(e.code || 'spawn-error'); });
child.on('exit', (code, signal) => finish({ code, signal }));

function finish(exitInfo) {
  try { fs.closeSync(raw); } catch { /* ignore */ }
  let bin = Buffer.alloc(0);
  try { bin = fs.readFileSync(path.join(OUT, 'stdout.bin')); } catch { /* 无输出 */ }
  const text = bin.toString('utf8');
  const lines = text.split(/\r?\n/).filter((l) => l.length);
  const report = {
    cwd: ROOT, java: JAVA, args, exit: exitInfo, ms: Date.now() - t0,
    totalBytes: bin.length, totalLines: lines.length, chunks,
    ansiEscapeBytes: ansiBytes,
    firstHighByteOffset: firstHighAt,                       // -1 = 整段纯 ASCII（auto 嗅探永不定案）
    bytesBeforeFirstHighByte: firstHighAt < 0 ? bin.length : firstHighAt,
    doneAtMs: doneAt,
    doneLines: lines.filter((l) => /Done/.test(l)).map((l) => l.slice(0, 200)),
    pickedUpLines: lines.filter((l) => /^Picked up /.test(l)),
    tail: lines.slice(-8),
  };
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  console.log('\n' + JSON.stringify(report, null, 2));
  console.log(`\n[probe] 结论：面板若在此刻之前拿不到文本，问题就在解码/切行；原始字节已存 ${path.join(OUT, 'stdout.bin')}`);
  process.exit(report.doneAtMs || /code/.test(String(exitInfo)) ? 0 : 1);
}

setTimeout(() => { console.error('[probe] 超时，强制收场'); try { child.stdin.write('stop\n'); } catch { /* */ } try { child.kill(); } catch { /* */ } }, HOLD_MS).unref?.();
