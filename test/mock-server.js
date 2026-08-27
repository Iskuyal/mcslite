'use strict';
/**
 * Mock Minecraft 服务端 —— 没有真 NeoForge 实例时用它验证面板全链路。
 * 行为对齐真实服务端：
 *   · stdout 输出带 ANSI 颜色 + [HH:MM:SS] [Server thread/INFO]: 前缀
 *   · 启动末行 Done (3.2s)! For help, type "help"  ← 面板据此判定 ONLINE
 *   · stdin 接受 stop / list / say / 未知命令
 *   · 周期刷日志（含中文、WARN、异常栈、§色码、超长行）
 *   · 模拟玩家进出
 * 用法：node mock-server.js [--chatty]
 */
const C = { r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', b: '\x1b[34m', c: '\x1b[36m', w: '\x1b[0m', gray: '\x1b[90m', bold: '\x1b[1m' };
const ts = () => new Date().toTimeString().slice(0, 8);
let seq = 0;
function out(level, msg, color = '') {
  process.stdout.write(`[${ts()}] [Server thread/${level}]: ${color}${msg}${color ? C.w : ''}\n`);
}

const chatty = process.argv.includes('--chatty');
const slowBoot = +process.env.MOCK_BOOT_MS || 1200;

out('INFO', 'Starting minecraft server version 1.21.4');
out('INFO', `${C.bold}NeoForge 21.4.50-beta 正在加载模组${C.w}`);
out('INFO', 'Loading 148 mods: minecraft, neoforge, jei, creating, 应用能源2');
out('WARN', `${C.y}检测到未在 server.properties 中设置 server-ip，将绑定全部网卡${C.w}`);
setTimeout(() => out('INFO', 'Preparing spawn area: 42%', C.gray), slowBoot * 0.4);
setTimeout(() => out('INFO', `${C.g}Done (${(slowBoot / 1000).toFixed(1)}s)! For help, type "help"${C.w}`), slowBoot);
setTimeout(() => out('INFO', '§6服务器§a启动完毕 §7— 欢迎回到 MCWorld'), slowBoot + 200);

const players = [];
const NAMES = ['Steve', '艾利克斯', 'Notch', 'Herobrine', '张三丰'];
let ni = 0;
function joinTimer() {
  const wait = 4000 + Math.random() * 6000;
  setTimeout(() => {
    if (players.length >= 3) return leaveTimer();
    const n = NAMES[ni++ % NAMES.length];
    players.push(n);
    out('INFO', `${n}[/192.168.3.${10 + ni}:52311] logged in with entity id ${100 + seq++} at (128.5, 64.0, -256.5)`, C.g);
    out('INFO', `${n} joined the game`, C.g);
    joinTimer();
  }, wait).unref?.();
}
function leaveTimer() {
  setTimeout(() => {
    if (!players.length) return joinTimer();
    const n = players.shift();
    out('INFO', `${n} left the game`, C.r);
    joinTimer();
  }, 5000).unref?.();
}
joinTimer();
leaveTimer();

const tick = setInterval(() => {
  seq++;
  out('DEBUG', `Server TPS ${19.8 + Math.random() * 0.2} / chunk ticks ${1 + (seq % 4)}`, C.gray);
  if (chatty && seq % 3 === 0) out('INFO', `[ChunkMap] Saving chunks for level 'minecraft:overworld'/overworld`, C.gray);
  if (seq % 17 === 0) out('ERROR', `${C.r}Failed to handle packet for /192.168.3.77:41234${C.w}`);
  if (seq % 17 === 1) out('ERROR', 'java.lang.IllegalArgumentException: 无效的实体类型：mod:未知生物');
  if (seq % 17 === 2) out('ERROR', '\tat net.minecraft.server.level.ServerPlayer.completeHurt(ServerPlayer.java:412)');
  if (seq % 23 === 0) out('WARN', `Can't keep up! Is the server overloaded? Running ${120 + (seq % 400)}ms or ${2 + (seq % 7)} ticks behind`, C.y);
  if (seq % 37 === 0) out('INFO', 'A very long line to verify the panel truncates huge console output: ' + 'X'.repeat(20000) + ' §c<END>');
}, 1500);
tick.unref?.();

process.stdin.on('data', (buf) => {
  for (const line of buf.toString('utf8').split(/\r?\n/).filter(Boolean)) {
    const [cmd, ...rest] = line.trim().split(/\s+/);
    const arg = rest.join(' ');
    if (cmd === 'stop') {
      out('INFO', Stopping());
      out('INFO', Waiting());
      clearInterval(tick);
      setTimeout(() => process.exit(0), 500);
    } else if (cmd === 'list') {
      out('INFO', `There are ${players.length}/20 players online: ${players.join(', ') || '-'}`);
    } else if (cmd === 'say') {
      out('INFO', `[Server] ${arg}`, C.c);
    } else if (cmd === 'whitelist') {
      out('INFO', `Added ${arg} to the whitelist`, C.g);
    } else if (cmd === 'crash') {
      out('FATAL', '模拟异常退出（验证自动重启与退出码上报）', C.r);
      process.exit(3);
    } else if (cmd) {
      out('ERROR', `Unknown or incomplete command, see below for error: ${cmd}`, C.r);
    }
  }
});
function Stopping() { return `${C.r}Stopping server${C.w}`; }
function Waiting() { return `${C.y}Waiting for io threads to stop${C.w}`; }

process.stdout.write('');
setInterval(() => { /* keep alive */ }, 1 << 30).unref?.();
