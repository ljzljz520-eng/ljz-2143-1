"""可注入时钟：生产用真实时间；测试可冻结/推进时间（用于跨午夜验收）。"""
import threading
from datetime import datetime


class Clock:
    def __init__(self):
        self._lock = threading.Lock()
        self._fixed = None

    def now(self) -> datetime:
        with self._lock:
            if self._fixed is not None:
                return self._fixed
        return datetime.now()

    def set_fixed(self, dt: datetime) -> None:
        with self._lock:
            self._fixed = dt

    def clear(self) -> None:
        with self._lock:
            self._fixed = None


def iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%S")


def biz_date(dt: datetime) -> str:
    """业务日：号码按此日期重置。"""
    return dt.strftime("%Y-%m-%d")
