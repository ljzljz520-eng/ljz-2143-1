'use strict';
/**
 * 验收测试：
 *  1. 两柜台竞争最后一张票
 *  2. 叫号指令重发（幂等，不重复改变排队状态）
 *  3. 午夜仍有人等待（号码按日重置 + 跨日稳定票据身份）
 *  4. 暂停与叫号同时提交
 *  5. 海报解码失败（背景降级不影响号码可读）
 *  6. 设备重启（待核对状态 + 人工重播入口）
 *  7. 断网离线队列（允许暂存的动作）
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

process.env.QUEUE_TEST_HOOKS = '1';
const { createApp } = require('../server');
const Display = require('../public/display.js');
const Common = require('../public/common.js');

const uuid = () => crypto.randomUUID();

function start() {
  const { app, db } = createApp({ dbPath: ':memory:' });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base, db,
    close: () => { server.closeAllConnections?.(); return new Promise(r => server.close(r)); },
  };
}

async function api(base, p, opts = {}) {
  const res = await fetch(base + p, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}
const issue = (base) => api(base, '/api/tickets', { method: 'POST', body: { idemKey: uuid() } });
const callNext = (base, c, key = uuid()) => api(base, `/api/counters/${c}/call-next`, { method: 'POST', body: { idemKey: key } });
const pause = (base, c, key = uuid()) => api(base, `/api/counters/${c}/pause`, { method: 'POST', body: { idemKey: key } });
const resume = (base, c, key = uuid()) => api(base, `/api/counters/${c}/resume`, { method: 'POST', body: { idemKey: key } });
const complete = (base, c, key = uuid()) => api(base, `/api/counters/${c}/complete`, { method: 'POST', body: { idemKey: key } });
const setClock = (base, date) => api(base, '/api/_test/clock', { method: 'POST', body: { date } });

/* ---------- 1. 两柜台竞争最后一张票 ---------- */
test('两柜台竞争最后一张票：恰好一个成功，顾客不会被两个柜台同时领走', async (t) => {
  const { base, db, close } = start();
  t.after(close);
  await issue(base); // 只剩这一张票

  const [r1, r2] = await Promise.all([callNext(base, 'C1'), callNext(base, 'C2')]);
  const results = [r1, r2];
  const ok = results.filter(r => r.status === 200);
  const empty = results.filter(r => r.status === 409 && r.body.error.code === 'QUEUE_EMPTY');
  assert.equal(ok.length, 1, '恰好一个柜台叫到');
  assert.equal(empty.length, 1, '另一个收到队列已空');

  const winner = ok[0].body.ticket.counter_id;
  const ticket = db.prepare("SELECT * FROM tickets WHERE status != 'done'").get();
  assert.equal(ticket.counter_id, winner, '票据只归属获胜柜台');
  const currents = db.prepare('SELECT id, current_ticket_id FROM counters WHERE current_ticket_id IS NOT NULL').all();
  assert.equal(currents.length, 1, '只有一个柜台持有当前顾客');
  assert.equal(currents[0].id, winner);
  const callCmds = db.prepare("SELECT * FROM commands WHERE type='CALL_NEXT'").all();
  assert.equal(callCmds.length, 1, '只产生一条叫号指令');

  // 再发两张票：两个柜台各叫一张，必须是不同顾客
  await issue(base); await issue(base);
  await complete(base, winner);
  const [a, b] = await Promise.all([callNext(base, 'C1'), callNext(base, 'C2')]);
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.notEqual(a.body.ticket.id, b.body.ticket.id, '同一顾客不会被两个柜台同时领为服务对象');
});

/* ---------- 2. 叫号指令重发幂等 ---------- */
test('叫号指令重发：同一幂等键重发/并发重发都不重复改变排队状态', async (t) => {
  const { base, db, close } = start();
  t.after(close);
  await issue(base);
  const key = uuid();

  const first = await callNext(base, 'C1', key);
  assert.equal(first.status, 200);
  // 网络重试：同键重发
  const retry = await callNext(base, 'C1', key);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.command.id, first.body.command.id, '返回同一条指令');
  assert.equal(retry.body.deduplicated, true);
  // 并发同键重发
  const burst = await Promise.all(Array.from({ length: 5 }, () => callNext(base, 'C1', key)));
  assert.ok(burst.every(r => r.status === 200 && r.body.command.id === first.body.command.id));

  assert.equal(db.prepare('SELECT COUNT(*) n FROM commands WHERE idem_key=?').get(key).n, 1, '指令只落库一次');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM tickets WHERE status='called'").get().n, 1);
  assert.equal(db.prepare('SELECT version v FROM tickets').get().v, 1, '票据状态只变更过一次');

  // 同一键被挪作他用 → 拒绝
  const conflict = await pause(base, 'C1', key);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'IDEM_KEY_CONFLICT');
});

/* ---------- 3. 午夜仍有人等待 ---------- */
test('午夜仍有人等待：号码按日重置，票据 UUID 跨日稳定，跨日等待者优先', async (t) => {
  const { base, close } = start();
  t.after(close);
  await setClock(base, '2026-10-04');
  const t1 = (await issue(base)).body.ticket;
  const t2 = (await issue(base)).body.ticket;
  assert.deepEqual([t1.seq, t2.seq], [1, 2]);

  // 午夜跨日：昨天的人还在等
  await setClock(base, '2026-10-05');
  const t3 = (await issue(base)).body.ticket;
  assert.equal(t3.seq, 1, '新一天号码从 1 重置');
  assert.notEqual(t3.id, t1.id, '每张票有独立的跨日稳定身份');

  const waiting = (await api(base, '/api/tickets?status=waiting')).body.tickets;
  assert.equal(waiting.length, 3);
  assert.equal(waiting.filter(t => t.crossDay).length, 2, '管理端能识别跨日等待者');

  // 叫号顺序：跨日等待者优先，且票据身份不变
  const c1 = (await callNext(base, 'C1')).body.ticket;
  assert.equal(c1.id, t1.id);
  assert.equal(c1.biz_date, '2026-10-04');
  await complete(base, 'C1');
  const c2 = (await callNext(base, 'C1')).body.ticket;
  assert.equal(c2.id, t2.id);
  await complete(base, 'C1');
  const c3 = (await callNext(base, 'C1')).body.ticket;
  assert.equal(c3.id, t3.id, '昨日等待者清零后才轮到今日号码');
  await setClock(base, null);
});

/* ---------- 4. 暂停与叫号同时提交 ---------- */
test('暂停与叫号同时提交：结果必为两种合法终态之一，绝不出现中间态', async (t) => {
  const { base, db, close } = start();
  t.after(close);
  for (let round = 0; round < 20; round++) {
    await issue(base);
    const [p, c] = await Promise.all([pause(base, 'C1'), callNext(base, 'C1')]);
    assert.equal(p.status, 200, '暂停总是成功');
    const counter = db.prepare("SELECT * FROM counters WHERE id='C1'").get();
    assert.equal(counter.status, 'paused', '最终必为暂停');
    if (c.status === 200) {
      // 叫号先提交：票已被叫出，随后窗口暂停（允许暂停中带当前顾客）
      assert.equal(counter.current_ticket_id, c.body.ticket.id);
      assert.equal(db.prepare('SELECT status FROM tickets WHERE id=?').get(c.body.ticket.id).status, 'called');
    } else {
      // 暂停先提交：叫号被拒绝，队列不受影响
      assert.equal(c.status, 409);
      assert.equal(c.body.error.code, 'COUNTER_NOT_OPEN');
      assert.equal(counter.current_ticket_id, null);
    }
    // 复位：恢复窗口；若有当前顾客则办结
    await resume(base, 'C1');
    if (counter.current_ticket_id) await complete(base, 'C1');
  }
  // 确定的顺序语义：先暂停再叫号必被拒
  await pause(base, 'C1');
  const denied = await callNext(base, 'C1');
  assert.equal(denied.status, 409);
  assert.equal(denied.body.error.code, 'COUNTER_NOT_OPEN');
});

/* ---------- 5. 海报解码失败 ---------- */
test('海报解码失败：降级背景生效，且号码可读性不依赖背景图', async (t) => {
  const { base, close } = start();
  t.after(close);
  // 正常海报可用
  const poster = await fetch(base + '/poster.svg');
  assert.equal(poster.status, 200);
  assert.match(poster.headers.get('content-type'), /svg/);
  assert.match(await poster.text(), /<svg/);

  // 损坏海报：内容类型声称是图片，字节无法解码
  const corrupt = await fetch(base + '/api/_test/corrupt-poster');
  assert.equal(corrupt.status, 200);
  const bytes = Buffer.from(await corrupt.arrayBuffer());
  assert.ok(!bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])), '不是合法 PNG 魔数');
  assert.ok(!bytes.toString('utf8').includes('<svg'), '也不是合法 SVG');

  // 展示窗降级逻辑：解码失败 → bg-fallback
  assert.equal(Display.posterOkToClass(false), 'bg-fallback');
  assert.equal(Display.posterOkToClass(true), '');

  // 可读性：号码面板自带高对比衬底与文字阴影，与背景图解耦
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
  const panel = css.match(/\.contrast-panel\s*\{[^}]+\}/s)[0];
  assert.match(panel, /rgba\(2, 6, 23/, '面板有深色半透明衬底');
  assert.match(css, /text-shadow/, '号码有文字阴影');
  assert.match(css, /body\.display\.bg-fallback\s*\{[^}]*linear-gradient/s, '降级背景为纯 CSS 渐变');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'display.html'), 'utf8');
  assert.match(html, /class="contrast-panel"|id="board"/, '号码渲染在对比面板容器内');
});

/* ---------- 6. 设备重启：待核对 + 人工重播 ---------- */
test('设备重启：已接收未确认的指令进入待核对，提供人工重播与人工确认', async (t) => {
  const { base, close } = start();
  t.after(close);
  await issue(base);
  const call = (await callNext(base, 'C1')).body.command;
  assert.equal(call.status, 'SAVED', '指令已保存');

  // 展示窗收到并开始播报 → ack；随后设备崩溃，confirm 永远丢失
  await api(base, `/api/commands/${call.id}/ack`, { method: 'POST', body: { terminalId: 'display-1' } });
  let cmd = (await api(base, `/api/admin/commands?status=DELIVERED`)).body.commands[0];
  assert.equal(cmd.status, 'DELIVERED', '终端已接收但未确认 —— 服务端无法断定物理播报是否发生');

  // 设备重启：拉取状态，该指令被分类为“待核对”，绝不自动重播
  const state = (await api(base, '/api/display/state')).body;
  const pending = state.pendingBroadcasts.find(c => c.id === call.id);
  assert.ok(pending, '重启后仍看到未确认指令');
  assert.equal(Display.classifyCommand(pending), 'verify', '重启后不自动重播，等待人工核对');
  assert.equal(Display.classifyCommand({ ...pending, status: 'SAVED' }), 'autoplay');
  assert.equal(Display.classifyCommand({ ...pending, status: 'CONFIRMED' }), 'done');

  // 管理端待核对列表可见
  const adminPending = (await api(base, '/api/admin/commands?pending=1')).body.commands;
  assert.ok(adminPending.some(c => c.id === call.id));

  // 人工重播入口：生成 REPLAY 指令，重播自身也幂等
  const replayKey = uuid();
  const rp1 = await api(base, `/api/commands/${call.id}/replay`, { method: 'POST', body: { idemKey: replayKey, actor: 'admin' } });
  const rp2 = await api(base, `/api/commands/${call.id}/replay`, { method: 'POST', body: { idemKey: replayKey, actor: 'admin' } });
  assert.equal(rp1.body.command.id, rp2.body.command.id, '重播指令重发不重复');
  assert.equal(rp1.body.command.type, 'REPLAY');
  assert.equal(rp1.body.command.replay_of, call.id);

  // 重播完成 → 现场确认，号码进入“服务中”
  await api(base, `/api/commands/${rp1.body.command.id}/ack`, { method: 'POST', body: {} });
  await api(base, `/api/commands/${rp1.body.command.id}/confirm`, { method: 'POST', body: { actor: 'display-1' } });
  const ticket = (await api(base, '/api/tickets')).body.tickets[0];
  assert.equal(ticket.status, 'serving', '现场确认后进入服务中');

  // 人工确认入口：直接标记已播
  await api(base, `/api/commands/${call.id}/confirm`, { method: 'POST', body: { actor: 'admin:manual' } });
  const done = (await api(base, `/api/admin/commands?status=CONFIRMED`)).body.commands;
  assert.ok(done.some(c => c.id === call.id));
});

/* ---------- 7. 断网离线队列 ---------- */
test('断网：允许暂存的动作带幂等键入队，恢复后按序同步且不重复', async (t) => {
  const storage = (() => { const m = new Map(); return {
    getItem: k => m.has(k) ? m.get(k) : null,
    setItem: (k, v) => m.set(k, String(v)),
  }; })();
  const q = new Common.OfflineQueue('test.q', storage);

  const a1 = { action: 'pause', path: '/api/counters/C1/pause', idemKey: uuid() };
  const a2 = { action: 'complete', path: '/api/counters/C1/complete', idemKey: uuid() };
  q.push(a1); q.push(a2);
  assert.equal(q.length, 2);

  // 仍然断网：drain 遇 OFFLINE 停止并保留
  const r1 = await q.drain(async () => { const e = new Error('x'); e.code = 'OFFLINE'; throw e; });
  assert.equal(r1.length, 0);
  assert.equal(q.length, 2, '断网时动作保留不丢失');

  // 恢复网络：按序回放，键不变
  const sent = [];
  const r2 = await q.drain(async item => { sent.push(item); });
  assert.equal(r2.filter(x => x.ok).length, 2);
  assert.deepEqual(sent.map(s => s.idemKey), [a1.idemKey, a2.idemKey], '幂等键在重放中保持不变');
  assert.equal(q.length, 0);

  // 业务拒绝（如窗口状态已变化）：丢弃该条继续后续，不无限重试
  q.push({ action: 'pause', path: '/x', idemKey: uuid() });
  q.push({ action: 'resume', path: '/y', idemKey: uuid() });
  let n = 0;
  await q.drain(async () => { n++; if (n === 1) { const e = new Error('x'); e.code = 'COUNTER_NOT_OPEN'; throw e; } });
  assert.equal(q.length, 0, '被拒动作丢弃，其余照常同步');
});

/* ---------- 附加：完成服务后才能叫下一位 ---------- */
test('柜台有未办结顾客时不能叫下一位；完成后方可', async (t) => {
  const { base, close } = start();
  t.after(close);
  await issue(base); await issue(base);
  assert.equal((await callNext(base, 'C1')).status, 200);
  const again = await callNext(base, 'C1');
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'ALREADY_SERVING');
  assert.equal((await complete(base, 'C1')).status, 200);
  assert.equal((await callNext(base, 'C1')).status, 200);
});
