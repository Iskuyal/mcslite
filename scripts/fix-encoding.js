'use strict';
/**
 * 交付脚本编码规范化（Windows 必需，不是洁癖）：
 *   · .ps1  → UTF-8 **with BOM** + CRLF。PowerShell 5.1 无 BOM 时按系统 ANSI(中文机 GBK)
 *             解码，中文注释会乱码并可能吞掉换行，连带注释掉下一行代码（实测踩过）。
 *   · .bat  → 纯 ASCII + CRLF。cmd 用 OEM 码页解析 .bat，UTF-8 中文不可靠，BOM 更会直接炸。
 *   · 其它  → 不动（nginx.conf 带 BOM 会让 nginx 报 unknown directive）。
 * 用法：node scripts/fix-encoding.js [--check]
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const check = process.argv.includes('--check');
const TARGETS = [['scripts/start.ps1', 'ps1'], ['scripts/install.ps1', 'ps1'], ['scripts/start.bat', 'bat']];
const BOM = '\uFEFF';
let changed = 0, bad = 0;

for (const [rel, kind] of TARGETS) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) { console.log(`跳过（不存在）：${rel}`); continue; }
  let text = fs.readFileSync(file, 'utf8');
  if (text.startsWith(BOM)) text = text.slice(1);
  const original = fs.readFileSync(file, 'utf8');

  const issues = [];
  if (!original.startsWith(BOM) && kind === 'ps1') issues.push('缺 BOM');
  if (!text.includes('\r\n')) issues.push('LF 而非 CRLF');
  if (kind === 'bat') {
    const nonAscii = [...text].filter((c) => c.codePointAt(0) > 0x7f);
    if (nonAscii.length) issues.push(`含 ${nonAscii.length} 个非 ASCII 字符`);
  }

  const out = (kind === 'ps1' ? BOM : '') + text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
  const needWrite = out !== fs.readFileSync(file, 'utf8');
  if (issues.length || needWrite) {
    bad += issues.length ? 1 : 0;
    console.log(`${check ? '[需修]' : '[已修]'} ${rel}  ${issues.join(' / ') || '格式'}`);
    if (!check && needWrite) { fs.writeFileSync(file, out); changed++; }
  } else {
    console.log(`[ OK ] ${rel}`);
  }
}
if (check && bad) { console.log(`\n${bad} 个文件需要规范化：node scripts/fix-encoding.js`); process.exit(1); }
console.log(check ? '' : `\n已重写 ${changed} 个文件`);
