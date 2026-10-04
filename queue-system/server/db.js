'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

/**
 * 关系数据库（SQLite，WAL）。
 * 数据模型要点：
 *  - tickets.id 是 UUID：跨日稳定票据身份；seq 仅在 biz_date 内唯一（每日重置）。
 *  - commands.idem_key 唯一：叫号指令重发不会产生第二次状态变更。
 *  - commands.status: SAVED(已保存) -> DELIVERED(终端已接收) -> CONFIRMED(现场已确认)。
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS counters (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','paused','closed')),
  current_ticket_id TEXT REFERENCES tickets(id),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,                 -- UUID，跨日稳定身份
  biz_date TEXT NOT NULL,              -- 业务日期 YYYY-MM-DD
  seq INTEGER NOT NULL,                -- 当日序号（按日期重置）
  idem_key TEXT UNIQUE,                -- 领号幂等键
  status TEXT NOT NULL DEFAULT 'waiting'
    CHECK (status IN ('waiting','called','serving','done')),
  counter_id TEXT REFERENCES counters(id),
  created_at TEXT NOT NULL,
  called_at TEXT,
  done_at TEXT,
  version INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_tickets_day_seq ON tickets(biz_date, seq);
CREATE INDEX IF NOT EXISTS ix_tickets_status ON tickets(status, biz_date, seq);

CREATE TABLE IF NOT EXISTS daily_seq (
  biz_date TEXT PRIMARY KEY,
  last_seq INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS commands (
  id TEXT PRIMARY KEY,
  idem_key TEXT NOT NULL UNIQUE,       -- 指令幂等键
  type TEXT NOT NULL CHECK (type IN ('CALL_NEXT','RECALL','REPLAY','PAUSE','RESUME','COMPLETE')),
  target TEXT NOT NULL CHECK (target IN ('display','counter')),
  counter_id TEXT,
  ticket_id TEXT REFERENCES tickets(id),
  payload TEXT NOT NULL DEFAULT '{}',  -- JSON：播报文本等
  status TEXT NOT NULL DEFAULT 'SAVED' CHECK (status IN ('SAVED','DELIVERED','CONFIRMED')),
  replay_of TEXT REFERENCES commands(id),
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  confirmed_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_commands_status ON commands(target, status, created_at);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor TEXT,
  action TEXT NOT NULL,
  detail TEXT
);
`;

function open(dbPath) {
  const p = dbPath || process.env.QUEUE_DB || path.join(__dirname, '..', 'data', 'queue.db');
  if (p !== ':memory:') fs.mkdirSync(path.dirname(p), { recursive: true });
  const db = new Database(p);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  return db;
}

function seedCounters(db) {
  const ins = db.prepare(`INSERT INTO counters (id, name, status, updated_at)
                          VALUES (?, ?, 'open', ?)
                          ON CONFLICT(id) DO NOTHING`);
  const now = new Date().toISOString();
  [['C1', '1 号窗口'], ['C2', '2 号窗口'], ['C3', '3 号窗口']].forEach(([id, name]) => ins.run(id, name, now));
}

module.exports = { open, seedCounters };
