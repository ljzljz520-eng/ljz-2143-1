'use strict';
/**
 * 公共模块：API 封装、幂等键、离线动作队列。
 * 断网策略（与 README 一致）：
 *  - 领号、叫下一号：必须在线（集中分配，离线无法保证号码唯一与认领互斥）→ 界面禁用。
 *  - 完成服务、暂停/恢复：只影响本柜台自身状态 → 离线时带幂等键暂存 localStorage，恢复后自动同步。
 *  - 展示窗：离线继续展示最后快照，可用缓存文本本地重播语音。
 */
const Common = (() => {
  function uuid() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  async function api(path, { method = 'GET', body } = {}) {
    let res;
    try {
      res = await fetch(path, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      const err = new Error('网络不可用');
      err.code = 'OFFLINE';
      throw err;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error((data.error && data.error.message) || `HTTP ${res.status}`);
      err.code = (data.error && data.error.code) || 'HTTP_' + res.status;
      err.status = res.status;
      throw err;
    }
    return data;
  }

  /** 离线动作队列：动作在点击时生成幂等键，重试/重启后键不变，服务端去重 */
  class OfflineQueue {
    constructor(key, storage) {
      this.key = key;
      this.storage = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    }
    _read() {
      if (!this.storage) return [];
      try { return JSON.parse(this.storage.getItem(this.key) || '[]'); } catch { return []; }
    }
    _write(items) {
      if (this.storage) this.storage.setItem(this.key, JSON.stringify(items));
    }
    push(item) { const a = this._read(); a.push(item); this._write(a); return a.length; }
    peek() { return this._read(); }
    get length() { return this._read().length; }
    /** 顺序回放；遇 OFFLINE 停止并保留剩余，遇业务错误丢弃该条（服务端已拒绝，重放无意义） */
    async drain(send) {
      const items = this._read();
      const done = [];
      for (const item of items) {
        try {
          await send(item);
          done.push({ item, ok: true });
        } catch (e) {
          if (e.code === 'OFFLINE') break;       // 仍然断网：保留剩余
          done.push({ item, ok: false, error: e.code }); // 业务拒绝：丢弃
        }
      }
      this._write(items.slice(done.length));
      return done;
    }
  }

  return { uuid, api, OfflineQueue };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Common;
if (typeof window !== 'undefined') window.Common = Common;
