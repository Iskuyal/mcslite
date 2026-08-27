'use strict';
/**
 * 核验远端仓库与本地 HEAD 是否逐文件等价（路径 + blob SHA + 模式），并扫描机密。
 * 为什么需要：git push 被网络阻断时我用 objects API 直推，"推成功了"不等于"推对了"，
 * 必须从远端读回来比对。
 * 用法：node scripts/gh-verify.mjs [--owner Iskuyal] [--repo mcslite] [--branch main]
 */
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const OWNER = opt('owner', 'Iskuyal'), REPO = opt('repo', 'mcslite'), BRANCH = opt('branch', 'main');

const git = (...a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 1 << 26 });
function token() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
}

async function api(path) {
  const r = await fetch('https://api.github.com' + path, {
    headers: { authorization: 'Bearer ' + token(), accept: 'application/vnd.github+json', 'user-agent': 'mcslite-gh-verify' },
  });
  if (!r.ok) throw new Error(`${path} → ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

/** 本地：递归列出 commit 里所有 blob（mode sha path）。
 *  必须关掉 core.quotepath —— 否则 git 把中文路径转义成 "\345\220…"，
 *  而 API 返回真实 UTF-8 名，集合比对会出现「本地独有 "\345…"」这种假阳性。
 *  （tree SHA 全等本身已足以证明文件集合一致：tree 哈希覆盖文件名与内容。） */
function localBlobs() {
  const out = [];
  const raw = execFileSync('git', ['-c', 'core.quotepath=false', 'ls-tree', '-r', 'HEAD'], { encoding: 'utf8', maxBuffer: 1 << 26 });
  for (const line of raw.split('\n').filter(Boolean)) {
    const [mode, type, sha, ...rest] = line.split(/\s+/);
    if (type === 'blob') out.push({ mode, sha, path: rest.join(' ') });
  }
  return out;
}

(async () => {
  const meta = await api(`/repos/${OWNER}/${REPO}`);
  const head = await api(`/repos/${OWNER}/${REPO}/commits/${encodeURIComponent(BRANCH)}`);
  const remoteTree = await api(`/repos/${OWNER}/${REPO}/git/trees/${head.sha}?recursive=1`);
  const remote = remoteTree.tree.filter((t) => t.type === 'blob').map((t) => ({ mode: t.mode, sha: t.sha, path: t.path }));
  const local = localBlobs();

  console.log(`仓库 ${meta.full_name}  visibility=${meta.visibility}  default=${meta.default_branch}`);
  console.log(`远端 ${BRANCH} HEAD=${head.sha}  tree=${head.commit.tree.sha}`);
  console.log(`本地 HEAD=${git('rev-parse', 'HEAD').trim()}`);
  console.log(`blob 数：远端 ${remote.length} / 本地 ${local.length}`);

  const L = new Map(local.map((b) => [b.path, b]));
  const R = new Map(remote.map((b) => [b.path, b]));
  const missing = [...L.keys()].filter((p) => !R.has(p));
  const extra = [...R.keys()].filter((p) => !L.has(p));
  const differ = [...L.keys()].filter((p) => R.has(p) && R.get(p).sha !== L.get(p).sha);

  // 机密与体积红线
  const SECRET_RE = /(^|\/)(credentials\.json|secret\.key|settings\.json|\.env)\b|\.db(-wal|-shm)?$/i;
  const DEP_RE = /(^|\/)node_modules\//;
  const secrets = [...R.keys()].filter((p) => SECRET_RE.test(p));
  const deps = [...R.keys()].filter((p) => DEP_RE.test(p));

  let ok = true;
  const say = (label, bad, detail) => { if (bad) ok = false; console.log(`  ${bad ? '✘' : '✔'} ${label}${detail ? '：' + detail : ''}`); };

  console.log('\n比对结果');
  say('文件集合一致', missing.length || extra.length, [missing.length ? `本地独有 ${missing.slice(0, 5).join(',')}` : '', extra.length ? `远端独有 ${extra.slice(0, 5).join(',')}` : ''].filter(Boolean).join(' | '));
  say('每个文件 blob SHA 一致', differ.length, differ.slice(0, 6).join(', '));
  say('无凭据/密钥/运行期数据入库', secrets.length, secrets.join(', '));
  say('无 node_modules 入库', deps.length, deps.slice(0, 3).join(', '));
  say('tree 一致', head.commit.tree.sha !== git('rev-parse', 'HEAD^{tree}').trim(),
      `远端 ${head.commit.tree.sha.slice(0, 8)} vs 本地 ${git('rev-parse', 'HEAD^{tree}').trim().slice(0, 8)}`);
  // trees API 不返回 blob size，体积以本地索引为准（远端内容已逐 SHA 比对过，等价即可信）
  const totalKB = local.reduce((a, b) => a + Number(execFileSync('git', ['cat-file', '-s', b.sha], { encoding: 'utf8' }).trim()), 0) / 1024;
  console.log(`  · 内容总量约 ${totalKB.toFixed(0)} KB（${local.length} 个文件，按本地索引统计）`);

  console.log(ok ? '\n✔ 远端与本地逐文件等价，且无机密泄漏' : '\n✗ 存在差异，见上');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('核验失败：', e.message); process.exit(1); });
