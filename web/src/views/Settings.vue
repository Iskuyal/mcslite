<script setup>
import { ref, computed, onActivated, onMounted, watch } from 'vue';
import { store, toast, act, loadState } from '../store';
import { api } from '../api';

defineOptions({ name: 'Settings' });

const tab = ref('server');
const cfg = ref(null);
const errors = ref([]);
const warnings = ref([]);
const curPass = ref('');
const newPass = ref('');
const dirty = ref(false);

async function load() {
  try { cfg.value = await api.settings(); dirty.value = false; }
  catch (e) { toast(e.message, 'error'); }
}
onActivated(load);
if (!cfg.value) load();

const s = computed(() => cfg.value?.server || {});
const jarMode = computed(() => s.value.launcher !== 'command');

/** 只提交改动过的分组，避免把未加载字段覆盖成默认值 */
function patch(group) {
  const c = cfg.value;
  if (group === 'server') return { server: { root: c.server.root, javaPath: c.server.javaPath, jarName: c.server.jarName, launcher: c.server.launcher, startCommand: c.server.startCommand, jvmArgs: c.server.jvmArgs, mcArgs: c.server.mcArgs, autostart: c.server.autostart, autoRestart: c.server.autoRestart, stopCommand: c.server.stopCommand, stopTimeoutMs: +c.server.stopTimeoutMs, consoleEncoding: c.server.consoleEncoding, maxLines: +c.server.maxLines, stopOnExit: c.server.stopOnExit, logFile: c.server.logFile } };
  if (group === 'rcon') return { rcon: { enabled: c.rcon.enabled, host: c.rcon.host, port: +c.rcon.port, ...(c.rcon.password ? { password: c.rcon.password } : {}) } };
  if (group === 'monitor') return { monitor: { intervalMs: +c.monitor.intervalMs, history: +c.monitor.history, diskSampler: c.monitor.diskSampler, samplerIdleMs: +c.monitor.samplerIdleMs } };
  if (group === 'panel') return { panel: { host: c.panel.host, port: +c.panel.port, serveStatic: c.panel.serveStatic, trustProxy: c.panel.trustProxy } };
  if (group === 'security') return { security: { user: c.security.user, tokenTtlHours: +c.security.tokenTtlHours, loginMaxPerMin: +c.security.loginMaxPerMin } };
  return {};
}
watch(cfg, () => { dirty.value = true; }, { deep: true });

async function check() {
  const r = await api.validateSettings(patch(tab.value));
  errors.value = r.errors; warnings.value = r.warnings;
  toast(r.ok ? '校验通过' : `校验未通过：${r.errors.length} 项`, r.ok ? 'ok' : 'error', 3500);
}

// ———— run.bat / run.sh 导入：把安装器脚本翻译成 argv，面板仍然不过 shell ————
const scripts = ref([]);
const preview = ref(null);
const previewFile = ref('');
async function detect() {
  try { const r = await api.importDetect(); scripts.value = r.scripts || []; }
  catch (e) { toast(e.message, 'error', 4000); }
}
async function doImport(file, apply) {
  previewFile.value = file;
  try {
    const r = await api.importRunbat(file, apply);
    preview.value = r;
    if (apply) {
      await load();
      toast('导入完成并已写入配置', 'ok', 3200);
    } else {
      toast('已生成预览，确认无误后点「应用导入」', 'info', 3500);
    }
  } catch (e) { preview.value = { error: e.message }; toast(e.message, 'error', 6000); }
}
onMounted(detect);
watch(() => s.value.root, detect);
async function save() {
  try {
    const r = await act('save', () => api.saveSettings(patch(tab.value)));
    errors.value = []; warnings.value = r.warnings || [];
    dirty.value = false;
    toast('已保存设置', 'ok', 2200);
    await loadState();
    if ((r.warnings || []).length) setTimeout(() => r.warnings.forEach((w) => toast('提示：' + w, 'warn', 6000)), 300);
  } catch (e) {
    errors.value = e.payload?.errors || [e.message];
  }
}
async function savePass() {
  if (newPass.value.length < 6) return toast('新密码至少 6 位', 'warn');
  await act('pw', () => api.setPassword(curPass.value, newPass.value), '密码已修改，其它设备需要重新登录');
  curPass.value = newPass.value = '';
}
const JVM_PRESETS = {
  '4G 稳妥（G1）': '-Xms4G -Xmx4G -XX:+UseG1GC -XX:MaxGCPauseMillis=50 -XX:+ParallelRefProcEnabled -XX:+UnlockDiagnosticVMOptions -XX:+DebugNonSafepoints -Dfile.encoding=UTF-8 -Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8',
  '8G 大服（G1）': '-Xms8G -Xmx8G -XX:+UseG1GC -XX:G1NewSizePercent=30 -XX:G1MaxNewSizePercent=40 -XX:MaxGCPauseMillis=50 -XX:+ParallelRefProcEnabled -Dfile.encoding=UTF-8',
  '16G+（ZGC 低停顿）': '-Xms16G -Xmx16G -XX:+UseZGC -XX:+ZGenerational -XX:+AlwaysPreTouch -Dfile.encoding=UTF-8',
  '省内存（2G 小服）': '-Xmx2G -XX:+UseSerialGC -XX:MaxRAMPercentage=85 -Dfile.encoding=UTF-8',
};
const usePreset = (k) => { if (cfg.value) { cfg.value.server.jvmArgs = JVM_PRESETS[k]; dirty.value = true; } };
</script>

<template>
  <div v-if="!cfg" class="p-6 text-[var(--dim)]">载入设置…</div>
  <div v-else class="h-full flex flex-col min-h-0">
    <div class="flex gap-1 px-3 py-2 border-b border-[var(--line)] bg-[var(--panel)] flex-wrap shrink-0">
      <button v-for="t in [['server', '服务端'], ['rcon', 'RCON'], ['monitor', '监控'], ['panel', '面板 / 网络'], ['security', '账号安全']]" :key="t[0]"
              class="btn btn-sm" :class="tab === t[0] ? 'btn-primary' : ''" @click="tab = t[0]; errors = []; warnings = []">{{ t[1] }}</button>
      <div class="flex-1"></div>
      <button class="btn btn-sm" @click="check">仅校验</button>
      <button class="btn btn-sm btn-primary" @click="save" :disabled="!dirty || store.busy.save">保存本组</button>
    </div>

    <div class="flex-1 overflow-auto p-4">
      <div v-if="errors.length" class="mb-4 card p-3" style="border-color:var(--err)">
        <div class="text-[var(--err)] font-semibold mb-1 text-sm">校验未通过，未写入</div>
        <ul class="list-disc pl-5 text-[13px] space-y-0.5"><li v-for="e in errors" :key="e">{{ e }}</li></ul>
      </div>
      <div v-if="warnings.length" class="mb-4 card p-3" style="border-color:var(--warn)">
        <div class="text-[var(--warn)] font-semibold mb-1 text-sm">提醒（不阻止保存）</div>
        <ul class="list-disc pl-5 text-[13px] space-y-0.5"><li v-for="w in warnings" :key="w">{{ w }}</li></ul>
      </div>

      <div class="max-w-3xl space-y-4">
        <!-- 服务端 -->
        <template v-if="tab === 'server'">
          <section class="card p-4 space-y-3">
            <h3 class="text-sm font-semibold text-[var(--acc)]">实例位置</h3>
            <label class="block">
              <div class="text-xs text-[var(--dim)]">服务端目录（绝对路径）</div>
              <input v-model="cfg.server.root" class="input mono w-full mt-1" placeholder="D:\MC\neoforge-server" />
              <div class="text-[11px] text-[var(--dim)] mt-0.5">面板文件管理、日志、指标都以此目录为沙箱边界。</div>
            </label>
            <label class="block">
              <div class="text-xs text-[var(--dim)]">Jar 文件名（相对上面目录）</div>
              <input v-model="cfg.server.jarName" class="input mono w-full mt-1" placeholder="server.jar" />
              <div class="text-[11px] text-[var(--dim)] mt-0.5">NeoForge 请填安装器生成的那个 universal jar（与 win.sh 里同名），或直接把启动脚本改成下方「完全托管命令」。</div>
            </label>
            <label class="block">
              <div class="text-xs text-[var(--dim)]">Java 路径（含空格也可，无需引号）</div>
              <input v-model="cfg.server.javaPath" class="input mono w-full mt-1" placeholder="C:\Program Files\Java\jdk-25\bin\java.exe" />
              <div class="text-[11px] text-[var(--dim)] mt-0.5">留 `java` 则走 PATH。面板以 <b>spawn(数组参数, shell:false)</b> 启动，带空格路径由 libuv 自动加引号。</div>
            </label>
            <div class="grid grid-cols-2 gap-3">
              <label class="block">
                <div class="text-xs text-[var(--dim)]">启动方式</div>
                <select v-model="cfg.server.launcher" class="input w-full mt-1">
                  <option value="jar">java -jar（推荐）</option>
                  <option value="command">完全托管命令</option>
                </select>
              </label>
              <label class="block">
                <div class="text-xs text-[var(--dim)]">控制台编码</div>
                <select v-model="cfg.server.consoleEncoding" class="input w-full mt-1">
                  <option value="auto">自动探测（推荐）</option>
                  <option value="utf-8">UTF-8</option>
                  <option value="gbk">GBK（中文 Windows 无 -Dfile.encoding 时）</option>
                </select>
              </label>
            </div>
            <label v-if="!jarMode" class="block">
              <div class="text-xs text-[var(--dim)]">完全托管命令（空格分隔，含空格用引号；绝不经过 shell）</div>
              <input v-model="cfg.server.startCommand" class="input mono w-full mt-1" placeholder='node G:\MC\launch.js --mod neoforge' />
            </label>
          </section>

          <section v-if="scripts.length" class="card p-4 space-y-3" style="border-color:#2d4a6b">
            <h3 class="text-sm font-semibold text-[var(--acc)]">从启动脚本导入</h3>
            <div class="text-[11px] text-[var(--dim)]">
              检测到实例目录里的 <span v-for="(f, i) in scripts" :key="f"><button class="underline text-[var(--acc)]" @click="doImport(f, false)">{{ f }}</button>{{ i < scripts.length - 1 ? ' · ' : '' }}</span>
              —— 面板会把脚本里的 java 命令行解析成参数数组（<b>不会</b>去执行 .bat），自动处理 <code class="mono">@argfile</code>、含空格路径、<code class="mono">%*</code> 与 <code class="mono">pause</code>。
            </div>
            <div class="flex gap-2 flex-wrap">
              <button v-for="f in scripts" :key="'b' + f" class="btn btn-sm" @click="doImport(f, false)" :disabled="store.busy.imp">预览 {{ f }}</button>
              <button v-if="previewFile" class="btn btn-sm btn-primary" @click="doImport(previewFile, true)">应用导入（{{ previewFile }}）</button>
            </div>
            <div v-if="preview" class="text-[12px] space-y-1">
              <div v-if="preview.error" class="text-[var(--err)]">{{ preview.error }}</div>
              <template v-else>
                <div class="mono p-2 rounded" style="background:#0b1015;word-break:break-all">
                  <span v-for="(a, i) in preview.argv" :key="i" class="mr-1"><span class="text-[var(--dim)]">{{ i ? '' : '$' }}</span> {{ a.includes(' ') ? '"' + a + '"' : a }}</span>
                </div>
                <ul class="text-[var(--dim)] list-disc pl-5 space-y-0.5"><li v-for="n in preview.notes" :key="n">{{ n }}</li></ul>
                <div v-if="!preview.applied" class="text-[var(--warn)]">尚未写入 —— 点「应用导入」后会填进下面的字段，仍需「保存本组」才落盘生效。</div>
                <div v-else class="text-[var(--ok)]">已写入配置。</div>
              </template>
            </div>
          </section>

          <section class="card p-4 space-y-3">
            <h3 class="text-sm font-semibold text-[var(--acc)]">JVM 参数</h3>
            <div class="flex gap-1.5 flex-wrap">
              <button v-for="(_, k) in JVM_PRESETS" :key="k" class="btn btn-sm" @click="usePreset(k)">{{ k }}</button>
            </div>
            <textarea v-model="cfg.server.jvmArgs" rows="3" spellcheck="false" class="input mono w-full"></textarea>
            <div class="text-[11px] text-[var(--warn)]">务必保留 <code class="mono">-Dfile.encoding=UTF-8</code>，否则中文日志在中文 Windows 上按 GBK 输出。</div>
            <label class="block">
              <div class="text-xs text-[var(--dim)]">游戏参数（追加在 -jar xxx.jar 之后）</div>
              <input v-model="cfg.server.mcArgs" class="input mono w-full mt-1" placeholder="nogui" />
            </label>
          </section>

          <section class="card p-4 space-y-3">
            <h3 class="text-sm font-semibold text-[var(--acc)]">生命周期</h3>
            <div class="grid grid-cols-2 gap-3">
              <label class="flex items-center gap-2 text-[13px]"><input type="checkbox" v-model="cfg.server.autostart" />面板启动时自动拉起服务端</label>
              <label class="flex items-center gap-2 text-[13px]"><input type="checkbox" v-model="cfg.server.autoRestart" />异常退出自动重启</label>
              <label class="flex items-center gap-2 text-[13px]" title="默认 false：升级/重启面板不打扰玩家"><input type="checkbox" v-model="cfg.server.stopOnExit" />面板退出时一并停止服务端</label>
            </div>
            <div class="grid grid-cols-3 gap-3">
              <label class="block"><div class="text-xs text-[var(--dim)]">优雅停止命令</div><input v-model="cfg.server.stopCommand" class="input mono w-full mt-1" /></label>
              <label class="block"><div class="text-xs text-[var(--dim)]">停止等待上限 (ms)</div><input type="number" v-model="cfg.server.stopTimeoutMs" class="input mono w-full mt-1" step="1000" /></label>
              <label class="block"><div class="text-xs text-[var(--dim)]">控制台缓冲行数</div><input type="number" v-model="cfg.server.maxLines" class="input mono w-full mt-1" step="100" /></label>
            </div>
            <div class="text-[11px] text-[var(--dim)]">缓冲行数直接决定面板常驻内存：3000 行约多占 1~2MB，调到 50000 行会到 ~30MB。</div>
          </section>
        </template>

        <!-- RCON -->
        <template v-else-if="tab === 'rcon'">
          <section class="card p-4 space-y-3">
            <h3 class="text-sm font-semibold text-[var(--acc)]">Source RCON</h3>
            <label class="flex items-center gap-2 text-[13px]"><input type="checkbox" v-model="cfg.rcon.enabled" />启用 RCON（用于权威在线玩家列表与无 stdin 依赖的命令通道）</label>
            <div class="grid grid-cols-3 gap-3">
              <label class="block"><div class="text-xs text-[var(--dim)]">主机</div><input v-model="cfg.rcon.host" class="input mono w-full mt-1" /></label>
              <label class="block"><div class="text-xs text-[var(--dim)]">端口</div><input type="number" v-model="cfg.rcon.port" class="input mono w-full mt-1" /></label>
              <label class="block"><div class="text-xs text-[var(--dim)]">密码{{ cfg.rcon.passwordSet ? '（留空保持不变）' : '' }}</div><input type="password" v-model="cfg.rcon.password" class="input mono w-full mt-1" autocomplete="new-password" /></label>
            </div>
            <div class="text-[11px] text-[var(--dim)] leading-relaxed">
              服务端需同时在 <code class="mono">server.properties</code> 里设
              <code class="mono">enable-rcon=true</code>、<code class="mono">rcon.password=…</code>、<code class="mono">rcon.port=25575</code>。
              「配置」页把 <code class="mono">rcon</code> 项设为 true 后，面板启动时会提示同步。
            </div>
          </section>
        </template>

        <!-- 监控 -->
        <template v-else-if="tab === 'monitor'">
          <section class="card p-4 space-y-3">
            <h3 class="text-sm font-semibold text-[var(--acc)]">指标采样</h3>
            <div class="grid grid-cols-2 gap-3">
              <label class="block"><div class="text-xs text-[var(--dim)]">采样间隔 (ms)</div><input type="number" v-model="cfg.monitor.intervalMs" class="input mono w-full mt-1" step="500" /></label>
              <label class="block"><div class="text-xs text-[var(--dim)]">历史点数（环形）</div><input type="number" v-model="cfg.monitor.history" class="input mono w-full mt-1" step="60" /></label>
              <label class="block">
                <div class="text-xs text-[var(--dim)]">磁盘/进程级 IO 采样器</div>
                <select v-model="cfg.monitor.diskSampler" class="input w-full mt-1">
                  <option value="auto">自动（PowerShell + CIM）</option>
                  <option value="powershell">强制启用</option>
                  <option value="off">关闭（最省内存）</option>
                </select>
              </label>
              <label class="block"><div class="text-xs text-[var(--dim)]">无人订阅后回收 (ms)</div><input type="number" v-model="cfg.monitor.samplerIdleMs" class="input mono w-full mt-1" step="10000" /></label>
            </div>
            <div class="text-[11px] text-[var(--dim)] leading-relaxed">
              采样器是一个常驻 PowerShell 子进程（约 30MB），只在有浏览器订阅时存活，空闲超时自动回收。
              选「关闭」后面板总内存可再降一档，代价是没有磁盘 IO 与 java 进程级 CPU/RSS。
            </div>
            <div class="text-[11px]">当前状态：
              <b :style="{ color: store.sampler.state === 'running' ? 'var(--ok)' : 'var(--warn)' }">{{ store.sampler.state }}</b>
              <span v-if="store.sampler.error" class="text-[var(--dim)]"> · {{ store.sampler.error }}</span>
            </div>
          </section>
        </template>

        <!-- 面板 -->
        <template v-else-if="tab === 'panel'">
          <section class="card p-4 space-y-3">
            <h3 class="text-sm font-semibold text-[var(--acc)]">监听与静态资源</h3>
            <div class="grid grid-cols-2 gap-3">
              <label class="block"><div class="text-xs text-[var(--dim)]">监听地址</div><input v-model="cfg.panel.host" class="input mono w-full mt-1" /></label>
              <label class="block"><div class="text-xs text-[var(--dim)]">端口</div><input type="number" v-model="cfg.panel.port" class="input mono w-full mt-1" /></label>
            </div>
            <label class="flex items-center gap-2 text-[13px]"><input type="checkbox" v-model="cfg.panel.serveStatic" />面板自身托管 web/dist（无 Nginx 时方便；生产建议交给 Nginx 并关闭）</label>
            <label class="flex items-center gap-2 text-[13px]"><input type="checkbox" v-model="cfg.panel.trustProxy" />信任 X-Forwarded-*（仅在请求来自回环地址时生效）</label>
            <div class="text-[11px] text-[var(--dim)] leading-relaxed">
              默认 <code class="mono">127.0.0.1:8787</code> 只监听回环 —— 公网暴露的唯一正确姿势是 Nginx 反代 + HTTPS。
              改成 <code class="mono">0.0.0.0</code> 前请确认防火墙规则，且务必先改强密码。
            </div>
            <div class="text-[11px] text-[var(--dim)]">改端口/监听地址需重启面板进程生效。</div>
          </section>
        </template>

        <!-- 安全 -->
        <template v-else-if="tab === 'security'">
          <section class="card p-4 space-y-3">
            <h3 class="text-sm font-semibold text-[var(--acc)]">账号</h3>
            <div class="grid grid-cols-3 gap-3">
              <label class="block"><div class="text-xs text-[var(--dim)]">登录用户名</div><input v-model="cfg.security.user" class="input w-full mt-1" /></label>
              <label class="block"><div class="text-xs text-[var(--dim)]">会话时长 (小时)</div><input type="number" v-model="cfg.security.tokenTtlHours" class="input mono w-full mt-1" /></label>
              <label class="block"><div class="text-xs text-[var(--dim)]">每分钟登录尝试上限</div><input type="number" v-model="cfg.security.loginMaxPerMin" class="input mono w-full mt-1" /></label>
            </div>
            <div class="text-[11px] text-[var(--dim)]">改用户名会立即让所有已签发 token 失效（等效全员踢出登录）。</div>
          </section>
          <section class="card p-4 space-y-3">
            <h3 class="text-sm font-semibold text-[var(--acc)]">修改密码</h3>
            <div class="grid grid-cols-2 gap-3">
              <input v-model="curPass" type="password" class="input" placeholder="当前密码" autocomplete="current-password" />
              <input v-model="newPass" type="password" class="input" placeholder="新密码（≥6 位）" autocomplete="new-password" />
            </div>
            <button class="btn btn-primary" @click="savePass" :disabled="store.busy.pw">更新密码</button>
            <div class="text-[11px] text-[var(--dim)]">密码以 scrypt(N=16384) 散列存于 data/credentials.json，明文不落盘、不进日志。</div>
          </section>
        </template>
      </div>
    </div>
  </div>
</template>
