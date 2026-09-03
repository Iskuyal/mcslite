/**
 * 全局响应式状态（不引 Pinia：面板就一个 store，Vue 自带 reactive 足够）。
 * 内存纪律（浏览器侧同样是「低内存」的一部分）：
 *   · 控制台 DOM 只保留最后 MAX_RENDER 行，超出即丢（虚拟滚动都不用，代价更小）
 *   · 指标数组定长环形截断，图表用 TypedArray，不产生 per-point 对象
 *   · 页面不可见时断开 WS（见 App.vue），后台标签页不占资源
 */
import { reactive } from 'vue';
import { api, rt } from './api';

export { rt };   // 视图层只需 import store 与 rt，避免两处来源混淆

const MAX_RENDER = 1200;    // 控制台 DOM 保留行数上限
const MAX_SERIES = 600;     // 指标环形点数上限（600 × 3s ≈ 30 分钟）

export const store = reactive({
  booted: false,
  authed: false,
  needPassword: false,
  user: 'admin',
  tab: 'dashboard',
  wsStatus: 'idle',
  server: { state: 'offline', running: false, pid: null, uptimeMs: 0, lineCount: 0, crashStreak: 0, onlinePlayers: 0, encoding: null, root: '', jar: '', lastExit: null },
  runtime: {},
  sampler: { state: 'idle', error: null, subs: 0, cores: 1 },
  players: { online: 0, max: null, names: [], source: 'log' },
  disk: { total: null, free: null },
  settings: null,
  console: { lines: [], paused: false, filter: '', level: 'all' },
  series: { ts: [], cpu: [], procCpu: [], sysCpu: [], procRss: [], sysMemUsed: [], ioRead: [], ioWrite: [], procIoRead: [], procIoWrite: [], panelRss: [] },
  toasts: [],
  busy: {},
});

let toastSeq = 0;
let buffered = [];            // 暂停滚动期间缓存的行（非响应式，省掉 Proxy 开销；恢复时一次性并入）
export function toast(text, kind = 'info', ms = 3600) {
  const id = ++toastSeq;
  store.toasts.push({ id, text, kind });
  setTimeout(() => { const i = store.toasts.findIndex((t) => t.id === id); if (i >= 0) store.toasts.splice(i, 1); }, ms);
}

export function trimSeries() {
  const over = store.series.ts.length - MAX_SERIES;
  if (over > 0) for (const k of Object.keys(store.series)) store.series[k].splice(0, over);
}

export function appendPoint(p) {
  const s = store.series;
  s.ts.push(p.ts / 1000);
  s.cpu.push(p.cpu);
  s.procCpu.push(p.procCpu);
  s.sysCpu.push(p.sysCpu);
  s.procRss.push(p.procRss != null ? +(p.procRss / 1048576).toFixed(1) : null);
  s.sysMemUsed.push(p.sysMemUsed != null ? +(p.sysMemUsed / 1073741824).toFixed(2) : null);
  s.ioRead.push(p.ioRead != null ? +(p.ioRead / 1024).toFixed(1) : null);
  s.ioWrite.push(p.ioWrite != null ? +(p.ioWrite / 1024).toFixed(1) : null);
  s.procIoRead.push(p.procIoRead != null ? +(p.procIoRead / 1024).toFixed(1) : null);
  s.procIoWrite.push(p.procIoWrite != null ? +(p.procIoWrite / 1024).toFixed(1) : null);
  s.panelRss.push(p.panelRss != null ? +(p.panelRss / 1048576).toFixed(1) : null);
  trimSeries();
}

export async function loadState() {
  const st = await api.state(MAX_SERIES);
  store.server = st.server;
  store.runtime = st.runtime || {};
  store.sampler = st.sampler || store.sampler;
  store.players = st.players || store.players;
  store.disk = st.disk || store.disk;
  store.settings = st.settings;
  if (st.series && st.series.length) {
    store.series.ts = [];
    for (const k of Object.keys(store.series)) if (k !== 'ts') store.series[k] = [];
    for (const p of st.series) appendPoint(p);
  }
  return st;
}

let bound = false;
export function bindRealtime() {
  if (bound) return;
  bound = true;
  rt.onStatus = (s) => { store.wsStatus = s; };
  rt.on('hello', (d) => { if (d && d.state) store.server = d.state; });
  rt.on('lines', (arr) => pushLines(arr));
  rt.on('replay', (d) => { if (d && d.lines) { resetConsoleBuffer(); store.console.lines = d.lines.slice(-MAX_RENDER); } });
  rt.on('cleared', () => { resetConsoleBuffer(); store.console.lines = []; });
  rt.on('metrics', (p) => { store.lastPoint = p; appendPoint(p); });
  rt.on('series', (d) => {
    if (!d || !d.points) return;
    const s = store.series;
    for (const k of Object.keys(s)) s[k] = [];
    for (const p of d.points) appendPoint(p);
    if (d.sampler) store.sampler = d.sampler;
  });
  rt.on('state', (s) => { store.server = { ...store.server, ...s }; });
  rt.on('exit', (info) => { store.server = { ...store.server, lastExit: info }; if (!info.expected) toast(info.signal === 'SIGKILL' ? '服务端被强制终止' : `服务端异常退出（${info.code ?? '?'}）`, 'error', 7000); });
  rt.on('players', (p) => { store.players = { ...store.players, ...p }; store.server.onlinePlayers = p.online; });
  rt.on('sampler', (s) => { store.sampler = s; });
  rt.on('subs', (d) => { if (d && d.topics) store.subTopics = d.topics; });
  rt.on('error', (m) => console.warn('[panel]', m && m.message));
  rt.connect();
}

export function pushLines(arr) {
  if (!arr || !arr.length) return;
  const lines = store.console.lines;
  if (store.console.paused) {
    // 暂停滚动 ≠ 丢弃日志。以前只加计数就把行扔掉，恢复后画面与服务端真实输出
    // 永久错位（少一段），正是「控制台显示的日志和实际不一样」的成因之一。
    for (const l of arr) buffered.push(l);
    const over = buffered.length - MAX_RENDER;
    if (over > 0) buffered.splice(0, over);
    store.console.pending = buffered.length;
    return;
  }
  if (buffered.length) {                       // 兜底：paused 被别处直接置 false 也不丢行
    for (const l of buffered) lines.push(l);
    buffered = [];
    store.console.pending = 0;
  }
  for (const l of arr) lines.push(l);
  const over = lines.length - MAX_RENDER;
  if (over > 0) lines.splice(0, over);
}

export function resumeConsole() {
  store.console.paused = false;
  if (buffered.length) {
    const lines = store.console.lines;
    for (const l of buffered) lines.push(l);
    buffered = [];
    const over = lines.length - MAX_RENDER;
    if (over > 0) lines.splice(0, over);
  }
  store.console.pending = 0;
}

/** 清屏/重放：缓存行一并作废，避免旧行在恢复时倒灌回新画面 */
export function resetConsoleBuffer() {
  buffered = [];
  store.console.pending = 0;
}

export async function act(name, fn, okMsg) {
  store.busy[name] = true;
  try {
    const r = await fn();
    if (okMsg) toast(okMsg, 'ok');
    return r;
  } catch (e) {
    toast(e.message || '操作失败', 'error', 6000);
    if (e.status === 401) store.authed = false;
    throw e;
  } finally {
    store.busy[name] = false;
  }
}

/** 时间轴文本：把 uptimeMs 说人话 */
export function fmtUptime(ms) {
  if (!ms || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  return (d ? d + '天' : '') + (h || d ? h + '时' : '') + (m || h || d ? m + '分' : '') + ss + '秒';
}
export function fmtBytes(b, d = 1) {
  if (b == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = +b;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return v.toFixed(i === 0 ? 0 : d) + ' ' + u[i];
}
export function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
}
