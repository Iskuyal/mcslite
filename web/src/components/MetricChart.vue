<script setup>
import { ref, onMounted, onBeforeUnmount, watch } from 'vue';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';

/**
 * uPlot 封装。选 uPlot 而不是 ECharts/Chart.js 的理由（低内存优先）：
 *  · 体积 45KB gzip vs ECharts 全量 ~1MB（还是运行时解析）
 *  · 数据面直接吃 TypedArray/普通数组，不为每个点建对象
 *  · 重绘走 canvas，DOM 里永远只有 1 个 <canvas>，600 点也不掉帧
 */
const props = defineProps({
  title: { type: String, default: '' },
  unit: { type: String, default: '' },
  series: { type: Array, required: true },      // [{key,label,color,fill?}]
  data: { type: Object, required: true },       // store.series
  height: { type: Number, default: 170 },
  max: { type: Number, default: null },
  min: { type: Number, default: 0 },
});
const el = ref(null);
let chart = null, ro = null;

/** 图例用的末值：取该序列最后一个非 null 点（null 表示那一刻采样器没数据） */
function last(key) {
  const arr = props.data[key];
  if (!arr || !arr.length) return '—';
  for (let i = arr.length - 1; i >= 0 && i > arr.length - 30; i--) {
    const v = arr[i];
    if (v != null) return (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1)) + (props.unit || '');
  }
  return '—';
}

function cols() {
  return props.series.map((s) => props.data[s.key] || []);
}
function slice() {
  const ts = props.data.ts || [];
  const n = ts.length;
  const start = Math.max(0, n - 400);            // 只画最近 400 点（≈20 分钟），历史留在内存里不外泄给渲染层
  return [ts.slice(start), ...cols().map((c) => c.slice(start))];
}

onMounted(() => {
  const spline = uPlot.paths.spline({ tension: 0.22 });   // 生成器建一次，别每帧重建
  const opts = {
    width: el.value.clientWidth || 420,
    height: props.height,
    pxAlign: 0,
    cursor: { dash: [4, 4], points: { show: false }, drag: { x: false, y: false } },
    legend: { show: false },                 // 图例自绘（见 template），省掉每帧 table 重建
    grid: { stroke: '#1b2532', width: 1 },
    ticks: { stroke: '#1b2532', size: 6 },
    axes: [
      // uPlot values 回调签名 (self, splits, values, …)：第 3 个参数在首帧可能为 null，
      // 必须映射第 2 个参数 splits（刻度数值），否则就是 m.map is not a function。
      { stroke: '#7d8b9c', size: 46, font: '10px ui-monospace,monospace',
        values: (_s, splits) => (splits || []).map((v) => new Date(v * 1000).toLocaleTimeString('zh-CN', { hour12: false, minute: '2-digit', second: '2-digit' })) },
      { stroke: '#7d8b9c', size: 46, font: '10px ui-monospace,monospace',
        values: (_s, splits) => (splits || []).map((v) => (Number.isFinite(v) ? (props.max ? Math.min(v, props.max) : v).toFixed(Math.abs(v) >= 100 ? 0 : 1) + (props.unit || '') : '')) },
    ],
    scales: {
      x: { time: true },
      // uPlot 的 range 签名是 (u, min, max)；百分比图钉死 0~100，其余留 25% 顶边
      y: { range: (_u, min, max) => (props.max ? [0, props.max] : [Math.min(0, min ?? 0), Math.max(max ?? 1, 1) * 1.25]) },
    },
    series: [
      { label: '时间' },
      ...props.series.map((s) => ({
        label: s.label, stroke: s.color, width: 1.6, show: true,
        fill: s.fill ? s.fill + '26' : undefined,
        paths: spline,
      })),
    ],
  };
  chart = new uPlot(opts, slice(), el.value);
  ro = new ResizeObserver(() => { if (chart) chart.setSize({ width: el.value.clientWidth, height: props.height }); });
  ro.observe(el.value);
});

watch(() => props.data.ts.length, () => { if (chart) chart.setData(slice()); });
watch(() => props.series.map((s) => !!props.data[s.key]?.length).join(), () => { if (chart) chart.setData(slice()); });

onBeforeUnmount(() => {
  if (ro) ro.disconnect();
  if (chart) chart.destroy();
  chart = null;
});
</script>

<template>
  <div class="card p-2.5">
    <div class="flex items-baseline gap-3 mb-1.5 flex-wrap">
      <span class="text-xs text-[var(--dim)] font-medium tracking-wide shrink-0">{{ title }}</span>
      <!-- 自绘图例：uPlot 内置 legend 在无光标时不回填末值（一片 “--”），
           且每帧重建 <table> 行；换成自己渲染，观感与开销都更好 -->
      <span v-for="s in series" :key="s.key" class="flex items-center gap-1 text-[11px] mono">
        <i class="inline-block w-2.5 h-[3px] rounded-sm" :style="{ background: s.color }"></i>
        <span class="text-[var(--dim)]">{{ s.label }}</span>
        <b>{{ last(s.key) }}</b>
      </span>
      <span class="flex-1"></span>
      <span class="text-[11px] mono text-[var(--dim)]">{{ (data.ts || []).length }} 点</span>
    </div>
    <div ref="el" class="w-full"></div>
  </div>
</template>
