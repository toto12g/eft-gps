#!/usr/bin/env python3
"""校正ツールのスクリーンショットを撮る (動作確認用)。

    py tools/shoot_calib_ui.py customs 1     # 初期値から出発した状態
    py tools/shoot_calib_ui.py the-lab       # 未校正マップ
"""
import http.server, os, socket, subprocess, sys, tempfile, threading, urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SHOTS = ROOT / "tools" / ".shots"
BROWSERS = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
]

class Q(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass

def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    browser = next((p for p in BROWSERS if os.path.exists(p)), None)
    if not browser:
        return 2
    map_key = sys.argv[1] if len(sys.argv) > 1 else "customs"
    seed = sys.argv[2] if len(sys.argv) > 2 else ""
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0)); port = s.getsockname()[1]
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", port),
        lambda *a, **k: Q(*a, directory=str(ROOT), **k))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    SHOTS.mkdir(parents=True, exist_ok=True)
    out = SHOTS / f"calibui-{map_key}.png"
    q = urllib.parse.urlencode({"map": map_key, "seed": seed})
    subprocess.run([browser, "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run",
        f"--user-data-dir={os.path.join(tempfile.gettempdir(), 'eft-gps-shot-profile')}",
        "--window-size=1600,1000", "--virtual-time-budget=25000", "--hide-scrollbars",
        f"--screenshot={out}", f"http://127.0.0.1:{port}/calibrate.html?{q}"], capture_output=True)
    srv.shutdown()
    print(f"  {out}  {out.stat().st_size if out.exists() else 0:,} bytes")
    return 0

sys.exit(main())
