'use strict';
/**
 * run.bat / start.sh 导入器。
 *
 * 为什么需要：NeoForge / Forge / Fabric 安装器生成的 run.bat 长这样
 *   "G:\Java\OpenJDK-25.03\bin\java.exe" -Xmx4G @libraries/net/neoforged/.../win_args.txt %* -nogui
 * 里面是 java 的 @argfile + `%*` + `pause`。面板绝不该 `shell:true` 去跑这个 bat
 * （那会把「网页上的一个输入框」变成任意命令执行），正确做法是把它**解析成 argv 数组**，
 * 然后仍然用 spawn(exe, argv, {shell:false}) 直起 java —— 少一层 cmd.exe，
 * 还顺带解决了 `pause` 让进程永远挂住、以及黑框弹窗的问题。
 *
 * 支持的写法：
 *   · 引号包裹的 java 绝对路径（含空格）        · -jar xxx.jar [程序参数]
 *   · @argfile（Java 自己展开，不需要 shell）    · user_jvm_args.txt 自动补 @
 *   · %* / %1 / $@ 之类的脚本占位符（剔除）      · set VAR=value 变量回填
 *   · 重定向 > log 2>&1 与 && || & 分句（剔除）
 */
const fs = require('node:fs');
const path = require('node:path');
const config = require('../lib/config');

const JAVA_TOKEN_RE = /(^|["'\s])(java|javaw|java\.exe|javaw\.exe)["'\s]/i;
const PLACEHOLDERS = new Set(['%*', '%1', '%2', '%~dp0', '$@', '"%~dp0"', '%~dp0']);

function stripNoise(tok) {
  return tok.replace(/^"|"$/g, '').replace(/^'|'$/g, '');
}

function cleanLine(line) {
  return line
    .replace(/^\s*@?(echo|rem|::|title|cd|setlocal|endlocal|if|for|goto|call\s+:)\b.*$/i, '')  // 纯脚本语句
    .replace(/\d*>&?\d+/g, ' ')                       // 2>&1 / >log
    .replace(/\|\|/g, ' ')
    .replace(/&&/g, ' ')
    .replace(/(\bgoto\b|^\s*pause\b).*$/i, ' ')
    .replace(/\bgoto\b.*$/i, ' ')
    .replace(/\\\s*$/gm, ' ')                         // 行尾续行
    .trim();
}

/** 把一行命令行切成 argv（引号感知），并剔除 shell 噪声 */
function splitCmd(line) {
  const out = [];
  let cur = '', q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === q) q = null; else cur += c; }
    else if (c === '"' || c === "'") { q = c; }
    else if (/\s/.test(c)) { if (cur) { out.push(cur); cur = ''; } }
    else if (c === '|' || c === '&') { if (cur) out.push(cur); cur = ''; }
    else cur += c;
  }
  if (cur) out.push(cur);
  return out.filter((t) => t && !PLACEHOLDERS.has(t) && !PLACEHOLDERS.has(t.toLowerCase()));
}

/**
 * @param {string} text bat/sh 正文
 * @param {object} [opts] { root, fileName }
 * @returns {{ok:boolean, patch:object, argv:string[], notes:string[], error?:string}}
 */
function parseRunScript(text, opts = {}) {
  const notes = [];
  const vars = {};
  const lines = String(text).split(/\r?\n/);

  // 先收集 set VAR=value，供 %VAR% 回填
  for (const raw of lines) {
    const m = /^\s*set\s+([A-Za-z_][\w]*)=(.*)$/i.exec(raw);
    if (m) vars[m[1].toUpperCase()] = m[2].trim().replace(/^"|"$/g, '');
  }
  const expand = (s) => s.replace(/%([A-Za-z_][\w]*)%/g, (_, k) => (vars[k.toUpperCase()] !== undefined ? vars[k.toUpperCase()] : ''));

  let best = null;
  for (const raw of lines) {
    const line = cleanLine(expand(raw));
    if (!line) continue;
    // 边界必须包含路径分隔符：真实脚本里是 "G:\Java\OpenJDK-25.03\bin\java.exe"，
    // java 前面是 \ 而不是空白，只按 ["'\s] 判会整行漏掉。
    if (!/(^|["'\s\\/])(java|javaw)(\.exe)?(["'\s]|$)/i.test(line)) continue;
    const argv = splitCmd(line);
    if (!argv.length) continue;
    if (!best || argv.length > best.length) best = argv;
  }
  if (!best) {
    return { ok: false, patch: {}, argv: [], notes, error: '没能在脚本里找到 java 调用行（请把启动命令手动填到「完全托管命令」）' };
  }

  const exe = stripNoise(best[0]);
  const rest = best.slice(1);

  const jvm = [], prog = [];
  let sawJar = false, sawArgfile = false, jarName = '';
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (t === '-jar') { sawJar = true; jarName = stripNoise(rest[++i] || ''); continue; }
    if (t.startsWith('@')) { sawArgfile = true; jvm.push(t); continue; }
    // -X*/-D*/-XX*/--add-*/-agentpath 属 JVM 参数；其余算程序参数
    if (/^(-X|-D|-agentlib|-agentpath|-javaagent|--add-|--enable-|--disable-|-verbose|-server|-client)/.test(t)) { jvm.push(t); continue; }
    prog.push(t);          // 其余原样保留：NeoForge 要 -nogui，vanilla 要 nogui，不做归一化
  }

  // 有 @win_args.txt 时，主类与 classpath 都在 argfile 里，绝不能再补 -jar
  if (sawJar && !jarName) { notes.push('脚本里有 -jar 但没跟上文件名，已忽略 -jar'); sawJar = false; }

  const root = opts.root || '';
  // user_jvm_args.txt 存在却未被引用 → 主动补上（安装器默认注释掉，用户往往改完内存就忘了）
  if (root && fs.existsSync(path.join(root, 'user_jvm_args.txt')) && !jvm.some((a) => /user_jvm_args/i.test(a))) {
    notes.push('检测到 user_jvm_args.txt 未被脚本引用，已自动加入 @user_jvm_args.txt');
    jvm.unshift('@user_jvm_args.txt');
  }

  const usesArgfile = sawArgfile;
  // 统一落成「完全托管命令」：语义与 run.bat 一致且不再依赖 cmd.exe
  const argv = [exe, ...jvm, ...(sawJar && !usesArgfile ? ['-jar', jarName] : []), ...prog];
  const patch = {
    server: {
      javaPath: exe,
      launcher: 'command',
      jvmArgs: jvm.join(' '),
      mcArgs: prog.join(' '),
      startCommand: argv.map(quoteArg).join(' '),
    },
  };
  if (sawJar && !usesArgfile && jarName) patch.server.jarName = path.basename(jarName);

  notes.push(usesArgfile
    ? '@argfile 由 java 自行展开（不经 shell），面板必须把工作目录设为实例根，相对路径才解得出'
    : '普通 -jar 启动，直接以 java 参数数组拉起');

  return { ok: true, patch, argv, notes, argfile: usesArgfile, jarName: jarName || null };
}

/** argv 里含空格的项加引号，保证「完全托管命令」可被 tokenize 原样还原 */
function quoteArg(t) {
  return /[\s"^']/.test(t) ? `"${t.replace(/"/g, '')}"` : t;
}

/** 自动在实例根里找常见启动脚本 */
function findScripts(root) {
  const CAND = ['run.bat', 'start.bat', 'win.bat', 'server.bat', 'run.sh', 'start.sh', 'win.sh', 'start_server.sh'];
  const out = [];
  for (const c of CAND) { try { if (fs.existsSync(path.join(root, c))) out.push(c); } catch { /* ignore */ } }
  return out;
}

function readScript(root, file) {
  const buf = fs.readFileSync(path.join(root, file));
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch { text = new TextDecoder('gbk').decode(buf); }        // 中文 Windows 上老脚本常是 ANSI/GBK 存的
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text;
}

module.exports = { parseRunScript, findScripts, readScript, splitCmd, cleanLine };
