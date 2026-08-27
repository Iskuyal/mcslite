<script setup>
import { computed } from 'vue';
import { store, act, toast } from '../store';
import { api } from '../api';

/** 生命周期控制条：状态机决定按钮可用性，避免出现「运行中还能点启动」的错觉 */
const s = computed(() => store.server.state);
const offline = computed(() => s.value === 'offline');
const online = computed(() => s.value === 'online' || s.value === 'starting');
const busy = computed(() => !!store.busy.lifecycle);

async function run(name, fn, msg) {
  await act('lifecycle', fn, msg);
}
const start = () => run('start', () => api.start(), '已拉起服务端');
const stop = () => run('stop', async () => { await api.stop(); toast('优雅停止指令已下发（等待存档）', 'ok'); });
const restart = () => run('restart', async () => { await api.restart(); toast('重启完成', 'ok'); });
const kill = async () => {
  if (!confirm('强制终止不会存档，可能损坏区块数据。确定？')) return;
  await run('kill', () => api.kill(), '已强制终止');
};
const resetCrash = () => run('crash', () => api.crashReset(), '已重置崩溃计数');
</script>

<template>
  <div class="flex items-center gap-2 flex-wrap">
    <button class="btn btn-primary" :disabled="!offline || busy" @click="start">
      {{ busy ? '处理中…' : '▶ 启动' }}
    </button>
    <button class="btn" :disabled="!online || busy" @click="restart">⟳ 重启</button>
    <button class="btn btn-warn" :disabled="!online || busy" @click="stop">■ 优雅停止</button>
    <button class="btn btn-danger" :disabled="offline || busy" @click="kill">✖ 强制终止</button>
    <button v-if="store.server.crashStreak > 0" class="btn btn-sm" @click="resetCrash" title="连续崩溃计数归零，恢复自动重启">
      崩溃计数 {{ store.server.crashStreak }} · 重置
    </button>
  </div>
</template>
