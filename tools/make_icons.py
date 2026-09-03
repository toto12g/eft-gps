#!/usr/bin/env python3
"""アプリのアイコンを生成する。

    py tools/make_icons.py

headless Chrome で HTML を描画してスクリーンショットを撮る方式。
画像ライブラリへの依存を増やさずに済む。出力は icons/icon-<size>.png。
"""

import http.server
import os
import socket
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ICONS = ROOT / "icons"
SIZES = [192, 512]

BROWSERS = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
]

HTML = """<!doctype html><meta charset="utf-8">
<style>
  html,body{margin:0;width:100%;height:100%;background:#0e1112}
  .wrap{width:100%;height:100%;display:grid;place-items:center}
  svg{width:78%;height:78%;display:block}
</style>
<div class="wrap">
<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <circle cx="50" cy="50" r="44" fill="none" stroke="#22e0ff" stroke-width="3.5" opacity=".38"/>
  <circle cx="50" cy="50" r="33" fill="none" stroke="#22e0ff" stroke-width="2" opacity=".2"/>
  <path d="M50 16 L74 82 L50 68 L26 82 Z" fill="#22e0ff"/>
  <path d="M50 16 L74 82 L50 68 L26 82 Z" fill="none" stroke="#0e1112" stroke-width="2.5"/>
</svg>
</div>
"""


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    browser = next((p for p in BROWSERS if os.path.exists(p)), None)
    if not browser:
        print("Chrome / Edge が見つかりません", file=sys.stderr)
        return 2

    ICONS.mkdir(parents=True, exist_ok=True)
    tmp = ROOT / "tools" / ".icon.html"
    tmp.write_text(HTML, encoding="utf-8")

    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    handler = lambda *a, **kw: QuietHandler(*a, directory=str(ROOT), **kw)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()

    for size in SIZES:
        out = ICONS / f"icon-{size}.png"
        subprocess.run(
            [
                browser, "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run",
                f"--user-data-dir={os.path.join(tempfile.gettempdir(), 'eft-gps-icon')}",
                f"--window-size={size},{size}",
                "--default-background-color=00000000",
                "--hide-scrollbars",
                "--virtual-time-budget=5000",
                f"--screenshot={out}",
                f"http://127.0.0.1:{port}/tools/.icon.html",
            ],
            capture_output=True,
        )
        print(f"  {out.name}  {out.stat().st_size if out.exists() else 0:,} bytes")

    server.shutdown()
    tmp.unlink(missing_ok=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
