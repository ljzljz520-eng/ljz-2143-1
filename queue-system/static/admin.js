/* 管理台：区分指令的四个确认级别，暴露"待核对"指令并提供人工重播入口。 */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const STATE_CN = { saved: "已保存", delivered: "终端已接收", played: "已播报", confirmed: "现场已确认" };
  const KIND_CN = { call: "叫号", recall: "重叫", replay: "人工重播" };

  async function api(path, opts) {
    const res = await fetch(path, opts);
    return res.json();
  }

  async function refresh() {
    const ov = await api("/api/admin/overview");
    $("now").textContent = ov.now;
    $("counters").innerHTML =
      "<tr><th>窗口</th><th>状态</th><th>当前服务</th></tr>" +
      ov.counters.map((c) =>
        `<tr><td>${c.name}</td><td class="${c.status === "paused" ? "paused" : ""}">${
          c.status === "open" ? "服务中" : "已暂停"}</td><td>${
          c.serving ? c.serving.number_label : "—"}</td></tr>`).join("");
    $("waiting").innerHTML =
      "<tr><th>号码</th><th>业务日</th><th>票据身份</th><th>取号时间</th></tr>" +
      ov.waiting.map((t) =>
        `<tr><td><b>${t.number_label}</b></td><td>${t.biz_date}</td>` +
        `<td title="跨日稳定身份">${t.ticket_id.slice(0, 8)}…</td><td>${t.created_at}</td></tr>`).join("");
    $("commands").innerHTML =
      "<tr><th>时间</th><th>号码</th><th>窗口</th><th>类型</th><th>状态</th><th>存活</th><th>操作</th></tr>" +
      ov.commands.map((c) => {
        const stale = c.stale ? `<span class="tag">待核对</span>` : "";
        return `<tr class="${c.stale ? "stale" : ""}">` +
          `<td>${c.created_at}</td><td><b>${c.number_label}</b></td><td>${c.counter_name}</td>` +
          `<td>${KIND_CN[c.kind] || c.kind}</td>` +
          `<td><span class="badge st-${c.state}">${STATE_CN[c.state]}</span>${stale}</td>` +
          `<td>${c.age_sec}s</td>` +
          `<td><button data-cmd="${c.command_id}" class="replay">重播</button></td></tr>`;
      }).join("");
    document.querySelectorAll("button.replay").forEach((b) =>
      b.addEventListener("click", async () => {
        await api(`/api/commands/${b.dataset.cmd}/replay`, { method: "POST" });
        refresh();
      }));
  }

  refresh();
  setInterval(refresh, 2000);
})();
