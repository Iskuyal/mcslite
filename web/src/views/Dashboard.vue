<script setup>
import { computed, ref, onActivated } from 'vue';
import { store, loadState, fmtBytes, fmtUptime } from '../store';
import { api } from '../api';
import ControlBar from '../components/ControlBar.vue';
import MetricChart from '../components/MetricChart.vue';

defineOptions({ name: 'Dashboard' });

const p = computed(() => store.lastPoint || {});
const s = computed(() => store.server);
const up = computed(() => (s.value.running ? fmtUptime(Date.now() - (s.value.startedAt || Date.now())) : '—'));
const cpuSeries = [
  { key: 'procCpu', label: '服务端进程 CPU', color: '#4ea1ff' },
  { key: 'sysCpu', label: '整机 CPU', color: '#7d8b9c' },
];
const memSeries = [
  { key: 'procRss', label: '服务端 RSS', color: '#3fb950', fill: '#3fb950' },
  { key: 'panelRss', label: '面板自身', color: '#bc8cff' },
];
// 整机内存是 GB 量级、JVM RSS 是 MB 量级，混在同一根同单位轴上读数会误导
// （曾经显示成「已用内存 14.4 MB」）。整机内存只作为数字放在「当前指标」卡里。
const ioSeries = [
  { key: 'ioWrite', label: '磁盘写', color: '#f85149', fill: '#f85149' },
  { key: 'ioRead', label: '磁盘读', color: '#39c5cf' },
];
const diskPct = computed(() => {
  const d = store.disk;
  if (!d || !d.total) return null;
  return ((1 - d.free / d.total) * 100).toFixed(1);
});
const showTs = ref(true);
onActivated(() => { loadState().catch(() => {}); });

function pct(v) { return v == null ? '—' : (+v).toFixed(1) + '%'; }
function mb(v) { return v == null ? '—' : fmtBytes(v, 0); }
</script>

<template>
  <div class="h-full overflow-auto p-3">
    <div class="grid grid-cols-1 xl:grid-cols-4 gap-3">
      <!-- 状态卡 -->
      <div class="card p-4 xl:col-span-2">
        <div class="flex items-center gap-3 mb-4">
          <span class="badge text-base px-3 py-1">
            <i class="dot" :class="{ 'dot-on': s.state === 'online', 'dot-off': s.state === 'offline', 'dot-start': s.state === 'starting', 'dot-stop': s.state === 'stopping' }"></i>
            {{ { online: '运行中', offline: '已停止', starting: '启动中', stopping: '停止中' }[s.state] }}
          </span>
          <span class="text-xs text-[var(--dim)] mono">PID {{ s.pid || '—' }} · 运行 {{ up }}</span>
        </div>
        <ControlBar />
        <div class="mt-4 grid grid-cols-2 gap-x-6">
          <div class="kv"><span class="text-[var(--dim)]">实例目录</span><b class="mono text-xs truncate max-w-[15rem]" :title="s.root">{{ s.root || '未配置' }}</b></div>
          <div class="kv"><span class="text-[var(--dim)]">Jar</span><b class="mono text-xs">{{ s.jar }}</b></div>
          <div class="kv"><span class="text-[var(--dim)]">日志编码</span><b class="mono">{{ s.encoding || '—' }}</b></div>
          <div class="kv"><span class="text-[var(--dim)]">缓冲行数</span><b class="mono">{{ s.lineCount }}</b></div>
          <div class="kv"><span class="text-[var(--dim)]">玩家（日志推断）</span><b class="mono">{{ s.onlinePlayers }}</b></div>
          <div class="kv"><span class="text-[var(--dim)]">最近退出</span><b class="mono text-xs">{{ s.lastExit ? (s.lastExit.expected ? '正常 ' + s.lastExit.code : '异常 code=' + s.lastExit.code + ' ' + (s.lastExit.signal || '')) : '—' }}</b></div>
        </div>
        <div v-if="s.state === 'offline' && !s.root" class="mt-3 text-[13px] text-[var(--warn)]">
          ⚠ 实例目录未配置或不存在 —— 请到「设置 → 服务端」填写，或把服务端文件放进 instance/。
        </div>
      </div>

      <!-- 关键数字 -->
      <div class="card p-4">
        <div class="text-xs text-[var(--dim)] mb-2">当前指标</div>
        <div class="kv"><span>服务端 CPU</span><b class="mono text-lg">{{ pct(p.procCpu ?? p.sysCpu) }}</b></div>
        <div class="kv"><span>整机 CPU</span><b class="mono">{{ pct(p.sysCpu) }}</b></div>
        <div class="kv"><span>服务端内存 RSS</span><b class="mono text-lg" style="color:var(--ok)">{{ mb(p.procRss) }}</b></div>
        <div class="kv"><span>整机已用 / 总量</span><b class="mono">{{ mb(p.sysMemUsed) }} / {{ mb(p.sysMemTotal) }}</b></div>
        <div class="kv"><span>磁盘 IO（读/写）</span><b class="mono text-xs">{{ mb(p.ioRead) + '/s' }} · {{ mb(p.ioWrite) + '/s' }}</b></div>
        <div class="kv"><span>实例盘剩余</span><b class="mono text-xs">{{ mb(store.disk.free) }}<span v-if="diskPct" class="text-[var(--dim)]">（已用 {{ diskPct }}%）</span></b></div>
        <div class="kv"><span>面板自身 RSS</span><b class="mono text-xs" style="color:#bc8cff">{{ mb(p.panelRss) }}</b></div>
        <div class="text-[11px] text-[var(--dim)] mt-3 leading-relaxed">
          采样器：
          <span :style="{ color: store.sampler.state === 'running' ? 'var(--ok)' : 'var(--warn)' }">{{ { running: 'CIM 正常运行', starting: '启动中', degraded: '已降级（仅系统级）', idle: '空闲', off: '已关闭' }[store.sampler.state] }}</span>
          <div v-if="store.sampler.error" class="mt-1 break-words">{{ store.sampler.error }}</div>
        </div>
      </div>

      <!-- 玩家 -->
      <div class="card p-4 flex flex-col">
        <div class="flex items-baseline justify-between mb-2">
          <span class="text-xs text-[var(--dim)]">在线玩家</span>
          <span class="mono text-lg">{{ store.players.online }}<span class="text-[var(--dim)] text-sm" v-if="store.players.max">/{{ store.players.max }}</span></span>
        </div>
        <div class="text-[11px] text-[var(--dim)] mb-2">来源：{{ store.players.source === 'rcon' ? 'RCON（权威）' : '日志解析（降级）' }}</div>
        <div v-if="store.players.names?.length" class="flex flex-wrap gap-1.5 content-start overflow-auto">
          <span v-for="n in store.players.names" :key="n" class="badge mono" style="border-color:#2c3e52">{{ n }}</span>
        </div>
        <div v-else class="text-[var(--dim)] text-sm py-6 text-center">暂无玩家在线</div>
        <div v-if="store.players.error || store.players.rconError" class="mt-auto text-[11px] text-[var(--warn)] break-words">
          RCON：{{ store.players.rconError || store.players.error }}
        </div>
      </div>
    </div>

    <div class="grid grid-cols-1 lg:grid-cols-3 gap-3 mt-3">
      <MetricChart title="CPU 使用率" unit="%" :max="100" :series="cpuSeries" :data="store.series" :height="185" />
      <MetricChart title="内存（服务端 / 整机 / 面板）" unit=" MB" :series="memSeries" :data="store.series" :height="185" />
      <MetricChart title="磁盘吞吐" unit=" KB/s" :series="ioSeries" :data="store.series" :height="185" />
    </div>

    <div class="card p-3 mt-3 text-[11px] text-[var(--dim)] leading-relaxed">
      运行时：Node {{ store.runtime.node }} · V8 {{ store.runtime.v8 }} · {{ store.runtime.platform }} {{ store.runtime.arch }} ·
      {{ store.runtime.cpus }} 逻辑核 · 存储 {{ store.runtime.storeBackend }} · 面板启动 {{ fmtUptime((store.runtime.uptime || 0) * 1000) }} ·
      {{ store.runtime.sea ? '单文件模式' : '源码模式' }}
    </div>
  </div>
</template>
