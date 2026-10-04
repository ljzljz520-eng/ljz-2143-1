'use strict';
const crypto = require('crypto');
const clock = require('./clock');

const uuid = () => crypto.randomUUID();
const nowIso = () => new Date().toISOString();

class QueueError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/* ---------------------------------- 工具 ---------------------------------- */

function getTicket(db, id) {
  return db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
}

function getCounter(db, id) {
  return db.prepare('SELECT * FROM counters WHERE id = ?').get(id);
}

function logEvent(db, actor, action, detail) {
  db.prepare('INSERT INTO events (at, actor, action, detail) VALUES (?,?,?,?)')
    .run(nowIso(), actor || null, action, detail || null);
}

function insertCommand(db, { idemKey, type, target, counterId, ticketId, payload, replayOf, autoConfirm }) {
  const id = uuid();
  const now = nowIso();
  db.prepare(`INSERT INTO commands
    (id, idem_key, type, target, counter_id, ticket_id, payload, status, replay_of, created_at, confirmed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, idemKey, type, target, counterId || null, ticketId || null,
      JSON.stringify(payload || {}), autoConfirm ? 'CONFIRMED' : 'SAVED',
      replayOf || null, now, autoConfirm ? now : null);
  return db.prepare('SELECT * FROM commands WHERE id = ?').get(id);
}

/** 指令幂等重放检查：同键直接返回已存指令，绝不重复改状态 */
function findCommandByIdem(db, idemKey) {
  return db.prepare('SELECT * FROM commands WHERE idem_key = ?').get(idemKey);
}

function requireIdemKey(idemKey) {
  if (!idemKey || typeof idemKey !== 'string') {
    throw new QueueError(400, 'IDEM_KEY_REQUIRED', '指令必须携带幂等键 idemKey（客户端生成，重试时保持不变）');
  }
}

function callPayload(ticket, counter) {
  return {
    text: `请 ${ticket.seq} 号顾客到 ${counter.name} 办理业务`,
    seq: ticket.seq,
    bizDate: ticket.biz_date,
    counterId: counter.id,
    counterName: counter.name,
  };
}

/* -------------------------------- 领号（集中分配） -------------------------------- */
/**
 * 服务器集中分配：号码在单个数据库事务内由 daily_seq 原子递增产生。
 * 断网时终端无法安全发号（见 README 方案对比），故本操作要求在线。
 */
const issueTicket = (db, { idemKey } = {}) => db.transaction(() => {
  const key = idemKey || uuid();
  const dup = db.prepare('SELECT * FROM tickets WHERE idem_key = ?').get(key);
  if (dup) return { ticket: dup, deduplicated: true };

  const date = clock.bizDate();
  db.prepare('INSERT INTO daily_seq (biz_date, last_seq) VALUES (?, 0) ON CONFLICT(biz_date) DO NOTHING').run(date);
  const { last_seq } = db.prepare('UPDATE daily_seq SET last_seq = last_seq + 1 WHERE biz_date = ? RETURNING last_seq').get(date);

  const id = uuid();
  db.prepare(`INSERT INTO tickets (id, biz_date, seq, idem_key, status, created_at)
              VALUES (?,?,?,?, 'waiting', ?)`).run(id, date, last_seq, key, nowIso());
  logEvent(db, 'kiosk', 'ISSUE', `ticket=${id} seq=${last_seq}@${date}`);
  return { ticket: getTicket(db, id), deduplicated: false };
})();

/* -------------------------------- 叫号（原子认领） -------------------------------- */
/**
 * 多柜台竞争同一号码的防线：
 *  1) 整个“选号 + 改状态 + 落指令”在一个事务里；
 *  2) UPDATE ... WHERE status='waiting' 乐观认领，changes!==1 即失败；
 *  3) 指令幂等键唯一索引，网络重发/双击/断网重传都只产生一条指令。
 * （迁移到 PostgreSQL 时选号语句可换 SELECT ... FOR UPDATE SKIP LOCKED，语义不变。）
 */
const callNext = (db, { counterId, idemKey }) => db.transaction(() => {
  requireIdemKey(idemKey);
  const dup = findCommandByIdem(db, idemKey);
  if (dup) {
    if (dup.type !== 'CALL_NEXT' || dup.counter_id !== counterId) {
      throw new QueueError(409, 'IDEM_KEY_CONFLICT', '该幂等键已被其他指令占用');
    }
    return { command: dup, ticket: dup.ticket_id ? getTicket(db, dup.ticket_id) : null, deduplicated: true };
  }

  const counter = getCounter(db, counterId);
  if (!counter) throw new QueueError(404, 'COUNTER_NOT_FOUND', '柜台不存在');
  if (counter.status !== 'open') {
    throw new QueueError(409, 'COUNTER_NOT_OPEN', `窗口已${counter.status === 'paused' ? '暂停' : '关闭'}，不能叫号`);
  }
  if (counter.current_ticket_id) {
    const cur = getTicket(db, counter.current_ticket_id);
    if (cur && (cur.status === 'called' || cur.status === 'serving')) {
      throw new QueueError(409, 'ALREADY_SERVING', '当前有未办结的顾客，请先完成服务');
    }
  }

  // 跨日等待者优先：先按业务日期、再按当日序号
  const next = db.prepare(`SELECT * FROM tickets WHERE status = 'waiting'
                           ORDER BY biz_date ASC, seq ASC LIMIT 1`).get();
  if (!next) throw new QueueError(409, 'QUEUE_EMPTY', '没有等待中的号码');

  const claim = db.prepare(`UPDATE tickets SET status='called', counter_id=?, called_at=?, version=version+1
                            WHERE id=? AND status='waiting'`).run(counterId, nowIso(), next.id);
  if (claim.changes !== 1) throw new QueueError(409, 'CLAIM_LOST', '该号码已被其他柜台领取');

  db.prepare('UPDATE counters SET current_ticket_id=?, updated_at=? WHERE id=?')
    .run(next.id, nowIso(), counterId);

  const command = insertCommand(db, {
    idemKey, type: 'CALL_NEXT', target: 'display',
    counterId, ticketId: next.id, payload: callPayload(next, counter),
  });
  logEvent(db, counterId, 'CALL_NEXT', `ticket=${next.id} seq=${next.seq}@${next.biz_date}`);
  return { command, ticket: getTicket(db, next.id), deduplicated: false };
})();

/* ------------------------------ 暂停 / 恢复 / 完成 ------------------------------ */

const setCounterStatus = (db, { counterId, idemKey, status }) => db.transaction(() => {
  requireIdemKey(idemKey);
  const type = status === 'paused' ? 'PAUSE' : 'RESUME';
  const dup = findCommandByIdem(db, idemKey);
  if (dup) {
    if (dup.type !== type || dup.counter_id !== counterId) {
      throw new QueueError(409, 'IDEM_KEY_CONFLICT', '该幂等键已被其他指令占用');
    }
    return { command: dup, counter: getCounter(db, counterId), deduplicated: true };
  }
  const counter = getCounter(db, counterId);
  if (!counter) throw new QueueError(404, 'COUNTER_NOT_FOUND', '柜台不存在');

  db.prepare('UPDATE counters SET status=?, updated_at=? WHERE id=?').run(status, nowIso(), counterId);
  const command = insertCommand(db, {
    idemKey, type, target: 'counter', counterId,
    payload: { status }, autoConfirm: true, // 柜台自身状态在服务端落库即生效，无物理播报环节
  });
  logEvent(db, counterId, type, `status=${status}`);
  return { command, counter: getCounter(db, counterId), deduplicated: false };
})();

const completeCurrent = (db, { counterId, idemKey }) => db.transaction(() => {
  requireIdemKey(idemKey);
  const dup = findCommandByIdem(db, idemKey);
  if (dup) {
    if (dup.type !== 'COMPLETE' || dup.counter_id !== counterId) {
      throw new QueueError(409, 'IDEM_KEY_CONFLICT', '该幂等键已被其他指令占用');
    }
    return { command: dup, deduplicated: true };
  }
  const counter = getCounter(db, counterId);
  if (!counter) throw new QueueError(404, 'COUNTER_NOT_FOUND', '柜台不存在');
  if (!counter.current_ticket_id) throw new QueueError(409, 'NO_CURRENT', '当前没有服务中的顾客');

  const r = db.prepare(`UPDATE tickets SET status='done', done_at=?, version=version+1
                        WHERE id=? AND status IN ('called','serving')`).run(nowIso(), counter.current_ticket_id);
  if (r.changes !== 1) throw new QueueError(409, 'NOT_SERVING', '当前号码不在服务中状态');
  db.prepare('UPDATE counters SET current_ticket_id=NULL, updated_at=? WHERE id=?').run(nowIso(), counterId);

  const command = insertCommand(db, {
    idemKey, type: 'COMPLETE', target: 'counter', counterId,
    ticketId: counter.current_ticket_id, autoConfirm: true,
  });
  logEvent(db, counterId, 'COMPLETE', `ticket=${counter.current_ticket_id}`);
  return { command, deduplicated: false };
})();

/** 重呼当前号码：只新增播报指令，不改变任何排队状态 */
const recallCurrent = (db, { counterId, idemKey }) => db.transaction(() => {
  requireIdemKey(idemKey);
  const dup = findCommandByIdem(db, idemKey);
  if (dup) {
    if (dup.type !== 'RECALL' || dup.counter_id !== counterId) {
      throw new QueueError(409, 'IDEM_KEY_CONFLICT', '该幂等键已被其他指令占用');
    }
    return { command: dup, deduplicated: true };
  }
  const counter = getCounter(db, counterId);
  if (!counter) throw new QueueError(404, 'COUNTER_NOT_FOUND', '柜台不存在');
  const cur = counter.current_ticket_id ? getTicket(db, counter.current_ticket_id) : null;
  if (!cur || (cur.status !== 'called' && cur.status !== 'serving')) {
    throw new QueueError(409, 'NO_CURRENT', '当前没有可重呼的顾客');
  }
  const command = insertCommand(db, {
    idemKey, type: 'RECALL', target: 'display', counterId,
    ticketId: cur.id, payload: callPayload(cur, counter),
  });
  logEvent(db, counterId, 'RECALL', `ticket=${cur.id}`);
  return { command, deduplicated: false };
})();

/* --------------------------- 指令生命周期（三态） --------------------------- */
/** SAVED(已保存) --ack--> DELIVERED(终端已接收) --confirm--> CONFIRMED(现场已确认) */

const ackCommand = (db, { commandId, terminalId }) => db.transaction(() => {
  const cmd = db.prepare('SELECT * FROM commands WHERE id = ?').get(commandId);
  if (!cmd) throw new QueueError(404, 'COMMAND_NOT_FOUND', '指令不存在');
  if (cmd.target !== 'display') throw new QueueError(409, 'NOT_DISPLAY_CMD', '该指令不需要终端接收确认');
  if (cmd.status === 'SAVED') {
    db.prepare(`UPDATE commands SET status='DELIVERED', delivered_at=? WHERE id=? AND status='SAVED'`)
      .run(nowIso(), commandId);
    logEvent(db, terminalId || 'display', 'ACK', `command=${commandId}`);
  }
  return { command: db.prepare('SELECT * FROM commands WHERE id = ?').get(commandId) };
})();

const confirmCommand = (db, { commandId, actor }) => db.transaction(() => {
  const cmd = db.prepare('SELECT * FROM commands WHERE id = ?').get(commandId);
  if (!cmd) throw new QueueError(404, 'COMMAND_NOT_FOUND', '指令不存在');
  if (cmd.status !== 'CONFIRMED') {
    db.prepare(`UPDATE commands SET status='CONFIRMED', confirmed_at=? WHERE id=? AND status IN ('SAVED','DELIVERED')`)
      .run(nowIso(), commandId);
    // 播报被现场确认 => 该号码进入“服务中”
    if (cmd.ticket_id) {
      db.prepare(`UPDATE tickets SET status='serving', version=version+1 WHERE id=? AND status='called'`)
        .run(cmd.ticket_id);
    }
    logEvent(db, actor || 'display', 'CONFIRM', `command=${commandId}`);
  }
  return { command: db.prepare('SELECT * FROM commands WHERE id = ?').get(commandId) };
})();

/** 人工重播：生成一条新的 REPLAY 指令（自身也有幂等键），原指令保留待核对轨迹 */
const replayCommand = (db, { commandId, idemKey, actor }) => db.transaction(() => {
  requireIdemKey(idemKey);
  const dup = findCommandByIdem(db, idemKey);
  if (dup) {
    if (dup.type !== 'REPLAY' || dup.replay_of !== commandId) {
      throw new QueueError(409, 'IDEM_KEY_CONFLICT', '该幂等键已被其他指令占用');
    }
    return { command: dup, deduplicated: true };
  }
  const src = db.prepare('SELECT * FROM commands WHERE id = ?').get(commandId);
  if (!src) throw new QueueError(404, 'COMMAND_NOT_FOUND', '原指令不存在');
  if (src.target !== 'display') throw new QueueError(409, 'NOT_DISPLAY_CMD', '只有播报类指令可以重播');
  const command = insertCommand(db, {
    idemKey, type: 'REPLAY', target: 'display', counterId: src.counter_id,
    ticketId: src.ticket_id, payload: JSON.parse(src.payload), replayOf: src.id,
  });
  logEvent(db, actor || 'admin', 'REPLAY', `command=${commandId} -> ${command.id}`);
  return { command, deduplicated: false };
})();

/* --------------------------------- 查询 --------------------------------- */

function displayState(db) {
  const counters = db.prepare(`
    SELECT c.*, t.id AS t_id, t.seq AS t_seq, t.biz_date AS t_biz_date, t.status AS t_status
    FROM counters c LEFT JOIN tickets t ON t.id = c.current_ticket_id
    ORDER BY c.id`).all();
  const waiting = db.prepare(`SELECT id, biz_date, seq FROM tickets WHERE status='waiting'
                              ORDER BY biz_date, seq`).all();
  const pendingBroadcasts = db.prepare(`
    SELECT c.*, t.seq AS t_seq, t.biz_date AS t_biz_date
    FROM commands c LEFT JOIN tickets t ON t.id = c.ticket_id
    WHERE c.target='display' AND c.status IN ('SAVED','DELIVERED')
    ORDER BY c.created_at`).all()
    .map(c => ({ ...c, payload: JSON.parse(c.payload) }));
  return {
    now: nowIso(),
    bizDate: clock.bizDate(),
    counters: counters.map(c => ({
      id: c.id, name: c.name, status: c.status,
      current: c.t_id ? { id: c.t_id, seq: c.t_seq, bizDate: c.t_biz_date, status: c.t_status } : null,
    })),
    waitingCount: waiting.length,
    waitingPreview: waiting.slice(0, 8),
    pendingBroadcasts,
  };
}

function listTickets(db, { status } = {}) {
  const today = clock.bizDate();
  const rows = status
    ? db.prepare('SELECT * FROM tickets WHERE status=? ORDER BY biz_date, seq').all(status)
    : db.prepare('SELECT * FROM tickets ORDER BY biz_date, seq').all();
  return rows.map(t => ({ ...t, crossDay: t.biz_date !== today }));
}

function adminCommands(db, { status, pending } = {}) {
  let sql = `SELECT c.*, t.seq AS t_seq, t.biz_date AS t_biz_date, k.name AS counter_name
             FROM commands c
             LEFT JOIN tickets t ON t.id = c.ticket_id
             LEFT JOIN counters k ON k.id = c.counter_id`;
  const cond = [];
  const args = [];
  if (status) { cond.push('c.status = ?'); args.push(status); }
  if (pending === '1') { cond.push(`c.target='display' AND c.status != 'CONFIRMED'`); }
  if (cond.length) sql += ' WHERE ' + cond.join(' AND ');
  sql += ' ORDER BY c.created_at DESC LIMIT 200';
  return db.prepare(sql).all(...args).map(c => ({ ...c, payload: JSON.parse(c.payload) }));
}

module.exports = {
  QueueError,
  issueTicket, callNext, setCounterStatus, completeCurrent, recallCurrent,
  ackCommand, confirmCommand, replayCommand,
  displayState, listTickets, adminCommands,
  getTicket, getCounter,
};
