'use strict';
/**
 * 打成单个 .exe —— 走 Node 官方 SEA（Single Executable Applications），不用 pkg/nexe。
 *
 * 【为什么是 SEA 而不是 pkg / nexe】
 *  · pkg：最后 release 停在 Node 18 时代，Node 24 的 V8/undici 直接打不动，已实质停维护。
 *  · nexe：要现场下载并编译对应版本 Node，依赖 Python + VS 工具链 —— Server 2016 上正是雷区。
 *  · SEA：Node 22+ 官方能力，拿本机 node.exe 注入一段 blob，无第三方运行时、无杀软黑名单特征。
 *
 * 【SEA 的两个硬限制（必须知道）】
 *  1) 只内嵌「单个入口脚本」：require 相对文件会失败 → 所以先用 esbuild 把零依赖后端打成 1 个 cjs。
 *     （本面板后端 0 第三方依赖，bundle 后 ~140KB，非常干净）
 *  2) exe 不能再 spawn 自身当子进程；且前端 dist 不内嵌在 exe 里（用 --embed-assets 可内嵌，
 *     但自注入资源的 exe 更容易被 AV 误杀，默认关闭）。
 *
 * 用法：
 *   node scripts/sea-build.js            → build/MCSLite.exe（+ 同级 web/dist）
 *   node scripts/sea-build.js --clean
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const BUILD = path.join(ROOT, 'build');
const ENTRY = path.join(ROOT, 'server', 'index.js');
const EXE_NAME = process.platform === 'win32' ? 'MCSLite.exe' : 'mcslite';

function findNode(name) {
  // 关键技巧：前端 npm install 已经带进 esbuild，直接复用，不再额外装依赖
  const cands = [
    path.join(ROOT, 'web', 'node_modules', name),
    path.join(ROOT, 'node_modules', name),
    path.join(ROOT, 'node_modules', '.pnpm'),
  ];
  for (const c of cands) {
    if (fs.existsSync(path.join(c, 'package.json'))) return c;
  }
  try { return require.resolve(name, { paths: [path.join(ROOT, 'web'), ROOT] }); } catch { /* 未安装 */ }
  // pnpm 结构下再找一层
  const pnpm = path.join(ROOT, 'node_modules', '.pnpm');
  if (fs.existsSync(pnpm)) {
    for (const d of fs.readdirSync(pnpm)) if (d.startsWith(name.replace('@', '').split('/')[0] + '@')) {
      const p = path.join(pnpm, d, 'node_modules', name);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

function main() {
  const clean = process.argv.includes('--clean');
  console.log('── MCSLite 单文件打包（Node SEA）──');
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj < 20) { console.error(`需要 Node ≥20（SEA 能力），当前 ${process.version}`); process.exit(1); }
  console.log(`  本机 Node ${process.version}，入口 ${path.relative(ROOT, ENTRY)}`);

  if (clean && fs.existsSync(BUILD)) { fs.rmSync(BUILD, { recursive: true, force: true }); console.log('  已清空 build/'); }
  fs.mkdirSync(BUILD, { recursive: true });

  // 1) 用 esbuild 把零依赖后端打成单文件 CJS
  const esbuildDir = findNode('esbuild');
  if (!esbuildDir) {
    console.error('  ✗ 未找到 esbuild。先执行：cd web && npm install（前端构建链自带 esbuild）');
    console.error('    或：npm i -D esbuild');
    process.exit(1);
  }
  const esbuild = require(esbuildDir);
  const bundlePath = path.join(BUILD, 'mcslite.bundle.cjs');
  const r = esbuild.buildSync({
    entryPoints: [ENTRY],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: `node${maj}.0`,
    outfile: bundlePath,
    minify: false,
    // SEA 内没有 __filename 对应的真实磁盘路径，业务代码统一用 process.execPath 推导数据目录
    define: { 'process.env.MCSLITE_BUNDLED': '"1"' },
    legalComments: 'none',
    logLevel: 'warning',
  });
  const kb = (fs.statSync(bundlePath).size / 1024).toFixed(0);
  console.log(`  ✓ 后端打包为单文件 CJS：${kb} KB`);

  // 2) 生成 sea-config 并注入 blob
  const configPath = path.join(BUILD, 'sea-config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    main: path.relative(ROOT, bundlePath).replace(/\\/g, '/'),
    output: 'build/sea-prep.blob',
    disableExperimentalSEAWarning: true,
    // 把内存上限直接烘进 exe：分发到任何机器都不会因为默认堆策略波动
    execArgv: ['--max-old-space-size=96', '--no-warnings'],
    useSnapshot: false,       // 快照会让 fs/child_process 状态固化，面板这类 IO 重的程序别开
    useFork: false,
  }, null, 2));
  console.log('  ✓ sea-config.json（execArgv 已烘入 96MB 堆上限）');

  const out = path.join(BUILD, 'sea-prep.blob');
  try {
    execFileSync(process.execPath, ['--experimental-sea-config', configPath], { cwd: ROOT, stdio: 'inherit' });
  } catch { console.error('  ✗ 生成 blob 失败（确认 Node ≥20 且未被组策略限制）'); process.exit(1); }
  console.log(`  ✓ sea-prep.blob ${((fs.statSync(out).size) / 1024).toFixed(0)} KB`);

  // 3) 复制本机 node.exe → MCSLite.exe
  const exe = path.join(BUILD, EXE_NAME);
  fs.copyFileSync(process.execPath, exe);
  console.log(`  ✓ 复制运行时 → ${EXE_NAME}（${(fs.statSync(exe).size / 1048576).toFixed(1)} MB）`);

  // 4) postject 注入（Windows 需要先用 Remove-Item 清签名，脚本已带）
  const postject = findNode('postject');
  if (postject) {
    try {
      execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['--yes', 'postject', exe, 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2', out],
        { cwd: ROOT, stdio: 'inherit' });
      console.log('  ✓ 已注入');
    } catch (e) { console.error('  ✗ postject 失败：', e.message); }
  } else {
    console.log('');
    console.log('  下一步（本机未装 postject，请手动执行一次）：');
    console.log(`    npx --yes postject "${exe}" NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 "${out}"`);
    if (process.platform === 'win32') {
      console.log('');
      console.log('  Windows 上若提示签名问题，先执行：');
      console.log(`    Remove-Item -LiteralPath "${exe}" -Stream * -ErrorAction SilentlyContinue`);
    }
  }

  // 5) 组一个可直接分发的目录
  const distDir = path.join(BUILD, 'dist');
  fs.mkdirSync(path.join(distDir, 'web'), { recursive: true });
  try { fs.rmSync(path.join(distDir, EXE_NAME), { force: true }); } catch { /* 首次 */ }
  if (fs.existsSync(exe)) fs.copyFileSync(exe, path.join(distDir, EXE_NAME));
  const webDist = path.join(ROOT, 'web', 'dist');
  if (fs.existsSync(webDist)) {
    fs.rmSync(path.join(distDir, 'web', 'dist'), { recursive: true, force: true });
    fs.cpSync(webDist, path.join(distDir, 'web', 'dist'), { recursive: true });
    console.log('  ✓ 已附带 web/dist（前端静态资源）');
  } else {
    console.log('  ⚠ 未发现 web/dist：先执行 cd web && npm run build，否则 exe 起来只有 API 没有界面');
  }
  console.log('');
  console.log(`产物：${path.join(distDir, EXE_NAME)}`);
  console.log('分发时把整个 build/dist 目录拷走即可（exe + web/dist + 自动生成的 data/）。');
  console.log('数据目录在 exe 同级 data/（settings.json / credentials.json / mcslite.db / logs/）。');
}

main();
