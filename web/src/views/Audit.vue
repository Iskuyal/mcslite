<script setup>
import { ref, onActivated, computed } from 'vue';
import { store, toast, fmtTime } from '../store';
import { api } from '../api';

defineOptions({ name: 'Audit' });
const rows = ref([]);
const total = ref(0);
const page = ref(0);
const size = 50;
const action = ref('');
const loading = ref(false);

const ACTIONS = ['', 'login.ok', 'login.fail', 'server.start', 'server.stop', 'server.kill', 'server.restart', 'console.send', 'rcon.exec', 'files.write', 'files.upload', 'files.delete', 'files.mkdir', 'files.rename', 'files.download', 'properties.write', 'settings.update', 'settings.password', 'ws.connect', 'panel.start', 'panel.crash'];

async function load() {
  loading.value = true;
  try {
    const r = await api.oplog(size, page.value * size);
    rows.value = r.rows; total.value = r.total;
  } catch (e) { toast(e.message, 'error'); }
  finally { loading.value = false; }
}
onActivated(load);
load();

const pages = computed(() => Math.max(1, Math.ceil(total.value / size)));
const actLabel = (a) => ({
  'login.ok': '登录成功', 'login.fail': '登录失败', 'server.start': '启动服务端', 'server.stop': '优雅停止', 'server.kill': '强制终止',
  'server.restart': '重启', 'console.send': '控制台命令', 'rcon.exec': 'RCON 命令', 'files.write': '写文件', 'files.upload': '上传',
  'files.delete': '删除', 'files.mkdir': '建目录', 'files.rename': '重命名', 'files.download': '下载', 'properties.write': '改配置',
  'settings.update': '改设置', 'settings.password': '改密码', 'ws.connect': 'WS 连接', 'panel.start': '面板启动', 'panel.crash': '面板异常',
}[a] || a);
</script>

<template>
  <div class="h-full flex flex-col min-h-0">
    <div class="flex items-center gap-2 px-3 py-2 border-b border-[var(--line)] bg-[var(--panel)] shrink-0">
      <select v-model="action" class="input py-1 text-xs" @change="page = 0; load()">
        <option value="">全部动作</option>
        <option v-for="a in ACTIONS.slice(1)" :key="a" :value="a">{{ actLabel(a) }}</option>
      </select>
      <span class="text-xs text-[var(--dim)]">共 {{ total }} 条（后端保留最近 5000 条）</span>
      <div class="flex-1"></div>
      <button class="btn btn-sm" :disabled="page === 0 || loading" @click="page--; load()">← 上一页</button>
      <span class="text-xs mono">{{ page + 1 }} / {{ pages }}</span>
      <button class="btn btn-sm" :disabled="(page + 1) * size >= total || loading" @click="page++; load()">下一页 →</button>
      <button class="btn btn-sm" @click="load">↻</button>
    </div>

    <div class="flex-1 overflow-auto p-2">
      <table class="grid">
        <thead><tr><th style="width:11rem">时间</th><th style="width:6rem">用户</th><th style="width:9rem">动作</th><th>目标 / 详情</th><th style="width:4rem">结果</th></tr></thead>
        <tbody>
          <tr v-for="r in rows" :key="r.id">
            <td class="mono text-[var(--dim)] whitespace-nowrap">{{ new Date(r.ts).toLocaleString('zh-CN', { hour12: false }) }}</td>
            <td class="mono">{{ r.user }}</td>
            <td>
              <span :class="r.action === 'login.fail' || r.action === 'panel.crash' ? 'text-[var(--err)]' : ''">{{ actLabel(r.action) }}</span>
            </td>
            <td class="mono text-xs break-all">
              <span v-if="r.target">{{ r.target }}</span>
              <div v-if="r.detail" class="text-[var(--dim)]">{{ r.detail }}</div>
            </td>
            <td :style="{ color: r.ok ? 'var(--ok)' : 'var(--err)' }">{{ r.ok ? '成功' : '失败' }}</td>
          </tr>
          <tr v-if="!rows.length"><td colspan="5" class="text-center py-10 text-[var(--dim)]">暂无记录</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
