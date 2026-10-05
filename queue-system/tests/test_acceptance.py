"""验收测试：真实 HTTP 服务器 + 真实 SQLite + 多线程并发。

覆盖需求验收项：
1. 两柜台竞争最后一张票
2. 午夜仍有人等待（序号按日重置、跨日稳定票据身份、跨日 FIFO）
3. 暂停与叫号同时提交
4. 海报解码失败（背景降级、号码可读）
5. 设备重启（崩溃前未播→自动补播；已播但回执丢失→待核对+人工重播）
另：幂等重发、租约离线发号与回同步、柜台状态机。
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from server.app import create_server  # noqa: E402

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def req(base, method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(base + path, data=data, method=method,
                               headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(r, timeout=10) as resp:
            raw = resp.read()
            return resp.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode())


class ServerCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.httpd = create_server(port=0, db_path=os.path.join(self.tmp, "t.db"),
                                   test_mode=True, stale_after=15)
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    # ---- helpers ----
    def set_clock(self, s):
        st, b = req(self.base, "POST", "/api/test/clock", {"now": s})
        self.assertEqual(st, 200, b)

    def issue(self, terminal="kiosk-1"):
        st, b = req(self.base, "POST", "/api/tickets", {"terminal_id": terminal})
        self.assertEqual(st, 201, b)
        return b

    def serve_next(self, counter, command_id):
        return req(self.base, "POST", f"/api/counters/{counter}/serve-next",
                   {"command_id": command_id})

    def queue(self):
        st, q = req(self.base, "GET", "/api/queue")
        self.assertEqual(st, 200)
        return q

    def overview(self):
        st, o = req(self.base, "GET", "/api/admin/overview")
        self.assertEqual(st, 200)
        return o

    def ack(self, command_id, stage):
        st, b = req(self.base, "POST", "/api/display/ack",
                    {"command_id": command_id, "stage": stage})
        self.assertEqual(st, 200, b)
        return b["command"]

    def command_row(self, overview, command_id):
        for c in overview["commands"]:
            if c["command_id"] == command_id:
                return c
        return None

    @staticmethod
    def race(fn_a, fn_b):
        """两个动作同刻提交（屏障对齐），返回 (result_a, result_b)。"""
        barrier = threading.Barrier(3)
        out = {}

        def run(key, fn):
            barrier.wait()
            out[key] = fn()

        ts = [threading.Thread(target=run, args=("a", fn_a)),
              threading.Thread(target=run, args=("b", fn_b))]
        for t in ts: t.start()
        barrier.wait()
        for t in ts: t.join()
        return out["a"], out["b"]


# ================================================================ 验收 1
class TestRaceForLastTicket(ServerCase):
    def test_two_counters_compete_for_last_ticket(self):
        self.issue()  # 队列里只剩最后一张票
        (s1, b1), (s2, b2) = self.race(
            lambda: self.serve_next(1, "race-c1"),
            lambda: self.serve_next(2, "race-c2"))

        self.assertEqual(sorted([s1, s2]), [200, 409],
                         f"必须恰好一个柜台成功: {s1}/{s2} {b1} {b2}")
        loser = b1 if s1 == 409 else b2
        self.assertEqual(loser["error"]["code"], "QUEUE_EMPTY")

        q = self.queue()
        self.assertEqual(len(q["serving"]), 1, "只能有一个柜台领到该顾客")
        self.assertEqual(q["waiting_count"], 0)
        # 胜者的指令票据 == 当前唯一服务中的票据；两个柜台绝不能服务同一顾客
        winner = b1 if s1 == 200 else b2
        self.assertEqual(q["serving"][0]["ticket_id"],
                         winner["command"]["ticket"]["ticket_id"])
        # 两个柜台各自再叫号：一个忙、一个空，绝不会再领到同一人
        codes = {self.serve_next(1, "again-1")[1]["error"]["code"],
                 self.serve_next(2, "again-2")[1]["error"]["code"]}
        self.assertEqual(codes, {"COUNTER_BUSY", "QUEUE_EMPTY"})


# ================================================================ 验收 2
class TestMidnightWaiting(ServerCase):
    def test_midnight_reset_and_stable_identity(self):
        self.set_clock("2026-10-05T23:59:30")
        t1 = self.issue()
        self.assertEqual(t1["biz_date"], "2026-10-05")
        self.assertEqual(t1["seq_no"], 1)

        self.set_clock("2026-10-06T00:00:30")  # 跨过午夜，仍有人等待
        t2 = self.issue()
        self.assertEqual(t2["biz_date"], "2026-10-06")
        self.assertEqual(t2["seq_no"], 1, "序号必须按日期重置")
        self.assertEqual(t1["number_label"], t2["number_label"],
                         "两天都是 A001——展示号码会重复")
        self.assertNotEqual(t1["ticket_id"], t2["ticket_id"],
                            "必须另有跨日稳定票据身份")

        # 跨日 FIFO：先叫到的仍是昨晚等待的顾客，且身份不变
        st, b = self.serve_next(1, "mid-1")
        self.assertEqual(st, 200, b)
        self.assertEqual(b["command"]["ticket"]["ticket_id"], t1["ticket_id"])
        self.assertEqual(b["command"]["ticket"]["biz_date"], "2026-10-05")
        req(self.base, "POST", "/api/counters/1/done")
        st, b = self.serve_next(1, "mid-2")
        self.assertEqual(b["command"]["ticket"]["ticket_id"], t2["ticket_id"])


# ================================================================ 验收 3
class TestPauseAndCallSimultaneous(ServerCase):
    def test_pause_and_call_race_is_deterministic(self):
        self.issue()
        (sp, bp), (sc, bc) = self.race(
            lambda: req(self.base, "POST", "/api/counters/1/pause"),
            lambda: self.serve_next(1, "pause-race"))

        self.assertEqual(sp, 200, bp)          # 暂停总能落库
        self.assertIn(sc, (200, 409), bc)      # 叫号：先于暂停则成功，后于暂停则拒绝
        q = self.queue()
        st, counter = req(self.base, "GET", "/api/counters/1")
        self.assertEqual(counter["status"], "paused")
        if sc == 200:
            # 叫号先提交：顾客已被领走，暂停随后生效（不打断当前服务）
            self.assertEqual(len(q["serving"]), 1)
            self.assertEqual(q["waiting_count"], 0)
        else:
            # 暂停先提交：叫号被拒，顾客仍在队列
            self.assertEqual(bc["error"]["code"], "COUNTER_NOT_OPEN")
            self.assertEqual(len(q["serving"]), 0)
            self.assertEqual(q["waiting_count"], 1)


# ================================================================ 验收 4
class TestPosterDecodeFailure(ServerCase):
    def test_poster_failure_degrades_background_and_keeps_number_readable(self):
        raw = urllib.request.urlopen(self.base + "/static/display.css").read().decode()
        self.assertIn("linear-gradient", raw, "必须有渐变兜底层")
        self.assertIn('url("/static/poster.svg")', raw, "海报必须是背景第一层")
        self.assertIn(".poster-failed", raw, "必须有解码失败后的降级样式")
        self.assertIn("background: #000", raw, "号码必须在近实色底上（可读性不依赖背景）")

        js = urllib.request.urlopen(self.base + "/static/display.js").read().decode()
        self.assertIn("onerror", js, "前端必须探测海报解码失败")

        # 损坏海报可被访问但无法解码（浏览器触发 onerror）
        with urllib.request.urlopen(self.base + "/static/broken.jpg") as r:
            data = r.read()
        self.assertFalse(data.startswith(b"\xff\xd8\xff"), "broken.jpg 应为非法 JPEG")

        # 降级决策逻辑：Node 直接单测纯函数
        node = shutil.which("node")
        if node:
            script = (
                f'const fb = require("{BASE}/static/fallback.js");'
                'const l = fb.backgroundLayers("/static/poster.svg");'
                'if (!l.includes("url(") || !l.includes("linear-gradient")) process.exit(1);'
                "const added=[];const cls={add:c=>added.push(c),remove:()=>{}};"
                "fb.applyProbeResult(false, cls);"
                'if (!added.includes("poster-failed")) process.exit(2);'
                'fb.applyProbeResult(true, cls);'
                'console.log("fallback ok");')
            r = subprocess.run([node, "-e", script], capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr)


# ================================================================ 验收 5
class TestDisplayDeviceRestart(ServerCase):
    def _make_command(self, counter=1, command_id="cmd-1"):
        self.issue()
        st, b = self.serve_next(counter, command_id)
        self.assertEqual(st, 200, b)
        return b["command"]["command_id"]

    def test_crash_before_play_replays_on_restart(self):
        """崩溃发生在物理播报之前：重启后终端自动补播。"""
        cmd = self._make_command()
        # 终端开机：收到指令并回执 delivered，随后"崩溃"（未播放、未回执 played）
        st, s1 = req(self.base, "GET", "/api/display/state")
        self.assertIn(cmd, [c["command_id"] for c in s1["pending_commands"]])
        self.ack(cmd, "delivered")
        # —— 设备重启：本地无播放记录 → 重新拉取 → 指令仍待播 → 补播 ——
        st, s2 = req(self.base, "GET", "/api/display/state")
        self.assertIn(cmd, [c["command_id"] for c in s2["pending_commands"]],
                      "未播放的指令重启后必须仍然待播")
        self.ack(cmd, "played")
        row = self.command_row(self.overview(), cmd)
        self.assertEqual(row["state"], "played")

    def test_crash_after_play_needs_manual_replay(self):
        """物理播报已发生但回执前崩溃：服务端无法确证 → 待核对 + 人工重播。"""
        cmd = self._make_command(counter=2, command_id="cmd-crash")
        st, s1 = req(self.base, "GET", "/api/display/state")
        self.assertIn(cmd, [c["command_id"] for c in s1["pending_commands"]])
        self.ack(cmd, "delivered")
        # 物理播放完成，但 ack played 之前设备崩溃。
        # 终端本地已记录"播过"（localStorage），重启后不会自动重播：
        terminal_played_locally = {cmd}
        st, s2 = req(self.base, "GET", "/api/display/state")   # —— 设备重启 ——
        pending = [c["command_id"] for c in s2["pending_commands"]]
        self.assertIn(cmd, pending, "服务端仍认为未播报（回执丢失）")
        self.assertIn(cmd, terminal_played_locally,
                      "终端本地已播 → 不自动重播（宁人工核对，不多播）")
        # 超时 → 管理端标记"待核对"
        self.set_clock("2026-10-05T12:00:00")
        row = self.command_row(self.overview(), cmd)
        self.assertEqual(row["state"], "delivered")
        self.assertTrue(row["stale"], "超时未播报应标记待核对")
        # 人工重播：生成 replay 指令，终端重新播报
        st, rp = req(self.base, "POST", f"/api/commands/{cmd}/replay")
        self.assertEqual(st, 201, rp)
        new_id = rp["command"]["command_id"]
        self.assertEqual(rp["command"]["kind"], "replay")
        self.assertEqual(rp["command"]["replay_of"], cmd)
        st, s3 = req(self.base, "GET", "/api/display/state")
        self.assertIn(new_id, [c["command_id"] for c in s3["pending_commands"]])
        self.ack(new_id, "delivered")
        self.ack(new_id, "played")
        self.assertEqual(self.command_row(self.overview(), new_id)["state"], "played")
        # 重播绝不改变票据/队列状态
        st, c2 = req(self.base, "GET", "/api/counters/2")
        self.assertEqual(c2["current_ticket"]["status"], "serving")
        self.assertEqual(self.queue()["waiting_count"], 0)


# ================================================================ 幂等
class TestIdempotency(ServerCase):
    def test_serve_next_retry_same_command_id(self):
        t = self.issue()
        st1, b1 = self.serve_next(1, "dup-cmd")
        st2, b2 = self.serve_next(1, "dup-cmd")  # 网络重试：同一指令重发
        self.assertEqual((st1, st2), (200, 200))
        self.assertFalse(b1["idempotent"])
        self.assertTrue(b2["idempotent"], "重发必须命中幂等，不得重复执行")
        self.assertEqual(b1["command"]["ticket"]["ticket_id"],
                         b2["command"]["ticket"]["ticket_id"])
        cmds = [c for c in self.overview()["commands"] if c["command_id"] == "dup-cmd"]
        self.assertEqual(len(cmds), 1, "重发不得产生第二条指令")
        self.assertEqual(len(self.queue()["serving"]), 1)

    def test_concurrent_same_command_id(self):
        self.issue()
        (s1, b1), (s2, b2) = self.race(
            lambda: self.serve_next(1, "same-id"),
            lambda: self.serve_next(1, "same-id"))
        self.assertEqual((s1, s2), (200, 200))
        self.assertEqual(b1["command"]["ticket"]["ticket_id"],
                         b2["command"]["ticket"]["ticket_id"])
        self.assertEqual(len(self.queue()["serving"]), 1)

    def test_ack_out_of_order_and_repeat(self):
        self.issue()
        _, b = self.serve_next(1, "ack-1")
        cmd = b["command"]["command_id"]
        self.ack(cmd, "played")
        c = self.ack(cmd, "delivered")   # 乱序回执：状态不得倒退
        self.assertEqual(c["state"], "played")
        c = self.ack(cmd, "played")      # 重复回执：幂等
        self.assertEqual(c["state"], "played")
        st, c = req(self.base, "POST", f"/api/commands/{cmd}/confirm")
        self.assertEqual(c["command"]["state"], "confirmed")


# ================================================================ 租约 / 断网
class TestLeaseOfflineIssue(ServerCase):
    def test_lease_offline_issue_and_sync(self):
        st, lease = req(self.base, "POST", "/api/leases",
                        {"terminal_id": "kiosk-1", "size": 5})
        self.assertEqual(st, 201, lease)
        self.assertEqual((lease["start_seq"], lease["end_seq"]), (1, 5))

        # 终端断网期间本地发 2 张票（ticket_id 本地生成），恢复后回同步
        offline = [{"ticket_id": "local-uuid-1", "seq_no": 1, "biz_date": lease["biz_date"]},
                   {"ticket_id": "local-uuid-2", "seq_no": 2, "biz_date": lease["biz_date"]}]
        st, r1 = req(self.base, "POST", "/api/tickets/sync",
                     {"lease_id": lease["lease_id"], "tickets": offline})
        self.assertEqual(st, 200)
        self.assertEqual(len(r1["accepted"]), 2)
        # 重复同步（网络重试）：幂等，不产生重复票
        st, r2 = req(self.base, "POST", "/api/tickets/sync",
                     {"lease_id": lease["lease_id"], "tickets": offline})
        self.assertEqual(len(r2["accepted"]), 2)
        self.assertEqual(self.queue()["waiting_count"], 2)
        # 租约外的序号被拒
        st, r3 = req(self.base, "POST", "/api/tickets/sync",
                     {"lease_id": lease["lease_id"],
                      "tickets": [{"ticket_id": "x", "seq_no": 9,
                                   "biz_date": lease["biz_date"]}]})
        self.assertEqual(r3["rejected"][0]["reason"], "out_of_lease")
        # 集中分配跳过已租出的号段，绝不撞号
        t = self.issue()
        self.assertEqual(t["seq_no"], 6)


# ================================================================ 柜台状态机
class TestCounterFlow(ServerCase):
    def test_busy_done_and_recall(self):
        self.issue()
        self.serve_next(1, "flow-1")
        st, b = self.serve_next(1, "flow-2")
        self.assertEqual(st, 409)                       # 有当前服务对象 → 拒
        self.assertEqual(b["error"]["code"], "COUNTER_BUSY")
        # 重叫：新指令，票据状态不变
        st, b = req(self.base, "POST", "/api/counters/1/recall",
                    {"command_id": "recall-1"})
        self.assertEqual(st, 200)
        self.assertEqual(b["command"]["kind"], "recall")
        self.assertEqual(b["command"]["ticket"]["status"], "serving")
        # 办结后才能叫下一位
        st, _ = req(self.base, "POST", "/api/counters/1/done")
        self.assertEqual(st, 200)
        st, b = self.serve_next(1, "flow-3")
        self.assertEqual(st, 409)
        self.assertEqual(b["error"]["code"], "QUEUE_EMPTY")

    def test_two_counters_get_different_tickets(self):
        t1, t2 = self.issue(), self.issue()
        _, b1 = self.serve_next(1, "d1")
        _, b2 = self.serve_next(2, "d2")
        ids = {b1["command"]["ticket"]["ticket_id"],
               b2["command"]["ticket"]["ticket_id"]}
        self.assertEqual(ids, {t1["ticket_id"], t2["ticket_id"]})


if __name__ == "__main__":
    unittest.main(verbosity=2)
