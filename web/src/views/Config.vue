<script setup>
import { ref, computed, onActivated } from 'vue';
import { store, toast, act } from '../store';
import { api } from '../api';
import ControlBar from '../components/ControlBar.vue';

defineOptions({ name: 'Config' });

const file = ref('server.properties');
const entries = ref([]);
const comments = ref(0);
const draft = ref({});
const raw = ref(false);
const rawText = ref('');
const loading = ref(false);

const GROUPS = [
  { id: 'base', name: '基础', keys: ['motd', 'server-port', 'server-ip', 'max-players', 'online-mode', 'white-list', 'enforce-whitelist', 'difficulty', 'gamemode', 'force-gamemode', 'pvp', 'hardcore', 'spawn-protection', 'allow-nether', 'snooper-enabled', 'level-name', 'level-seed', 'level-type', 'generator-settings'] },
  { id: 'perf', name: '性能', keys: ['view-distance', 'simulation-distance', 'chunk-builder', 'network-compression-threshold', 'rate-limit', 'sync-chunk-writes', 'entity-broadcast-range-percentage', 'max-chained-neighbor-updates', 'max-tick-time', 'enable-jmx-monitoring'] },
  { id: 'net', name: '网络 / RCON', keys: ['rcon', 'rcon.port', 'rcon.password', 'query.port', 'query.enabled', 'server-properties-file-comment', 'broadcast-console-to-ops', 'broadcast-rcon-to-ops', 'hide-online-players', 'previews-chat'] },
  { id: 'other', name: '其它' },
];
const grouped = computed(() => {
  const used = new Set(GROUPS.filter((g) => g.keys).flatMap((g) => g.keys));
  const out = GROUPS.map((g) => ({
    id: g.id, name: g.name,
    items: entries.value.filter((e) => (g.keys ? g.keys.includes(e.key) : !used.has(e.key))),
  })).filter((g) => g.items.length);
  return out;
});
const dirty = computed(() => Object.keys(draft.value).length);
const running = computed(() => store.server.state !== 'offline');

async function load() {
  loading.value = true;
  try {
    const r = await api.props(file.value);
    entries.value = r.entries;
    comments.value = r.comments;
    draft.value = {};
    const t = await api.read(file.value);
    rawText.value = t.text;
  } catch (e) { toast(e.message, 'error', 5000); entries.value = []; }
  finally { loading.value = false; }
}
function set(key, val) {
  const cur = entries.value.find((e) => e.key === key)?.value;
  if (String(val) === String(cur)) delete draft.value[key];
  else draft.value[key] = val;
  draft.value = { ...draft.value };
}
async function apply() {
  const r = await act('apply', () => api.writeProps(file.value, draft.value));
  if (r.requiresRestart && running.value) toast(`已写入 ${r.changed} 项：这些键需要重启服务端才生效`, 'warn', 6500);
  else toast(`已写入 ${r.changed} 项（多数可热生效）`, 'ok', 3000);
  await load();
}
async function saveRaw() {
  await act('raw', () => api.write(file.value, rawText.value), '已保存原始文本');
  await load();
}
onActivated(load);
if (!entries.value.length) load();
</script>

<template>
  <div class="h-full flex flex-col min-h-0">
    <div class="flex items-center gap-2 px-3 py-2 border-b border-[var(--line)] bg-[var(--panel)] flex-wrap shrink-0">
      <ControlBar />
      <span class="w-px h-6 bg-[var(--line)] mx-1"></span>
      <input v-model="file" class="input py-1 text-xs mono w-52" @change="load" spellcheck="false" title="可改成其它 .properties 文件" />
      <label class="text-xs text-[var(--dim)] flex items-center gap-1"><input type="checkbox" v-model="raw" />按原始文本编辑</label>
      <button class="btn btn-sm" @click="load" :disabled="loading">↻ 重载</button>
      <div class="flex-1"></div>
      <template v-if="!raw">
        <span class="text-xs text-[var(--dim)]">{{ entries.length }} 项 · 保留注释 {{ comments }} 行</span>
        <button class="btn btn-primary btn-sm" :disabled="!dirty || store.busy.apply" @click="apply">应用 {{ dirty ? dirty + ' 项' : '' }}</button>
      </template>
      <button v-else class="btn btn-primary btn-sm" @click="saveRaw" :disabled="store.busy.raw">保存文本</button>
    </div>

    <div class="flex-1 overflow-auto p-3">
      <div v-if="raw" class="h-full">
        <textarea v-model="rawText" spellcheck="false" class="mono w-full h-full resize-none p-3 outline-none card" style="background:#0b1015;font-size:12.5px"></textarea>
      </div>

      <div v-else class="max-w-4xl space-y-4">
        <div class="text-[11px] text-[var(--dim)] px-1">
          修改写回时保留原有注释与行序；标记 <span class="text-[var(--warn)]">★</span> 的项在服务端运行中修改需重启才生效。
        </div>
        <section v-for="g in grouped" :key="g.id" class="card p-4">
          <h3 class="text-sm font-semibold mb-3 text-[var(--acc)]">{{ g.name }}</h3>
          <div class="space-y-2.5">
            <label v-for="e in g.items" :key="e.key" class="flex items-center gap-3">
              <span class="w-60 shrink-0 text-[13px] leading-tight">
                {{ e.schema.label || e.key }}
                <span v-if="e.schema.perf" class="text-[var(--warn)]" title="影响性能">⚡</span>
                <span v-if="e.schema.risk" class="text-[var(--err)]" title="涉及安全或世界数据">★</span>
                <span class="block text-[10px] text-[var(--dim)] mono">{{ e.key }}</span>
              </span>
              <span class="flex-1 min-w-0">
                <!-- 这里必须是 span：外层已是 label，内层再套 label 会让点击「切换两次」 -->
                <span v-if="e.schema.type === 'bool'" class="flex items-center gap-2 cursor-pointer select-none">
                  <input type="checkbox" :checked="String(e.value).toLowerCase() === 'true'" @change="set(e.key, $event.target.checked ? 'true' : 'false')" />
                  <span class="mono text-xs">{{ draft[e.key] ?? e.value }}</span>
                </span>
                <select v-else-if="e.schema.type === 'enum'" class="input w-full max-w-xs" @change="set(e.key, $event.target.value)">
                  <option v-for="v in e.schema.values" :value="v" :selected="v === e.value">{{ v }}</option>
                </select>
                <input v-else-if="e.schema.type === 'int'" type="number" class="input mono w-full max-w-[10rem]" :value="draft[e.key] ?? e.value" @input="set(e.key, $event.target.value)" />
                <input v-else-if="e.schema.type === 'secret'" type="password" class="input mono w-full max-w-sm" :value="draft[e.key] ?? e.value" @input="set(e.key, $event.target.value)" />
                <input v-else class="input mono w-full" :value="draft[e.key] ?? e.value" @input="set(e.key, $event.target.value)" :placeholder="e.schema.hint || ''" />
                <span v-if="e.schema.hint && e.schema.type !== 'string'" class="block text-[10px] text-[var(--dim)]">{{ e.schema.hint }}</span>
              </span>
              <span v-if="draft[e.key] !== undefined" class="badge text-[10px] text-[var(--warn)] shrink-0">待写入</span>
            </label>
          </div>
        </section>
        <div v-if="!grouped.length && !loading" class="text-center text-[var(--dim)] py-10">
          没有可解析的键值行。可切到「原始文本」直接编辑。
        </div>
      </div>
    </div>
  </div>
</template>
