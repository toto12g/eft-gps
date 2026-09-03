#!/usr/bin/env python3
"""校正の目視検証用スクリーンショットを撮る。

    py tools/shoot_calib.py                 # SVG のある全マップ
    py tools/shoot_calib.py customs woods   # 指定したマップだけ

test/calib.html を headless Chrome で開き、tools/.shots/<map>.png に保存する。
脱出口のポリゴンが図の出口・扉に乗っていれば校正は正しい。
"""

import http.server
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SHOTS = ROOT / "tools" / ".shots"

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

    db = json.loads((ROOT / "data" / "mapdb.json").read_text(encoding="utf-8"))
    wanted = sys.argv[1:]
    targets = [m for m in db["maps"] if m.get("svg") and (not wanted or m["key"] in wanted)]
    if not targets:
        print("対象なし", file=sys.stderr)
        return 1

    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    handler = lambda *a, **kw: QuietHandler(*a, directory=str(ROOT), **kw)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()

    SHOTS.mkdir(parents=True, exist_ok=True)
    profile = os.path.join(tempfile.gettempdir(), "eft-gps-shot-profile")

    for m in targets:
        _vx, _vy, vw, vh = m["svgViewBox"]
        width = 1500
        height = min(2400, int(width * vh / vw) + 40)
        out = SHOTS / f"{m['key']}.png"
        subprocess.run(
            [
                browser, "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run",
                f"--user-data-dir={profile}",
                f"--window-size={width},{height}",
                "--virtual-time-budget=20000",
                "--hide-scrollbars",
                f"--screenshot={out}",
                f"http://127.0.0.1:{port}/test/calib.html?map={m['key']}",
            ],
            capture_output=True,
        )
        size = out.stat().st_size if out.exists() else 0
        print(f"  {m['key']:<20} {width}x{height}  {size:>9,} bytes  {out}")

    server.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
