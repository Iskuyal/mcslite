'use strict';
/**
 * ANSI SGR + Minecraft § 传统色码 → 受限 HTML。
 *
 * 需求「支持 ANSI 颜色渲染」：现代 MC / NeoForge 服务端（JLine 终端）直接吐
 * \x1B[...m；旧插件与模组仍用 §a / §l。两者都要吃下。
 *
 * 安全：先整体 HTML 转义，再只注入 <span class="c f? b? 装饰"> —— class 名全部
 * 来自固定白名单，前端 v-html 渲染也无 XSS 面。
 * 非 SGR 控制序列（光标移动、清屏、OSC 标题）属 JLine 噪声，一律丢弃。
 * 真彩/256 色近似到 MC 16 色调色板，保证 class 集合恒定（渲染与内存都可控）。
 */

const FG = { 30: 'k', 31: 'r', 32: 'g', 33: 'y', 34: 'b', 35: 'm', 36: 'c', 37: 'w', 39: '',
             90: 'K', 91: 'R', 92: 'G', 93: 'Y', 94: 'B', 95: 'M', 96: 'C', 97: 'W' };
const BG = { 40: 'k', 41: 'r', 42: 'g', 43: 'y', 44: 'b', 45: 'm', 46: 'c', 47: 'w', 49: '',
             100: 'K', 101: 'R', 102: 'G', 103: 'Y', 104: 'B', 105: 'M', 106: 'C', 107: 'W' };
const MC_FG = { 0: 'k', 1: 'b', 2: 'g', 3: 'c', 4: 'r', 5: 'm', 6: 'y', 7: 'w',
                8: 'K', 9: 'B', a: 'G', b: 'C', c: 'R', d: 'M', e: 'Y', f: 'W' };
const MC_FMT = { k: 'obf', l: 'bold', m: 'strike', n: 'underline', o: 'italic' };
const PAL = { k: [0, 0, 0], r: [170, 0, 0], g: [0, 170, 0], y: [170, 85, 0], b: [0, 0, 170], m: [170, 0, 170], c: [0, 170, 170], w: [170, 170, 170],
              K: [85, 85, 85], R: [255, 85, 85], G: [85, 255, 85], Y: [255, 255, 85], B: [85, 85, 255], M: [255, 85, 255], C: [85, 255, 255], W: [255, 255, 255] };

const CSI = /\x1b\[([0-9;?]*)([A-Za-z@`])/g;
const NOISE = /\x1b\][^\x07]*\x07|\x1b[@-_]/g;
const SECT = /[§\u00a7]([0-9a-fk-orA-FK-OR])/g;

function esc(s) {
  return s.indexOf('&') >= 0 || s.indexOf('<') >= 0 || s.indexOf('>') >= 0
    ? s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'))
    : s;
}

function _add(d, x) { return d.includes(x) ? d : (d ? d + ' ' + x : x); }
function _del(d, x) { const a = d.split(' ').filter((t) => t && t !== x); return a.join(' '); }
function _nearest(hex) {
  const n = parseInt(hex.slice(1), 16), r = n >> 16 & 255, g = n >> 8 & 255, b = n & 255;
  let best = 'w', bd = Infinity;
  for (const k in PAL) { const p = PAL[k]; const d = (p[0] - r) ** 2 + (p[1] - g) ** 2 + (p[2] - b) ** 2; if (d < bd) { bd = d; best = k; } }
  return best;
}
function _xterm256(v) {
  const L = [0, 95, 135, 175, 215, 255];
  if (v < 16) return '#' + ['000000', 'aa0000', '00aa00', 'aa5500', '0000aa', 'aa00aa', '00aaaa', 'aaaaaa', '555555', 'ff5555', '55ff55', 'ffff55', '5555ff', 'ff55ff', '55ffff', 'ffffff'][v];
  if (v >= 232) { const x = 8 + (v - 232) * 10; return '#' + ((1 << 24) + (x << 16) + (x << 8) + x).toString(16).slice(1); }
  const i = v - 16;
  return '#' + ((1 << 24) + (L[(i / 36 | 0) % 6] << 16) + (L[(i / 6 | 0) % 6] << 8) + L[i % 6]).toString(16).slice(1);
}

/** 渲染一行 → HTML 片段（外壳 <span class="line"> 由前端/CSS 负责） */
function ansiToHtml(line) {
  if (!line) return '';
  if (line.indexOf('\x1b') < 0 && line.indexOf('§') < 0 && line.indexOf('\u00a7') < 0) return esc(line);

  // 先把三种标记归并成一条有序事件流，避免多轮扫描互相踩位
  const marks = [];
  let m;
  CSI.lastIndex = 0;
  while ((m = CSI.exec(line))) { marks.push({ i: m.index, len: m[0].length, sgr: m[2] === 'm' ? (m[1] === '' ? ['0'] : m[1].split(';')) : null }); }
  SECT.lastIndex = 0;
  while ((m = SECT.exec(line))) marks.push({ i: m.index, len: m[0].length, sect: m[1].toLowerCase() });
  NOISE.lastIndex = 0;
  while ((m = NOISE.exec(line))) marks.push({ i: m.index, len: m[0].length, drop: true });
  marks.sort((a, b) => a.i - b.i);

  let fg = '', bg = '', deco = '', curCls = null, out = '', pos = 0;
  const clsOf = () => (fg || bg || deco) ? ('c' + (fg ? ' f' + fg : '') + (bg ? ' b' + bg : '') + (deco ? ' ' + deco.split(' ').join('-') : '')) : '';

  const flush = (text) => {
    if (!text) return;
    const cls = clsOf();
    if (cls !== curCls) { if (curCls) out += '</span>'; curCls = cls; out += cls ? `<span class="${cls}">` : ''; }
    out += esc(text);
  };
  const applySgr = (params) => {
    for (let i = 0; i < params.length; i++) {
      const n = params[i] === '' ? 0 : +params[i];
      if (n === 0) { fg = bg = deco = ''; }
      else if (n === 1) deco = _add(deco, 'bold');
      else if (n === 2) deco = _add(deco, 'dim');
      else if (n === 3) deco = _add(deco, 'italic');
      else if (n === 4) deco = _add(deco, 'underline');
      else if (n === 5 || n === 6) deco = _add(deco, 'obf');
      else if (n === 7) deco = _add(deco, 'inverse');
      else if (n === 9) deco = _add(deco, 'strike');
      else if (n === 21 || n === 22) deco = _del(_del(deco, 'bold'), 'dim');
      else if (n === 23) deco = _del(deco, 'italic');
      else if (n === 24) deco = _del(deco, 'underline');
      else if (n === 27) deco = _del(deco, 'inverse');
      else if (n === 29) deco = _del(deco, 'strike');
      else if (FG[n] !== undefined) fg = FG[n];
      else if (BG[n] !== undefined) bg = BG[n];
      else if (n === 38 || n === 48) {
        const kind = +params[i + 1];
        let hex = null;
        if (kind === 5 && params[i + 2] !== undefined) { hex = _xterm256(+params[i + 2]); i += 2; }
        else if (kind === 2 && params[i + 4] !== undefined) {
          hex = '#' + ((1 << 24) + (+params[i + 2] << 16) + (+params[i + 3] << 8) + +params[i + 4]).toString(16).slice(1); i += 4;
        }
        if (hex) { const k = _nearest(hex); if (n === 38) fg = k; else bg = k; }
      }
    }
  };

  for (const mk of marks) {
    if (mk.i < pos) continue;                       // 被前一标记覆盖（如 § 落在 CSI 参数里）
    flush(line.slice(pos, mk.i));
    pos = mk.i + mk.len;
    if (mk.sgr) applySgr(mk.sgr);
    else if (mk.sect) {
      if (mk.sect === 'r') { fg = bg = deco = ''; }
      else if (MC_FG[mk.sect]) fg = MC_FG[mk.sect];
      else if (MC_FMT[mk.sect]) deco = _add(deco, MC_FMT[mk.sect]);
    }
  }
  flush(line.slice(pos));
  if (curCls) out += '</span>';
  return out;
}

/** 从日志行猜级别，供前端染色/过滤/告警，不依赖任何格式解析库 */
function detectLevel(text) {
  if (/\b(TRACE|FINER|FINEST)\b/.test(text)) return 'trace';
  if (/\bDEBUG\b|\bFINE\b/.test(text)) return 'debug';
  if (/\bERROR\b|\bSEVERE\b|\bFATAL\b|Exception|\bCaused by:|\tat [\w$.]+\./.test(text)) return 'error';
  if (/\bWARN(?:ING)?\b|\bALERT\b|\bNOTICE\b/.test(text)) return 'warn';
  if (/\bINFO\b/.test(text)) return 'info';
  return null;
}

/** 抽掉日志前缀，兼容两种真实格式：
 *   vanilla : `[12:00:01] [Server thread/INFO]: Done (3.2s)!`
 *   NeoForge: `[278月2026 23:42:26.189] [main/INFO] [cpw.mods.modlauncher.Launcher/MODLAUNCHER]: ModLauncher running: …`
 * Log4j2 的 %d{DATE} 会跟随系统语言（中文系统上是「278月2026」这种带本地化月份的串），
 * 所以不能按 "\d\d:\d\d:\d\d" 之外的样子假设 —— 这里改成「吃掉行首连续的 [...] 段」。
 * 至少要两段方括号（或含时间/级别特征）才认定是前缀，避免把 `[Server] 玩家聊天` 误剥。 */
const PREFIX_RE = /^((?:\[[^\]]*\]\s?){2,})(?::\s?)?/;
const KNOWN_LEVELS = new Set(['TRACE', 'DEBUG', 'INFO', 'WARN', 'WARNING', 'ERROR', 'FATAL', 'SEVERE']);
const TIME_IN_BRACKET = /\d{2}:\d{2}:\d{2}/;

function stripPrefix(line) {
  const m = PREFIX_RE.exec(line);
  if (!m) return null;
  const prefix = m[1];
  const brackets = prefix.match(/\[[^\]]*\]/g) || [];
  let time = null, level = null, thread = null;
  for (const b of brackets) {
    const inner = b.slice(1, -1);
    if (TIME_IN_BRACKET.test(inner)) {
      const t = /(\d{2}:\d{2}:\d{2})(?:[.,]\d+)?/.exec(inner);
      if (t && !time) time = t[1];
      continue;
    }
    const slash = inner.lastIndexOf('/');
    if (slash > 0) {
      const head = inner.slice(0, slash), tail = inner.slice(slash + 1).toUpperCase();
      if (KNOWN_LEVELS.has(tail)) {
        if (!level) level = tail === 'WARNING' ? 'WARN' : tail;
        if (/thread|main|pool|worker|chunk/i.test(head) && !thread) thread = head;
        continue;
      }
    }
    if (/^\s*(Server thread|Render thread|Worker|pool-|Thread-)/i.test(inner) && !thread) thread = inner;
  }
  if (!time && !level) return null;                       // 只是普通方括号开头的正文，别动
  return { time: time || null, level: level || null, thread: thread || null, rest: line.slice(m[0].length) };
}

/** 去掉所有 ANSI/§ 控制码，得到纯文本 —— 做名字/正则解析前必须先过这一关，
 *  否则 `\x1b[32mSteve` 会被解析成 "eve" 之类的鬼东西。 */
const ANSI_ALL = /\x1b\[[0-9;?]*[A-Za-z@`]|\x1b\][^\x07]*\x07|\x1b[@-_]|[§\u00a7][0-9a-fk-orA-FK-OR]/g;
function stripAnsi(s) {
  if (!s || (s.indexOf('\x1b') < 0 && s.indexOf('§') < 0 && s.indexOf('\u00a7') < 0)) return s;
  return s.replace(ANSI_ALL, '');
}

module.exports = { ansiToHtml, detectLevel, stripPrefix, stripAnsi, esc, PREFIX_RE };
