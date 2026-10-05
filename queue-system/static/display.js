/* C 展示窗终端。
 *
 * 播报可靠性设计（物理世界无法保证恰好一次，见 README）：
 * - 终端先回执 delivered（已接收），物理播报后再回执 played（已播报）；
 * - 已播放集合持久化在 localStorage：崩溃重启后不会自动重播已出声的指令
 *   （宁可人工核对，也不多播一次）；未播放的指令重启后自动补播；
 * - 服务端对超时未 played 的指令标记"待核对"，管理端可人工重播。
 */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const posterUrl = params.get("poster") || "/static/poster.svg";
  const PLAYED_KEY = "display.playedCommands.v1";

  // ---------- 海报探测：解码失败 → 降级 ----------
  function probePoster() {
    if (posterUrl !== "/static/poster.svg") {
      document.body.style.backgroundImage =
        PosterFallback.backgroundLayers(posterUrl);
    }
    const img = new Image();
    img.onload = () => PosterFallback.applyProbeResult(true, document.body.classList);
    img.onerror = () => {
      PosterFallback.applyProbeResult(false, document.body.classList);
      $("poster-badge").classList.remove("hidden");
    };
    img.src = posterUrl + (posterUrl.includes("?") ? "&" : "?") + "v=" + Date.now();
  }

  // ---------- 已播放集合（持久化，崩溃重启后不重复出声） ----------
  function loadPlayed() {
    try { return new Set(JSON.parse(localStorage.getItem(PLAYED_KEY) || "[]")); }
    catch { return new Set(); }
  }
  function savePlayed(s) {
    try { localStorage.setItem(PLAYED_KEY, JSON.stringify([...s].slice(-200))); } catch {}
  }
  let playedSet = loadPlayed();

  // ---------- 声音 ----------
  let audioEnabled = false;
  $("enable-audio").addEventListener("click", () => {
    audioEnabled = true;
    $("enable-audio").classList.add("hidden");
  });
  function ding() {
    if (!audioEnabled) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      [880, 660].forEach((f, i) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.value = f; o.connect(g); g.connect(ctx.destination);
        g.gain.setValueAtTime(0.25, ctx.currentTime + i * 0.25);
        o.start(ctx.currentTime + i * 0.25); o.stop(ctx.currentTime + i * 0.25 + 0.22);
      });
    } catch {}
  }
  function speak(text) {
    return new Promise((resolve) => {
      if (!audioEnabled || !("speechSynthesis" in window)) return resolve();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "zh-CN";
      const timer = setTimeout(resolve, 4000); // 兜底： utterance 事件不可靠
      u.onend = u.onerror = () => { clearTimeout(timer); resolve(); };
      speechSynthesis.speak(u);
    });
  }

  // ---------- 网络 ----------
  async function api(path, opts) {
    const res = await fetch(path, opts);
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  }
  async function ack(commandId, stage, via) {
    try {
      await api("/api/display/ack", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command_id: commandId, stage, played_via: via }),
      });
    } catch {}
  }

  // ---------- 播报 ----------
  let playing = false;
  async function playCommand(cmd) {
    await ack(cmd.command_id, "delivered");        // 1) 终端已接收
    if (playedSet.has(cmd.command_id)) return;     // 已物理播报过（如崩溃前）→ 不重复出声
    flash(cmd);                                    // 2) 物理播报：屏幕 + 声音
    ding();
    await speak(`请 ${cmd.number_label} 号，到 ${cmd.counter_name} 办理`);
    playedSet.add(cmd.command_id);                 // 3) 先落本地，再回执
    savePlayed(playedSet);                         //    崩溃时宁可人工核对也不多播
    await ack(cmd.command_id, "played", audioEnabled ? "voice+screen" : "screen");
  }
  function flash(cmd) {
    $("big-number").textContent = cmd.number_label;
    $("big-counter").textContent = "请前往 " + cmd.counter_name;
    const panel = $("now-panel");
    panel.classList.remove("flash"); void panel.offsetWidth;
    panel.classList.add("flash");
  }

  // ---------- 渲染 ----------
  function render(state) {
    $("waiting-count").textContent = state.waiting_count;
    const ul = $("serving-list");
    ul.innerHTML = "";
    for (const c of state.counters) {
      const li = document.createElement("li");
      const label = c.status !== "open" ? "（暂停）"
        : c.serving ? "" : "（空闲）";
      li.innerHTML = `<span>${c.counter_name}${label}</span>` +
        (c.serving ? `<span class="num">${c.serving.number_label}</span>` : `<span>—</span>`);
      ul.appendChild(li);
    }
    // 主屏显示最新一条叫号指令
    const latest = state.counters
      .map((c) => c.latest_command)
      .filter(Boolean)
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
    if (latest) {
      $("big-number").textContent = latest.number_label;
      const c = state.counters.find((x) => x.counter_id === latest.counter_id);
      $("big-counter").textContent = "请前往 " + (c ? c.counter_name : "");
    }
  }

  // ---------- 轮询（断网时保留最后画面） ----------
  async function poll() {
    try {
      const state = await api("/api/display/state");
      $("net-status").textContent = "";
      render(state);
      if (!playing) {
        playing = true;
        try {
          for (const cmd of state.pending_commands) await playCommand(cmd);
        } finally { playing = false; }
      }
    } catch {
      $("net-status").textContent = "⚠ 与服务器断开，展示最后已知状态…";
    }
  }

  probePoster();
  poll();
  setInterval(poll, 1500);
})();
