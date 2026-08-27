<script setup>
import { ref, computed, nextTick, watch, onActivated, onDeactivated } from 'vue';
import { store, pushLines, toast, act, resumeConsole } from '../store';
import { api, rt } from '../api';
import ControlBar from '../components/ControlBar.vue';

defineOptions({ name: 'ConsoleView' });

const box = ref(null);
const cmd = ref('');
const autoscroll = ref(true);
const dense = ref(false);
const level = ref('all');
const kw = ref('');
const history = ref(JSON.parse(localStorage.getItem('mcslite.cmds') || '[]'));
let hIdx = -1;

const LEVELS = [['all', '全部'], ['info', 'INFO+'], ['warn', 'WARN+'], ['error', '仅错误'], ['sys', '面板']];

const shown = computed(() => {
  let ls = store.console.lines;
  if (level.value !== 'all') {
    const rank = { trace: 0, debug: 1, cmd: 2, sys: 2, info: 3, warn: 4, error: 5 };
    if (level.value === 'error') ls = ls.filter((l) => l.level === 'error');
    else if (level.value === 'sys') ls = ls.filter((l) => l.level === 'sys' || l.level === 'cmd');
    else { const min = rank[level.value]; ls = ls.filter((l) => (rank[l.level] ?? 3) >= min); }
  }
  if (kw.value) { const k = kw.value.toLowerCase(); ls = ls.filter((l) => l.raw.toLowerCase().includes(k)); }
  return dense.value ? ls.slice(-400) : ls;
});

function atBottom() {
  const e = box.value;
  return e && e.scrollTop + e.clientHeight >= e.scrollHeight - 40;
}
function onScroll() {
  const was = autoscroll.value;
  autoscroll.value = atBottom();
  if (was && !autoscroll.value) store.console.paused = true;
  else if (!was && autoscroll.value) resumeConsole();
}
async function scrollEnd(force) {
  if (!autoscroll.value && !force) return;
  await nextTick();
  const e = box.value;
  if (e) e.scrollTop = e.scrollHeight;
}
watch(() => store.console.lines.length, () => scrollEnd(false));

const QUICK = [
  { c: 'list', t: '在线玩家' }, { c: 'save-all', t: '落盘存档' }, { c: 'reload', t: '重载配置' },
  { c: 'whitelist list', t: '白名单' }, { c: 'difficulty', t: '难度' }, { c: 'weather clear', t: '晴' },
  { c: 'time set day', t: '设为白天' }, { c: 'gamerule doDaylightCycle false', t: '停昼夜' },
];

async function send() {
  const v = cmd.value.trim();
  if (!v) return;
  cmd.value = '';
  history.value = [v, ...history.value.filter((x) => x !== v)].slice(0, 60);
  localStorage.setItem('mcslite.cmds', JSON.stringify(history.value));
  hIdx = -1;
  if (!rt.command(v)) {
    await act('cmd', () => api.send(v));
  }
  autoscroll.value = true;
  scrollEnd(true);
}
function onKey(e) {
  if (e.key === 'ArrowUp' && !e.target.selectionStart) { e.preventDefault(); if (history.value.length) { hIdx = Math.min(hIdx + 1, history.value.length - 1); cmd.value = history.value[hIdx]; } }
  else if (e.key === 'ArrowDown') { hIdx = Math.max(hIdx - 1, -1); cmd.value = hIdx < 0 ? '' : history.value[hIdx]; }
}
async function clearView() {
  store.console.lines = [];
  toast('已清空显示（服务端日志文件不受影响）', 'ok', 2200);
}
async function loadMore() {
  const r = await act('more', () => api.consoleTail(store.server.maxLines || 3000));
  store.console.lines = r.lines;
  scrollEnd(true);
}
onActivated(() => { scrollEnd(true); });
onDeactivated(() => { store.console.paused = false; });
</script>

<template>
  <div class="h-full flex flex-col min-h-0">
    <div class="flex items-center gap-2 px-3 py-2 border-b border-[var(--line)] bg-[var(--panel)] flex-wrap shrink-0">
      <ControlBar />
      <span class="w-px h-6 bg-[var(--line)] mx-1"></span>
      <select v-model="level" class="input py-1 text-xs">
        <option v-for="l in LEVELS" :key="l[0]" :value="l[0]">{{ l[1] }}</option>
      </select>
      <input v-model="kw" class="input py-1 text-xs w-36" placeholder="过滤关键字…" />
      <label class="text-xs text-[var(--dim)] flex items-center gap-1"><input type="checkbox" v-model="dense" />紧凑</label>
      <div class="flex-1"></div>
      <span v-if="store.console.paused" class="badge text-[var(--warn)]">已暂停滚动（+{{ store.console.pending || 0 }}）</span>
      <span class="text-xs text-[var(--dim)] mono">{{ shown.length }} 行</span>
      <button class="btn btn-sm" @click="loadMore" :disabled="store.busy.more">载入更多</button>
      <button class="btn btn-sm" @click="clearView">清屏</button>
    </div>

    <div ref="box" class="term flex-1 min-h-0 overflow-auto px-2 py-1.5" @scroll="onScroll">
      <div v-if="!shown.length" class="text-[var(--dim)] text-center py-10">
        {{ store.server.running ? '等待输出…' : '服务端未运行，无日志。点上方「启动」开始。' }}
      </div>
      <div v-for="l in shown" :key="l.i" class="line" :class="'lv-' + (l.level || 'plain')" v-html="l.html || l.raw"></div>
    </div>

    <form class="flex items-center gap-2 px-3 py-2 border-t border-[var(--line)] bg-[var(--panel)] shrink-0" @submit.prevent="send">
      <span class="mono text-[var(--ok)] select-none">‣</span>
      <input v-model="cmd" @keydown="onKey" class="input mono flex-1" :placeholder="store.server.running ? '输入服务端命令，回车发送（Ctrl+↑ 取历史）' : '服务端未运行 —— 命令不可用'" :disabled="!store.server.running" autocomplete="off" />
      <button class="btn btn-primary" :disabled="!store.server.running || !cmd.trim()">发送</button>
    </form>

    <div class="px-3 py-1.5 border-t border-[var(--line)] bg-[var(--bg)] flex gap-1.5 flex-wrap shrink-0">
      <button v-for="q in QUICK" :key="q.c" class="btn btn-sm" :disabled="!store.server.running" :title="q.c" @click="cmd = q.c; send()">{{ q.t }}</button>
    </div>
  </div>
</template>
