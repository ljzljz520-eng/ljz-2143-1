'use strict';
(function () {
  const { api, uuid } = window.Common;
  const $ = id => document.getElementById(id);

  const STATUS_LABEL = { SAVED: '已保存', DELIVERED: '终端已接收', CONFIRMED: '现场已确认' };
  const TYPE_LABEL = { CALL_NEXT: '叫号', RECALL: '重呼', REPLAY: '重播', PAUSE: '暂停', RESUME: '恢复', COMPLETE: '完成' };

  async function refresh() {
    const [ov, cmds] = await Promise.all([
      api('/api/admin/overview'),
      api('/api/admin/commands' + filterQuery()),
    ]);
    renderOverview(ov);
    renderCommands(cmds.commands);
  }

  function filterQuery() {
    const v = $('filter').value;
    if (v === 'pending') return '?pending=1';
    return v ? `?status=${v}` : '';
  }

  function renderOverview(s) {
    $('overview').innerHTML =
      `<strong>业务日期 ${s.bizDate}</strong> ｜ 等待 ${s.waitingCount} 人 ｜ ` +
      s.counters.map(c =>
        `${c.name}：${c.status === 'open' ? '营业中' : '<b style="color:var(--warn)">已暂停</b' + '>'}` +
        `${c.current ? `，当前 ${String(c.current.seq).padStart(3, '0')} 号（${c.current.status}）` : '，空闲'}`
      ).join(' ｜ ');
  }

  function renderCommands(list) {
    $('commands').innerHTML = list.map(c => {
      const pending = c.target === 'display' && c.status !== 'CONFIRMED';
      return `<tr class="${pending ? 'pending-row' : ''}">
        <td>${new Date(c.created_at).toLocaleTimeString('zh-CN')}</td>
        <td>${TYPE_LABEL[c.type] || c.type}${c.replay_of ? '（重播）' : ''}</td>
        <td>${c.counter_name || c.counter_id || '—'}</td>
        <td>${c.t_seq != null ? String(c.t_seq).padStart(3, '0') + (c.t_biz_date ? ` <span class="muted">${c.t_biz_date}</span>` : '') : '—'}</td>
        <td><span class="chip ${c.status}">${STATUS_LABEL[c.status]}</span>${pending ? ' ⚠待核对' : ''}</td>
        <td class="muted">${c.delivered_at ? new Date(c.delivered_at).toLocaleTimeString('zh-CN') : '—'} /
            ${c.confirmed_at ? new Date(c.confirmed_at).toLocaleTimeString('zh-CN') : '—'}</td>
        <td class="row-actions">${pending ? `
          <button data-act="replay" data-id="${c.id}">人工重播</button>
          <button class="confirm" data-act="confirm" data-id="${c.id}">标记已播</button>` : ''}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="7" class="muted">暂无指令</td></tr>';
  }

  $('commands').addEventListener('click', async e => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = btn.dataset.id;
    if (btn.dataset.act === 'replay') {
      await api(`/api/commands/${id}/replay`, { method: 'POST', body: { idemKey: uuid(), actor: 'admin' } });
    } else {
      await api(`/api/commands/${id}/confirm`, { method: 'POST', body: { actor: 'admin:manual' } });
    }
    refresh();
  });

  $('filter').addEventListener('change', refresh);
  refresh();
  setInterval(refresh, 2000);
})();
