'use strict';
/**
 * 柜台端。
 * 幂等：每次点击生成一个 idemKey 并记住，自动重试/断网重传都复用同一键 → 服务端去重。
 * 断网：领号/叫号禁用；完成、暂停/恢复进入离线队列，online 后自动 drain。
 */
(function () {
  const { api, uuid, OfflineQueue } = window.Common;
  const $ = id => document.getElementById(id);
  const queue = new OfflineQueue('counter.offline.v1');

  let counterId = localStorage.getItem('counter.id') || 'C1';
  let online = navigator.onLine;
  let state = null;
  const pendingKeys = {}; // action -> idemKey（点击生成，重试复用）

  const keyFor = a => pendingKeys[a] || (pendingKeys[a] = uuid());

  async function refresh() {
    try {
      const [counters, waiting] = await Promise.all([
        api('/api/counters'), api('/api/tickets?status=waiting'),
      ]);
      setOnline(true);
      state = counters;
      render(counters, waiting.tickets);
    } catch (e) {
      if (e.code === 'OFFLINE') setOnline(false);
    }
  }

  function setOnline(v) {
    online = v;
    $('net').textContent = v ? '' : '● 离线';
    $('offline-banner').hidden = v;
    $('btn-issue').disabled = !v;
    $('btn-call').disabled = !v;
    $('btn-recall').disabled = !v;
    updateQueuedBanner();
  }

  function updateQueuedBanner() {
    const n = queue.length;
    $('queued-banner').hidden = n === 0;
    $('queued-banner').textContent = n ? `有 ${n} 个操作已暂存，联网后自动同步` : '';
  }

  function render(counters, waiting) {
    const c = counters.counters.find(x => x.id === counterId);
    if (!c) return;
    const st = $('counter-status');
    st.textContent = c.status === 'open' ? '营业中' : '已暂停';
    st.className = 'chip ' + (c.status === 'open' ? 'open' : 'paused');
    $('btn-pause').textContent = c.status === 'open' ? '暂停窗口' : '恢复窗口';
    $('current-seq').textContent = c.current ? String(c.current.seq).padStart(3, '0') : '—';
    $('current-meta').textContent = c.current
      ? `票据 ${c.current.id.slice(0, 8)} ｜ ${c.current.bizDate}${c.current.status === 'serving' ? ' ｜ 现场已确认服务' : ''}`
      : '空闲';
    $('waiting-count').textContent = waiting.length;
    $('waiting-list').innerHTML = waiting.map(t =>
      `<span class="chip ${t.crossDay ? 'crossday' : 'open'}" style="margin:2px">
         ${String(t.seq).padStart(3, '0')}${t.crossDay ? ' 跨日' : ''}</span>`).join('') || '<span class="muted">无</span>';
  }

  function say(m) { $('msg').textContent = m; }

  /** 在线动作：直接调用；失败若是 OFFLINE 且允许暂存 → 入队 */
  async function doAction(action, path, { queueable }) {
    const idemKey = keyFor(action);
    try {
      await api(path, { method: 'POST', body: { idemKey } });
      delete pendingKeys[action];
      say('');
      await refresh();
    } catch (e) {
      if (e.code === 'OFFLINE' && queueable) {
        queue.push({ action, path, idemKey });
        setOnline(false);
        say('已离线暂存，联网后自动同步');
      } else if (e.code === 'OFFLINE') {
        setOnline(false);
        say('断网时该操作不可用：' + e.message);
      } else {
        delete pendingKeys[action];
        say(e.message);
        await refresh();
      }
    }
  }

  async function flushQueue() {
    const done = await queue.drain(item => api(item.path, { method: 'POST', body: { idemKey: item.idemKey } }));
    if (done.length) { say(`已同步 ${done.filter(d => d.ok).length} 个暂存操作`); }
    updateQueuedBanner();
    refresh();
  }

  function boot() {
    const sel = $('counter-select');
    ['C1', 'C2', 'C3'].forEach(id => {
      const o = document.createElement('option');
      o.value = id; o.textContent = id + ' 窗口';
      sel.appendChild(o);
    });
    sel.value = counterId;
    sel.onchange = () => { counterId = sel.value; localStorage.setItem('counter.id', counterId); refresh(); };

    $('btn-issue').onclick = async () => {
      try {
        const r = await api('/api/tickets', { method: 'POST', body: { idemKey: uuid() } });
        say(`已发号：${String(r.ticket.seq).padStart(3, '0')}（${r.ticket.biz_date}）`);
        refresh();
      } catch (e) { say(e.code === 'OFFLINE' ? '断网时不能领号：号码由服务器集中分配' : e.message); if (e.code === 'OFFLINE') setOnline(false); }
    };
    $('btn-call').onclick = () => doAction('call', `/api/counters/${counterId}/call-next`, { queueable: false });
    $('btn-recall').onclick = () => doAction('recall', `/api/counters/${counterId}/recall`, { queueable: false });
    $('btn-complete').onclick = () => doAction('complete', `/api/counters/${counterId}/complete`, { queueable: true });
    $('btn-pause').onclick = () => {
      const paused = $('counter-status').textContent === '已暂停';
      doAction(paused ? 'resume' : 'pause', `/api/counters/${counterId}/${paused ? 'resume' : 'pause'}`, { queueable: true });
    };

    window.addEventListener('online', () => { setOnline(true); flushQueue(); });
    window.addEventListener('offline', () => setOnline(false));
    setOnline(navigator.onLine);
    refresh();
    setInterval(refresh, 3000);
    if (queue.length) flushQueue();
  }

  window.addEventListener('DOMContentLoaded', boot);
})();
