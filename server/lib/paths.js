'use strict';
/**
 * 路径解析：同时兼容「源码运行」与「Node SEA 单文件运行」。
 * SEA 场景下 process.execPath 就是面板本体 exe，数据目录必须落在 exe 同级目录，
 * 而不是任何临时解包位置，否则重启丢配置。
 */
const path = require('node:path');
const fs = require('node:fs');

/** 是否以单文件 exe 运行：execPath 不是 node.exe，且同级找不到 server/index.js */
function detectSEA() {
  const exeName = path.basename(process.execPath || '').toLowerCase();
  if (exeName === 'node.exe' || exeName === 'node') return false;
  return !fs.existsSync(path.join(path.dirname(process.execPath), 'server', 'index.js'));
}

const SEA = detectSEA();

// 项目根：源码运行 = 仓库根；SEA 运行 = exe 所在目录
const ROOT = SEA ? path.dirname(process.execPath) : path.resolve(__dirname, '..', '..');
const DATA = process.env.MCSLITE_DATA || path.join(ROOT, 'data');
const WEB_DIST = path.join(ROOT, 'web', 'dist');
const LOGS = path.join(DATA, 'logs');

for (const d of [DATA, LOGS]) {
  try { fs.mkdirSync(d, { recursive: true }); } catch { /* 只读介质下忽略 */ }
}

module.exports = { ROOT, DATA, WEB_DIST, LOGS, SEA };
