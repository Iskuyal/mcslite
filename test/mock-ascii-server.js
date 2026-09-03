'use strict';
/**
 * 纯 ASCII mock 服务端 —— 回放真实 Forge 1.20.1 的控制台字节流。
 *
 * 为什么单独要一个：test/mock-server.js 里那句中文「正在加载模组」会让 StreamDecoder
 * 的 auto 嗅探立刻定案，恰好绕开了真实世界最常见的一条路径 —— 英文服务端从 spawn 到
 * Done 的整段输出**一个高位字节都没有**（fixtures/forge-1.20.1-boot.txt 就是实采样本）。
 * 「面板永久卡在启动中 / 控制台一片空白」这个 bug 就是这么漏掉测试的：只要解码器在
 * 判定编码前扣住文本，这里就会一行都不出。
 *
 * 行为：
 *   · 默认一次性把 fixture 灌进 stdout（走「单块上千行」的大批量切行路径），全程零高位字节
 *   · --fast：按不定长小块（137B，故意不沿行边界）分次写，模拟真实管道切块
 *   · 播完进入空闲，每 2s 一条 tick 噪声（验证启动之后仍在持续出词）
 *   · stdin: stop / list / say <text> / crash
 *   · --quiet：stdout 一个字节都不写，改为延迟把整段启动日志落到 <cwd>/logs/latest.log
 *              —— 验证 stdout 拿不到 Done 时，面板靠日志文件兜底判定运行状态
 */
const fs = require('node:fs');
const path = require('node:path');

const argv = process.argv.slice(2);
const QUIET = argv.includes('--quiet');
const FAST = argv.includes('--fast');
const CHUNK = +process.env.ASCII_CHUNK || 137;

const boot = fs.readFileSync(path.join(__dirname, 'fixtures', 'forge-1.20.1-boot.txt'), 'utf8');
const bytes = Buffer.from(boot, 'utf8');
if (bytes.some((b) => b > 0x7f)) throw new Error('fixture 不再纯净：本用例的意义就在于全 ASCII，请重新采集');

const out = (s) => process.stdout.write(s);
function idle() {
  let n = 0;
  setInterval(() => {
    n++;
    out(`[17:37:1${n % 9}] [Server thread/INFO] [minecraft/MinecraftServer]: Keeping the console alive, pure-ascii tick ${n}\n`);
  }, 2000).unref?.();
}

if (QUIET) {
  // 延迟落盘：确保面板是在「已记录启动基线体积」之后才看到新内容（真实服务端也是边启动边写）
  setTimeout(() => {
    const f = path.join(process.cwd(), 'logs', 'latest.log');
    try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.appendFileSync(f, boot); } catch { /* 只读介质 */ }
  }, 1500);
  idle();
} else if (FAST) {
  let pos = 0;
  const pump = () => {
    if (pos >= bytes.length) { idle(); return; }
    const n = Math.min(CHUNK, bytes.length - pos);
    process.stdout.write(bytes.subarray(pos, pos + n));
    pos += n;
    setTimeout(pump, 5);
  };
  pump();
} else {
  out(boot);
  idle();
}

let buf = '';
process.stdin.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    const say = (m) => out(`[17:37:21] [Server thread/INFO] [minecraft/ServerGamePacketListenerImpl]: ${m}\n`);
    if (line === 'stop') { say('Stopping the server'); say('Stopping server'); setTimeout(() => process.exit(0), 300); }
    else if (line === 'list') say('There are 0/20 players online: ');
    else if (line.startsWith('say ')) say('<Server> ' + line.slice(4));
    else if (line === 'crash') process.exit(3);
    else say('Unknown or incomplete command, see below for error');
  }
});
process.stdin.resume();
