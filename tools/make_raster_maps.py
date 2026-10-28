#!/usr/bin/env python3
"""SVG の地図が無いマップ（Labyrinth / Icebreaker）の地図を作る。

    py tools/make_raster_maps.py            # 元画像はキャッシュがあれば使う
    py tools/make_raster_maps.py --refresh  # 元画像を取り直す

the-hideout/tarkov-dev-svg-maps には Labyrinth と Icebreaker が無い。tarkov.dev 自身は
画像タイルで出しているが、タイルには利用条件が書かれていない。そこで、利用条件が
明記された re3mr の地図（CC BY-NC-SA 4.0, https://re3mr.com）を使う。

やること:
  1. 元画像を取る（tools/.cache/）
  2. headless Chrome で切り出して縮小し、WebP にする（maps/<map>/）
     Icebreaker は甲板 14 枚が横に並んだ 1 枚の絵なので、甲板ごとに同じ大きさの
     枠で切り出す。枠が同じなので、座標変換は全甲板で 1 つで済む
  3. 画像を <image> で並べた SVG を作る（maps/Labyrinth.svg, maps/Icebreaker.svg）。
     甲板は SVG のグループにするので、既存のフロア切り替えがそのまま効く
  4. data/calib-overrides.json に座標変換を書く（build_data.py が手動校正として読む）

座標変換は、地図上の目印とワールド座標の対応から求めた値を下に固定で持つ:
  Labyrinth  警報スイッチ 5 か所と脱出口 2 か所の最小二乗。残差 7〜31px（約 0.2〜0.9m）
  Icebreaker ヘリポートの中心を脱出口 Helicopter に合わせ、縮尺は POI が床に乗る割合
             （84%）が最大になる値。施錠扉 11 か所が地図の扉の印に重なることで確かめた
"""

import base64
import http.server
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "tools" / ".cache"
MAPS = ROOT / "maps"
OVERRIDES = ROOT / "data" / "calib-overrides.json"

BROWSERS = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
]

CREDIT = "map: re3mr (re3mr.com, CC BY-NC-SA 4.0)"
# 出力は元画像の半分の大きさ。地図 1 枚 1MB 前後に収める
SCALE = 0.5

# Icebreaker の甲板。左から順に re3mr の絵の並び（Lv10 → Lv-3）。
# 高さは tarkov-dev のレイヤに合わせ、re3mr が 1 枚にまとめている階は範囲もまとめる
ICE_PITCH = (7128 - 57) / 13
ICE_DECKS = [
    ("Bridge_Roof", "Bridge Roof", "Lv10", [43.8, 10000]),
    ("Bridge", "Bridge", "Lv9", [40.7, 43.7]),
    ("Stairs_blocked", "Stairs (blocked)", "Lv8", [37.6, 40.6]),
    ("Officers_Deck", "Officers' Deck", "Lv7", [34.5, 37.5]),
    ("Accommodation_upper", "Accommodation (upper)", "Lv6", [31.4, 34.4]),
    ("Accommodation_mid", "Accommodation (mid)", "Lv5", [28.3, 31.3]),
    ("Accommodation_lower", "Accommodation (lower)", "Lv4", [25.3, 28.2]),
    ("Gym_Canteen", "Gym / Canteen", "Lv3", [22.2, 25.2]),
    ("Helipad", "Helipad", "Lv2", [19.57, 22.1]),
    ("Infirmary", "Infirmary", "Lv1", [18.92, 19.56]),
    ("Storage_Security", "Storage / Security", "Lv0", [15, 18.93]),
    ("Fuel_Pumps", "Fuel Pumps", "Lv-1", [8.8, 14.9]),
    ("Engine_Room", "Engine Room", "Lv-2", [3.6, 8.7]),
    ("Lower_Automation", "Lower Automation", "Lv-3", [-10000, 3.5]),
]

# 元画像の画素（切り出し後）への座標変換。説明は冒頭を参照
LAB_CROP = (960, 240, 4800, 3780)
LAB_AFFINE = {"a": 0.80156922, "b": 33.5623937, "c": 1260.76471,
              "d": 33.0405741, "e": 0.32195180, "f": 1790.93365}
ICE_CROP = (500, 2520)  # 1 甲板の枠（左上は 57 + i*ICE_PITCH, 148）
ICE_AFFINE = {"a": -14.4, "b": 0.0, "c": 254.632, "d": 0.0, "e": 14.4, "f": 1292.832}

SOURCES = {
    "labyrinth": "https://www.re3mr.com/maps/Labyrinth/re3mrLabyrinthPNG.png",
    "icebreaker": "https://reemr.se/maps/Icebreaker/re3mrIcebreaker.png",
}


def fetch(name: str, url: str, refresh: bool) -> Path:
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / f"re3mr_{name}.png"
    if path.exists() and not refresh:
        return path
    print(f"  fetch {url}", file=sys.stderr)
    req = urllib.request.Request(url, headers={"User-Agent": "eft-gps-build/1.0"})
    with urllib.request.urlopen(req, timeout=300) as r:
        body = r.read()
    if not body.startswith(b"\x89PNG"):
        raise RuntimeError(f"{url} が PNG を返さなかった")
    path.write_bytes(body)
    return path


def crops():
    """(出力ファイル名, 元画像名, x0, y0, w, h) の一覧。"""
    out = [("labyrinth/main.webp", "labyrinth", LAB_CROP[0], LAB_CROP[1],
            LAB_CROP[2] - LAB_CROP[0], LAB_CROP[3] - LAB_CROP[1])]
    for i, (gid, _, _, _) in enumerate(ICE_DECKS):
        x0 = round(57 + i * ICE_PITCH)
        out.append((f"icebreaker/{gid}.webp", "icebreaker", x0, 148, ICE_CROP[0], ICE_CROP[1]))
    return out


# 画像はページに直接置く。load イベントは画像の読み込みまで待つので、
# そこで同期的に処理すれば --dump-dom が途中の状態を拾わない
PAGE = """<!doctype html><meta charset="utf-8">%s<pre id="out">running</pre><script>
addEventListener('load', () => {
  try {
    const jobs = %s;
    const scale = %s;
    const out = {};
    for (const [file, src, x, y, w, h] of jobs) {
      const img = document.getElementById('src-' + src);
      const c = document.createElement('canvas');
      c.width = Math.round(w * scale); c.height = Math.round(h * scale);
      const g = c.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(img, x, y, w, h, 0, 0, c.width, c.height);
      out[file] = c.toDataURL('image/webp', 0.82);
    }
    document.getElementById('out').textContent = JSON.stringify(out);
  } catch (e) {
    document.getElementById('out').textContent = 'ERROR ' + e;
  }
});
</script>"""


def render(images: dict) -> dict:
    """headless Chrome で切り出して WebP にする。{出力ファイル名: bytes}"""
    browser = next((p for p in BROWSERS if os.path.exists(p)), None)
    if not browser:
        raise RuntimeError("Chrome / Edge が見つかりません")
    tags = "".join(f'<img id="src-{n}" src="{n}.png" style="display:none">' for n in images)
    page = (PAGE % (tags, json.dumps(crops()), SCALE)).encode("utf-8")

    class H(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_GET(self):
            name = self.path.strip("/").split("?")[0]
            if name == "page.html":
                body, ctype = page, "text/html; charset=utf-8"
            elif name.endswith(".png") and name[:-4] in images:
                body, ctype = images[name[:-4]].read_bytes(), "image/png"
            else:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), H)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        r = subprocess.run(
            [browser, "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run",
             f"--user-data-dir={os.path.join(tempfile.gettempdir(), 'eft-gps-raster')}",
             "--virtual-time-budget=120000", "--dump-dom", f"http://127.0.0.1:{port}/page.html"],
            capture_output=True, timeout=600,
        )
    finally:
        server.shutdown()
    dom = r.stdout.decode("utf-8", "replace")
    start, end = dom.find('<pre id="out">'), dom.find("</pre>")
    text = dom[start + len('<pre id="out">'):end]
    if not text.startswith("{"):
        raise RuntimeError(f"切り出しに失敗: {text[:200]}")
    out = {}
    for name, url in json.loads(text).items():
        if not url.startswith("data:image/webp;base64,"):
            raise RuntimeError(f"{name} が WebP にならなかった（ブラウザが WebP 書き出しに未対応）")
        out[name] = base64.b64decode(url.split(",", 1)[1])
    return out


def write_atomic(path: Path, data) -> None:
    tmp = path.with_name(path.name + ".tmp")
    if isinstance(data, str):
        tmp.write_text(data, encoding="utf-8")
    else:
        tmp.write_bytes(data)
    os.replace(tmp, path)


def scaled(aff: dict) -> dict:
    """切り出した元画像の画素 → 出力画像（= SVG の viewBox）の座標変換。"""
    return {k: round(v * SCALE, 8) for k, v in aff.items()}


def svg_doc(w: int, h: int, groups: list) -> str:
    """画像を <image> で並べた SVG。href は index.html からの相対パス（SVG は文書に埋め込まれる）。"""
    body = "\n".join(
        f'  <g id="{gid}"><image href="maps/{href}" x="0" y="0" width="{w}" height="{h}"/></g>'
        for gid, href in groups
    )
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}">\n'
            f"  <!-- {CREDIT}。切り出して縮小した（tools/make_raster_maps.py） -->\n{body}\n</svg>\n")


def main():
    refresh = "--refresh" in sys.argv
    images = {name: fetch(name, url, refresh) for name, url in SOURCES.items()}
    files = render(images)
    for name, data in files.items():
        path = MAPS / name
        path.parent.mkdir(parents=True, exist_ok=True)
        write_atomic(path, data)
    total = sum(len(b) for b in files.values())
    print(f"  画像 {len(files)} 枚 / {total:,} バイト", file=sys.stderr)

    lw, lh = round((LAB_CROP[2] - LAB_CROP[0]) * SCALE), round((LAB_CROP[3] - LAB_CROP[1]) * SCALE)
    iw, ih = round(ICE_CROP[0] * SCALE), round(ICE_CROP[1] * SCALE)
    write_atomic(MAPS / "Labyrinth.svg", svg_doc(lw, lh, [("Main", "labyrinth/main.webp")]))
    write_atomic(MAPS / "Icebreaker.svg",
                 svg_doc(iw, ih, [(gid, f"icebreaker/{gid}.webp") for gid, _, _, _ in ICE_DECKS]))

    overrides = json.loads(OVERRIDES.read_text(encoding="utf-8")) if OVERRIDES.exists() else {}
    overrides["the-labyrinth"] = {
        "svg": "maps/Labyrinth.svg",
        "svgViewBox": [0, 0, lw, lh],
        "affine": scaled(LAB_AFFINE),
        "rms": None,
        "fit": {"method": "control-points", "points": 7, "residualPx": [14, 7, 31, 14, 13, 12, 13]},
        "points": [],
        "svgLayer": "Main",
        "credit": CREDIT,
        "note": "re3mr の地図。警報スイッチ 5 か所と脱出口 2 か所で合わせた（tools/make_raster_maps.py）",
    }
    overrides["icebreaker"] = {
        "svg": "maps/Icebreaker.svg",
        "svgViewBox": [0, 0, iw, ih],
        "affine": scaled(ICE_AFFINE),
        "rms": None,
        "fit": {"method": "anchor+overlap", "overlap": 0.841},
        "points": [],
        "svgLayer": "Infirmary",
        "credit": CREDIT,
        # re3mr の甲板 1 枚 = SVG のグループ 1 つ。tarkov-dev のレイヤをこれに置き換える
        "layers": [
            {"name": f"{label} {name}", "svgLayer": gid, "label": label,
             "extents": [{"height": height}]}
            for gid, name, label, height in ICE_DECKS
        ],
        "note": "re3mr の地図。甲板ごとに同じ枠で切り出した（tools/make_raster_maps.py）",
    }
    write_atomic(OVERRIDES, json.dumps(overrides, ensure_ascii=False, indent=2) + "\n")
    print("  maps/Labyrinth.svg, maps/Icebreaker.svg と calib-overrides.json を更新", file=sys.stderr)


if __name__ == "__main__":
    main()
