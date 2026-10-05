"""HTTP 层：REST API + 静态页面。仅依赖 Python 标准库。

写请求统一在 BEGIN IMMEDIATE 事务中执行；读请求直接查询（WAL 允许并发读）。
"""
import json
import os
import re
import traceback
import uuid
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

from . import core
from .clock import Clock, iso
from .db import connect, init_db

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATIC_DIR = os.path.join(BASE_DIR, "static")

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml",
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    ".ico": "image/x-icon", ".json": "application/json; charset=utf-8",
}
PAGE_ALIASES = {"/": "index.html", "/display": "display.html", "/counter": "counter.html",
                "/admin": "admin.html", "/kiosk": "kiosk.html"}


class QueueServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, addr, db_path, clock=None, test_mode=False,
                 stale_after=core.STALE_DEFAULT_SEC):
        super().__init__(addr, Handler)
        self.db_path = db_path
        self.clock = clock or Clock()
        self.test_mode = test_mode
        self.stale_after = stale_after


def create_server(port=0, db_path="queue.db", test_mode=None,
                  stale_after=core.STALE_DEFAULT_SEC) -> QueueServer:
    if test_mode is None:
        test_mode = os.environ.get("QUEUE_TEST_MODE") == "1"
    init_db(db_path, now_iso=iso(datetime.now()))
    return QueueServer(("127.0.0.1", port), db_path, test_mode=test_mode,
                       stale_after=stale_after)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):  # 静默访问日志
        pass

    # ------------------------------------------------------------ 基础工具
    def _send_json(self, status, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n == 0:
            return {}
        return json.loads(self.rfile.read(n).decode("utf-8") or "{}")

    def _read(self, fn):
        conn = connect(self.server.db_path)
        try:
            return fn(conn)
        finally:
            conn.close()

    def _write(self, fn):
        """在 IMMEDIATE 写事务中执行 fn(conn)，返回 (status, payload)。"""
        conn = connect(self.server.db_path)
        try:
            conn.execute("BEGIN IMMEDIATE")
            status, payload = fn(conn)
            conn.execute("COMMIT")
            return status, payload
        except Exception:
            try:
                conn.execute("ROLLBACK")
            except Exception:
                pass
            raise
        finally:
            conn.close()

    def _handle_error(self, e):
        if isinstance(e, core.ApiError):
            self._send_json(e.status, {"error": {"code": e.code, "message": e.message}})
        else:
            traceback.print_exc()
            self._send_json(500, {"error": {"code": "INTERNAL", "message": str(e)}})

    # ------------------------------------------------------------ 路由
    def do_GET(self):
        path = urlparse(self.path).path
        try:
            now = self.server.clock.now()
            if path == "/api/queue":
                return self._send_json(200, self._read(lambda c: core.queue_state(c)))
            if path == "/api/display/state":
                return self._send_json(200, self._read(lambda c: core.display_state(c, now)))
            if path == "/api/admin/overview":
                return self._send_json(200, self._read(
                    lambda c: core.admin_overview(c, now, self.server.stale_after)))
            m = re.fullmatch(r"/api/counters/(\d+)", path)
            if m:
                return self._send_json(200, self._read(
                    lambda c: core.counter_detail(c, int(m.group(1)))))
            if path == "/api/test/clock" and self.server.test_mode:
                return self._send_json(200, {"now": iso(now)})
            return self._static(path)
        except Exception as e:
            return self._handle_error(e)

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            body = self._read_json()
            now = self.server.clock.now()

            if path == "/api/tickets":
                terminal = body.get("terminal_id") or "unknown"
                return self._send_json(*self._write(
                    lambda c: (201, core.issue_ticket(c, terminal, now))))

            if path == "/api/leases":
                return self._send_json(*self._write(lambda c: (201, core.create_lease(
                    c, body.get("terminal_id") or "unknown", body.get("size", 10), now))))

            if path == "/api/tickets/sync":
                return self._send_json(*self._write(lambda c: (200, core.sync_tickets(
                    c, body.get("lease_id"), body.get("tickets") or [], now))))

            m = re.fullmatch(r"/api/counters/(\d+)/(serve-next|recall|done|pause|resume)", path)
            if m:
                cid, action = int(m.group(1)), m.group(2)
                if action == "serve-next":
                    command_id = body.get("command_id") or str(uuid.uuid4())
                    def fn(c):
                        cmd, idem = core.serve_next(c, cid, command_id, now)
                        return 200, {"command": cmd, "idempotent": idem}
                    return self._send_json(*self._write(fn))
                if action == "recall":
                    command_id = body.get("command_id") or str(uuid.uuid4())
                    def fn(c):
                        cmd, idem = core.recall(c, cid, command_id, now)
                        return 200, {"command": cmd, "idempotent": idem}
                    return self._send_json(*self._write(fn))
                if action == "done":
                    return self._send_json(*self._write(
                        lambda c: (200, {"ticket": core.done(c, cid, now)})))
                if action == "pause":
                    return self._send_json(*self._write(
                        lambda c: (200, {"counter": core.set_counter_status(c, cid, "paused", now)})))
                if action == "resume":
                    return self._send_json(*self._write(
                        lambda c: (200, {"counter": core.set_counter_status(c, cid, "open", now)})))

            if path == "/api/display/ack":
                return self._send_json(*self._write(lambda c: (200, {"command": core.ack_command(
                    c, body.get("command_id"), body.get("stage"),
                    body.get("played_via"), now)})))

            m = re.fullmatch(r"/api/commands/([0-9A-Za-z-]+)/(replay|confirm)", path)
            if m:
                cmd_id, action = m.group(1), m.group(2)
                if action == "replay":
                    return self._send_json(*self._write(
                        lambda c: (201, {"command": core.replay_command(c, cmd_id, now)})))
                return self._send_json(*self._write(
                    lambda c: (200, {"command": core.confirm_command(c, cmd_id, now)})))

            if path == "/api/test/clock" and self.server.test_mode:
                self.server.clock.set_fixed(datetime.strptime(body["now"], "%Y-%m-%dT%H:%M:%S"))
                return self._send_json(200, {"now": iso(self.server.clock.now())})

            return self._send_json(404, {"error": {"code": "NOT_FOUND", "message": path}})
        except Exception as e:
            return self._handle_error(e)

    def do_DELETE(self):
        path = urlparse(self.path).path
        if path == "/api/test/clock" and self.server.test_mode:
            self.server.clock.clear()
            return self._send_json(200, {"now": iso(self.server.clock.now())})
        return self._send_json(404, {"error": {"code": "NOT_FOUND", "message": path}})

    # ------------------------------------------------------------ 静态文件
    def _static(self, path):
        rel = PAGE_ALIASES.get(path)
        if rel is None:
            if not path.startswith("/static/"):
                return self._send_json(404, {"error": {"code": "NOT_FOUND", "message": path}})
            rel = path[len("/static/"):]
        rel = os.path.normpath(rel).lstrip("/")
        full = os.path.join(STATIC_DIR, rel)
        if not full.startswith(STATIC_DIR) or not os.path.isfile(full):
            return self._send_json(404, {"error": {"code": "NOT_FOUND", "message": rel}})
        with open(full, "rb") as f:
            data = f.read()
        ext = os.path.splitext(full)[1].lower()
        self.send_response(200)
        self.send_header("Content-Type", CONTENT_TYPES.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
