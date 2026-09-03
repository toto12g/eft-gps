#!/usr/bin/env python3
"""受け入れテストを 1 コマンドで走らせる。

    py tools/run_tests.py

静的サーバを一時ポートで立て、headless Chrome (無ければ Edge) で
test/index.html を開き、結果を標準出力に出す。失敗があれば終了コード 1。

Node は不要。ブラウザで動く本番と同じコードをそのまま実行する。
"""

import http.server
import os
import re
import html
import socket
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

BROWSERS = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
]


def find_browser() -> str:
    for p in BROWSERS:
        if os.path.exists(p):
            return p
    print("Chromium 系ブラウザが見つかりません。Chrome か Edge が必要です。", file=sys.stderr)
    sys.exit(2)


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    port = free_port()
    handler = lambda *a, **kw: QuietHandler(*a, directory=str(ROOT), **kw)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()

    browser = find_browser()
    profile = os.path.join(tempfile.gettempdir(), "eft-gps-test-profile")
    url = f"http://127.0.0.1:{port}/test/"

    proc = subprocess.run(
        [
            browser,
            "--headless=new",
            "--disable-gpu",
            "--no-sandbox",
            "--no-first-run",
            f"--user-data-dir={profile}",
            "--virtual-time-budget=30000",
            "--dump-dom",
            url,
        ],
        capture_output=True,
    )
    server.shutdown()

    dom = proc.stdout.decode("utf-8", errors="replace")
    m = re.search(r'(?s)<pre id="out">(.*?)</pre>', dom)
    if not m:
        print("テスト出力を取得できませんでした。", file=sys.stderr)
        print(dom[:3000], file=sys.stderr)
        return 2

    text = html.unescape(m.group(1)).strip()
    print(text)

    tail = re.search(r"RESULT pass=(\d+) fail=(\d+) skip=(\d+)", text)
    if not tail:
        return 2
    return 0 if int(tail.group(2)) == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
