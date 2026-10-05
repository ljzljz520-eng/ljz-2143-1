/* 柜台工作台：领号（叫下一号）、重播、暂停/恢复、办结、确认到场。
 *
 * 幂等重试：点击"叫下一号"时生成 command_id；若网络异常，按钮变为"重试"，
 * 重试仍使用同一 command_id —— 服务端按幂等键去重，不会重复改变排队状态。
 * 断网策略：叫号/暂停/确认都必须连接服务器（需服务端仲裁），断网时明确提示。
 */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const counterId = new URLSearchParams(location.search).get("counter") || "1";
  $("title").textContent = `柜台工作台 · ${counterId} 号窗口`;

  const STATE_CN = { saved: "已保存", delivered: "终端已接收", played: "已播报", confirmed: "现场已确认" };
  let counter = null;
  let inflight = null; // { commandId } 未完成的叫号指令（重试复用）

  async function api(path, opts) {
    const res = await fetch(path, opts);
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body };
  }
  const post = (path, obj) => api(path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj || {}),
  });

  function showMsg(t) { $("msg").textContent = t || ""; }
  function netDown() { $("net").textContent = "⚠ 网络中断：叫号/暂停/确认需连接服务器，请稍候"; }

  async function refresh() {
    try {
      const [c, q] = await Promise.all([
        api(`/api/counters/${counterId}`), api("/api/queue"),
      ]);
      $("net").textContent = "";
      counter = c.body;
      render(q.body);
    } catch { netDown(); }
  }

  function render(queue) {
    $("status").textContent = counter.status === "open" ? "服务中" : "已暂停";
    $("waiting").textContent = queue.waiting_count;
    $("current").textContent = counter.current_ticket
      ? counter.current_ticket.number_label : "—";
    const cmd = counter.latest_command;
    const badge = $("cmd-state");
    if (cmd) {
      badge.textContent = STATE_CN[cmd.state] || cmd.state;
      badge.className = "badge st-" + cmd.state;
    } else { badge.textContent = "无"; badge.className = "badge"; }
    $("btn-pause").textContent = counter.status === "open" ? "暂停窗口" : "恢复窗口";
    $("btn-next").disabled = !!inflight || counter.status !== "open" || !!counter.current_ticket;
    $("btn-recall").disabled = !counter.current_ticket;
    $("btn-done").disabled = !counter.current_ticket;
    $("btn-confirm").disabled = !cmd || cmd.state === "confirmed";
  }

  // 叫下一号（领号）：inflight 期间重试复用同一 command_id
  $("btn-next").addEventListener("click", async () => {
    if (inflight) return;
    inflight = { commandId: crypto.randomUUID() };
    $("btn-next").disabled = true;
    try {
      const r = await post(`/api/counters/${counterId}/serve-next`,
        { command_id: inflight.commandId });
      if (!r.ok) showMsg(r.body.error ? r.body.error.message : "叫号失败");
    } catch {
      showMsg("网络异常：指令可能已保存，再次点击将以同一指令重试（不会重复叫号）");
      $("btn-next").disabled = false;
      return; // 保留 inflight → 下次点击重试同一指令
    }
    inflight = null;
    refresh();
  });

  $("btn-recall").addEventListener("click", async () => {
    const r = await post(`/api/counters/${counterId}/recall`,
      { command_id: crypto.randomUUID() });
    if (!r.ok) showMsg(r.body.error ? r.body.error.message : "重叫失败");
    refresh();
  });

  $("btn-done").addEventListener("click", async () => {
    const r = await post(`/api/counters/${counterId}/done`);
    if (!r.ok) showMsg(r.body.error ? r.body.error.message : "办结失败");
    refresh();
  });

  $("btn-pause").addEventListener("click", async () => {
    const action = counter && counter.status === "open" ? "pause" : "resume";
    try {
      const r = await post(`/api/counters/${counterId}/${action}`);
      if (!r.ok) showMsg(r.body.error ? r.body.error.message : "操作失败");
    } catch { netDown(); }
    refresh();
  });

  $("btn-confirm").addEventListener("click", async () => {
    const cmd = counter && counter.latest_command;
    if (!cmd) return;
    const r = await post(`/api/commands/${cmd.command_id}/confirm`);
    if (!r.ok) showMsg(r.body.error ? r.body.error.message : "确认失败");
    refresh();
  });

  refresh();
  setInterval(refresh, 2000);
})();
