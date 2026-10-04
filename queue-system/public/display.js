'use strict';
/**
 * C 展示窗终端逻辑。
 * 诚实面对“物理播报恰好一次”问题：
 *  - SAVED(已保存)      → 终端自动播报；开始播 → ack(DELIVERED)；播完 → confirm(CONFIRMED)
 *  - DELIVERED(已接收)  → 设备可能“播了但崩溃在确认前”，无法自动判断 → 进入待核对面板，
 *                         只提供【人工重播】【标记已播】，绝不自动重播（避免二次播报）
 *  - 海报 decode 失败   → 切换 .bg-fallback 渐变底色；号码面板自带高对比衬底，不受影响
 */
(function (root, factory) {
  const api = factory(typeof module !== 'undefined' && module.exports ? require('./common.js') : root.Common);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') {
    window.DisplayApp = api;
    window.addEventListener('DOMContentLoaded', api.boot);
  }
})(typeof self !== 'undefined' ? self : this, function (Common) {

  const FALLBACK_CLASS = 'bg-fallback';
  const SNAPSHOT_KEY = 'display.snapshot.v1';
  const TERMINAL_ID = 'display-1';
  const POLL_MS = 2000;

  /* ---------- 纯函数（可单测） ---------- */

  /** 指令 → 终端应执行的动作 */
  function classifyCommand(cmd) {
    if (cmd.status === 'SAVED') return 'autoplay';   // 新指令：自动播报
    if (cmd.status === 'DELIVERED') return 'verify'; // 已接收未确认：待人工核对
    return 'done';
  }

  /** 海报加载结果 → 是否启用降级背景 */
  function posterOkToClass(ok) { return ok ? '' : FALLBACK_CLASS; }

  /* ---------- 浏览器环境 ---------- */

  let lastSnapshot = null;
  const spoken = new Set(); // 本次运行已自动播过的指令，避免轮询重复播报

  function $(id) { return document.getElementById(id); }

  function saveSnapshot(s) {
    lastSnapshot = s;
    try { localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(s)); } catch {}
  }

  function loadSnapshot() {
    try { return JSON.parse(localStorage.getItem(SNAPSHOT_KEY) || 'null'); } catch { return null; }
  }

  /** 海报加载：decode() 失败 / onerror → 降级背景。返回是否成功。 */
  async function setupPoster() {
    const img = $('poster');
    const url = new URL(location.href).searchParams.get('poster');
    if (url) img.src = url;
    const fail = () => { document.body.classList.add(FALLBACK_CLASS); return false; };
    try {
      if (img.decode) { await img.decode(); return true; }
      throw new Error('decode unsupported');
    } catch {
      // decode 抛错 = 海报解码失败（文件损坏/格式不支持）
      return fail();
    }
  }

  function setOnline(online) {
    const b = $('net-badge');
    b.textContent = online ? '在线' : '离线 · 展示最后同步状态';
    b.classList.toggle('offline', !online);
  }

  function render(state) {
    const board = $('board');
    board.innerHTML = '';
    for (const c of state.counters) {
      const card = document.createElement('div');
      card.className = 'contrast-panel' + (c.status === 'paused' ? ' paused-card' : '');
      const crossDay = c.current && c.current.bizDate !== state.bizDate;
      card.innerHTML = c.current
        ? `<div class="counter-name">${c.name}${c.status === 'paused' ? '（已暂停）' : ''}</div>
           <div class="ticket-seq">${String(c.current.seq).padStart(3, '0')}</div>
           <div class="ticket-sub">${crossDay ? `<span class="chip crossday">跨日 ${c.current.bizDate}</span> ` : ''}票据 ${c.current.id.slice(0, 8)}</div>`
        : `<div class="counter-name">${c.name}</div>
           <div class="idle">${c.status === 'paused' ? '暂停服务' : '空闲'}</div>`;
      board.appendChild(card);
    }
    $('waiting-strip').textContent = `等待人数：${state.waitingCount}` +
      (state.waitingPreview.length
        ? ` ｜ 队列：${state.waitingPreview.map(t =>
            `${String(t.seq).padStart(3, '0')}${t.biz_date !== state.bizDate ? '(跨日)' : ''}`).join('、')}`
        : '');
    renderPending(state.pendingBroadcasts.filter(c => classifyCommand(c) === 'verify'));
  }

  function renderPending(verifyList) {
    const panel = $('pending-panel');
    const list = $('pending-list');
    list.innerHTML = '';
    panel.hidden = verifyList.length === 0;
    for (const cmd of verifyList) {
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `<span>${cmd.payload.text || cmd.id.slice(0, 8)}（${cmd.type}）</span>`;
      const replay = document.createElement('button');
      replay.textContent = '人工重播';
      replay.onclick = () => speak(cmd, { manual: true });
      const done = document.createElement('button');
      done.textContent = '标记已播';
      done.className = 'confirm';
      done.onclick = async () => { await Common.api(`/api/commands/${cmd.id}/confirm`, { method: 'POST', body: { actor: TERMINAL_ID + ':manual' } }); poll(); };
      row.append(replay, done);
      list.appendChild(row);
    }
  }

  /** 语音播报：开始→ack；结束→confirm；失败/无语音→留在待核对，交人工 */
  function speak(cmd, { manual = false } = {}) {
    if (!manual && spoken.has(cmd.id)) return;
    spoken.add(cmd.id);
    const acked = Common.api(`/api/commands/${cmd.id}/ack`, { method: 'POST', body: { terminalId: TERMINAL_ID } })
      .catch(() => {});
    if (!('speechSynthesis' in window)) {
      // 无语音设备：只确认接收，等待人工核对
      acked.then(poll);
      return;
    }
    const u = new SpeechSynthesisUtterance(cmd.payload.text || '');
    u.lang = 'zh-CN';
    u.onend = () => Common.api(`/api/commands/${cmd.id}/confirm`, { method: 'POST', body: { actor: TERMINAL_ID } }).then(poll).catch(() => {});
    u.onerror = () => poll(); // 播报失败：保持 DELIVERED，进入待核对
    acked.finally(() => window.speechSynthesis.speak(u));
  }

  async function poll() {
    try {
      const state = await Common.api('/api/display/state');
      setOnline(true);
      saveSnapshot(state);
      render(state);
      for (const cmd of state.pendingBroadcasts) {
        if (classifyCommand(cmd) === 'autoplay') speak(cmd);
      }
    } catch (e) {
      setOnline(false); // 断网：继续展示最后快照（含本地缓存）
    }
  }

  function boot() {
    setupPoster();
    const snap = loadSnapshot(); // 设备重启：先渲染上次快照，再向服务器对齐
    if (snap) render(snap);
    setInterval(() => { $('clock').textContent = new Date().toLocaleTimeString('zh-CN'); }, 1000);
    window.addEventListener('online', () => poll());
    window.addEventListener('offline', () => setOnline(false));
    poll();
    setInterval(poll, POLL_MS);
  }

  return { boot, classifyCommand, posterOkToClass, FALLBACK_CLASS, _private: { setupPoster, render } };
});
