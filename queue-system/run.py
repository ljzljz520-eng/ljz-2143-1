#!/usr/bin/env python3
"""启动入口：python3 run.py --port 8000"""
import argparse

from server.app import create_server


def main():
    p = argparse.ArgumentParser(description="门店叫号系统")
    p.add_argument("--port", type=int, default=8000)
    p.add_argument("--db", default="queue.db")
    p.add_argument("--test-mode", action="store_true", help="启用测试时钟接口 /api/test/clock")
    args = p.parse_args()
    httpd = create_server(port=args.port, db_path=args.db, test_mode=args.test_mode or None)
    port = httpd.server_address[1]
    print(f"叫号系统已启动: http://127.0.0.1:{port}")
    print("  展示窗(C屏): /display      柜台端: /counter?counter=1")
    print("  管理端:      /admin        取号机: /kiosk")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
