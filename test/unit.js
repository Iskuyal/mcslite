'use strict';
/**
 * 纯函数单元测试：日志前缀解析 / ANSI 渲染 / 编码嗅探 / 命令分词 / 玩家名提取。
 * 用例全部取自真实服务端日志样本（vanilla + NeoForge 1.21.1 + Log4j2 中文本地化）。
 * 用法：node test/unit.js
 */
const { stripPrefix, ansiToHtml, detectLevel, stripAnsi } = require('../server/lib/ansi');
const { StreamDecoder } = require('../server/lib/decode');
const config = require('../server/lib/config');
const { parseList } = require('../server/mc/rcon');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name}\n      ${e.message}`); }
}

console.log('\n—— stripPrefix：真实服务端日志格式 ——');
const CASES = [
  ['[278月2026 23:42:26.189] [main/INFO] [cpw.mods.modlauncher.Launcher/MODLAUNCHER]: ModLauncher running: args [--launchTarget, forgeserver]', 'main', 'info', 'ModLauncher running: args [--launchTarget, forgeserver]'],
  ['[278月2026 23:42:29.001] [Server thread/INFO] [minecraft/MinecraftServer]: Done (27.915s)! For help, type "help"', 'Server thread', 'info', 'Done (27.915s)! For help, type "help"'],
  ['[278月2026 23:42:29.500] [Server thread/WARN] [minecraft/MinecraftServer]: Can\'t keep up! Is the server overloaded?', 'Server thread', 'warn', 'Can\'t keep up! Is the server overloaded?'],
  ['[278月2026 23:43:01.120] [Server thread/ERROR] [ne.mi.ev.EventBus/EVENTBUS]: Exception caught during firing event', 'Server thread', 'error', 'Exception caught during firing event'],
  ['[12:00:01] [Server thread/INFO]: Done (3.2s)! For help, type "help"', 'Server thread', 'info', 'Done (3.2s)! For help, type "help"'],
  ['[12:00:01] [Worker-Main-4/DEBUG] [Foo/BAR]: trace noise', 'Worker-Main-4', 'debug', 'trace noise'],
];
for (const [line, thread, level, rest] of CASES) {
  t(thread + ' / ' + level, () => {
    const r = stripPrefix(line);
    assert.ok(r, '未识别为前缀');
    assert.strictEqual(r.level, level.toUpperCase());
    assert.strictEqual(r.rest, rest);
    assert.ok(r.time && /^\d{2}:\d{2}:\d{2}$/.test(r.time), 'time 应为 HH:MM:SS，实得 ' + r.time);
  });
}
t('聊天/普通方括号行不被误剥', () => {
  const r = stripPrefix('[Server] 广播一条消息');
  assert.strictEqual(r, null);
  const c = stripPrefix('[CHAT] something');
  assert.strictEqual(c, null);
});
t('NeoForge 多段前缀的时间抽取（中文月份串）', () => {
  const r = stripPrefix('[278月2026 23:42:26.189] [main/INFO] [a/b]: x');
  assert.strictEqual(r.time, '23:42:26');
});

console.log('\n—— detectLevel 兜底（无前缀行）——');
t('异常栈 → error', () => assert.strictEqual(detectLevel('java.lang.IllegalStateException: foo'), 'error'));
t('\tat 帧 → error', () => assert.strictEqual(detectLevel('\tat net.minecraft.X.y(X.java:1)'), 'error'));
t('WARN → warn', () => assert.strictEqual(detectLevel('[Server thread/WARN]: hmm'), 'warn'));

console.log('\n—— ANSI / § 渲染 ——');
t('SGR 前景色 → class', () => assert.strictEqual(ansiToHtml('\x1b[32mgreen\x1b[0m'), '<span class="c fg">green</span>'));
t('加粗+颜色组合', () => assert.ok(/bold/.test(ansiToHtml('\x1b[1m\x1b[31mX\x1b[0m'))));
t('256 色近似到 16 色', () => assert.strictEqual(ansiToHtml('\x1b[38;5;196mX\x1b[0m'), '<span class="c fr">X</span>'));
t('真彩近似', () => assert.strictEqual(ansiToHtml('\x1b[38;2;255;0;0mX\x1b[0m'), '<span class="c fr">X</span>'));
t('§传统码（MC §a 是亮绿，映射到 ANSI 亮色）', () => assert.strictEqual(ansiToHtml('§a绿§l粗'), '<span class="c fG">绿</span><span class="c fG bold">粗</span>'));
t('HTML 注入被转义', () => {
  const h = ansiToHtml('<img src=x onerror=alert(1)>');
  assert.ok(!/<img/.test(h) && /&lt;img/.test(h), h);
});
t('光标移动等非 SGR 序列被丢弃', () => {
  assert.strictEqual(ansiToHtml('a\x1b[2Kb'), 'ab');
  assert.strictEqual(ansiToHtml('a\x1b[?25lb'), 'ab');
});
t('无颜色行零开销直出', () => assert.strictEqual(ansiToHtml('普通中文 abc'), '普通中文 abc'));
t('stripAnsi 供名字解析', () => assert.strictEqual(stripAnsi('\x1b[32mSteve[/1.2.3.4:5] logged in\x1b[0m'), 'Steve[/1.2.3.4:5] logged in'));
t('未闭合色码在行尾自然收尾', () => {
  const h = ansiToHtml('\x1b[31m红');
  assert.ok(h.startsWith('<span') && h.endsWith('</span>'), h);
});
t('30000 字符超长行不炸（有界）', () => {
  const h = ansiToHtml('x'.repeat(30000));
  assert.strictEqual(h.length, 30000);
});

console.log('\n—— StreamDecoder：中文 Windows 编码坑 ——');
// 注意：Node 没有 GBK「编码器」（Buffer.from(s,'gbk') 会抛 Unknown encoding），
// 只有 TextDecoder 支持 GBK「解码」。测试里必须写字面 GBK 字节。
const GBK_ZHONGWEN = [0xd6, 0xd0, 0xce, 0xc4];           // 中文
const GBK_FUWU = [0xb7, 0xfe, 0xce, 0xf1];               // 服务
const GBK_NIHAO = [0xc4, 0xe3, 0xba, 0xc3];              // 你好
const GBK_CEISHI = [0xb2, 0xe2, 0xca, 0xd4];             // 测试

t('纯 ASCII 必须立刻输出（旧实现在此扣住整段，直到攒满 64KB 才吐一个字符 —— 面板卡死的根因）', () => {
  const d = new StreamDecoder('auto');
  const line = '[17:36:54] [Server thread/INFO] [minecraft/DedicatedServer]: Done (13.206s)! For help, type "help"\n';
  assert.strictEqual(d.push(Buffer.from(line, 'utf8')), line);
  assert.strictEqual(d.encoding, 'pending', '纯 ASCII 判不出编码很正常，但绝不能因此扣着不发');
});
t('真实 Forge 1.20.1 启动字节流分 137B 小块回放：字节级守恒、顺序不乱、零 U+FFFD', () => {
  const raw = fs.readFileSync(path.join(__dirname, 'fixtures', 'forge-1.20.1-boot.txt'));
  assert.ok(!raw.some((b) => b > 0x7f), 'fixture 必须保持全 ASCII（这条用例的全部意义）');
  const d = new StreamDecoder('auto');
  let acc = '';
  for (let i = 0; i < raw.length; i += 137) acc += d.push(raw.subarray(i, Math.min(i + 137, raw.length)));
  acc += d.end();
  assert.strictEqual(acc, raw.toString('utf8'));
  assert.ok(!acc.includes('\uFFFD'));
});
t('纯 ASCII 段先发不重复；后续 GBK 行才定案', () => {
  const d = new StreamDecoder('auto');
  assert.strictEqual(d.push(Buffer.from('hello world', 'utf8')), 'hello world');   // 先发，不缓存
  assert.strictEqual(d.push(Buffer.from([...GBK_NIHAO, 0x0a])), '你好\n', '整行样本才判定');
  assert.strictEqual(d.encoding, 'gbk');
  assert.strictEqual(d.push(Buffer.from(GBK_CEISHI)), '测试');                       // 定案后按 GBK 解
});
t('半个多字节字符被切断：只缓存该行，不产生 U+FFFD 也不乱序', () => {
  const full = Buffer.from('前面 中文尾巴\n', 'utf8');
  const d = new StreamDecoder('auto');
  let out = '';
  for (let i = 0; i < full.length; i += 3) out += d.push(full.subarray(i, Math.min(i + 3, full.length)));
  out += d.end();
  assert.strictEqual(out, '前面 中文尾巴\n');
  assert.ok(!out.includes('\uFFFD'), out);
});
t('无换行的 GBK 长行也要收口（缓存有上限，不许无限攒）', () => {
  const d = new StreamDecoder('auto');
  let out = '';
  const unit = Buffer.from([...GBK_ZHONGWEN, ...GBK_CEISHI]);   // 中文测试（8 字节 GBK）
  for (let i = 0; i < 20000; i++) out += d.push(unit);
  assert.ok(out.length > 10000, `缓存到上限后必须继续吐字，实得 ${out.length}`);
  assert.ok(d.encoding === 'gbk' || d.encoding === 'utf-8', '最终一定要定案');
});
t('GBK 字节流自动判定并正确解码', () => {
  const d = new StreamDecoder('auto');
  const s = d.push(Buffer.from(GBK_ZHONGWEN)) + d.push(Buffer.from(GBK_FUWU)) + d.end();
  assert.strictEqual(s, '中文服务');
  assert.strictEqual(d.encoding, 'gbk');
});
t('UTF-8 中文自动判定', () => {
  const d = new StreamDecoder('auto');
  const s = d.push(Buffer.from('中文', 'utf8'));
  assert.strictEqual(s, '中文');
  assert.strictEqual(d.encoding, 'utf-8');
});
t('多字节被 TCP 包切碎也能拼回', () => {
  const d = new StreamDecoder('gbk');
  const b = Buffer.from([...GBK_ZHONGWEN, ...GBK_CEISHI]);
  let out = '';
  for (const byte of b) out += d.push(Buffer.from([byte]));
  assert.strictEqual(out, '中文测试');
});
t('服务端中文日志（GBK 字节）完整解码', () => {
  const g = new StreamDecoder('gbk');
  const bytes = Buffer.concat([Buffer.from('[Server thread/INFO] [minecraft/MinecraftServer]: '), Buffer.from(GBK_ZHONGWEN), Buffer.from(GBK_CEISHI)]);
  assert.strictEqual(g.push(bytes) + g.end(), '[Server thread/INFO] [minecraft/MinecraftServer]: 中文测试');
});
t('非法字节产生 U+FFFD 而非抛异常', () => {
  const d = new StreamDecoder('utf-8');
  assert.ok(typeof d.push(Buffer.from([0xff, 0xfe, 0x41])) === 'string');
});

console.log('\n—— tokenize：含空格路径的安全分词（不过 shell）——');
t('带空格可执行路径', () => assert.deepStrictEqual(
  config.tokenize('"G:\\Java\\OpenJDK 25.03\\bin\\java.exe" -Xmx4G @libraries/a/win_args.txt -nogui'),
  ['G:\\Java\\OpenJDK 25.03\\bin\\java.exe', '-Xmx4G', '@libraries/a/win_args.txt', '-nogui']));
t('NeoForge win_args argfile 原样保留', () => assert.ok(config.tokenize('a @libraries/net/neoforged/neoforge/21.1.235/win_args.txt b')[1].startsWith('@')));
t('连续空白与引号内空格', () => assert.deepStrictEqual(config.tokenize('  a   "b c"  d  '), ['a', 'b c', 'd']));
t('空串 → 空数组', () => assert.deepStrictEqual(config.tokenize(''), []));

console.log('\n—— RCON 响应解析 ——');
t('标准 list 响应', () => {
  const r = parseList('There are 3/20 players online: Steve, Alex, 张三');
  assert.strictEqual(r.online, 3); assert.strictEqual(r.max, 20);
  assert.deepStrictEqual(r.names, ['Steve', 'Alex', '张三']);
});
t('0 人在线', () => { const r = parseList('There are 0/20 players online:'); assert.strictEqual(r.online, 0); });
t('带延迟尾注', () => { const r = parseList('There are 1/20 players online: Steve (32ms)'); assert.deepStrictEqual(r.names, ['Steve']); });
t('空/异常响应不抛', () => { const r = parseList(''); assert.strictEqual(r.online, 0); });

console.log('\n—— 进程 CPU 差值计算（100ns 时间片 → 整机 0~100%）——');
{
  const { Monitor } = require('../server/sys/monitor');
  const m = new Monitor();
  const cores = m._cores;
  t('单核跑满 = 100/核数 %', () => {
    m._prevTicks = null;
    m._applyCpuDelta({ ts: 1000, procTicks: 0 });
    const o = { ts: 2000, procTicks: 1e7 };                       // 1 秒墙钟内用了 1 秒 CPU = 1 核跑满
    m._applyCpuDelta(o);
    const expect = +(100 / cores).toFixed(1);
    assert.ok(Math.abs(o.procCpu - expect) < 0.2, `期望 ≈${expect}（${cores}核），实得 ${o.procCpu}`);
  });
  t('两核跑满 = 200/核数 %', () => {
    m._prevTicks = null;
    m._applyCpuDelta({ ts: 10000, procTicks: 0 });
    const o = { ts: 12000, procTicks: 4e7 };                      // 2s 墙钟 × 2 核
    m._applyCpuDelta(o);
    assert.ok(Math.abs(o.procCpu - (200 / cores)) < 0.3, `实得 ${o.procCpu}`);
  });
  t('零消耗 = 0%', () => {
    m._prevTicks = null;
    m._applyCpuDelta({ ts: 1787000000000, procTicks: 500 });          // 注意别用 ts:0 —— 会被 `|| Date.now()` 兜底
    const o = { ts: 1787000003000, procTicks: 500 };
    m._applyCpuDelta(o);
    assert.strictEqual(o.procCpu, 0);
  });
  t('首轮无基准 → 不产出假值', () => {
    m._prevTicks = null;
    const o = { ts: 1000, procTicks: 999999 };
    m._applyCpuDelta(o);
    assert.strictEqual(o.procCpu, undefined);
  });
  t('换进程（ticks 回退）不产生负数或天文数字', () => {
    m._prevTicks = 5e9; m._prevTicksTs = 1000;
    const o = { ts: 2000, procTicks: 100 };                       // PID 变了，累计值比基准小
    m._applyCpuDelta(o);
    assert.ok(o.procCpu === undefined || (o.procCpu >= 0 && o.procCpu <= 100), `实得 ${o.procCpu}`);
  });
  t('procTicks 缺失（进程已退出）只清基准不抛错', () => {
    m._prevTicks = 123; m._prevTicksTs = 1;
    m._applyCpuDelta({ ts: 2000 });
    assert.strictEqual(m._prevTicks, null);
  });
  m.shutdown();
}

(async () => {
  console.log('\n—— 行管线（proc.js 白盒）：批量切行不合并 / 启动完成标记 ——');
  const { MinecraftProcess, STATE } = require('../server/mc/proc');
  const tick = () => new Promise((r) => setImmediate(r));
  {
    const p = new MinecraftProcess();
    const seen = [];
    p.on('line', (l) => seen.push(l.raw));
    p.state = STATE.STARTING;
    for (let i = 0; i < 5000; i++) p.partialOut += `[12:00:0${i % 9}] [Server thread/INFO]: noise ${i}\n`;
    p._drain(false);
    let guard = 0;
    while (p.partialOut && guard++ < 200) await tick();
    t('单块 5000 行逐行切开（旧实现在第 400 行后把剩余合并成一条巨型行）', () => {
      assert.strictEqual(seen.length, 5000, `实得 ${seen.length} 行`);
      assert.ok(seen.every((r) => r.length < 160 && !r.includes('\n')), '存在被合并的行');
    });
    t('让出事件循环续排后顺序保持', () => {
      assert.ok(seen[0].endsWith('noise 0'), seen[0]);
      assert.ok(seen[4999].endsWith('noise 4999'), seen[4999]);
    });
  }
  {
    const p = new MinecraftProcess();
    const line = '[17:36:54] [Server thread/INFO] [minecraft/DedicatedServer]: Done (13.206s)! For help, type "help"';
    const it = p._pushLine(line);
    t('正文一字不改：前缀只抽成元数据，绝不从显示文本里删掉（面板与 bat 日志一致的前提）', () => {
      assert.strictEqual(it.raw, line);
      assert.strictEqual(it.html, line);
      assert.strictEqual(it.time, '17:36:54');
      assert.strictEqual(it.level, 'info');
      assert.strictEqual(it.src, 'stdout');
    });
  }
  const MARKS = [
    ['Forge 1.20.1 实测 stdout 行', '[17:36:54] [Server thread/INFO] [minecraft/DedicatedServer]: Done (13.206s)! For help, type "help"'],
    ['Forge 文件日志行（中文月份前缀）', '[039月2026 17:19:28.781] [Server thread/INFO] [net.minecraft.server.dedicated.DedicatedServer/]: Done (10.533s)! For help, type "help"'],
    ['带 ANSI 的服务端', '\u001b[0m[12:00:01] \u001b[0m[Server thread/\u001b[32mINFO\u001b[0m]: \u001b[32mDone\u001b[0m (3.2s)! For help, type "help"'],
    ['本地化括号/秒数', '[12:00:01] [Server thread/INFO]: Done（2.5秒）！输入 help 获取帮助'],
    ['欧陆小数逗号', '[12:00:01] [Server thread/INFO]: Done (3,2s)! For help, type "help"'],
  ];
  MARKS.forEach(([name, line], i) => {
    const p = new MinecraftProcess();
    p.state = STATE.STARTING;
    p._pushLine(line);
    t(`启动标记 ${i + 1}（${name}）→ ONLINE`, () => assert.strictEqual(p.state, STATE.ONLINE, `实为 ${p.state}`));
  });
  {
    const p = new MinecraftProcess();
    p.state = STATE.STARTING;
    p._pushLine('[12:00:01] [Server thread/INFO]: Preparing spawn area: 42%');
    p._pushLine('[12:00:02] [Server thread/INFO]: Loading 148 mods');
    t('未启动完就结束（无标记）→ 保持 STARTING，交给日志文件兜底', () => assert.strictEqual(p.state, STATE.STARTING));
  }
  {
    const p = new MinecraftProcess();
    p.state = STATE.STARTING;
    p._pushLine('Picked up JAVA_TOOL_OPTIONS: -Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8');
    p._pushLine('Picked up JDK_JAVA_OPTIONS: --add-opens java.base/java.lang=ALL-UNNAMED');
    t('java 对面板注入项的 Picked up 回显被折叠（不与 bat 启动的正文混淆）', () => assert.strictEqual(p.seq, 0, `seq=${p.seq}`));
    p._pushLine('[12:00:01] [Server thread/INFO]: Picked up 3 items by Steve');
    t('正文里恰好以 Picked up 开头的行不会被误吞', () => assert.strictEqual(p.seq, 1, `seq=${p.seq}`));
  }
  {
    const p = new MinecraftProcess();
    p.state = STATE.ONLINE;
    p._pushLine('[12:00:01] [Server thread/INFO]: Steve[/1.2.3.4:5] logged in with entity id 42');
    p._pushLine('§a张三[/1.2.3.4:6] logged in with entity id 43');
    t('玩家进出解析（含 § 色码 + 中文名）', () => assert.deepStrictEqual([...p.players].sort(), ['Steve', '张三']));
  }

  console.log(`\n${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
