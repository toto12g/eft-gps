#!/usr/bin/env python3
"""実機のスクリーンショットをまとめて解析する。

    py tools/analyze_shots.py                       # 既定のスクショフォルダ
    py tools/analyze_shots.py "D:\\path\\to\\folder"

ファイル名だけを読み、位置・姿勢・ゲーム内時刻・マップ判定・時計整合を出す。
閾値を実データで詰めるための道具。画像は開かない。
"""

import json
import math
import os
import re
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

DEFAULT_DIRS = [
    Path(os.path.expandvars(r"%USERPROFILE%\OneDrive\ドキュメント\Escape from Tarkov\Screenshots")),
    Path(os.path.expandvars(r"%USERPROFILE%\Documents\Escape from Tarkov\Screenshots")),
    Path(os.path.expandvars(r"%USERPROFILE%\OneDrive\Documents\Escape from Tarkov\Screenshots")),
]

NUM_RE = re.compile(r"^-?\d+(?:[.,]\d+)?$")
TS_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})\[(\d{1,2})-(\d{1,2})(?:-(\d{1,2}))?\]")
SEQ_RE = re.compile(r"\s*\((\d+)\)\s*$")
EXT_RE = re.compile(r"\.(png|jpe?g|bmp)$", re.I)

# しきい値は src/verify/index.js の DEFAULT_THRESHOLDS と揃える
NEAR_M = 5.0
RATIO = 5.0
AMBIGUOUS_RATIO = 2.0
CLOCK_TOL_H = 0.02


def to_numbers(chunk):
    parts = re.split(r",\s+", chunk)
    if len(parts) == 1 and "," in chunk and not NUM_RE.match(chunk.strip()):
        parts = chunk.split(",")
    parts = [p.strip() for p in parts if p.strip()]
    if not parts or not all(NUM_RE.match(p) for p in parts):
        return None
    return [float(p.replace(",", ".")) for p in parts]


def parse(filename):
    base = EXT_RE.sub("", filename)
    seq = None
    m = SEQ_RE.search(base)
    if m:
        seq = int(m.group(1))
        base = SEQ_RE.sub("", base)

    chunks = base.split("_")
    pos = rot = None
    pi = ri = -1
    for i, c in enumerate(chunks):
        nums = to_numbers(c)
        if not nums:
            continue
        if len(nums) == 3 and pos is None:
            pos, pi = nums, i
        elif len(nums) == 4 and rot is None:
            rot, ri = nums, i
    if pos is None:
        return None

    game_time = None
    for i in range(max(pi, ri) + 1, len(chunks)):
        nums = to_numbers(chunks[i])
        if nums and len(nums) == 1 and 0 <= nums[0] < 24:
            game_time = nums[0]
            break

    return {"file": filename, "x": pos[0], "y": pos[1], "z": pos[2],
            "q": rot or [0, 0, 0, 1], "gameTime": game_time, "seq": seq}


def forward(q):
    x, y, z, w = q
    return 2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)


def yaw_deg(q):
    fx, _fy, fz = forward(q)
    return math.degrees(math.atan2(fx, fz)) % 360


def pitch_deg(q):
    _fx, fy, _fz = forward(q)
    return math.degrees(math.asin(max(-1.0, min(1.0, -fy))))


def roll_deg(q):
    x, y, z, w = q
    return math.degrees(math.atan2(2 * (w * z + x * y), 1 - 2 * (x * x + z * z)))


def tarkov_hours(epoch_ms, right=False):
    off = (15 if right else 3) * 3600 * 1000
    return ((off + epoch_ms * 7) % (24 * 3600 * 1000)) / 3600000


def hour_diff(a, b):
    return ((a - b) % 24 + 36) % 24 - 12


def load_db():
    db = json.loads((ROOT / "data" / "mapdb.json").read_text(encoding="utf-8"))
    blob = (ROOT / "data" / "poi.bin").read_bytes()
    pts = struct.unpack(f"<{len(blob) // 2}h", blob)
    return db, pts


def nearest(pts, m, X, Y, Z):
    o = m["poiOffset"] * 3
    best = float("inf")
    X, Y, Z = X * 10, Y * 10, Z * 10
    for i in range(m["poiCount"]):
        j = o + i * 3
        dx = pts[j] - X
        dy = pts[j + 1] - Y
        dz = pts[j + 2] - Z
        d = dx * dx + dy * dy + dz * dz
        if d < best:
            best = d
    return math.sqrt(best) / 10


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    if len(sys.argv) > 1:
        folder = Path(sys.argv[1])
    else:
        folder = next((d for d in DEFAULT_DIRS if d.is_dir()), None)
    if not folder or not folder.is_dir():
        print("スクリーンショットフォルダが見つかりません。パスを引数で渡してください。", file=sys.stderr)
        return 2

    db, pts = load_db()
    files = sorted(p for p in folder.iterdir() if EXT_RE.search(p.name))
    rows = []
    for p in files:
        s = parse(p.name)
        if not s:
            continue
        s["mtime"] = p.stat().st_mtime
        rows.append(s)
    rows.sort(key=lambda r: r["mtime"])

    print(f"{folder}\n{len(rows)} 枚\n")
    hdr = (f"{'撮影(実)':<12} {'位置 x, y, z':<26} {'yaw':>7} {'pitch':>7} {'roll':>6} "
           f"{'ゲーム内':>8} {'時計差':>8} {'マップ':<20} {'d1':>7} {'比':>7}  判定")
    print(hdr)
    print("-" * len(hdr))

    summary = {}
    for r in rows:
        rank = sorted((nearest(pts, m, r["x"], r["y"], r["z"]), m["key"]) for m in db["maps"])
        d1, best = rank[0]
        d2, second = rank[1]
        ratio = d2 / d1 if d1 > 0 else float("inf")

        clock = ""
        agrees = False
        if r["gameTime"] is not None:
            left = tarkov_hours(r["mtime"] * 1000)
            right = tarkov_hours(r["mtime"] * 1000, True)
            dl, dr = hour_diff(r["gameTime"], left), hour_diff(r["gameTime"], right)
            diff = dl if abs(dl) <= abs(dr) else dr
            agrees = abs(diff) <= CLOCK_TOL_H
            clock = f"{diff * 60:+7.1f}m" if agrees else f"{diff:+7.2f}h"

        if ratio < AMBIGUOUS_RATIO and not agrees:
            verdict = "レイド外"
        elif d1 < NEAR_M and ratio > RATIO:
            verdict = "確定"
        elif agrees:
            verdict = "確定(時計)"
        else:
            verdict = "低信頼"
        summary[verdict] = summary.get(verdict, 0) + 1

        import datetime as dt
        ts = dt.datetime.fromtimestamp(r["mtime"]).strftime("%H:%M:%S")
        print(f"{ts:<12} "
              f"{r['x']:>8.2f},{r['y']:>6.2f},{r['z']:>8.2f}  "
              f"{yaw_deg(r['q']):>7.1f} {pitch_deg(r['q']):>7.1f} {roll_deg(r['q']):>6.1f} "
              f"{(r['gameTime'] if r['gameTime'] is not None else float('nan')):>8.2f} {clock:>8} "
              f"{best:<20} {d1:>7.2f} {ratio:>7.1f}  {verdict}")

    print()
    print("  判定内訳: " + " / ".join(f"{k} {v}" for k, v in summary.items()))

    seqs = {}
    for r in rows:
        seqs[r["seq"]] = seqs.get(r["seq"], 0) + 1
    print("  連番 (n) の分布: " + ", ".join(f"({k}) x{v}" for k, v in sorted(seqs.items(), key=lambda t: (t[0] is None, t[0]))))

    rolls = [abs(roll_deg(r["q"])) for r in rows]
    print(f"  |roll| の最大: {max(rolls):.4f}°   pitch の範囲: "
          f"{min(pitch_deg(r['q']) for r in rows):.1f}° … {max(pitch_deg(r['q']) for r in rows):.1f}°")
    return 0


if __name__ == "__main__":
    sys.exit(main())
