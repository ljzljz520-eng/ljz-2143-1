"""关系数据库（SQLite）模式与连接。

关键不变量由数据库层兜底：
1. tickets.UNIQUE(biz_date, seq_no)      —— 当日序号唯一（集中分配与租约同步都不能撞号）
2. 部分唯一索引 one_serving_per_counter   —— 一个柜台同一时刻至多一个"服务中"顾客
3. tickets 状态机由带条件的 UPDATE 守护   —— 同一顾客不能被两个柜台同时领走
4. call_commands.command_id 主键          —— 叫号指令幂等键，重发不产生第二条
"""
import sqlite3

SCHEMA = """
CREATE TABLE IF NOT EXISTS counters (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','paused','closed')),
  updated_at  TEXT NOT NULL
);

-- 每个业务日一个序号计数器：集中发号与租约分配共用，从源头杜绝撞号
CREATE TABLE IF NOT EXISTS seq_counters (
  biz_date  TEXT PRIMARY KEY,
  next_seq  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tickets (
  ticket_id    TEXT PRIMARY KEY,              -- 跨日稳定身份（UUID）
  biz_date     TEXT NOT NULL,                 -- 归属业务日（序号按它重置）
  seq_no       INTEGER NOT NULL,              -- 当日序号
  number_label TEXT NOT NULL,                 -- 展示号码，如 A023（跨日可重复！）
  status       TEXT NOT NULL DEFAULT 'waiting'
               CHECK (status IN ('waiting','serving','done','cancelled')),
  counter_id   INTEGER REFERENCES counters(id),
  issued_by    TEXT,
  lease_id     TEXT,
  created_at   TEXT NOT NULL,
  called_at    TEXT,
  done_at      TEXT,
  UNIQUE (biz_date, seq_no)
);
-- 同一柜台同一时刻至多一个服务中顾客
CREATE UNIQUE INDEX IF NOT EXISTS one_serving_per_counter
  ON tickets(counter_id) WHERE status = 'serving';
CREATE INDEX IF NOT EXISTS idx_tickets_waiting
  ON tickets(status, created_at);

-- 终端取号租约：预分配号段 [start_seq, end_seq]，断网时终端可在段内离线发号
CREATE TABLE IF NOT EXISTS leases (
  lease_id    TEXT PRIMARY KEY,
  terminal_id TEXT NOT NULL,
  biz_date    TEXT NOT NULL,
  start_seq   INTEGER NOT NULL,
  end_seq     INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','exhausted','revoked')),
  created_at  TEXT NOT NULL
);

-- 叫号指令：幂等 + 分段确认状态机 saved -> delivered -> played -> confirmed
CREATE TABLE IF NOT EXISTS call_commands (
  command_id   TEXT PRIMARY KEY,              -- 客户端生成的幂等键
  ticket_id    TEXT NOT NULL REFERENCES tickets(ticket_id),
  counter_id   INTEGER NOT NULL REFERENCES counters(id),
  counter_seq  INTEGER NOT NULL,              -- 该柜台第几条指令（终端排序/去重用）
  kind         TEXT NOT NULL DEFAULT 'call' CHECK (kind IN ('call','recall','replay')),
  state        TEXT NOT NULL DEFAULT 'saved'
               CHECK (state IN ('saved','delivered','played','confirmed')),
  replay_of    TEXT,                          -- 人工重播时指向原指令
  created_at   TEXT NOT NULL,
  delivered_at TEXT,
  played_at    TEXT,
  confirmed_at TEXT,
  played_via   TEXT
);
CREATE INDEX IF NOT EXISTS idx_commands_counter ON call_commands(counter_id, counter_seq);
CREATE INDEX IF NOT EXISTS idx_commands_state   ON call_commands(state, created_at);
"""


def connect(path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(path, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.isolation_level = None  # 手动控制事务（BEGIN IMMEDIATE / COMMIT）
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=10000")
    return conn


def init_db(path: str, counter_count: int = 3, now_iso: str = "") -> None:
    conn = connect(path)
    try:
        conn.executescript(SCHEMA)
        conn.execute("BEGIN IMMEDIATE")
        for i in range(1, counter_count + 1):
            conn.execute(
                "INSERT OR IGNORE INTO counters(id, name, status, updated_at) VALUES(?,?, 'open', ?)",
                (i, f"{i} 号窗口", now_iso or "2026-01-01T00:00:00"),
            )
        conn.execute("COMMIT")
    finally:
        conn.close()
