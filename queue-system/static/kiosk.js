/* 取号终端：集中分配（在线） + 租约离线发号（断网）。
 * 租约 = 服务端预分配的当日号段；离线票携带本地生成的 UUID（跨日稳定身份），
 * 恢复网络后通过 /api/tickets/sync 幂等回同步。
 */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const TERMINAL = "kiosk-" + (localStorage.getItem("kiosk.id") ||
    (localStorage.setItem("kiosk.id", Math.random().toString(36).slice(2, 8)),
     localStorage.getItem("kiosk.id")));
  const K = { lease: "kiosk.lease", outbox: "kiosk.outbox" };
  const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
  const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));

  let offline = false;
  let lease = load(K.lease, null);   // {lease_id,biz_date,start_seq,end_seq,next_seq}
  let outbox = load(K.outbox, []);   // 待同步离线票

  async function api(path, opts) {
    const res = await fetch(path, opts);
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  }
  const post = (p, o) => api(p, { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(o || {}) });

  function render() {
    $("lease-info").textContent = lease
      ? `租约 ${lease.biz_date} 号段 ${lease.next_seq}~${lease.end_seq}` : "无租约";
    $("outbox").innerHTML = outbox.map((t) =>
      `<li class="offline-tag">离线票 ${t.number_label}（待同步，id=${t.ticket_id.slice(0,8)}…）</li>`).join("");
  }
  function show(t, offlineMade) {
    $("ticket").innerHTML =
      `<div class="big">${t.number_label}</div>` +
      (offlineMade ? `<div class="offline-tag">离线出票 · 恢复网络后自动同步</div>` : "") +
      `<div>票据身份 ${t.ticket_id.slice(0, 8)}…（跨日稳定）</div>`;
  }

  async function ensureLease() {
    if (lease && lease.end_seq - lease.next_seq + 1 >= 3) return;
    lease = await post("/api/leases", { terminal_id: TERMINAL, size: 10 });
    lease.next_seq = lease.start_seq;
    save(K.lease, lease);
  }

  async function syncOutbox() {
    if (!outbox.length || !lease) return;
    const res = await post("/api/tickets/sync", { lease_id: lease.lease_id, tickets: outbox });
    const accepted = new Set(res.accepted);
    outbox = outbox.filter((t) => !accepted.has(t.ticket_id));
    save(K.outbox, outbox);
    if (res.rejected.length) $("msg").textContent =
      `${res.rejected.length} 张离线票被拒（${res.rejected[0].reason}）`;
  }

  $("offline").addEventListener("change", async (e) => {
    offline = e.target.checked;
    if (!offline) {           // 恢复网络：补租约 + 回同步
      try { await ensureLease(); await syncOutbox(); $("msg").textContent = "已恢复在线"; }
      catch { $("msg").textContent = "同步失败，稍后自动重试"; }
    }
    render();
  });

  $("take").addEventListener("click", async () => {
    $("msg").textContent = "";
    if (!offline) {
      try { show(await post("/api/tickets", { terminal_id: TERMINAL })); await ensureLease(); }
      catch { $("msg").textContent = "网络异常，可勾选“模拟断网”体验租约离线发号"; }
      return render();
    }
    // 断网：仅当持有有效租约时允许本地发号
    if (!lease || lease.next_seq > lease.end_seq) {
      $("msg").textContent = "断网且无可用租约：无法取号";
      return;
    }
    const t = {
      ticket_id: crypto.randomUUID(),           // 跨日稳定身份，本地生成
      seq_no: lease.next_seq++, biz_date: lease.biz_date,
      number_label: "A" + String(lease.next_seq - 1).padStart(3, "0"),
      issued_at: new Date().toISOString(),
    };
    save(K.lease, lease);
    outbox.push({ ticket_id: t.ticket_id, seq_no: t.seq_no, biz_date: t.biz_date, issued_at: t.issued_at });
    save(K.outbox, outbox);
    show(t, true);
    render();
  });

  ensureLease().catch(() => {}).then(render);
  render();
})();
