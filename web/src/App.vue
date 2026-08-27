<script setup>
import { ref, onMounted, onUnmounted, computed } from 'vue';
import { store, loadState, bindRealtime, toast, fmtUptime, rt, act } from './store';
import { api } from './api';
import Login from './views/Login.vue';
import Dashboard from './views/Dashboard.vue';
import ConsoleView from './views/ConsoleView.vue';
import Files from './views/Files.vue';
import Config from './views/Config.vue';
import Settings from './views/Settings.vue';
import Audit from './views/Audit.vue';

const booting = ref(true);
const bootError = ref('');
const clock = ref(Date.now());
let clockTimer = null;

const TABS = [
  { id: 'dashboard', label: '仪表盘', icon: '◧' },
  { id: 'console', label: '控制台', icon: '‣_' },
  { id: 'files', label: '文件', icon: '🗀' },
  { id: 'config', label: '配置', icon: '⚙' },
  { id: 'settings', label: '设置', icon: '☰' },
  { id: 'audit', label: '审计', icon: '✓' },
];
const VIEWS = { dashboard: Dashboard, console: ConsoleView, files: Files, config: Config, settings: Settings, audit: Audit };
const current = computed(() => VIEWS[store.tab] || Dashboard);

const stateText = computed(() => ({ online: '运行中', starting: '启动中', stopping: '停止中', offline: '已停止' }[store.server.state] || store.server.state));
const dotCls = computed(() => ({ online: 'dot-on', starting: 'dot-start', stopping: 'dot-stop', offline: 'dot-off' }[store.server.state]));
const uptime = computed(() => (store.server.running ? fmtUptime(clock.value - (store.server.startedAt || clock.value)) : '—'));
const panelRss = computed(() => {
  const bytes = (store.lastPoint && store.lastPoint.panelRss) || store.runtime.panelRss || 0;
  return (bytes / 1048576).toFixed(0);
});

async function boot() {
  booting.value = true; bootError.value = '';
  try {
    // 先问免鉴权端点「当前会话是否有效」，避免未登录时必然打出一次 401 污染控制台
    const pub = await api.publicConfig();
    store.user = pub.user || 'admin';
    if (!pub.authed) { store.authed = false; return; }
    await loadState();
    store.authed = true;
    bindRealtime();
    rt.sub('state', 'console');
  } catch (e) {
    if (e.status === 401) store.authed = false;
    else { bootError.value = e.message; }
  } finally { booting.value = false; }
}

function onVisible() {
  if (document.hidden) { rt.unsub('metrics', 'players'); }
  else { rt.sub('metrics', 'players'); loadState().catch(() => {}); }
}

onMounted(async () => {
  await boot();
  clockTimer = setInterval(() => { clock.value = Date.now(); }, 1000);
  document.addEventListener('visibilitychange', onVisible);
  if (store.authed) rt.sub('metrics', 'players');
  window.addEventListener('error', (e) => { if (e.message && /WebSocket|fetch/.test(e.message)) toast('网络抖动：' + e.message, 'warn'); });
});
onUnmounted(() => { clearInterval(clockTimer); document.removeEventListener('visibilitychange', onVisible); rt.close(); });

async function doLogout() {
  try { await api.logout(); } catch { /* 忽略 */ }
  rt.close();
  store.authed = false;
  toast('已退出登录', 'ok');
}
const reload = () => act('reload', async () => { await loadState(); toast('状态已刷新', 'ok', 1500); });
</script>

<template>
  <div v-if="booting" class="h-full flex items-center justify-center text-[var(--dim)]">正在加载面板…</div>

  <div v-else-if="!store.authed" class="h-full">
    <Login @done="boot" />
  </div>

  <div v-else class="h-full flex flex-col">
    <!-- 顶栏 -->
    <header class="flex items-center gap-3 px-3 h-12 border-b border-[var(--line)] bg-[var(--panel)] shrink-0">
      <div class="flex items-center gap-2 font-semibold tracking-wide">
        <span class="text-[var(--ok)]">◆</span> MCSLite
        <span class="text-[11px] text-[var(--dim)] font-normal">v{{ store.runtime.panelVersion }}</span>
      </div>

      <div class="badge">
        <i class="dot" :class="dotCls"></i>{{ stateText }}
        <span v-if="store.server.pid" class="text-[var(--dim)]">PID {{ store.server.pid }}</span>
      </div>
      <div v-if="store.server.running" class="text-xs text-[var(--dim)] mono">↑ {{ uptime }}</div>
      <div class="text-xs">
        <span class="text-[var(--dim)]">在线</span>
        <b class="ml-1">{{ store.players.online }}<span v-if="store.players.max" class="text-[var(--dim)]">/{{ store.players.max }}</span></b>
      </div>

      <div class="flex-1"></div>

      <span class="badge" :title="'WebSocket: ' + store.wsStatus"
            :class="store.wsStatus === 'online' ? 'text-[var(--ok)]' : 'text-[var(--warn)]'">
        <i class="dot" :class="store.wsStatus === 'online' ? 'dot-on' : 'dot-start'"></i>
        {{ store.wsStatus === 'online' ? '实时' : '重连中' }}
      </span>
      <span class="badge text-[var(--dim)] mono" title="面板自身常驻内存 RSS（后端全部业务逻辑的总代价）">{{ panelRss }} MB</span>
      <button class="btn btn-sm" @click="reload" :disabled="store.busy.reload">刷新</button>
      <button class="btn btn-sm btn-ghost" @click="doLogout" title="退出登录">{{ store.user }}</button>
    </header>

    <!-- 页签 -->
    <nav class="flex gap-1 px-2 pt-2 border-b border-[var(--line)] bg-[var(--bg)] shrink-0 overflow-x-auto">
      <button v-for="t in TABS" :key="t.id" class="tab" :class="{ 'tab-active': store.tab === t.id }" @click="store.tab = t.id">
        <span class="opacity-60 mr-1">{{ t.icon }}</span>{{ t.label }}
        <span v-if="t.id === 'console' && store.console.pending" class="ml-1 text-[10px] text-[var(--warn)]">+{{ store.console.pending }}</span>
      </button>
    </nav>

    <!-- 内容 -->
    <main class="flex-1 min-h-0 overflow-hidden bg-[var(--bg)]">
      <div v-if="bootError" class="m-4 p-3 card border-[var(--err)] text-[var(--err)]">{{ bootError }}</div>
      <KeepAlive include="ConsoleView,Files,Dashboard">
        <component :is="current" />
      </KeepAlive>
    </main>

    <!-- 浮层提示 -->
    <div class="fixed right-3 bottom-3 z-50 flex flex-col gap-2 max-w-sm">
      <TransitionGroup name="toast">
        <div v-for="t in store.toasts" :key="t.id"
             class="card px-3 py-2 text-sm shadow-xl border"
             :class="t.kind === 'error' ? 'border-[var(--err)]' : t.kind === 'warn' ? 'border-[var(--warn)]' : t.kind === 'ok' ? 'border-[var(--ok)]' : 'border-[var(--line)]'">
          {{ t.text }}
        </div>
      </TransitionGroup>
    </div>
  </div>
</template>

<style>
.toast-enter-active, .toast-leave-active { transition: all .22s ease; }
.toast-enter-from { opacity: 0; transform: translateX(24px); }
.toast-leave-to { opacity: 0; transform: translateY(8px); }
</style>
