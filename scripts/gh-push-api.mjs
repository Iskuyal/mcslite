'use strict';
/**
 * 通过 GitHub REST API 直接推送一个已存在的本地 commit。
 *
 * 用途：本机 git-over-HTTPS（github.com 的 git-upload-pack 通道）被网络重置，
 * 而 api.github.com 通道可用（gh 建仓库成功即为证明）。这时不必反复赌运气重试 push，
 * 直接走 objects API 把同一个提交搬上去。
 *
 * 等价性保证：内容取自 git 对象库（`git cat-file`），即索引规范化后的字节 —— 与本地
 * 仓库保存的完全一致；推送完成后比对远端 tree SHA 与本地 tree SHA，不同就是没推对。
 *
 * 用法：node scripts/gh-push-api.mjs [--owner Iskuyal] [--repo mcslite] [--branch main]
 * 依赖：gh CLI 已登录（用 `gh auth token` 取凭据），或环境变量 GITHUB_TOKEN。
 */
import { execFileSync } from 'node:child_process';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const OWNER = opt('owner', 'Iskuyal');
const REPO = opt('repo', 'mcslite');
const BRANCH = opt('branch', 'main');
const git = (...a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 1 << 26 }).trim();
const gitBin = (...a) => execFileSync('git', a, { maxBuffer: 1 << 26, encoding: 'buffer' });

function token() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try { return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim(); }
  catch { throw new Error('取不到凭据：请 gh auth login 或设 GITHUB_TOKEN'); }
}

const TK = token();
async function api(method, path, body) {
  const res = await fetch('https://api.github.com' + path, {
    method,
    headers: {
      'authorization': 'Bearer ' + TK,
      'accept': 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'mcslite-gh-push',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw Object.assign(new Error(`${method} ${path} → ${res.status} ${text.slice(0, 400)}`), { status: res.status });
  return text ? JSON.parse(text) : null;
}

/** 只有 404 才等于「不存在」。其它错误必须冒出来 ——
 *  上一版这里用 .catch(()=>null) 把 403/限流/网络错误一并当成「分支不存在」，
 *  导致脚本对着一个已有历史的仓库报「远端没有 main」，属于典型的静默掩盖故障。 */
async function apiOrNull(method, path, body) {
  try { return await api(method, path, body); }
  catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

(async () => {
  const head = git('rev-parse', 'HEAD');
  const localTree = git('rev-parse', 'HEAD^{tree}');
  const message = git('log', '-1', '--pretty=%B');
  const author = git('log', '-1', '--pretty=%an%x1f%ae%x1f%aI');
  const committer = git('log', '-1', '--pretty=%cn%x1f%ce%x1f%cI');
  const [an, ae, ad] = author.split('\u001f');
  const [cn, ce, cd] = committer.split('\u001f');

  // ls-tree -r 给出所有叶子 blob：mode, type, sha, path（路径可能含空格 → 按前 3 段切）
  const rows = git('ls-tree', '-r', 'HEAD').split('\n').filter(Boolean).map((l) => {
    const [mode, type, sha, ...rest] = l.split(/\s+/);
    return { mode, type, sha, path: rest.join(' ') };
  });
  console.log(`本地 HEAD=${head.slice(0, 8)} tree=${localTree.slice(0, 8)} 文件 ${rows.length} 个`);

  const repo = `/repos/${OWNER}/${REPO}`;
  const info = await api('GET', repo);
  const remoteRef = await apiOrNull('GET', `${repo}/git/ref/heads/${BRANCH}`);
  const remoteSha = remoteRef ? remoteRef.object.sha : null;
  console.log(`目标仓库 ${info.full_name} visibility=${info.visibility} 远端 ${BRANCH}=${remoteSha ? remoteSha.slice(0, 8) : '(不存在)'}`);

  // 父提交：根提交 parents=[]；否则必须挂在远端 HEAD 上（远端与本地父不一致时中止，避免孤儿提交）
  let parents = [];
  const localParent = (() => { try { return git('rev-parse', 'HEAD^'); } catch { return null; } })();
  if (localParent) {
    if (!remoteSha) { console.error(`本地不是根提交（父=${localParent.slice(0, 8)}）但远端没有 ${BRANCH}，中止`); process.exit(2); }
    if (localParent !== remoteSha) {
      // SHA 不同不代表内容不同：API 重建 commit 对象时会归一化字节，导致同一个 tree 得到不同 commit SHA。
      // 真正的判据是 tree —— 本地父的 tree == 远端 HEAD 的 tree，就是内容等价，可安全快进。
      const localParentTree = git('rev-parse', localParent + '^{tree}');
      const remoteCommit = await apiOrNull('GET', `${repo}/git/commits/${remoteSha}`);
      if (remoteCommit.tree && remoteCommit.tree.sha === localParentTree) {
        console.log(`远端 ${BRANCH} 的 SHA 与本地父不同，但 tree 等价（${localParentTree.slice(0, 8)}）→ 按快进处理`);
      } else {
        console.error(`远端 HEAD(${remoteSha.slice(0, 8)}, tree=${remoteCommit.tree && remoteCommit.tree.sha.slice(0, 8)}) 与本地父(${localParent.slice(0, 8)}, tree=${localParentTree.slice(0, 8)}) 内容不一致 —— 先 pull/rebase，或显式 --no-empty-guard 覆盖`);
        if (!argv.includes('--no-empty-guard')) process.exit(2);
        console.warn('已按 --no-empty-guard 覆盖远端历史');
      }
    }
    parents = [remoteSha];
  } else if (remoteSha && !argv.includes('--no-empty-guard')) {
    console.warn('本地是根提交但远端已有分支；按快进处理');
    parents = [remoteSha];
  }

  // 1) 建 tree：文本用 content 内联（一次调用搞定），二进制退回 base64 blob 预传
  const entries = [];
  let inlined = 0, uploaded = 0;
  for (const r of rows) {
    const buf = gitBin('cat-file', 'blob', r.sha);
    const isText = !buf.includes(0) && looksLikeUtf8(buf);
    if (isText) {
      entries.push({ path: r.path, mode: r.mode, type: 'blob', content: buf.toString('utf8') });
      inlined++;
    } else {
      const b = await api('POST', `${repo}/git/blobs`, { content: buf.toString('base64'), encoding: 'base64' });
      entries.push({ path: r.path, mode: r.mode, type: 'blob', sha: b.sha });
      uploaded++;
    }
  }
  console.log(`tree 条目：内联文本 ${inlined}，base64 上传 ${uploaded}`);

  const tree = await api('POST', `${repo}/git/trees`, { tree: entries });
  console.log(`远端 tree=${tree.sha.slice(0, 8)}  本地 tree=${localTree.slice(0, 8)}  ${tree.sha === localTree ? '✔ 逐字节等价' : '✘ 不一致！'}`);
  if (tree.sha !== localTree) {
    console.error('tree 不一致，多半是行尾/编码规范化差异。已中止，不创建错误提交。');
    process.exit(3);
  }

  // 2) 建 commit（复用本地作者/提交者/时间戳/消息 → 理想情况下连 commit SHA 都一致）
  const commit = await api('POST', `${repo}/git/commits`, {
    message, tree: tree.sha, parents,
    author: { name: an, email: ae, date: ad },
    committer: { name: cn, email: ce, date: cd },
  });
  console.log(`parents=[${parents.map((p) => p.slice(0, 8)).join(',')}]  远端 commit=${commit.sha.slice(0, 8)}  本地 HEAD=${head.slice(0, 8)}  ${commit.sha === head ? '✔ 提交号一致' : '（提交号不同，内容等价即可）'}`);

  // 3) 建/移分支引用
  const existing = await apiOrNull('GET', `${repo}/git/ref/heads/${BRANCH}`);
  if (existing) {
    await api('PATCH', `${repo}/git/refs/heads/${BRANCH}`, { sha: commit.sha, force: true });
    console.log(`已更新分支 ${BRANCH}`);
  } else {
    await api('POST', `${repo}/git/refs`, { ref: `refs/heads/${BRANCH}`, sha: commit.sha });
    console.log(`已创建分支 ${BRANCH}`);
  }

  // 4) 收尾：默认分支名可能不是 main（新仓库默认可能叫 master）
  const meta = await api('PATCH', repo, { name: REPO });
  if (meta.default_branch !== BRANCH) {
    await api('PATCH', repo, { default_branch: BRANCH });
    console.log(`默认分支已切到 ${BRANCH}`);
  } else {
    console.log(`默认分支即 ${BRANCH}`);
  }
  console.log(`\n完成 → ${info.html_url}`);
  console.log('提示：git push 通道仍被网络阻断，后续提交可再跑本脚本，或配好代理/SSH 后正常 push。');
})().catch((e) => { console.error('失败：', e.message); process.exit(1); });

function looksLikeUtf8(buf) {
  try { new TextDecoder('utf-8', { fatal: true }).decode(buf); return true; }
  catch { return false; }
}
