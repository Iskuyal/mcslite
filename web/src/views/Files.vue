<script setup>
import { ref, computed, onActivated } from 'vue';
import { store, toast, act, fmtBytes, fmtTime } from '../store';
import { api } from '../api';

defineOptions({ name: 'Files' });

const dir = ref('');
const entries = ref([]);
const loading = ref(false);
const editor = ref({ open: false, path: '', text: '', encoding: '', size: 0, dirty: false, binary: false });
const dropActive = ref(false);
const fileInput = ref(null);

const crumbs = computed(() => {
  const parts = dir.value ? dir.value.split('/').filter(Boolean) : [];
  return [{ p: '', n: '实例根目录' }, ...parts.map((x, i) => ({ p: parts.slice(0, i + 1).join('/'), n: x }))];
});

async function open(d) {
  loading.value = true;
  try {
    const r = await api.files(d);
    dir.value = r.dir || '';
    entries.value = r.entries;
    if (r.truncated) toast(`目录条目过多，仅显示前 ${r.entries.length} 项`, 'warn', 4000);
  } catch (e) { toast(e.message, 'error', 5000); }
  finally { loading.value = false; }
}
async function enter(e) { if (e.dir) open((dir.value ? dir.value + '/' : '') + e.name); else view(e); }
const full = (n) => (dir.value ? dir.value + '/' + n : n);
// Vue 模板编译器会把非白名单全局标识符编译成 _ctx.X —— Blob 在模板里用会运行时炸
// （TypeError: g.Blob is not a constructor），所以体积一律在 script 里算好。
const editBytes = computed(() => {
  try { return new Blob([editor.value.text || '']).size; } catch { return (editor.value.text || '').length; }
});

async function view(e) {
  if (e.binary) { toast('二进制文件请用下载查看', 'info', 2500); return; }
  const r = await act('edit', () => api.read(full(e.name)));
  editor.value = { open: true, path: r.rel, text: r.text, encoding: r.encoding, size: r.size, dirty: false, binary: r.binary };
  if (r.encoding !== 'utf-8') toast(`该文件按 ${r.encoding} 解码后编辑`, 'warn', 3500);
}
async function save() {
  if (!editor.value.open) return;
  const r = await act('save', () => api.write(editor.value.path, editor.value.text));
  editor.value.dirty = false;
  toast(`已保存 ${fmtBytes(r.bytes)}（${r.lineEnding.toUpperCase()}）`, 'ok', 2200);
  open(dir.value);
}
async function del(e) {
  if (!confirm(`删除 ${full(e.name)} ？${e.dir ? '（含其内全部内容）' : ''}`)) return;
  await act('del', () => api.rm(full(e.name), !!e.dir), '已删除');
  open(dir.value);
}
async function rename(e) {
  const to = prompt('新名称（相对当前目录）', e.name);
  if (!to || to === e.name) return;
  await act('re', () => api.rename(full(e.name), (dir.value ? dir.value + '/' : '') + to), '已重命名');
  open(dir.value);
}
async function newFile() {
  const n = prompt('新建文件名（相对当前目录）', 'new.txt');
  if (!n) return;
  await act('nf', () => api.write(full(n), ''), '已创建');
  open(dir.value);
  editor.value = { open: true, path: (dir.value ? dir.value + '/' : '') + n, text: '', encoding: 'utf-8', size: 0, dirty: false, binary: false };
}
async function newDir() {
  const n = prompt('新建目录名', 'new-folder');
  if (!n) return;
  await act('nd', () => api.mkdir(full(n)), '已创建目录');
  open(dir.value);
}

async function upload(files) {
  for (const f of files) {
    if (f.size > 500 * 1024 * 1024) { toast(`${f.name} 超过 500MB，建议直接放盘`, 'warn', 4000); continue; }
    const target = (dir.value ? dir.value + '/' : '') + f.name;
    // 直接把 File(Blob) 交给 fetch：浏览器从磁盘流式读出，不进 JS 堆
    await act('up', async () => {
      const res = await fetch(api.uploadUrl ? api.uploadUrl(target) : `/api/files/upload?path=${encodeURIComponent(target)}`, { method: 'PUT', body: f, credentials: 'same-origin' });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      return res.json();
    });
    toast(`已上传 ${target} (${fmtBytes(f.size)})`, 'ok', 3000);
  }
  open(dir.value);
}
function onDrop(e) {
  dropActive.value = false;
  const fs = [...(e.dataTransfer?.files || [])];
  if (fs.length) upload(fs);
}
onActivated(() => { if (!entries.value.length) open(''); });
</script>

<template>
  <div class="h-full flex min-h-0">
    <!-- 列表 -->
    <div class="flex-1 flex flex-col min-w-0"
         @dragover.prevent="dropActive = true" @dragleave="dropActive = false" @drop.prevent="onDrop">
      <div class="flex items-center gap-2 px-3 py-2 border-b border-[var(--line)] bg-[var(--panel)] flex-wrap shrink-0">
        <nav class="flex items-center gap-1 text-sm min-w-0 overflow-hidden">
          <template v-for="(c, i) in crumbs" :key="c.p">
            <span v-if="i" class="text-[var(--dim)]">/</span>
            <button class="hover:underline truncate max-w-[12rem]" :class="i === crumbs.length - 1 ? 'font-semibold' : 'text-[var(--acc)]'" @click="open(c.p)">{{ c.n }}</button>
          </template>
        </nav>
        <div class="flex-1"></div>
        <button class="btn btn-sm" @click="newFile">+ 文件</button>
        <button class="btn btn-sm" @click="newDir">+ 目录</button>
        <button class="btn btn-sm" @click="fileInput.click()">⇪ 上传</button>
        <input ref="fileInput" type="file" multiple class="hidden" @change="upload($event.target.files); $event.target.value = ''" />
        <button class="btn btn-sm" @click="open(dir)" :disabled="loading">↻</button>
      </div>

      <div class="flex-1 overflow-auto p-2 relative">
        <div v-if="dropActive" class="absolute inset-2 z-10 rounded-lg border-2 border-dashed border-[var(--acc)] bg-[rgba(78,161,255,.08)] flex items-center justify-center text-[var(--acc)]">释放以上传到当前目录</div>
        <table class="grid">
          <thead><tr><th style="width:2.2rem"></th><th>名称</th><th style="width:7rem" class="text-right">大小</th><th style="width:10rem">修改时间</th><th style="width:9rem"></th></tr></thead>
          <tbody>
            <tr v-if="dir" class="cursor-pointer" @click="open(dir.split('/').slice(0, -1).join('/'))">
              <td>↩</td><td colspan="4" class="text-[var(--dim)]">..</td>
            </tr>
            <tr v-for="e in entries" :key="e.name" class="cursor-pointer" @dblclick="enter(e)" @click="enter(e)">
              <td class="opacity-70">{{ e.dir ? '🗀' : e.binary ? '▣' : '▸' }}</td>
              <td class="mono truncate max-w-[26rem]" :title="e.name">
                {{ e.name }}
                <span v-if="e.link" class="badge ml-1 text-[10px]">链接</span>
                <span v-if="e.protected" class="badge ml-1 text-[10px] text-[var(--warn)]">运行期文件</span>
              </td>
              <td class="text-right mono text-[var(--dim)]">{{ e.dir ? '—' : fmtBytes(e.size) }}</td>
              <td class="mono text-[var(--dim)]">{{ e.mtime ? fmtTime(e.mtime) : '' }}</td>
              <td class="text-right whitespace-nowrap">
                <a v-if="!e.dir" class="btn btn-sm btn-ghost" :href="`/api/files/download?path=${encodeURIComponent((dir ? dir + '/' : '') + e.name)}`" @click.stop>下载</a>
                <button class="btn btn-sm btn-ghost" @click.stop="rename(e)">重命名</button>
                <button class="btn btn-sm btn-ghost" style="color:var(--err)" @click.stop="del(e)">删</button>
              </td>
            </tr>
            <tr v-if="!entries.length && !loading"><td colspan="5" class="text-center py-8 text-[var(--dim)]">
              空目录。可拖拽文件到此窗口上传。
            </td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 编辑器 -->
    <div v-if="editor.open" class="w-[46%] min-w-[24rem] border-l border-[var(--line)] bg-[var(--panel)] flex flex-col">
      <div class="flex items-center gap-2 px-3 py-2 border-b border-[var(--line)]">
        <span class="mono text-xs truncate flex-1" :title="editor.path">{{ editor.path }}</span>
        <span class="badge text-[10px]">{{ editor.encoding }}</span>
        <span v-if="editor.dirty" class="text-[var(--warn)] text-xs">● 未保存</span>
        <button class="btn btn-sm" @click="editor.open = false">✕</button>
      </div>
      <textarea v-model="editor.text" @input="editor.dirty = true" @keydown.ctrl.s.prevent="save" spellcheck="false"
                class="flex-1 mono w-full resize-none p-3 outline-none" style="background:#0b1015;border:0;font-size:12.5px"></textarea>
      <div class="flex items-center gap-2 px-3 py-2 border-t border-[var(--line)]">
        <button class="btn btn-primary btn-sm" @click="save" :disabled="!editor.dirty || store.busy.save">保存 (Ctrl+S)</button>
        <button class="btn btn-sm" @click="editor.text = ''; editor.dirty = true">清空</button>
        <span class="flex-1"></span>
        <span class="text-xs text-[var(--dim)] mono">{{ fmtBytes(editBytes) }}</span>
      </div>
    </div>
  </div>
</template>
