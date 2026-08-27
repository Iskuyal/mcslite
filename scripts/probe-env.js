'use strict';
/**
 * 环境探测（供 deploy.ps1 / install.ps1 调用）。
 *
 * 为什么单独成文件而不是在 .ps1 里写 `node -e "…"`：
 * PowerShell 5.1 向原生命令拼命令行时，会**吃掉参数里的双引号** ——
 * `node -e 'try{require("node:sqlite")}…'` 到 node 手里变成 `require(node:sqlite)`，
 * 语法报错 → 探测误判为「不支持」。（实测踩过：明明可用的 node:sqlite 被报成不可用。）
 * 把探测逻辑放进 JS 文件，PS 只传一个文件路径，整个引号地雷区就不存在了。
 *
 * 输出为 key=value 行，恒以 exit 0 结束（失败由调用方按字段判断，不用退出码传歧义）。
 */
const out = [];
const yesno = (b) => (b ? 'yes' : 'no');

out.push('node=' + process.version);
out.push('major=' + Number(process.versions.node.split('.')[0]));
out.push('arch=' + process.arch);
out.push('platform=' + process.platform + ' ' + require('node:os').release());

// node:sqlite（Node ≥22.5；缺失时面板会自动降级 JSONL，不是致命项）
let sqlite = false, sqliteErr = '';
try { const m = require('node:sqlite'); sqlite = typeof m.DatabaseSync === 'function'; }
catch (e) { sqliteErr = e.code || e.message; }
out.push('sqlite=' + yesno(sqlite));
if (sqliteErr) out.push('sqlite_err=' + sqliteErr.replace(/[\r\n]+/g, ' ').slice(0, 80));

// full-ICU + GBK 解码能力（中文 Windows 上解码 GBK 日志的关键）
let gbk = false, gbkErr = '';
try { gbk = new TextDecoder('gbk').decode(Buffer.from([0xd6, 0xd0, 0xce, 0xc4])) === '中文'; }
catch (e) { gbkErr = e.message; }
out.push('icu_gbk=' + yesno(gbk));
if (gbkErr) out.push('icu_err=' + gbkErr.slice(0, 80));
out.push('icu_small=' + yesno(!!process.config.variables.icu_small));

// 反向能力：Node 没有 GBK 编码器（面板写文件时要知道）
let gbkEncode = false;
try { gbkEncode = Buffer.from('中文', 'gbk').length === 4; } catch { gbkEncode = false; }
out.push('gbk_encode=' + yesno(gbkEncode));

// 流式 API 面（面板用到 statfs / memoryUsage.rss / structuredClone）
out.push('statfs=' + yesno(typeof require('node:fs').statfsSync === 'function'));
out.push('mem_usage_rss=' + yesno(typeof process.memoryUsage.rss === 'function'));

// Java 探测也放这儿：PS 里写 java 版本正则容易踩引号与转义，不如一次做完。
// 传 --java <path> 可只探单个路径；不传则不探测（由 PS 侧决定候选）。
const ji = process.argv.indexOf('--java');
if (ji >= 0 && process.argv[ji + 1]) {
  const jpath = process.argv[ji + 1];
  try {
    const { spawnSync } = require('node:child_process');
    // ⚠ 关键：`java -version` 把版本写在 **stderr**，stdout 是空的。
    // 用 execFileSync 拿返回值只会得到空串且**不抛异常** —— 于是探测静默失败、
    // 误判成"读不到版本"，最后挑中 PATH 上的 Java 8 壳。必须合并两路输出。
    const r = spawnSync(jpath, ['-version'], { encoding: 'utf8', timeout: 15000 });
    if (r.error) throw r.error;
    const all = [r.stdout, r.stderr].filter(Boolean).join('\n');
    const m = /version "(\d+)(?:\.(\d+))?/.exec(all);
    let maj = 0;
    if (m) { maj = +m[1]; if (maj === 1 && m[2]) maj = +m[2]; }
    out.push('java_ok=' + yesno(maj > 0));
    out.push('java_major=' + maj);
    out.push('java_line=' + ((all.split(/\r?\n/).find((l) => /version/.test(l)) || '') ).slice(0, 90));
  } catch (e) {
    out.push('java_ok=no');
    out.push('java_major=0');
    out.push('java_err=' + String(e.message || e.code || e).replace(/[\r\n]+/g, ' ').slice(0, 90));
  }
}

console.log(out.join('\n'));
