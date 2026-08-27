'use strict';
/**
 * 发布订阅中心 + 控制台帧批处理。
 *
 * 关键点：MC 服务端在块加载/大量实体时可瞬间刷几百行，逐行发 WS 帧会让
 * 序列化与 socket 写队列成为瓶颈（内存与 CPU 双高）。这里按 60ms 聚合成一帧，
 * 单客户端每秒最多 ~16 帧，浏览器渲染压力也同时降下来。
 * 无人订阅时完全不发（publish 直接 return），零开销。
 */
const BATCH_MS = 60;
const BATCH_MAX = 300;

class Hub {
  constructor() {
    this.conns = new Set();
    this.topics = new Map();          // topic -> Set<conn>
    this.connTopics = new WeakMap();  // conn -> Set<topic>
    this.batch = new Map();           // topic -> [items]
    this.timer = null;
  }

  add(conn) {
    this.conns.add(conn);
    this.connTopics.set(conn, new Set());
    conn.on('close', () => this.remove(conn));
  }
  remove(conn) {
    this.conns.delete(conn);
    const set = this.connTopics.get(conn);
    if (set) for (const t of set) { const s = this.topics.get(t); if (s) { s.delete(conn); if (!s.size) this.topics.delete(t); } }
  }

  subscribe(conn, topic) {
    const set = this._topic(topic);
    set.add(conn);
    (this.connTopics.get(conn) || new Set()).add(topic);
  }
  unsubscribe(conn, topic) {
    const s = this.topics.get(topic);
    if (s) { s.delete(conn); if (!s.size) this.topics.delete(topic); }
    this.connTopics.get(conn)?.delete(topic);
  }
  topicsOf(conn) { return [...(this.connTopics.get(conn) || [])]; }

  _topic(t) { let s = this.topics.get(t); if (!s) { s = new Set(); this.topics.set(t, s); } return s; }
  count(topic) { return this.topics.get(topic)?.size || 0; }

  /** 即时广播（状态、玩家等低频事件） */
  publish(topic, type, data) {
    const set = this.topics.get(topic);
    if (!set || !set.size) return 0;
    let n = 0;
    for (const c of set) if (c.send(type === topic ? topic : type, data)) n++;
    return n;
  }

  /** 高频行：进批处理队列 */
  publishLines(topic, item) {
    const set = this.topics.get(topic);
    if (!set || !set.size) return;
    let arr = this.batch.get(topic);
    if (!arr) { arr = []; this.batch.set(topic, arr); }
    arr.push(item);
    if (arr.length >= BATCH_MAX) this._flush(topic);
    else if (!this.timer) this._arm();
  }

  _arm() {
    this.timer = setTimeout(() => { this.timer = null; this._flushAll(); }, BATCH_MS);
    this.timer.unref?.();
  }
  _flushAll() { for (const t of [...this.batch.keys()]) this._flush(t); }

  _flush(topic) {
    const arr = this.batch.get(topic);
    this.batch.delete(topic);
    if (!arr || !arr.length) return;
    this.publish(topic, topic === 'console' ? 'lines' : topic, arr);
  }

  stats() {
    const o = {};
    for (const [t, s] of this.topics) o[t] = s.size;
    return { clients: this.conns.size, topics: o };
  }
}

module.exports = { Hub, BATCH_MS, BATCH_MAX };
