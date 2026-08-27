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
 * 'auto' 模式：只有遇到高位字节才判定，避免纯 ASCII 前缀误判。
 */
class StreamDecoder {
  /** @param {'utf-8'|'gbk'|'auto'} enc */
  constructor(enc = 'auto') {
    this.mode = enc === 'utf-8' || enc === 'gbk' ? enc : 'auto';
    this.decoder = null;
    this.decided = this.mode !== 'auto';
    if (this.decided) this._make(this.mode === 'gbk' ? 'gbk' : 'utf-8');
    this.pending = null; // auto 模式下未判定前暂存的原始块（有上限，防内存堆积）
    this.pendingBytes = 0;
  }

  _make(label) {
    this.label = label;
    // fatal:false：容忍残缺多字节尾，配合 stream:true 正确跨块拼接
    this.decoder = new TextDecoder(label, { fatal: false, ignoreBOM: true });
  }

  /** 用严格 UTF-8 试解判定编码；失败即为 GBK */
  static sniff(buf) {
    for (let i = 0; i < buf.length; i++) if (buf[i] > 0x7f) return _tryUtf8(buf) ? 'utf-8' : 'gbk';
    return null; // 纯 ASCII，暂不判定
  }

  /** @returns {string} 已解码文本 */
  push(buf) {
    if (!buf || !buf.length) return '';
    if (!this.decided) {
      const guess = StreamDecoder.sniff(buf);
      if (guess === null) {
        // 还没出现高位字节：先缓存（超过 64KB 强制按 utf-8 定案）
        if (this.pendingBytes + buf.length > 65536) { this._lock('utf-8'); }
        else {
          this.pending = this.pending ? Buffer.concat([this.pending, buf]) : Buffer.from(buf);
          this.pendingBytes += buf.length;
          return '';
        }
      } else {
        this._lock(guess);
      }
      if (this.pending) {
        const p = this.pending; this.pending = null; this.pendingBytes = 0;
        return this.decoder.decode(p, { stream: true }) + this.decoder.decode(buf, { stream: true });
      }
    }
    return this.decoder.decode(buf, { stream: true });
  }

  _lock(label) {
    this._make(label);
    this.decided = true;
  }

  /** 进程退出时收尾，吐出解码器内部残留字节 */
  end() {
    if (!this.decided) {
      this._lock('utf-8');
      if (this.pending) { const p = this.pending; this.pending = null; this.pendingBytes = 0; return this.decoder.decode(p); }
      return '';
    }
    try { return this.decoder.decode(); } catch { return ''; }
  }

  get encoding() { return this.label || 'pending'; }
}

function _tryUtf8(buf) {
  try { new TextDecoder('utf-8', { fatal: true }).decode(buf); return true; }
  catch { return false; }
}

module.exports = { StreamDecoder };
