<script setup>
import { ref, onMounted } from 'vue';
import { store, toast, loadState, bindRealtime, rt } from '../store';
import { api } from '../api';

const emit = defineEmits(['done']);
const user = ref('admin');
const pass = ref('');
const err = ref('');
const busy = ref(false);
const showPass = ref(false);

onMounted(async () => {
  try { const c = await api.publicConfig(); user.value = c.user || 'admin'; store.needPassword = c.needLogin; } catch { /* 用默认 */ }
});

async function submit() {
  err.value = ''; busy.value = true;
  try {
    await api.login(user.value, pass.value);
    store.authed = true;
    await loadState();
    bindRealtime();
    rt.sub('state', 'console', 'metrics', 'players');
    emit('done');
    toast('登录成功', 'ok', 1800);
  } catch (e) {
    err.value = e.message || '登录失败';
  } finally { busy.value = false; pass.value = ''; }
}
</script>

<template>
  <div class="h-full flex items-center justify-center p-6 overflow-auto">
    <form class="card w-full max-w-sm p-6" @submit.prevent="submit">
      <div class="text-center mb-5">
        <div class="text-2xl mb-1" style="color:var(--ok)">◆</div>
        <div class="font-semibold text-lg">MCSLite 面板</div>
        <div class="text-xs text-[var(--dim)] mt-1">Minecraft 服务端轻量管理</div>
      </div>
      <label class="block text-xs text-[var(--dim)] mb-1" for="luser">用户名</label>
      <input id="luser" name="username" v-model="user" class="input w-full mb-3" autocomplete="username" />
      <label class="block text-xs text-[var(--dim)] mb-1" for="lpass">密码</label>
      <div class="relative mb-3">
        <input id="lpass" name="password" v-model="pass" :type="showPass ? 'text' : 'password'" class="input w-full pr-14" autocomplete="current-password" autofocus />
        <button type="button" class="btn btn-sm btn-ghost absolute right-1 top-1" @click="showPass = !showPass">{{ showPass ? '隐藏' : '显示' }}</button>
      </div>
      <div v-if="err" class="text-[13px] text-[var(--err)] mb-3 px-2 py-1.5 rounded" style="background:rgba(248,81,73,.1)">{{ err }}</div>
      <button class="btn btn-primary w-full justify-center" :disabled="busy || !pass">{{ busy ? '验证中…' : '登 录' }}</button>
      <p class="text-[11px] text-[var(--dim)] mt-4 leading-relaxed">
        首次启动的初始密码打印在面板控制台，并保存于
        <code class="mono px-1 rounded" style="background:#0e141b">data/credentials.json</code>。
      </p>
    </form>
  </div>
</template>
