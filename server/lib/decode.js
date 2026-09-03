'use strict';
/**
 * 控制台输出流式解码器 —— 中文 Windows 最核心的坑的解法。
 *
 * 背景：服务端 java.exe 的 stdout 编码由「JVM file.encoding / 系统 ACP」决定。
 * 中文 Windows Server 2016 的 ACP 是 936(GBK)，未加 -Dfile.encoding=UTF-8 时
 * 日志里的中文（含模组作者名、玩家名、崩溃报告）全是 GBK 字节。
 * 若按 utf-8 强解 → 乱码 + U+FFFD 不可逆污染。
 *
 * Node 24 官方 Windows 版内置 full-ICU，new TextDecoder('gbk') 开箱可用，
 * 所以这里零依赖即可正确处理（无需 iconv-lite）。
 *
 * 【为什么 auto 模式绝不允许「先攒一段再判定」—— 真实事故复盘】
 * 旧实现在判定前把原始块整体缓存，直到出现高位字节或攒满 64KB 才吐一个字符。
 * 但 Forge / vanilla 这类英文服务端，从 spawn 到 Done 的整段输出一个高位字节
 * 都没有（实测 E:\Desktop\1.20.1Forge：10818 字节全 ASCII，零 ANSI）。后果链：
 *   解码器不发文本 → 面板收不到行 → _track 永远看不到 Done
 *   → 状态永久停在「启动中」，控制台一片空白，
 *     而服务端自己的 logs/latest.log 明明白白写着启动完成。
 *
 * 新规则：**永远不为了判定编码而扣着文本不发。**
 *   · 纯 ASCII 段立即输出 —— ASCII 在 UTF-8 与 GBK 下逐字节相同，先发不可能错；
 *   · 只有「含高位字节的整行」才拿去做严格 UTF-8 试解，判完立刻锁定；
 *   · 唯一允许缓存的是「行尾还没收口且含高位字节」的残段（可能是半个多字节字符）。
 * 按 \n 做字节级分行是安全的：GBK 尾字节区间 0x40–0x7E / 0x80–0xFE、UTF-8 续字节
 * 区间 0x80–0xBF，都不含 0x0A —— 换行字节只可能是真正的换行，不会切坏字符。
 */
const HOLD_CAP = 64 * 1024;    // 行尾残段缓存上限（超长无换行的病态输出，保内存）

class StreamDecoder {
  /** @param {'utf-8'|'gbk'|'auto'} enc */
  constructor(enc = 'auto') {
    this.mode = enc === 'utf-8' || enc === 'gbk' ? enc : 'auto';
    this.decoder = null;
    this.label = null;
    this.decided = this.mode !== 'auto';
    if (this.decided) this._make(this.mode === 'gbk' ? 'gbk' : 'utf-8');
    this.pending = null;       // 未定案时暂存「含高位字节的行尾残段」
    this.pendingBytes = 0;
  }

  _make(label) {
    this.label = label;
    // fatal:false：容忍残缺多字节尾，配合 stream:true 正确跨块拼接
    this.decoder = new TextDecoder(label, { fatal: false, ignoreBOM: true });
  }

  /** 用严格 UTF-8 试解判定编码；失败即为 GBK。纯 ASCII 返回 null（无从判定） */
  static sniff(buf) {
    for (let i = 0; i < buf.length; i++) if (buf[i] > 0x7f) return _tryUtf8(buf) ? 'utf-8' : 'gbk';
    return null;
  }

  /**
   * 喂进一块原始字节，拿到「此刻可以安全输出」的文本 —— 任何情况下都不会整体扣住。
   * @returns {string}
   */
  push(buf) {
    if (!buf || !buf.length) return '';
    if (this.decided) return this.decoder.decode(buf, { stream: true });
    if (this.pending) { buf = Buffer.concat([this.pending, buf]); this.pending = null; this.pendingBytes = 0; }
    if (!hasHighBytes(buf)) return buf.toString('utf8');       // 全 ASCII：无判定成本，直接放行

    let out = '';
    let start = 0;
    while (start < buf.length) {
      if (this.decided) { out += this.decoder.decode(buf.subarray(start), { stream: true }); break; }
      const nl = buf.indexOf(0x0a, start);                     // 字节级分行，见文件头论证
      const end = nl < 0 ? buf.length : nl + 1;
      out += this._piece(buf.subarray(start, end), nl < 0);
      start = end;
    }
    return out;
  }

  /**
   * 定案前处理一段字节。
   * @param {Buffer} bytes
   * @param {boolean} tail 该段是否位于块末尾（行还没收口，可能切在多字节中间）
   */
  _piece(bytes, tail) {
    if (!hasHighBytes(bytes)) return bytes.toString('utf8');   // 与 GBK 结果相同，先发
    if (!tail) {
      this._lock(StreamDecoder.sniff(bytes) || 'utf-8');       // 整行样本最可靠
      return this.decoder.decode(bytes, { stream: true });
    }
    // 行还没收口：能被严格 UTF-8 完整解出的高位字节串，就不可能是「半个字」，直接定案发出；
    // 解不过才缓存（要么是真 GBK，要么是被切断的 UTF-8 尾，等下一块即可）。
    if (StreamDecoder.sniff(bytes) === 'utf-8') {
      this._lock('utf-8');
      return this.decoder.decode(bytes, { stream: true });
    }
    return this._hold(bytes);
  }

  _hold(bytes) {
    this.pending = this.pending ? Buffer.concat([this.pending, bytes]) : Buffer.from(bytes);
    this.pendingBytes = this.pending.length;
    if (this.pendingBytes <= HOLD_CAP) return '';
    const p = this.pending; this.pending = null; this.pendingBytes = 0;
    this._lock(StreamDecoder.sniff(p) || 'utf-8');
    return this.decoder.decode(p, { stream: true });
  }

  _lock(label) {
    this._make(label);
    this.decided = true;
  }

  /** 流结束时收尾，吐出解码器内部残留字节 */
  end() {
    let out = '';
    if (this.pending) {
      const p = this.pending; this.pending = null; this.pendingBytes = 0;
      if (!this.decided) this._lock(StreamDecoder.sniff(p) || 'utf-8');
      out += this.decoder.decode(p);
    }
    if (!this.decided) this._lock('utf-8');
    try { out += this.decoder.decode(); } catch { /* 残留非法字节，放弃 */ }
    return out;
  }

  get encoding() { return this.label || 'pending'; }
}

function hasHighBytes(buf) {
  for (let i = 0; i < buf.length; i++) if (buf[i] > 0x7f) return true;
  return false;
}

function _tryUtf8(buf) {
  try { new TextDecoder('utf-8', { fatal: true }).decode(buf); return true; }
  catch { return false; }
}

module.exports = { StreamDecoder, hasHighBytes };
