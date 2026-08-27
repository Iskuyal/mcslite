'use strict';
/**
 * 固定容量环形缓冲 —— 面板内存可控的根基。
 * 控制台日志、指标序列全部走这里，堆占用恒定，永不因长时间运行增长。
 */
class Ring {
  constructor(capacity) {
    this.cap = capacity >>> 0 || 1;
    this.buf = new Array(this.cap);
    this.head = 0;   // 下一个写入位置
    this.size = 0;
  }

  push(item) {
    this.buf[this.head] = item;
    this.head = (this.head + 1) % this.cap;
    if (this.size < this.cap) this.size++;
    return item;
  }

  /** 最旧 → 最新 */
  toArray() {
    const out = new Array(this.size);
    const start = (this.head - this.size + this.cap) % this.cap;
    for (let i = 0; i < this.size; i++) out[i] = this.buf[(start + i) % this.cap];
    return out;
  }

  last(n) {
    const k = Math.min(n >>> 0, this.size);
    const out = new Array(k);
    for (let i = 0; i < k; i++) out[i] = this.buf[(this.head - k + i + this.cap * 2) % this.cap];
    return out;
  }

  clear() { this.buf = new Array(this.cap); this.head = 0; this.size = 0; }
}

module.exports = { Ring };
