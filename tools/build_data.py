#!/usr/bin/env python3
"""同梱データ (data/mapdb.json, data/poi.bin) を生成する。

実行時に tarkov.dev を叩かないための事前ビルド。生成物はリポジトリに
コミットして、tarkov.dev が落ちていてもアプリが動くようにする。

    py tools/build_data.py            # キャッシュがあれば使う
    py tools/build_data.py --refresh  # 取得しなおす

取得元:
  https://json.tarkov.dev/regular/maps                      (約 9.5MB)
  the-hideout/tarkov-dev  src/data/maps.json                (階層・transform)

出力:
  data/poi.bin    Int16 の (x, y, z) 三つ組をデシメートル単位で連結したもの。
                  1 点 6 バイト。量子化誤差 0.05m。検証器が最近傍距離を出すのに使う。
  data/mapdb.json マップごとのメタデータ。poi.bin へのオフセットを持つ。
"""

import argparse
import json
import math
import re
import struct
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "tools" / ".cache"
DATA = ROOT / "data"
MAPS = ROOT / "maps"

SRC_API = "https://json.tarkov.dev/regular/maps"
SRC_MAPS_JSON = "https://raw.githubusercontent.com/the-hideout/tarkov-dev/main/src/data/maps.json"
# 表示名の辞書。API 本体は翻訳キーを返すので、これを当てないと
# 脱出口名が "scav_e2" や "Factory Gate" のような内部キーのままになる。
# ("Factory Gate" は Woods の内部キーだが、正式名称は Friendship Bridge (Co-Op)。
#  当てないと別の場所の名前に見えてしまう。)
SRC_LANG = "https://json.tarkov.dev/regular/maps_{lang}"
SRC_TASKS = "https://json.tarkov.dev/regular/tasks"
SRC_TASKS_LANG = "https://json.tarkov.dev/regular/tasks_{lang}"
SRC_TRADERS = "https://json.tarkov.dev/regular/traders"
# 施錠扉が要求する鍵の名前を引くためだけに使う。16MB あるがビルド時のみで、
# 出力に載るのは実際に参照される 200 件弱の名前だけ。--no-keys で省ける。
SRC_ITEMS = "https://json.tarkov.dev/regular/items"
SRC_ITEMS_LANG = "https://json.tarkov.dev/regular/items_{lang}"

# マップを問わないタスク（「スカブを 10 体倒す」など）を入れるファイル名。
# 全マップのファイルに複製すると重複するので 1 つにまとめ、アプリ側で合成する。
ANY_MAP = "_any"
SRC_SVG = "https://raw.githubusercontent.com/the-hideout/tarkov-dev-svg-maps/main/"

# 校正ツール (calibrate.html) が出した手動校正。解析的な初期値より優先する。
OVERRIDES = ROOT / "data" / "calib-overrides.json"

# tarkov-dev の maps.json に svgPath が無くても、SVG リポジトリには存在するもの。
# Labs.svg は bounds と縦横比が 10% 合わないため採用しない (要手動校正)。
EXTRA_SVG = {}

# 座標系を共有するシーンは 1 つのマップに統合する。
# 統合しないと factory と night-factory が互いに距離 0 になり、
# 「2 位 / 1 位」の比による判定が常に 1.0 になって機能しなくなる。
SCENE_ALIASES = {
    "night-factory": "factory",
    "ground-zero-21": "ground-zero",
    "ground-zero-tutorial": "ground-zero",
    "the-lab-dark": "the-lab",
}

# 位置を持つコレクション。増えても壊れないよう、存在するものだけ拾う。
POI_COLLECTIONS = [
    "spawns", "extracts", "transits", "switches", "hazards",
    "lootContainers", "lootLoose", "btrStops", "stationaryWeapons",
]


def fetch(url: str, name: str, refresh: bool) -> bytes:
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / name
    if path.exists() and not refresh:
        return path.read_bytes()
    print(f"  fetch {url}", file=sys.stderr)
    req = urllib.request.Request(url, headers={"User-Agent": "eft-gps-build/1.0"})
    with urllib.request.urlopen(req, timeout=120) as r:
        body = r.read()
    path.write_bytes(body)
    return body


def resolve_path(node, parts):
    """translations の JSONPath（$.a.b.*.c[*].d の形）を辿って、
    書き換え可能な (入れ物, キー) を列挙する。必要な形だけを扱う小さな実装。"""
    if not parts:
        return
    seg, rest = parts[0], parts[1:]

    if seg == "*":
        values = node.values() if isinstance(node, dict) else node if isinstance(node, list) else []
        for v in values:
            yield from resolve_path(v, rest)
        return

    m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)\[\*\]$", seg)
    if m:
        lst = node.get(m.group(1)) if isinstance(node, dict) else None
        if not isinstance(lst, list):
            return
        if rest:
            for v in lst:
                yield from resolve_path(v, rest)
        else:
            for i in range(len(lst)):
                yield lst, i
        return

    if not isinstance(node, dict) or seg not in node:
        return
    if rest:
        yield from resolve_path(node[seg], rest)
    else:
        yield node, seg


def apply_translations(payload: dict, primary: dict, fallback: dict) -> int:
    """payload["translations"] の指す文字列を辞書で置き換える。戻り値は置換件数。

    tarkov-dev の src/modules/api-request.mjs と同じ考え方。優先言語 → 英語 →
    元のキー、の順に当てる。当たらなくても壊さない。
    """
    replaced = 0
    for jpath in payload.get("translations") or []:
        parts = jpath.lstrip("$.").split(".")
        for container, key in resolve_path(payload, parts):
            val = container[key]
            if not isinstance(val, str):
                continue
            new = primary.get(val) or fallback.get(val)
            if new and new != val:
                container[key] = new
                replaced += 1
    return replaced


def load_item_names(refresh: bool, wanted: set):
    """必要なアイテムの表示名だけを引く。

    items は 16MB あるがビルド時のみで、出力に載るのは実際に参照されるものだけ。
    取れなければ空の辞書を返す（名前が出ないだけで他は動く）。
    """
    if not wanted:
        return {}
    try:
        items = json.loads(fetch(SRC_ITEMS, "items.json", refresh))
        ija = json.loads(fetch(SRC_ITEMS_LANG.format(lang="ja"), "items_ja.json", refresh))["data"]
        ien = json.loads(fetch(SRC_ITEMS_LANG.format(lang="en"), "items_en.json", refresh))["data"]
        pool = items.get("data", items)
        pool = pool.get("items", pool)
        out = {}
        for iid in wanted:
            rec = pool.get(iid) if isinstance(pool, dict) else None
            if not rec:
                continue
            # 略称 ("USEC", "Cabin") では何か分からないので正式名称を使う
            raw = rec.get("name") or rec.get("shortName") or ""
            name = ija.get(raw) or ien.get(raw) or raw
            if name:
                out[iid] = name
        print(f"  アイテム名を解決: {len(out)}/{len(wanted)} 件", file=sys.stderr)
        return out
    except Exception as exc:
        print(f"  アイテム名は取得できませんでした（{exc}）", file=sys.stderr)
        return {}


def build_landmarks(refresh: bool, api_maps: dict, interactive: dict,
                    ja: dict, en: dict, mobs: dict, want_keys: bool):
    """脱出口以外の「名前の付いた地点」をマップごとに切り出す。

    地名ラベルは tarkov-dev の maps.json（人が付けた地名。Big Red, Dorms, Sawmill …）、
    それ以外は tarkov.dev の API から取る。全部で 140KB ほどなので、
    タスクと同じくマップ単位に分けて遅延読み込みする。
    """
    def tr(s):
        return ja.get(s) or en.get(s) or s

    def rnd(v):
        return round(float(v), 1)

    def pos3(p):
        return [rnd(p["x"]), rnd(p["y"]), rnd(p["z"])]

    # 鍵の名前。参照される鍵だけ拾う
    key_name = {}
    if want_keys:
        wanted = set()
        for m in api_maps.values():
            for lock in m.get("locks") or []:
                if lock.get("key"):
                    wanted.add(lock["key"])
        key_name = load_item_names(refresh, wanted)

    out = {}

    def bucket(map_key, kind):
        return out.setdefault(map_key, {}).setdefault(kind, [])

    for m in api_maps.values():
        k = SCENE_ALIASES.get(m["normalizedName"], m["normalizedName"])

        for t in m.get("transits") or []:
            if t.get("position"):
                bucket(k, "transit").append({"n": tr(t.get("description") or ""), "p": pos3(t["position"])})

        for sw in m.get("switches") or []:
            if sw.get("position"):
                bucket(k, "switch").append({"n": tr(sw.get("name") or ""), "p": pos3(sw["position"])})

        for b in m.get("btrStops") or []:
            if b.get("x") is not None:
                bucket(k, "btr").append({"n": tr(b.get("name") or ""),
                                         "p": [rnd(b["x"]), rnd(b["y"]), rnd(b["z"])]})

        for h in m.get("hazards") or []:
            if not h.get("position"):
                continue
            bucket(k, "hazard").append({
                "n": tr(h.get("name") or ""),
                "t": h.get("hazardType") or "",
                "p": pos3(h["position"]),
                "o": [[rnd(v["x"]), rnd(v["z"])] for v in (h.get("outline") or [])],
            })

        for lock in m.get("locks") or []:
            if not lock.get("position"):
                continue
            rec = {"t": lock.get("lockType") or "door", "p": pos3(lock["position"])}
            # 鍵の ID も残す。タスクの必要な鍵と突き合わせるとき、
            # 名前の文字列一致ではなく ID で照合するため
            if lock.get("key"):
                rec["k"] = lock["key"]
            name = key_name.get(lock.get("key"))
            if name:
                rec["n"] = name
            if lock.get("needsPower"):
                rec["pw"] = 1
            bucket(k, "lock").append(rec)

        for w in m.get("stationaryWeapons") or []:
            if w.get("position"):
                bucket(k, "gun").append({"p": pos3(w["position"])})

        for b in m.get("bosses") or []:
            mob = mobs.get(b.get("mob")) or {}
            name = tr(mob.get("name") or b.get("mob") or "")
            # 1 つのゾーンに湧き位置が何十個も入っている。全部出すと地図が
            # 点で埋まるので、20m 格子で間引いてゾーンあたり 3 点までにする。
            seen = set()
            for sl in b.get("spawnLocations") or []:
                kept = 0
                for p in sl.get("positions") or []:
                    cell = (name, round(p["x"] / 20), round(p["z"] / 20))
                    if cell in seen:
                        continue
                    seen.add(cell)
                    bucket(k, "boss").append({
                        "n": name, "z": tr(sl.get("name") or ""),
                        "c": sl.get("chance"), "p": pos3(p),
                    })
                    kept += 1
                    if kept >= 3:
                        break

    # 地名ラベル（tarkov-dev の手書きデータ。position は [x, z] か [x, z, y]）
    for key, sub in interactive.items():
        for lab in sub.get("labels") or []:
            p = lab.get("position") or []
            if len(p) < 2:
                continue
            bucket(key, "label").append({
                "n": lab.get("text") or "",
                "p": [rnd(p[0]), rnd(p[2]) if len(p) > 2 else 0.0, rnd(p[1])],
                "r": lab.get("rotation") or 0,
                "s": lab.get("size") or 0,
            })

    out_dir = DATA / "landmarks"
    out_dir.mkdir(parents=True, exist_ok=True)
    for stale in out_dir.glob("*.json"):
        stale.unlink()

    counts = {}
    for key, groups in out.items():
        (out_dir / f"{key}.json").write_text(
            json.dumps(groups, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
        )
        counts[key] = {kind: len(v) for kind, v in groups.items()}

    total_items = sum(sum(c.values()) for c in counts.values())
    total_bytes = sum((out_dir / f"{k}.json").stat().st_size for k in counts)
    print(f"  地点 {total_items} 件 / {len(counts)} ファイル {total_bytes:,} バイト", file=sys.stderr)
    return counts


def build_tasks(refresh: bool, id_to_key: dict):
    """クエストの目標地点をマップごとに切り出す。

    tarkov.dev の tasks には目標ゾーン (position + outline) と、
    アイテムの設置候補地点 (possibleLocations) が入っている。
    マップごとに分けて data/tasks/<key>.json に書き、アプリ側では
    そのマップを開いたときだけ読む。全部で 180KB ほどなので、
    初期表示には影響させない。
    """
    payload = json.loads(fetch(SRC_TASKS, "tasks.json", refresh))
    ja = json.loads(fetch(SRC_TASKS_LANG.format(lang="ja"), "tasks_ja.json", refresh))["data"]
    en = json.loads(fetch(SRC_TASKS_LANG.format(lang="en"), "tasks_en.json", refresh))["data"]
    n = apply_translations(payload, ja, en)
    print(f"  タスクの表示名を解決: {n} 件", file=sys.stderr)

    traders = json.loads(fetch(SRC_TRADERS, "traders.json", refresh))
    traders = traders.get("data", traders)
    trader_name = {
        k: (v.get("normalizedName") or "?").replace("-", " ").title() for k, v in traders.items()
    }

    tasks = payload["data"]["tasks"]
    tasks = list(tasks.values()) if isinstance(tasks, dict) else (tasks or [])

    # クエストアイテム（持ち込む／探す／引き渡す対象）。
    # これらの目標は items を持たず questItem だけを持つので、
    # items だけを見ていると持ち物にまったく出てこない。
    quest_items = payload["data"].get("questItems") or {}

    # 持ち物として出すアイテムの名前を引く。
    # usingWeapon は 1 目標に数十丁並ぶので一覧にせず「指定あり」とだけ出す。
    wanted_items = set()
    for t in tasks:
        for nk in t.get("neededKeys") or []:
            wanted_items.update(nk.get("keys") or [])
        for o in t.get("objectives") or []:
            for lst in o.get("requiredKeys") or []:
                wanted_items.update(lst)
            if o.get("markerItem"):
                wanted_items.add(o["markerItem"])
            if o.get("items") and o.get("type") in (
                "giveItem", "plantItem", "plantQuestItem", "mark", "buildWeapon",
            ):
                wanted_items.update(o["items"])
    item_name = load_item_names(refresh, wanted_items)

    def quest_item_rec(qid):
        rec = quest_items.get(qid) or {}
        return {"i": qid, "n": rec.get("name") or "クエストアイテム"}

    def item_rec(iid, count=None, fir=False):
        rec = {"i": iid, "n": item_name.get(iid, "?")}
        if count and count > 1:
            rec["c"] = count
        if fir:
            rec["f"] = 1
        return rec

    def rnd(v):
        return round(float(v), 1)

    by_map = {}
    zones = points = 0
    for t in tasks:
        objectives = []
        for o in t.get("objectives") or []:
            zs, locs = [], []
            for z in o.get("zones") or []:
                key = id_to_key.get(z.get("map"))
                pos = z.get("position")
                if not key or not pos:
                    continue
                zs.append({
                    "m": key,
                    "p": [rnd(pos["x"]), rnd(pos["y"]), rnd(pos["z"])],
                    "o": [[rnd(v["x"]), rnd(v["z"])] for v in (z.get("outline") or [])],
                })
                zones += 1
            for loc in o.get("possibleLocations") or []:
                key = id_to_key.get(loc.get("map"))
                if not key:
                    continue
                ps = [[rnd(p["x"]), rnd(p["y"]), rnd(p["z"])] for p in (loc.get("positions") or [])]
                if ps:
                    locs.append({"m": key, "p": ps})
                    points += len(ps)
            entry = {"d": o.get("description"), "t": o.get("type")}
            if o.get("optional"):
                entry["opt"] = 1
            # 持ち込むもの。渡す・設置する系だけを対象にする。
            # 「見つける」系は現地調達なので持ち物には入れない
            if o.get("items") and o.get("type") in (
                "giveItem", "plantItem", "plantQuestItem", "mark", "buildWeapon",
            ):
                entry["it"] = [
                    item_rec(i, o.get("count"), bool(o.get("foundInRaid"))) for i in o["items"][:8]
                ]
                if len(o["items"]) > 8:
                    entry["itMore"] = len(o["items"]) - 8
            if o.get("questItem"):
                # 持ち込む(plant) / 探す(find) / 引き渡す(give) で意味が違う
                entry["qi"] = quest_item_rec(o["questItem"])
            if o.get("markerItem"):
                entry["mk"] = item_rec(o["markerItem"])
            if o.get("usingWeapon"):
                entry["wp"] = len(o["usingWeapon"])
            if zs:
                entry["z"] = zs
            if locs:
                entry["l"] = locs
            objectives.append(entry)

        if not objectives:
            continue

        # 必要な鍵。neededKeys はマップ別に入っている
        keys_by_map = {}
        for nk in t.get("neededKeys") or []:
            mk = id_to_key.get(nk.get("map"))
            if mk:
                keys_by_map.setdefault(mk, []).extend(nk.get("keys") or [])
        # 目標ごとの requiredKeys は、その目標があるマップに紐づける
        for o in t.get("objectives") or []:
            omaps = {id_to_key.get(x) for x in (o.get("maps") or [])} - {None}
            for lst in o.get("requiredKeys") or []:
                for mk in omaps:
                    keys_by_map.setdefault(mk, []).extend(lst)

        rec = {
            "id": t.get("id"),
            "n": t.get("name"),
            "tr": trader_name.get(t.get("trader"), "?"),
            "lv": t.get("minPlayerLevel"),
            "o": objectives,
        }
        if t.get("kappaRequired"):
            rec["kap"] = 1
        if t.get("wikiLink"):
            rec["w"] = t["wikiLink"]

        # この課題がどのマップに関わるか。
        # 座標があるものが第一。座標は無いが maps でマップを名指ししている
        # ものも、そのマップの一覧に出す。どちらも無ければ「任意のマップ」。
        keys = set()
        for obj in objectives:
            for z in obj.get("z", []):
                keys.add(z["m"])
            for loc in obj.get("l", []):
                keys.add(loc["m"])
        if not keys:
            for o in t.get("objectives") or []:
                for mid in o.get("maps") or []:
                    mk = id_to_key.get(mid)
                    if mk:
                        keys.add(mk)
        if not keys:
            keys = {ANY_MAP}
        for key in keys:
            # そのマップで要る鍵だけを載せる（重複は落とす）
            mine = list(dict.fromkeys(keys_by_map.get(key) or []))
            entry = dict(rec)
            if mine:
                entry["k"] = [item_rec(i) for i in mine]
            by_map.setdefault(key, []).append(entry)

    out_dir = DATA / "tasks"
    out_dir.mkdir(parents=True, exist_ok=True)
    for stale in out_dir.glob("*.json"):
        stale.unlink()

    counts = {}
    for key, recs in by_map.items():
        # トレーダー → 必要レベル → 名前 の順に並べておく。UI 側で並べ替えなくて済む
        recs.sort(key=lambda r: (r["tr"], r.get("lv") or 0, r["n"] or ""))
        if key == ANY_MAP:
            for r in recs:
                r["any"] = 1
        (out_dir / f"{key}.json").write_text(
            json.dumps(recs, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
        )
        counts[key] = len(recs)

    total = sum((out_dir / f"{k}.json").stat().st_size for k in counts)
    print(f"  タスク {sum(counts.values())} 件（うち任意マップ {counts.get(ANY_MAP, 0)}）"
          f" / ゾーン {zones} / 候補点 {points} / {len(counts)} ファイル {total:,} バイト",
          file=sys.stderr)
    return counts


def collect_points(scene: dict):
    """シーンから (x, y, z) を全部集める。outline は 1 頂点ずつ別の点として扱う。"""
    out = []

    def take(node):
        if not isinstance(node, dict):
            return
        p = node.get("position")
        if isinstance(p, dict) and all(k in p for k in "xyz"):
            out.append((p["x"], p["y"], p["z"]))
        for v in node.get("outline") or []:
            if isinstance(v, dict) and all(k in v for k in "xyz"):
                out.append((v["x"], v["y"], v["z"]))

    for coll in POI_COLLECTIONS:
        for item in scene.get(coll) or []:
            take(item)
    return out


def fetch_svg(filename: str, refresh: bool) -> Path:
    MAPS.mkdir(parents=True, exist_ok=True)
    path = MAPS / filename
    if path.exists() and not refresh:
        return path
    print(f"  fetch {SRC_SVG}{filename}", file=sys.stderr)
    req = urllib.request.Request(SRC_SVG + filename, headers={"User-Agent": "eft-gps-build/1.0"})
    with urllib.request.urlopen(req, timeout=180) as r:
        path.write_bytes(r.read())
    return path


def read_viewbox(path: Path):
    head = path.read_text(encoding="utf-8", errors="replace")[:8000]
    m = re.search(r"viewBox\s*=\s*[\"']([^\"']+)[\"']", head)
    if not m:
        return None
    v = [float(t) for t in re.split(r"[\s,]+", m.group(1).strip()) if t]
    return v if len(v) == 4 else None


def analytic_affine(td: dict, viewbox: list, bounds_key: str = "svgBounds"):
    """tarkov-dev の配置をそのまま再現して、ワールド (x, z) -> SVG ユーザ座標の
    フルアフィンを求める。

    tarkov-dev は L.svgOverlay(svg, getBounds(svgBounds ?? bounds)) で置いている。
    Leaflet の ImageOverlay は latLngBounds の北西と南東だけを投影し、その 2 点の
    軸並行矩形に画像を貼る。SVG 側は preserveAspectRatio の既定値 "xMidYMid meet"
    なので、縦横比が違えば等倍で中央寄せになる (レターボックス)。

    ワールド -> CRS:
        Xr = x·cosθ − z·sinθ ,  Zr = x·sinθ + z·cosθ
        px = t0·Xr + t1      ,  py = −t2·Zr + t3
    CRS -> SVG ユーザ座標: 上記の矩形と viewBox を meet で対応させる。
    """
    t = td.get("transform") or [1, 0, 1, 0]
    th = math.radians(td.get("coordinateRotation") or 0)
    ct, st = math.cos(th), math.sin(th)
    b = td.get(bounds_key) or td.get("bounds")
    if not b or not viewbox:
        return None, None

    def to_crs(x, z):
        xr = x * ct - z * st
        zr = x * st + z * ct
        return t[0] * xr + t[1], -t[2] * zr + t[3]

    xs = [b[0][0], b[1][0]]
    zs = [b[0][1], b[1][1]]
    # 北西 = (x 最小, z 最大) / 南東 = (x 最大, z 最小)
    p1 = to_crs(min(xs), max(zs))
    p2 = to_crs(max(xs), min(zs))
    min_x, max_x = min(p1[0], p2[0]), max(p1[0], p2[0])
    min_y, max_y = min(p1[1], p2[1]), max(p1[1], p2[1])
    rect_w, rect_h = max_x - min_x, max_y - min_y

    vx, vy, vw, vh = viewbox
    if vw <= 0 or vh <= 0 or rect_w <= 0 or rect_h <= 0:
        return None, None

    scale = min(rect_w / vw, rect_h / vh)          # preserveAspectRatio="meet"
    off_x = (rect_w - vw * scale) / 2
    off_y = (rect_h - vh * scale) / 2

    affine = {
        "a": t[0] * ct / scale,
        "b": -t[0] * st / scale,
        "c": (t[1] - min_x - off_x) / scale + vx,
        "d": -t[2] * st / scale,
        "e": -t[2] * ct / scale,
        "f": (t[3] - min_y - off_y) / scale + vy,
    }
    letterbox = max(off_x, off_y) / max(rect_w, rect_h)
    return affine, letterbox


def coverage(affine, viewbox, pts_dm):
    """POI が viewBox 内に落ちる割合と、占有している矩形の割合を返す。"""
    vx, vy, vw, vh = viewbox
    inside = 0
    xs, ys = [], []
    for x, _y, z in pts_dm:
        wx, wz = x / 10, z / 10
        px = affine["a"] * wx + affine["b"] * wz + affine["c"]
        py = affine["d"] * wx + affine["e"] * wz + affine["f"]
        xs.append(px)
        ys.append(py)
        if vx <= px <= vx + vw and vy <= py <= vy + vh:
            inside += 1
    fill = ((max(xs) - min(xs)) / vw) * ((max(ys) - min(ys)) / vh) if xs else 0
    return inside / len(pts_dm), fill


def drop_outliers(points, td, margin=0.10):
    """マップの想定範囲から外れた点を落とす。

    tarkov.dev のデータには実際のマップ外に飛んでいる点が混ざっている
    (factory の lootLoose に x=274.9 の点があるが、マップ幅は約 160m しかない)。
    こういう点を残すと、別マップのサンプルがそこに近いと判定されて
    「最寄りマップ」が誤る。tarkov-dev が持つ bounds を各辺 10% 広げた矩形で
    足切りする。bounds が無いマップは何も落とさない。
    """
    b = (td or {}).get("bounds")
    if not b:
        return list(points), 0

    xs = sorted((b[0][0], b[1][0]))
    zs = sorted((b[0][1], b[1][1]))
    mx = (xs[1] - xs[0]) * margin
    mz = (zs[1] - zs[0]) * margin
    lo_x, hi_x = xs[0] - mx, xs[1] + mx
    lo_z, hi_z = zs[0] - mz, zs[1] + mz

    kept = [p for p in points if lo_x <= p[0] <= hi_x and lo_z <= p[2] <= hi_z]
    return kept, len(points) - len(kept)


def quantize(points):
    """デシメートル int16 に量子化して重複を落とす。"""
    seen = set()
    for x, y, z in points:
        t = (
            max(-32768, min(32767, round(x * 10))),
            max(-32768, min(32767, round(y * 10))),
            max(-32768, min(32767, round(z * 10))),
        )
        if t not in seen:
            seen.add(t)
            yield t


def build():
    ap = argparse.ArgumentParser()
    ap.add_argument("--refresh", action="store_true")
    ap.add_argument("--no-keys", action="store_true",
                    help="施錠扉の鍵名を解決しない（items の 16MB を取りに行かない）")
    args = ap.parse_args()

    print("sources", file=sys.stderr)
    api_payload = json.loads(fetch(SRC_API, "api_maps.json", args.refresh))
    lang_ja = json.loads(fetch(SRC_LANG.format(lang="ja"), "maps_ja.json", args.refresh))["data"]
    lang_en = json.loads(fetch(SRC_LANG.format(lang="en"), "maps_en.json", args.refresh))["data"]
    n = apply_translations(api_payload, lang_ja, lang_en)
    print(f"  表示名を解決: {n} 件（日本語優先・英語フォールバック）", file=sys.stderr)
    api = api_payload["data"]
    tdmaps = json.loads(fetch(SRC_MAPS_JSON, "maps.json", args.refresh))
    overrides = {}
    if OVERRIDES.exists():
        try:
            overrides = json.loads(OVERRIDES.read_text(encoding="utf-8")) or {}
        except json.JSONDecodeError as exc:
            print(f"  calib-overrides.json を読めません: {exc}", file=sys.stderr)

    # tarkov-dev の interactive マップ定義を key で引けるようにする
    interactive = {}
    for group in tdmaps:
        for sub in group.get("maps", []):
            if sub.get("projection") == "interactive":
                interactive[sub["key"]] = sub

    # マップ ID → こちらのキー（統合後）
    id_to_key = {}
    for scene in api["maps"].values():
        name = scene["normalizedName"]
        id_to_key[scene["id"]] = SCENE_ALIASES.get(name, name)
    task_counts = build_tasks(args.refresh, id_to_key)
    landmark_counts = build_landmarks(
        args.refresh, api["maps"], interactive, lang_ja, lang_en,
        api.get("mobs") or {}, not args.no_keys,
    )

    # シーンを統合先ごとにまとめる
    merged: dict[str, dict] = {}
    for scene in api["maps"].values():
        name = scene["normalizedName"]
        key = SCENE_ALIASES.get(name, name)
        m = merged.setdefault(key, {"key": key, "scenes": [], "points": []})
        m["scenes"].append({
            "normalizedName": name,
            "nameId": scene.get("nameId"),
            "scenePath": scene.get("scenePath"),
        })
        m["points"].extend(collect_points(scene))
        if name == key:
            m["name"] = scene.get("name")
            m["raidDuration"] = scene.get("raidDuration")
            m["coordinateToCardinalRotation"] = scene.get("coordinateToCardinalRotation")
            m["extracts"] = [
                {
                    "name": e.get("name"),
                    # 内部キーも残す。校正ツールの参照 ID に使うため、
                    # 表示名が変わっても対応点が迷子にならない。
                    "key": e.get("id") or e.get("name"),
                    "faction": e.get("faction"),
                    "position": e.get("position"),
                    "outline": e.get("outline") or [],
                }
                for e in (scene.get("extracts") or [])
            ]

    blob = bytearray()
    maps_out = []
    dropped_total = 0
    for key in sorted(merged):
        m = merged[key]
        raw, dropped = drop_outliers(m["points"], interactive.get(key))
        dropped_total += dropped
        m["dropped"] = dropped
        pts = list(quantize(raw))
        if not pts:
            print(f"  skip {key}: 位置データなし", file=sys.stderr)
            continue

        offset = len(blob) // 6
        for t in pts:
            blob += struct.pack("<3h", *t)

        xs = [p[0] / 10 for p in pts]
        ys = [p[1] / 10 for p in pts]
        zs = [p[2] / 10 for p in pts]

        td = interactive.get(key)

        # ---- 校正 (S3): tarkov-dev の配置を再現して解析的な初期値を作る ----
        svg_name = None
        viewbox = None
        affine = None
        calib = None
        if td:
            sp = td.get("svgPath") or EXTRA_SVG.get(key)
            if sp:
                svg_name = sp.rsplit("/", 1)[-1]
                try:
                    viewbox = read_viewbox(fetch_svg(svg_name, args.refresh))
                except Exception as exc:
                    print(f"  {key}: SVG 取得失敗 {exc}", file=sys.stderr)
                    svg_name = None
        # 手動校正があれば、そちらを最優先する
        ov = overrides.get(key)
        if ov and ov.get("affine") and ov.get("svg") and ov.get("svgViewBox"):
            svg_name = ov["svg"].rsplit("/", 1)[-1]
            viewbox = ov["svgViewBox"]
            affine = ov["affine"]
            try:
                fetch_svg(svg_name, False)
            except Exception as exc:
                print(f"  {key}: SVG 取得失敗 {exc}", file=sys.stderr)
            inside, fill = coverage(affine, viewbox, pts)
            calib = {
                "source": "manual",
                "letterbox": 0.0,
                "poiInside": round(inside, 4),
                "poiFill": round(fill, 4),
                "droppedOutliers": m["dropped"],
                "rms": ov.get("rms"),
                "points": len(ov.get("points") or []),
            }
        elif svg_name and viewbox:
            affine, letterbox = analytic_affine(td, viewbox)
            if affine:
                inside, fill = coverage(affine, viewbox, pts)
                calib = {
                    "source": "analytic",
                    "letterbox": round(letterbox, 4),
                    "poiInside": round(inside, 4),
                    "poiFill": round(fill, 4),
                    "droppedOutliers": m["dropped"],
                }

        entry = {
            "key": key,
            "name": m.get("name"),
            "scenes": m["scenes"],
            "poiOffset": offset,
            "poiCount": len(pts),
            "bbox": {
                "x": [round(min(xs), 2), round(max(xs), 2)],
                "y": [round(min(ys), 2), round(max(ys), 2)],
                "z": [round(min(zs), 2), round(max(zs), 2)],
            },
            "extracts": m.get("extracts", []),
            "taskCount": task_counts.get(key, 0),
            "taskFile": f"data/tasks/{key}.json" if task_counts.get(key) else None,
            "landmarkCounts": landmark_counts.get(key) or {},
            "landmarkFile": f"data/landmarks/{key}.json" if landmark_counts.get(key) else None,
            "affine": affine,
            "rms": (ov or {}).get("rms"),
            "calib": calib,
            "svg": ("maps/" + svg_name) if (svg_name and affine) else None,
            "svgViewBox": viewbox if affine else None,
            "tarkovDev": None if not td else {
                "transform": td.get("transform"),
                "coordinateRotation": td.get("coordinateRotation"),
                "bounds": td.get("bounds"),
                "svgPath": td.get("svgPath"),
                "svgLayer": td.get("svgLayer"),
                "heightRange": td.get("heightRange"),
                "layers": [
                    {
                        "name": L.get("name"),
                        "svgLayer": L.get("svgLayer"),
                        "extents": L.get("extents"),
                    }
                    for L in (td.get("layers") or [])
                ],
            },
        }
        maps_out.append(entry)

    DATA.mkdir(parents=True, exist_ok=True)
    (DATA / "poi.bin").write_bytes(bytes(blob))
    svg_files = sorted(p.name for p in MAPS.glob("*.svg")) if MAPS.exists() else []
    any_count = task_counts.get(ANY_MAP, 0)
    db = {
        "anyTaskFile": f"data/tasks/{ANY_MAP}.json" if any_count else None,
        "anyTaskCount": any_count,
        "version": 1,
        "generated": "build_data.py",
        "builtAt": __import__("datetime").datetime.now().strftime("%Y-%m-%d %H:%M"),
        "svgFiles": svg_files,
        "poiUnit": "decimetre",
        "poiStride": 3,
        "poiTotal": len(blob) // 6,
        "maps": maps_out,
    }
    (DATA / "mapdb.json").write_text(
        json.dumps(db, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )

    print(f"\n  {len(maps_out)} maps / {db['poiTotal']} points", file=sys.stderr)
    print(f"  data/poi.bin     {len(blob):>8,} bytes", file=sys.stderr)
    print(f"  data/mapdb.json  {(DATA / 'mapdb.json').stat().st_size:>8,} bytes", file=sys.stderr)
    print(file=sys.stderr)
    print(f"  {'map':<20} {'points':>7}  {'svg':<20} {'POI in view':>11} {'fill':>6} {'letterbox':>9}", file=sys.stderr)
    for e in maps_out:
        c = e["calib"]
        if c:
            src = "手動" if c["source"] == "manual" else "解析"
            stat = (f"{c['poiInside'] * 100:>10.1f}% {c['poiFill'] * 100:>5.0f}% "
                    f"{c['letterbox'] * 100:>8.2f}%  {src}  外れ値除去 {c['droppedOutliers']}")
        else:
            stat = f"{'(SVG なし - 手動校正が必要)':>11}"
        print(
            f"  {e['key']:<20} {e['poiCount']:>7}  "
            f"{(e['svg'] or '-').replace('maps/', ''):<20} {stat}",
            file=sys.stderr,
        )


if __name__ == "__main__":
    build()
