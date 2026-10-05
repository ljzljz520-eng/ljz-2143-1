"""核心业务逻辑。

所有写操作都在调用方开启的 BEGIN IMMEDIATE 事务内执行：
- SQLite 写事务串行化 + 带条件的 UPDATE + 唯一索引，三重保证并发正确；
- 叫号指令以 command_id 为幂等键：重发只读不写，绝不重复改变排队状态。
"""
import sqlite3
import uuid
from datetime import datetime

from .clock import iso, biz_date

STALE_DEFAULT_SEC = 15  # 指令超过该时长仍未被终端确认播报 → 管理端标记"待核对"
COMMAND_ORDER = {"saved": 0, "delivered": 1, "played": 2, "confirmed": 3}


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def _d(row) -> dict:
    return {k: row[k] for k in row.keys()}


def _label(seq: int) -> str:
    return f"A{seq:03d}"


# ---------------------------------------------------------------- 发号 / 租约

def _allocate_block(conn, d: str, size: int):
    """从当日计数器原子分配号段 [start, end]。集中发号(size=1)与租约(size>1)共用。"""
    conn.execute(
        "INSERT INTO seq_counters(biz_date, next_seq) VALUES(?, 0) "
        "ON CONFLICT(biz_date) DO NOTHING",
        (d,),
    )
    start = conn.execute(
        "SELECT next_seq FROM seq_counters WHERE biz_date=?", (d,)
    ).fetchone()["next_seq"] + 1
    conn.execute("UPDATE seq_counters SET next_seq=? WHERE biz_date=?", (start + size - 1, d))
    return start, start + size - 1


def get_ticket(conn, ticket_id: str):
    row = conn.execute("SELECT * FROM tickets WHERE ticket_id=?", (ticket_id,)).fetchone()
    return _d(row) if row else None


def issue_ticket(conn, terminal_id: str, now: datetime) -> dict:
    """服务器集中分配：每次请求由服务端原子取下一个当日序号。"""
    d = biz_date(now)
    seq, _ = _allocate_block(conn, d, 1)
    tid = str(uuid.uuid4())
    conn.execute(
        "INSERT INTO tickets(ticket_id, biz_date, seq_no, number_label, status, issued_by, created_at)"
        " VALUES(?,?,?,?, 'waiting', ?, ?)",
        (tid, d, seq, _label(seq), terminal_id, iso(now)),
    )
    return get_ticket(conn, tid)


def create_lease(conn, terminal_id: str, size: int, now: datetime) -> dict:
    if not isinstance(size, int) or size < 1 or size > 500:
        raise ApiError(400, "BAD_SIZE", "租约大小须为 1..500")
    d = biz_date(now)
    start, end = _allocate_block(conn, d, size)
    lid = str(uuid.uuid4())
    conn.execute(
        "INSERT INTO leases(lease_id, terminal_id, biz_date, start_seq, end_seq, status, created_at)"
        " VALUES(?,?,?,?,?, 'active', ?)",
        (lid, terminal_id, d, start, end, iso(now)),
    )
    return {"lease_id": lid, "terminal_id": terminal_id, "biz_date": d,
            "start_seq": start, "end_seq": end, "status": "active", "created_at": iso(now)}


def sync_tickets(conn, lease_id: str, items: list, now: datetime) -> dict:
    """终端离线发号后的回同步。幂等：同 ticket_id 重复上报视为已接受。"""
    row = conn.execute("SELECT * FROM leases WHERE lease_id=?", (lease_id,)).fetchone()
    if not row:
        raise ApiError(404, "LEASE_NOT_FOUND", "租约不存在")
    lease = _d(row)
    accepted, rejected = [], []
    for it in items or []:
        tid, seq = it.get("ticket_id"), it.get("seq_no")
        bd = it.get("biz_date") or lease["biz_date"]
        if not tid or not isinstance(seq, int):
            rejected.append({"ticket_id": tid, "seq_no": seq, "reason": "missing_fields"})
            continue
        if bd != lease["biz_date"] or not (lease["start_seq"] <= seq <= lease["end_seq"]):
            rejected.append({"ticket_id": tid, "seq_no": seq, "reason": "out_of_lease"})
            continue
        if get_ticket(conn, tid):           # 重复同步 → 幂等接受
            accepted.append(tid)
            continue
        try:
            conn.execute(
                "INSERT INTO tickets(ticket_id, biz_date, seq_no, number_label, status, issued_by, lease_id, created_at)"
                " VALUES(?,?,?,?, 'waiting', ?,?, ?)",
                (tid, bd, seq, _label(seq), lease["terminal_id"], lease_id,
                 it.get("issued_at") or iso(now)),
            )
            accepted.append(tid)
        except sqlite3.IntegrityError:
            rejected.append({"ticket_id": tid, "seq_no": seq, "reason": "seq_conflict"})
    return {"accepted": accepted, "rejected": rejected}


# ---------------------------------------------------------------- 柜台动作

def _command_with_ticket(conn, cmd_row) -> dict:
    cmd = _d(cmd_row)
    cmd["ticket"] = get_ticket(conn, cmd["ticket_id"])
    return cmd


def _next_counter_seq(conn, counter_id: int) -> int:
    return conn.execute(
        "SELECT COALESCE(MAX(counter_seq),0)+1 AS s FROM call_commands WHERE counter_id=?",
        (counter_id,),
    ).fetchone()["s"]


def _get_counter(conn, counter_id: int):
    row = conn.execute("SELECT * FROM counters WHERE id=?", (counter_id,)).fetchone()
    if not row:
        raise ApiError(404, "COUNTER_NOT_FOUND", "柜台不存在")
    return row


def serve_next(conn, counter_id: int, command_id: str, now: datetime):
    """领号+叫号：原子地把队首顾客领为本柜台当前服务对象，并生成叫号指令。

    并发安全：BEGIN IMMEDIATE 串行化写事务；UPDATE...WHERE status='waiting'
    与部分唯一索引兜底——两个柜台绝不可能领到同一位顾客。
    幂等：command_id 已存在时直接返回首次结果，不重写任何状态。
    """
    existing = conn.execute(
        "SELECT * FROM call_commands WHERE command_id=?", (command_id,)).fetchone()
    if existing:
        return _command_with_ticket(conn, existing), True

    counter = _get_counter(conn, counter_id)
    if counter["status"] != "open":
        raise ApiError(409, "COUNTER_NOT_OPEN", f"窗口已{'暂停' if counter['status']=='paused' else '关闭'}，不能叫号")
    if conn.execute(
        "SELECT 1 FROM tickets WHERE counter_id=? AND status='serving'", (counter_id,)).fetchone():
        raise ApiError(409, "COUNTER_BUSY", "当前仍有服务对象，请先办结")

    ticket = conn.execute(
        "SELECT * FROM tickets WHERE status='waiting' ORDER BY created_at, rowid LIMIT 1"
    ).fetchone()
    if not ticket:
        raise ApiError(409, "QUEUE_EMPTY", "等待队列为空")

    cur = conn.execute(
        "UPDATE tickets SET status='serving', counter_id=?, called_at=?"
        " WHERE ticket_id=? AND status='waiting'",
        (counter_id, iso(now), ticket["ticket_id"]),
    )
    if cur.rowcount != 1:
        raise ApiError(409, "CLAIM_LOST", "该号码已被其他窗口领取")

    conn.execute(
        "INSERT INTO call_commands(command_id, ticket_id, counter_id, counter_seq, kind, state, created_at)"
        " VALUES(?,?,?,?, 'call', 'saved', ?)",
        (command_id, ticket["ticket_id"], counter_id, _next_counter_seq(conn, counter_id), iso(now)),
    )
    cmd = conn.execute("SELECT * FROM call_commands WHERE command_id=?", (command_id,)).fetchone()
    return _command_with_ticket(conn, cmd), False


def recall(conn, counter_id: int, command_id: str, now: datetime):
    """重叫当前顾客：新指令，不改变票据状态。"""
    existing = conn.execute(
        "SELECT * FROM call_commands WHERE command_id=?", (command_id,)).fetchone()
    if existing:
        return _command_with_ticket(conn, existing), True
    _get_counter(conn, counter_id)
    current = conn.execute(
        "SELECT * FROM tickets WHERE counter_id=? AND status='serving'", (counter_id,)).fetchone()
    if not current:
        raise ApiError(409, "NO_CURRENT", "当前没有服务对象")
    conn.execute(
        "INSERT INTO call_commands(command_id, ticket_id, counter_id, counter_seq, kind, state, created_at)"
        " VALUES(?,?,?,?, 'recall', 'saved', ?)",
        (command_id, current["ticket_id"], counter_id, _next_counter_seq(conn, counter_id), iso(now)),
    )
    cmd = conn.execute("SELECT * FROM call_commands WHERE command_id=?", (command_id,)).fetchone()
    return _command_with_ticket(conn, cmd), False


def done(conn, counter_id: int, now: datetime) -> dict:
    current = conn.execute(
        "SELECT * FROM tickets WHERE counter_id=? AND status='serving'", (counter_id,)).fetchone()
    if not current:
        raise ApiError(409, "NO_CURRENT", "当前没有服务对象")
    conn.execute(
        "UPDATE tickets SET status='done', done_at=? WHERE ticket_id=? AND status='serving'",
        (iso(now), current["ticket_id"]),
    )
    return get_ticket(conn, current["ticket_id"])


def set_counter_status(conn, counter_id: int, status: str, now: datetime) -> dict:
    _get_counter(conn, counter_id)
    conn.execute("UPDATE counters SET status=?, updated_at=? WHERE id=?",
                 (status, iso(now), counter_id))
    return _d(conn.execute("SELECT * FROM counters WHERE id=?", (counter_id,)).fetchone())


def counter_detail(conn, counter_id: int) -> dict:
    counter = _d(_get_counter(conn, counter_id))
    current = conn.execute(
        "SELECT * FROM tickets WHERE counter_id=? AND status='serving'", (counter_id,)).fetchone()
    cmd = conn.execute(
        "SELECT * FROM call_commands WHERE counter_id=? ORDER BY counter_seq DESC LIMIT 1",
        (counter_id,)).fetchone()
    counter["current_ticket"] = _d(current) if current else None
    counter["latest_command"] = _d(cmd) if cmd else None
    return counter


# ---------------------------------------------------------------- 指令状态机

def _get_command(conn, command_id: str):
    row = conn.execute("SELECT * FROM call_commands WHERE command_id=?", (command_id,)).fetchone()
    if not row:
        raise ApiError(404, "COMMAND_NOT_FOUND", "指令不存在")
    return row


def ack_command(conn, command_id: str, stage: str, played_via: str, now: datetime) -> dict:
    """终端回执。状态只前进不后退；重复/乱序回执被安全忽略（幂等）。"""
    row = _get_command(conn, command_id)
    cur = COMMAND_ORDER[row["state"]]
    if stage == "delivered" and cur < COMMAND_ORDER["delivered"]:
        conn.execute(
            "UPDATE call_commands SET state='delivered', delivered_at=? WHERE command_id=?",
            (iso(now), command_id))
    elif stage == "played" and cur < COMMAND_ORDER["played"]:
        conn.execute(
            "UPDATE call_commands SET state='played', played_at=?, played_via=?,"
            " delivered_at=COALESCE(delivered_at, ?) WHERE command_id=?",
            (iso(now), played_via, iso(now), command_id))
    return _d(_get_command(conn, command_id))


def confirm_command(conn, command_id: str, now: datetime) -> dict:
    """柜台确认：顾客已到场、服务已开始（现场已确认）。"""
    _get_command(conn, command_id)
    conn.execute(
        "UPDATE call_commands SET state='confirmed', confirmed_at=? WHERE command_id=?",
        (iso(now), command_id))
    return _d(_get_command(conn, command_id))


def replay_command(conn, command_id: str, now: datetime) -> dict:
    """人工重播：生成一条 replay 指令。只触发终端重新播报，绝不改变票据/队列状态。"""
    orig = _get_command(conn, command_id)
    new_id = str(uuid.uuid4())
    conn.execute(
        "INSERT INTO call_commands(command_id, ticket_id, counter_id, counter_seq, kind, state, replay_of, created_at)"
        " VALUES(?,?,?,?, 'replay', 'saved', ?, ?)",
        (new_id, orig["ticket_id"], orig["counter_id"],
         _next_counter_seq(conn, orig["counter_id"]), command_id, iso(now)),
    )
    return _command_with_ticket(conn, _get_command(conn, new_id))


# ---------------------------------------------------------------- 查询

def queue_state(conn) -> dict:
    waiting = [ _d(r) for r in conn.execute(
        "SELECT * FROM tickets WHERE status='waiting' ORDER BY created_at, rowid").fetchall()]
    serving = [ _d(r) for r in conn.execute(
        "SELECT t.*, c.name AS counter_name FROM tickets t JOIN counters c ON c.id=t.counter_id"
        " WHERE t.status='serving' ORDER BY t.counter_id").fetchall()]
    return {"waiting": waiting, "serving": serving, "waiting_count": len(waiting)}


def display_state(conn, now: datetime) -> dict:
    counters = []
    for c in conn.execute("SELECT * FROM counters ORDER BY id").fetchall():
        t = conn.execute(
            "SELECT * FROM tickets WHERE counter_id=? AND status='serving'", (c["id"],)).fetchone()
        cmd = conn.execute(
            "SELECT cc.*, t.number_label FROM call_commands cc JOIN tickets t ON t.ticket_id=cc.ticket_id"
            " WHERE cc.counter_id=? ORDER BY cc.counter_seq DESC LIMIT 1", (c["id"],)).fetchone()
        counters.append({
            "counter_id": c["id"], "counter_name": c["name"], "status": c["status"],
            "serving": _d(t) if t else None,
            "latest_command": _d(cmd) if cmd else None,
        })
    pending = [ _d(r) for r in conn.execute(
        "SELECT cc.*, t.number_label, c.name AS counter_name FROM call_commands cc"
        " JOIN tickets t ON t.ticket_id=cc.ticket_id JOIN counters c ON c.id=cc.counter_id"
        " WHERE cc.state IN ('saved','delivered') ORDER BY cc.created_at, cc.rowid").fetchall()]
    waiting_count = conn.execute(
        "SELECT COUNT(*) AS n FROM tickets WHERE status='waiting'").fetchone()["n"]
    return {"now": iso(now), "counters": counters,
            "pending_commands": pending, "waiting_count": waiting_count}


def admin_overview(conn, now: datetime, stale_after: int) -> dict:
    counters = []
    for c in conn.execute("SELECT * FROM counters ORDER BY id").fetchall():
        t = conn.execute(
            "SELECT ticket_id, number_label FROM tickets WHERE counter_id=? AND status='serving'",
            (c["id"],)).fetchone()
        counters.append({"id": c["id"], "name": c["name"], "status": c["status"],
                         "serving": _d(t) if t else None})
    waiting = [ _d(r) for r in conn.execute(
        "SELECT ticket_id, number_label, biz_date, created_at FROM tickets"
        " WHERE status='waiting' ORDER BY created_at, rowid").fetchall()]
    commands = []
    for r in conn.execute(
        "SELECT cc.*, t.number_label, c.name AS counter_name FROM call_commands cc"
        " JOIN tickets t ON t.ticket_id=cc.ticket_id JOIN counters c ON c.id=cc.counter_id"
        " ORDER BY cc.created_at DESC, cc.rowid DESC LIMIT 100").fetchall():
        cmd = _d(r)
        created = datetime.strptime(cmd["created_at"], "%Y-%m-%dT%H:%M:%S")
        cmd["age_sec"] = max(0, int((now - created).total_seconds()))
        # 已保存/终端已接收但超时未播报 → 待核对（可能设备崩溃，物理播报无法确认）
        cmd["stale"] = cmd["state"] in ("saved", "delivered") and cmd["age_sec"] > stale_after
        commands.append(cmd)
    return {"now": iso(now), "stale_after_sec": stale_after,
            "counters": counters, "waiting": waiting, "commands": commands}
