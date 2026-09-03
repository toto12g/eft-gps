#!/usr/bin/env python3
"""アプリ本体のスクリーンショットを撮る (動作確認用)。

    py tools/shoot_app.py                       # 既定 (Streets + 実機サンプル)
    py tools/shoot_app.py customs               # マップを指定
    py tools/shoot_app.py customs "203, 4, 402" # 入力も指定

?map= と ?sample= を index.html に渡し、tools/.shots/app-<map>.png に保存する。
"""

import http.server
import os
import socket
import subprocess
import sys
import tempfile
import threading
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SHOTS = ROOT / "tools" / ".shots"

DEFAULT_SAMPLE = (
    "2026-09-03[07-31]_253.03, 4.36, 392.09_"
    "-0.02791, 0.97159, -0.18087, -0.15004_16.71 (0).png"
)

BROWSERS = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
]


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    browser = next((p for p in BROWSERS if os.path.exists(p)), None)
    if not browser:
        print("Chrome / Edge が見つかりません", file=sys.stderr)
        return 2

    map_key = sys.argv[1] if len(sys.argv) > 1 else "streets-of-tarkov"
    sample = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_SAMPLE

    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    handler = lambda *a, **kw: QuietHandler(*a, directory=str(ROOT), **kw)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()

    SHOTS.mkdir(parents=True, exist_ok=True)
    out = SHOTS / f"app-{map_key}.png"
    query = urllib.parse.urlencode({"map": map_key, "sample": sample})
    subprocess.run(
        [
            browser, "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run",
            f"--user-data-dir={os.path.join(tempfile.gettempdir(), 'eft-gps-shot-profile')}",
            "--window-size=1600,1000",
            "--virtual-time-budget=25000",
            "--hide-scrollbars",
            f"--screenshot={out}",
            f"http://127.0.0.1:{port}/index.html?{query}",
        ],
        capture_output=True,
    )
    server.shutdown()
    print(f"  {out}  {out.stat().st_size if out.exists() else 0:,} bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
