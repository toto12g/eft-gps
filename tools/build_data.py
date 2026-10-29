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
import os
import re
import struct
import sys
import urllib.parse
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
SRC_TRADERS_LANG = "https://json.tarkov.dev/regular/traders_{lang}"
# 施錠扉が要求する鍵の名前を引くためだけに使う。16MB あるがビルド時のみで、
# 出力に載るのは実際に参照される 200 件弱の名前だけ。--no-keys で省ける。
SRC_HIDEOUT = "https://json.tarkov.dev/regular/hideout"
SRC_HIDEOUT_LANG = "https://json.tarkov.dev/regular/hideout_{lang}"
SRC_CRAFTS = "https://json.tarkov.dev/regular/crafts"
SRC_BARTERS = "https://json.tarkov.dev/regular/barters"
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


def write_atomic(path: Path, data) -> None:
    """同じディレクトリの一時ファイルに書いてから置き換える。

    書きかけで落ちても、切り詰められた JSON が配信物として残らない。
    os.replace は同一ボリューム上では不可分。
    """
    tmp = path.with_name(path.name + ".tmp")
    if isinstance(data, str):
        tmp.write_text(data, encoding="utf-8")
    else:
        tmp.write_bytes(data)
    os.replace(tmp, path)


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
    # 統合したシーン間で同じ湧き位置が二重に入るのを防ぐ
    SPAWN_SEEN = {}

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

        for z in ((m.get("artillery") or {}).get("zones")) or []:
            if not z.get("position"):
                continue
            bucket(k, "artillery").append({
                "n": "砲撃",
                "p": pos3(z["position"]),
                "o": [[rnd(v["x"]), rnd(v["z"])] for v in (z.get("outline") or [])],
            })

        # 湧き位置。3000 点あるので 25m 格子で間引き、陣営ごとにまとめる
        # プレイヤーの湧き位置。
        #
        # categories に "player" があるものだけを出す。bot / botpmc /
        # boss / sniper は AI 用の湧きなので、プレイヤーの湧きではない。
        #
        # sides は上流のデータどおりに扱い、推測で寄せない:
        #   pmc  … PMC 専用
        #   scav … スカブ専用
        #   all  … PMC・スカブ共通（factory / lighthouse / reserve /
        #          streets / ground-zero / the-lab はこの形しか持たない）
        #
        # 間引きはしない。湧き位置は「だいたいこの辺」では意味が無く、
        # 20m ずれれば別の建物になる。代わりに、夜や別バージョンのシーンを
        # 統合したことで生じる完全な重複だけを落とす
        # （night-factory は factory と 117 点すべてが同一座標）。
        for sp in m.get("spawns") or []:
            pos = sp.get("position")
            if not pos or "player" not in (sp.get("categories") or []):
                continue
            sides = sp.get("sides") or []
            side = "pmc" if "pmc" in sides else "scav" if "scav" in sides else "all"
            xyz = pos3(pos)
            seen = SPAWN_SEEN.setdefault(k, set())
            token = (side, xyz[0], xyz[1], xyz[2])
            if token in seen:
                continue
            seen.add(token)
            kind = {"pmc": "spawnPmc", "scav": "spawnScav"}.get(side, "spawnBoth")
            bucket(k, kind).append({
                "n": {
                    "pmc": "PMC 湧き",
                    "scav": "スカブ湧き",
                }.get(side, "PMC・スカブ共通の湧き"),
                # "s" は label が文字サイズに使っているので別名にする
                "sd": side,
                "p": xyz,
            })

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

    # 鍵が「扉」として使われているマップ。上流はトランク（車のトランクなど）の鍵に、
    # Factory 非常口の鍵の ID を仮に入れていることがある（2026-10 時点で 7 マップ・19 か所）。
    # 扉としては別のマップでしか使われない鍵がトランクに付いていたら、鍵の名前を付けない。
    # 付けたままだと、鍵の一覧に「Interchange で Factory 非常口の鍵 13 か所」のような嘘が出る
    door_maps = {}
    for key, groups in out.items():
        for lk in groups.get("lock") or []:
            if lk.get("k") and lk.get("t") == "door":
                door_maps.setdefault(lk["k"], set()).add(key)

    def strip_placeholder(lk, map_key):
        homes = door_maps.get(lk.get("k"))
        if lk.get("t") == "trunk" and homes and map_key not in homes:
            lk = {k: v for k, v in lk.items() if k not in ("k", "n")}
        return lk

    for key, groups in out.items():
        groups["lock"] = [strip_placeholder(lk, key) for lk in groups.get("lock") or []]

    # 上流で施錠扉がごっそり抜けることがある（2026-10 に Interchange が 101 → 15 件。
    # Goshan・IDEA・OLI のレジ 74 か所がまとめて消えた）。扉はゲーム側でそう変わるものでは
    # ないので、前回の半分を割ったら抜けとみなし、今回の扉に、前回にしかない扉を足す。
    # 前回をまるごと残すと、上流で新しく増えた扉（KORD のパス）が入らない。
    # 足すのは鍵の分かるものだけ（鍵の無いトランクは、上流の仮の値だった可能性がある）
    for key, groups in out.items():
        prev_path = out_dir / f"{key}.json"
        if not prev_path.exists():
            continue
        try:
            prev_locks = json.loads(prev_path.read_text(encoding="utf-8")).get("lock") or []
        except (json.JSONDecodeError, AttributeError):
            continue
        cur = groups.get("lock") or []
        if not (len(prev_locks) >= 20 and len(cur) < len(prev_locks) / 2):
            continue
        seen = {(lk.get("k"), tuple(round(v) for v in lk["p"])) for lk in cur}
        added = 0
        for lk in prev_locks:
            lk = strip_placeholder(lk, key)
            sig = (lk.get("k"), tuple(round(v) for v in lk["p"]))
            if not lk.get("k") or sig in seen:
                continue
            cur.append(lk)
            seen.add(sig)
            added += 1
        groups["lock"] = cur
        print(f"  !! {key} の施錠扉が上流で {len(prev_locks)} → {len(cur) - added} 件に減ったので、"
              f"前回にしかない {added} 件を足しました", file=sys.stderr)

    for stale in out_dir.glob("*.json"):
        stale.unlink()

    counts = {}
    for key, groups in out.items():
        write_atomic(
            out_dir / f"{key}.json",
            json.dumps(groups, ensure_ascii=False, separators=(",", ":")),
        )
        counts[key] = {kind: len(v) for kind, v in groups.items()}

    total_items = sum(sum(c.values()) for c in counts.values())
    total_bytes = sum((out_dir / f"{k}.json").stat().st_size for k in counts)
    print(f"  地点 {total_items} 件 / {len(counts)} ファイル {total_bytes:,} バイト", file=sys.stderr)
    return counts



def build_items(refresh: bool):
    """アイテムが何に使われるかを逆引きできる形にする。

    「これは拾う価値があるのか」が分からない、という声から。
    上流には用途そのものの一覧は無いので、ハイドアウト・タスク・交換・製作の
    4 つを横断して集め、アイテム側から引けるように裏返す。

    数が分かることを第一に置く。「要る」だけでは足りず、
    「射撃場 Lv2 に 6 個」のように、どこに何個要るかまで出す。
    """
    hideout = json.loads(fetch(SRC_HIDEOUT, "hideout.json", refresh))
    hja = json.loads(fetch(SRC_HIDEOUT_LANG.format(lang="ja"), "hideout_ja.json", refresh))["data"]
    hen = json.loads(fetch(SRC_HIDEOUT_LANG.format(lang="en"), "hideout_en.json", refresh))["data"]
    crafts = json.loads(fetch(SRC_CRAFTS, "crafts.json", refresh))["data"]
    barters = json.loads(fetch(SRC_BARTERS, "barters.json", refresh))["data"]

    tasks_payload = json.loads(fetch(SRC_TASKS, "tasks.json", refresh))
    tja = json.loads(fetch(SRC_TASKS_LANG.format(lang="ja"), "tasks_ja.json", refresh))["data"]
    ten = json.loads(fetch(SRC_TASKS_LANG.format(lang="en"), "tasks_en.json", refresh))["data"]

    traders = json.loads(fetch(SRC_TRADERS, "traders.json", refresh))
    traders = traders.get("data", traders)
    trader_name = {
        k: (v.get("normalizedName") or "?").replace("-", " ").title() for k, v in traders.items()
    }

    items_payload = json.loads(fetch(SRC_ITEMS, "items.json", refresh))
    ija = json.loads(fetch(SRC_ITEMS_LANG.format(lang="ja"), "items_ja.json", refresh))["data"]
    ien = json.loads(fetch(SRC_ITEMS_LANG.format(lang="en"), "items_en.json", refresh))["data"]
    items = items_payload["data"]["items"]
    items = list(items.values()) if isinstance(items, dict) else items
    by_id = {i["id"]: i for i in items if i.get("id")}

    def iname(iid):
        it = by_id.get(iid)
        if not it:
            return None
        raw = it.get("name")
        return ija.get(raw) or ien.get(raw) or raw

    def iname_en(iid):
        it = by_id.get(iid)
        if not it:
            return None
        return ien.get(it.get("name")) or it.get("name")

    station = {
        sid: (hja.get(st.get("name")) or hen.get(st.get("name")) or st.get("name"))
        for sid, st in hideout["data"].items()
    }

    # アイテムの分類。一覧を絞り込むのに使う。
    # categories は親子構造なので、子を持たない（＝いちばん具体的な）ものを選ぶ。
    cat_src = items_payload["data"].get("itemCategories") or {}
    cat_by_id = {c["id"]: c for c in
                 (cat_src.values() if isinstance(cat_src, dict) else cat_src)}

    def category_of(iid):
        groups = [cat_by_id[g] for g in (by_id[iid].get("categories") or []) if g in cat_by_id]
        leaf = [g for g in groups if not g.get("children")]
        pick = (leaf or groups)
        if not pick:
            return None
        raw = pick[0].get("name")
        return ija.get(raw) or ien.get(raw) or pick[0].get("normalizedName")

    # tarkov.dev のアイテムページ。相場はここで見てもらう
    DEV_PREFIX = "https://tarkov.dev/item/"

    rec = {}

    def slot(iid):
        return rec.setdefault(iid, {"h": [], "t": [], "b": [], "c": [], "tool": [], "out": 0})

    fir = set()

    # --- ハイドアウトの建設に要るもの ---
    for sid, st in hideout["data"].items():
        for lv in st.get("levels") or []:
            for r in lv.get("itemRequirements") or []:
                if not r.get("item"):
                    continue
                slot(r["item"])["h"].append(
                    [station.get(sid, "?"), lv.get("level"), r.get("count") or 1])
                if (r.get("attributes") or {}).get("foundInRaid"):
                    fir.add(r["item"])

    # --- タスクに要るもの ---
    #
    # 目標の種別を絞る。usingWeapon のような「その銃で倒せ」は持ち帰る話では
    # ないので外す。候補が ALT_CAP より多い目標は「そのうちどれか 1 つ」で、
    # 特定のアイテムが要るとは言えないので数えない（sellItem には
    # 候補が 3535 件のものがある）。
    ALT_CAP = 8
    KEEP = ("giveItem", "findItem", "plantItem")
    # Wiki の URL は 517 件すべてが同じ接頭辞なので、末尾だけを持つ。
    # 丸ごと持つと 1 件あたり 42 文字の無駄になる
    WIKI_PREFIX = "https://escapefromtarkov.fandom.com/wiki/"

    tasks = tasks_payload["data"]["tasks"]
    tasks = list(tasks.values()) if isinstance(tasks, dict) else tasks
    for t in tasks:
        nm = tja.get(t.get("name")) or ten.get(t.get("name")) or t.get("name")
        link = t.get("wikiLink") or ""
        slug = link[len(WIKI_PREFIX):] if link.startswith(WIKI_PREFIX) else ""
        seen_here = set()
        for o in t.get("objectives") or []:
            if o.get("type") not in KEEP:
                continue
            lst = o.get("items") or []
            if not lst or len(lst) > ALT_CAP:
                continue
            for it in lst:
                iid = it if isinstance(it, str) else (it or {}).get("id")
                if not iid:
                    continue
                token = (iid, nm, o.get("count") or 1, len(lst))
                if token in seen_here:
                    continue  # 同じ課題が同じものを複数の目標で挙げることがある
                seen_here.add(token)
                slot(iid)["t"].append([nm, o.get("count") or 1, len(lst), slug])
                if o.get("foundInRaid"):
                    fir.add(iid)

    # --- 製作 ---
    for c in crafts:
        prod = iname((c.get("productItem") or {}).get("item"))
        st = station.get(c.get("station"), "?")
        for r in c.get("requiredItems") or []:
            if not r.get("item"):
                continue
            # tool は作業に使うだけで減らない。「消費する材料」と混ぜない。
            # 個数も持たせない（持たせると「毎回 1 個要る」と誤解させる）
            if (r.get("attributes") or {}).get("tool"):
                slot(r["item"])["tool"].append([st, c.get("level"), prod])
            else:
                slot(r["item"])["c"].append([st, c.get("level"), prod, r.get("count") or 1])
        pid = (c.get("productItem") or {}).get("item")
        if pid:
            slot(pid)["out"] += 1

    # --- トレーダーとの交換 ---
    for b in barters:
        got = iname((b.get("offeredItem") or {}).get("item"))
        for r in b.get("requiredItems") or []:
            if not r.get("item"):
                continue
            slot(r["item"])["b"].append(
                [trader_name.get(b.get("trader"), "?"), b.get("minTraderLevel"),
                 got, r.get("count") or 1])

    out = {}
    for iid, v in rec.items():
        if iid not in by_id:
            continue
        o = {"n": iname(iid)}
        en = iname_en(iid)
        if en and en != o["n"]:
            o["ne"] = en
        # shortName も翻訳キーで来る。解決できなければ出さない
        # （"xxxxx ShortName" のような内部キーが表に出てしまう）
        raw_short = by_id[iid].get("shortName")
        short = ija.get(raw_short) or ien.get(raw_short)
        if short and short != o["n"]:
            o["s"] = short
        for key in ("h", "t", "b", "c", "tool"):
            if v[key]:
                o[key] = v[key]
        if v["out"]:
            o["out"] = v["out"]
        if iid in fir:
            o["fir"] = 1
        cat = category_of(iid)
        if cat:
            o["cat"] = cat
        # 相場は持たない。毎日動くのにこのツールのデータは手動ビルドで止まるため、
        # 古い数字を自信ありげに出すと判断を誤らせる。
        # 代わりに tarkov.dev の該当ページへ送り、価格は向こうで見てもらう。
        # URL は 5312 件すべてが同じ接頭辞なので、末尾だけを持つ。
        dev_link = by_id[iid].get("link") or ""
        if dev_link.startswith(DEV_PREFIX):
            o["dev"] = dev_link[len(DEV_PREFIX):]
        # Wiki の URL もタスクと同じ形にする（接頭辞は共通なので末尾だけ）
        wiki = by_id[iid].get("wikiLink") or ""
        if wiki.startswith(WIKI_PREFIX):
            o["w"] = wiki[len(WIKI_PREFIX):]
        out[iid] = o

    DATA.mkdir(parents=True, exist_ok=True)
    write_atomic(DATA / "items.json",
                 json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    size = (DATA / "items.json").stat().st_size
    kinds = {k: sum(1 for v in out.values() if v.get(k)) for k in ("h", "t", "b", "c", "tool")}
    print(f"  アイテムの用途 {len(out)} 種 ({size/1024:.0f}KB) "
          f"ハイドアウト {kinds['h']} / タスク {kinds['t']} / 交換 {kinds['b']} / "
          f"製作 {kinds['c']} / 道具 {kinds['tool']} / FiR {len(fir)}", file=sys.stderr)
    return len(out)


# 銃の分類。上流の分類 ID → (URL に使うキー, 表示名)。並びがそのまま画面の並びになる。
# グレネードランチャーとロケットランチャーは改造する部品が無いので外す。
GUN_CATEGORIES = [
    ("5447b5f14bdc2d61278b4567", "assault-rifle", "アサルトライフル"),
    ("5447b5fc4bdc2d87278b4567", "assault-carbine", "アサルトカービン"),
    ("5447b5e04bdc2d62278b4567", "smg", "サブマシンガン"),
    ("5447b6194bdc2d67278b4567", "marksman", "マークスマンライフル"),
    ("5447b6254bdc2dc3278b4568", "sniper", "スナイパーライフル"),
    ("5447bed64bdc2d97278b4568", "machinegun", "マシンガン"),
    ("5447b6094bdc2dc3278b4567", "shotgun", "ショットガン"),
    ("5447b5cf4bdc2d65278b4567", "pistol", "ハンドガン"),
    ("617f1ef5e8b54b0998387733", "revolver", "リボルバー"),
]

# 部品の計算に入れない差し込み口。
# 照準器・ライト・レーザーは好みで決めるもので、反動にも効かない（エルゴが下がるだけ）。
# 入れると「最適」がどれも裸の銃に寄ってしまうので、最初から候補にしない。
# 回転弾倉（camora）は弾そのものが入る口なので部品ではない。
EXCLUDED_SLOT = re.compile(
    r"^(mod_scope|mod_tactical|mod_flashlight|mod_launcher|mod_bipod|mod_nvg|camora)")

# 品揃えが固定でない、または特別な条件で開くトレーダー。部品の入手先に数えない。
# Fence は毎回品揃えが変わる。Lightkeeper は長いタスクの先でしか取引できない。
EXCLUDED_TRADERS = {"fence", "lightkeeper"}

# 擲弾・信号弾・おもちゃの口径。M32A1 は上流でリボルバーに分類されているので、口径で外す
EXCLUDED_CALIBERS = {"Caliber40x46", "Caliber40mmRU", "Caliber30x29", "Caliber26x75", "Caliber20x1mm"}


def caliber_label(raw: str) -> str:
    """上流の口径キー（Caliber556x45NATO など）を、ふだん呼ぶ形にする。"""
    special = {
        "Caliber1143x23ACP": ".45 ACP", "Caliber86x70": ".338 LM", "Caliber9x33R": ".357 Magnum",
        "Caliber366TKM": ".366 TKM", "Caliber12g": "12ga", "Caliber20g": "20ga",
        "Caliber23x75": "23x75mm", "Caliber127x33": ".50 AE", "Caliber762x35": ".300 BLK",
        "Caliber127x99": ".50 BMG", "Caliber784x49": ".308 ME",
    }
    if not raw:
        return ""
    if raw in special:
        return special[raw]
    m = re.match(r"^Caliber(\d+)x(\d+)([A-Za-z]*)$", raw)
    if not m:
        return raw.replace("Caliber", "")
    a, b, tail = m.groups()
    # 先頭 1 桁が整数部。556 → 5.56、762 → 7.62、9 → 9、127 → 12.7
    if len(a) == 1:
        head = a
    elif a.startswith("1"):
        head = a[:2] + ("." + a[2:] if a[2:] else "")
    else:
        head = a[0] + "." + a[1:]
    suffix = "R" if tail == "R" else ""
    return f"{head}x{b}{suffix}"


def build_guns(refresh: bool):
    """銃と、それに付く部品のデータを作る。おすすめカスタムの計算に使う。

    計算そのものはブラウザでやる。トレーダーのレベルやフリマの有無で
    答えが変わるので、ここで決め打ちにすると条件を変えられない。
    ここでは「どの部品がどこに付くか」と、部品ごとの数値・入手先だけを出す。

    相場（フリマの値段）は持たない。items.json と同じ理由で、毎日動くのに
    このデータは手動ビルドで止まるため。トレーダーの定価だけを持つ。
    """
    items_payload = json.loads(fetch(SRC_ITEMS, "items.json", refresh))
    ija = json.loads(fetch(SRC_ITEMS_LANG.format(lang="ja"), "items_ja.json", refresh))["data"]
    ien = json.loads(fetch(SRC_ITEMS_LANG.format(lang="en"), "items_en.json", refresh))["data"]
    barters = json.loads(fetch(SRC_BARTERS, "barters.json", refresh))["data"]
    traders = json.loads(fetch(SRC_TRADERS, "traders.json", refresh))
    traders = traders.get("data", traders)
    tja = json.loads(fetch(SRC_TRADERS_LANG.format(lang="ja"), "traders_ja.json", refresh))["data"]

    items = items_payload["data"]["items"]
    by_id = items if isinstance(items, dict) else {i["id"]: i for i in items}

    def tr(raw, lang=None):
        if lang is None:
            return ija.get(raw) or ien.get(raw) or raw
        return lang.get(raw) or raw

    # トレーダー。並び順の番号で参照する
    trader_keys = [k for k, v in traders.items()
                   if v.get("normalizedName") not in EXCLUDED_TRADERS]
    trader_keys.sort(key=lambda k: traders[k].get("normalizedName") or "")
    trader_idx = {k: i for i, k in enumerate(trader_keys)}
    # 4 つ目は LL ごとに要るプレイヤーレベル（LL1, LL2, …）。レベル別のおすすめに使う。
    # 信頼度（rep）と取引額の条件もあるが、プレイヤーごとに違うので満たしているとみなす
    trader_out = [[traders[k]["normalizedName"],
                   tja.get(traders[k].get("name"))
                   or (traders[k].get("normalizedName") or "?").replace("-", " ").title(),
                   [lv.get("requiredPlayerLevel") or 0
                    for lv in sorted(traders[k].get("levels") or [], key=lambda lv: lv.get("level") or 0)]]
                  for k in trader_keys]

    # タスクで解放される品物は、そのタスクを受けられるレベルを「解放レベル」とする。
    # タスク自体の必要レベルが 0 でも、前提のタスクに必要レベルがあることが多いので、
    # 前提をたどって最大をとる（35 件はタスク自体が 0）。最低でも 1（0 だと「解放条件なし」と区別できない）
    tasks_payload = json.loads(fetch(SRC_TASKS, "tasks.json", refresh))
    task_list = tasks_payload["data"]["tasks"]
    task_by_id = {t["id"]: t for t in (task_list.values() if isinstance(task_list, dict) else task_list)}
    unlock_memo = {}

    def unlock_level(tid, depth=0):
        if not tid or tid not in task_by_id:
            return 1 if tid else 0
        if tid in unlock_memo:
            return unlock_memo[tid]
        t = task_by_id[tid]
        lv = t.get("minPlayerLevel") or 0
        if depth < 40:
            for req in t.get("taskRequirements") or []:
                lv = max(lv, unlock_level((req or {}).get("task"), depth + 1))
        unlock_memo[tid] = max(lv, 1)
        return unlock_memo[tid]

    cat_of = {cid: key for cid, key, _ in GUN_CATEGORIES}
    guns_src = []
    for it in by_id.values():
        props = it.get("properties") or {}
        if "gun" not in (it.get("types") or []) or props.get("propertiesType") != "ItemPropertiesWeapon":
            continue
        cat = next((cat_of[c] for c in it.get("categories") or [] if c in cat_of), None)
        if cat and props.get("caliber") not in EXCLUDED_CALIBERS:
            guns_src.append((it, cat))

    def slots_of(it):
        out = []
        for s in (it.get("properties") or {}).get("slots") or []:
            if EXCLUDED_SLOT.match(s.get("nameId") or ""):
                continue
            allowed = [a for a in (s.get("filters") or {}).get("allowedItems") or [] if a in by_id]
            if allowed:
                out.append((s["nameId"], bool(s.get("required")), allowed, s.get("name")))
        return out

    # 銃から辿れる部品を集める
    reach = set()
    stack = [a for g, _ in guns_src for _, _, allowed, _ in slots_of(g) for a in allowed]
    while stack:
        iid = stack.pop()
        if iid in reach:
            continue
        it = by_id[iid]
        if (it.get("properties") or {}).get("propertiesType") == "ItemPropertiesAmmo":
            continue
        reach.add(iid)
        stack.extend(a for _, _, allowed, _ in slots_of(it) for a in allowed)

    mod_ids = sorted(reach)
    mod_idx = {iid: i for i, iid in enumerate(mod_ids)}

    # 差し込み口の表示名。mod_mount_000 のような連番は訳が無いので、末尾を削って探す
    slot_label = {}

    def label_for(name_id, raw_name):
        if name_id in slot_label:
            return
        key = (raw_name or name_id).upper()
        while key not in ija and "_" in key[4:]:
            key = key.rsplit("_", 1)[0]
        slot_label[name_id] = ija.get(key) or ien.get(key) or name_id

    # 同じ候補の並びが何百回も出てくる（AR-15 系のグリップなど）ので 1 回だけ持つ
    lists, list_idx = [], {}

    def list_ref(allowed):
        key = tuple(mod_idx[a] for a in allowed if a in mod_idx)
        if key not in list_idx:
            list_idx[key] = len(lists)
            lists.append(list(key))
        return list_idx[key]

    def slots_out(it):
        out = []
        for name_id, req, allowed, raw in slots_of(it):
            ref = list_ref(allowed)
            if not lists[ref]:
                continue
            label_for(name_id, raw)
            out.append([name_id, 1 if req else 0, ref])
        return out

    def buy_out(it):
        out = []
        for b in it.get("buyFromTrader") or []:
            t = b.get("trader")
            if t not in trader_idx:
                continue
            out.append([trader_idx[t], b.get("minTraderLevel") or 1,
                        b.get("priceRUB") or 0, unlock_level(b.get("taskUnlock"))])
        out.sort()
        return out

    barter_of = {}
    for b in barters:
        t = b.get("trader")
        iid = (b.get("offeredItem") or {}).get("item")
        if t in trader_idx and iid:
            barter_of.setdefault(iid, set()).add(
                (trader_idx[t], b.get("minTraderLevel") or 1, unlock_level(b.get("taskUnlock"))))

    dev_prefix = "https://tarkov.dev/item/"
    wiki_prefix = "https://escapefromtarkov.fandom.com/wiki/"

    def names(it, o):
        o["n"] = tr(it.get("name"))
        short = ija.get(it.get("shortName")) or ien.get(it.get("shortName"))
        if short and short != o["n"]:
            o["s"] = short
        # tarkov.dev のページ。接頭辞は全件同じなので末尾だけ持つ（items.json と同じ形）
        link = it.get("link") or ""
        if link.startswith(dev_prefix):
            o["dev"] = link[len(dev_prefix):]

    def rnd(v, nd=3):
        v = round(float(v or 0), nd)
        return int(v) if v == int(v) else v

    mods_out = []
    for iid in mod_ids:
        it = by_id[iid]
        props = it.get("properties") or {}
        o = {"id": iid}
        names(it, o)
        ergo = props.get("ergonomics", it.get("ergonomicsModifier") or 0)
        # 上流は 2 か所に持っている。上の階層は百分率（-0.5 = -0.5%）、
        # properties の中は割合（-0.005）。百分率に揃える
        rec = it.get("recoilModifier")
        if rec is None:
            rec = (props.get("recoilModifier") or 0) * 100
        if ergo:
            o["e"] = rnd(ergo, 2)
        if rec:
            o["r"] = rnd(rec, 2)
        o["w"] = rnd(it.get("weight"))
        sl = slots_out(it)
        if sl:
            o["sl"] = sl
        conf = sorted({mod_idx[c] for c in it.get("conflictingItems") or [] if c in mod_idx})
        if conf:
            o["x"] = conf
        b = buy_out(it)
        if b:
            o["b"] = b
        bt = sorted(barter_of.get(iid, ()))
        if bt:
            o["bt"] = [list(x) for x in bt]
        types = it.get("types") or []
        if "noFlea" not in types:
            o["fl"] = it.get("minLevelForFlea") or 0
        if "suppressor" in types:
            o["sup"] = 1
        if props.get("capacity"):
            o["cap"] = props["capacity"]
        mods_out.append(o)

    # 弾。銃ごとに撃てるもの（上流の allowedAmmo）を表にする。口径で合わせると、
    # 同じ口径でも込められない弾（12ga のスラッグを受けない銃など）まで並んでしまう
    ammo_ids = sorted({a for g, _ in guns_src for a in (g.get("properties") or {}).get("allowedAmmo") or []
                       if a in by_id})
    ammo_idx = {iid: i for i, iid in enumerate(ammo_ids)}
    ammo_out = []
    for iid in ammo_ids:
        it = by_id[iid]
        p = it.get("properties") or {}
        o = {"id": iid}
        names(it, o)
        o["dmg"] = p.get("damage") or 0
        if (p.get("projectileCount") or 1) > 1:
            o["pc"] = p["projectileCount"]  # 散弾の粒の数。ダメージは 1 粒あたり
        o["pen"] = p.get("penetrationPower") or 0
        o["ad"] = p.get("armorDamage") or 0
        o["fg"] = round((p.get("fragmentationChance") or 0) * 100)
        o["v"] = p.get("initialSpeed") or 0
        # 反動の補正。上の階層は百分率（5 = +5%）、properties の中は割合
        rec = it.get("recoil")
        if rec is None:
            rec = (p.get("recoilModifier") or 0) * 100
        if rec:
            o["r"] = rnd(rec, 1)
        if p.get("tracer"):
            o["tr"] = 1
        b = buy_out(it)
        if b:
            o["b"] = b
        bt = sorted(barter_of.get(iid, ()))
        if bt:
            o["bt"] = [list(x) for x in bt]
        if "noFlea" not in (it.get("types") or []):
            o["fl"] = it.get("minLevelForFlea") or 0
        ammo_out.append(o)

    # URL に使う短い名前。英語の略称から作る（日本語の略称はカナ混じりのことがある）
    used_slugs = set()

    def slug_for(it):
        base = ien.get(it.get("shortName")) or it.get("normalizedName") or it["id"]
        s = re.sub(r"[^a-z0-9]+", "-", base.lower()).strip("-") or it["id"]
        # 色違いなどで略称が重なるものは、正式名から作った長い名前にする（-2 では区別が付かない）
        if s in used_slugs:
            s = it.get("normalizedName") or it["id"]
        cand, n = s, 2
        while cand in used_slugs:
            cand, n = f"{s}-{n}", n + 1
        used_slugs.add(cand)
        return cand

    # 標準の構成（プリセット）の ID。銃そのものの画像はレシーバーだけの裸の姿なので、
    # 組み上がった姿を見せるにはプリセットの画像を使う
    default_preset = {}
    for it in by_id.values():
        props = it.get("properties") or {}
        if "preset" in (it.get("types") or []) and props.get("default") and props.get("baseItem"):
            default_preset[props["baseItem"]] = it["id"]

    order = {key: i for i, (_, key, _) in enumerate(GUN_CATEGORIES)}
    guns_src.sort(key=lambda gc: (order[gc[1]], ien.get(gc[0].get("shortName")) or ""))
    guns_out = []
    for it, cat in guns_src:
        props = it["properties"]
        sl = slots_out(it)
        if not sl:
            continue  # 何も付けられない銃（信号拳銃など）は出さない
        o = {"id": it["id"], "slug": slug_for(it), "cat": cat}
        names(it, o)
        o["cal"] = caliber_label(props.get("caliber"))
        o["e"] = rnd(props.get("ergonomics"), 2)
        o["rv"] = props.get("recoilVertical") or 0
        o["rh"] = props.get("recoilHorizontal") or 0
        o["w"] = rnd(it.get("weight"))
        if props.get("fireRate"):
            o["fr"] = props["fireRate"]
        wiki = it.get("wikiLink") or ""
        if wiki.startswith(wiki_prefix):
            o["wiki"] = wiki[len(wiki_prefix):]
        if it["id"] in default_preset:
            o["img"] = default_preset[it["id"]]
        o["sl"] = sl
        # 標準の構成（買ったときに付いてくる部品）。トレーダーで売っていない部品でも
        # 銃を買えば手に入るので、計算では入手できるものとして扱う
        o["d"] = sorted({mod_idx[c["item"]] for c in it.get("containsItems") or []
                         if c.get("item") in mod_idx})
        o["am"] = [ammo_idx[a] for a in props.get("allowedAmmo") or [] if a in ammo_idx]
        b = buy_out(it)
        if b:
            o["b"] = b
        guns_out.append(o)

    counts = {}
    for g in guns_out:
        counts[g["cat"]] = counts.get(g["cat"], 0) + 1
    out = {
        "builtAt": __import__("datetime").datetime.now().strftime("%Y-%m-%d %H:%M"),
        "categories": [[key, label, counts.get(key, 0)]
                       for _, key, label in GUN_CATEGORIES if counts.get(key)],
        "traders": trader_out,
        # フリマを使えるプレイヤーレベル。部品ごとの「Lv○○ から」は各部品の fl
        "fleaLevel": ((items_payload["data"].get("fleaMarket") or {}).get("minPlayerLevel") or 15),
        "slots": slot_label,
        "lists": lists,
        "mods": mods_out,
        "ammo": ammo_out,
        "guns": guns_out,
    }
    DATA.mkdir(parents=True, exist_ok=True)
    write_atomic(DATA / "guns.json", json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    size = (DATA / "guns.json").stat().st_size
    print(f"  銃 {len(guns_out)} 丁 / 部品 {len(mods_out)} 点 / 弾 {len(ammo_out)} 種 / "
          f"候補の並び {len(lists)} 種 ({size/1024:.0f}KB)", file=sys.stderr)
    return len(guns_out), len(mods_out), len(ammo_out)


def fix_swapped_verbs(payload: dict, ja: dict, en: dict):
    """上流の和訳で「渡す」と「手に入れる」が入れ替わっている目標を直す。

    A Bitter Victory では "Obtain the item: Rye croutons" が「ライ麦クルトン を渡す」、
    "Hand over the item: Rye croutons" が「… を手に入れる」になっていた。
    英語の原文の動詞を正として、食い違うものだけ動詞を差し替える。
    ja は書き換えずに写しを返す。
    """
    tasks = payload["data"]["tasks"]
    tasks = tasks.values() if isinstance(tasks, dict) else tasks
    fixed = dict(ja)
    count = 0
    for t in tasks:
        for o in t.get("objectives") or []:
            key = o.get("description")
            e, j = en.get(key) or "", ja.get(key) or ""
            if e.startswith("Hand over") and "手に入れる" in j and "渡" not in j:
                fixed[key] = j.replace("を手に入れる", "を渡す").replace("手に入れる", "渡す")
            elif e.startswith(("Obtain", "Find")) and "渡す" in j and "手に入れる" not in j and "見つけ" not in j:
                fixed[key] = j.replace("を渡す", "を手に入れる").replace("渡す", "手に入れる")
            else:
                continue
            count += 1
    return fixed, count


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
    # 上流の ja 辞書には課題名の和訳が 1 件も無く（517 件すべて英語が返る）、
    # 課題名は常に英語になる。逆に目標の description は和訳されている。
    # つまり検索は「英語の課題名」と「日本語の目標文」の両方に当たる必要がある。
    # Wiki と照合するための英語のタスク名。訳を当てると一部が日本語になる
    raw = payload["data"]["tasks"]
    en_names = {en.get(t.get("name"), t.get("name")) for t in (raw.values() if isinstance(raw, dict) else raw)}
    ja, swapped = fix_swapped_verbs(payload, ja, en)
    n = apply_translations(payload, ja, en)
    print(f"  タスクの表示名を解決: {n} 件（訳の入れ替わりを直した {swapped} 件）", file=sys.stderr)

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

    # tarkov.dev に無いタスクを Wiki で補う。Wiki が読めなくても続行する
    try:
        supplement_from_wiki(refresh, en_names | {t.get("name") or "" for t in tasks}, by_map, out_dir)
    except Exception as exc:  # noqa: BLE001 取り込み元が別サイトなので何が起きても続行
        print(f"  !! Wiki でタスクを補えませんでした: {exc}", file=sys.stderr)

    for stale in out_dir.glob("*.json"):
        stale.unlink()

    counts = {}
    for key, recs in by_map.items():
        # トレーダー → 必要レベル → 名前 の順に並べておく。UI 側で並べ替えなくて済む
        recs.sort(key=lambda r: (r["tr"], r.get("lv") or 0, r["n"] or ""))
        if key == ANY_MAP:
            for r in recs:
                r["any"] = 1
        write_atomic(
            out_dir / f"{key}.json",
            json.dumps(recs, ensure_ascii=False, separators=(",", ":")),
        )
        counts[key] = len(recs)

    total = sum((out_dir / f"{k}.json").stat().st_size for k in counts)
    print(f"  タスク {sum(counts.values())} 件（うち任意マップ {counts.get(ANY_MAP, 0)}）"
          f" / ゾーン {zones} / 候補点 {points} / {len(counts)} ファイル {total:,} バイト",
          file=sys.stderr)
    return counts


# Wiki 上のマップ名 → こちらのキー。リンク先がこの名前と完全に一致するときだけ
# マップへの言及とみなす（"The Labyrinth (story chapter)" は章の名前でマップではない）
WIKI_MAPS = {
    "Customs": "customs", "Factory": "factory", "Ground Zero": "ground-zero",
    "Icebreaker": "icebreaker", "Interchange": "interchange", "Lighthouse": "lighthouse",
    "Reserve": "reserve", "Shoreline": "shoreline", "Streets of Tarkov": "streets-of-tarkov",
    "Terminal": "terminal", "The Lab": "the-lab", "The Labyrinth": "the-labyrinth",
    "Woods": "woods",
}
WIKI_LINK = re.compile(r"\[\[([^\[\]|]+)(?:\|([^\[\]]*))?\]\]")


def wiki_section(text: str, name: str) -> str:
    """==name== から次の ==…== までを返す。===…=== は区切りにしない。"""
    m = re.search(rf"^==\s*{re.escape(name)}\s*==\s*$", text, re.M)
    if not m:
        return ""
    rest = text[m.end():]
    nxt = re.search(r"^==[^=].*?[^=]==\s*$", rest, re.M)
    return rest[:nxt.start()] if nxt else rest


def wiki_plain(s: str):
    """wikitext の 1 行を、表示する文字列と言及しているマップに分ける。"""
    maps = []

    def link(m):
        target, label = m.group(1).strip(), m.group(2)
        if target in WIKI_MAPS:
            maps.append(WIKI_MAPS[target])
        return (label if label is not None else target).strip()

    s = re.sub(r"\[\[File:[^\[\]]*\]\]", "", s)
    s = WIKI_LINK.sub(link, s)
    s = re.sub(r"\{\{[^{}]*\}\}", "", s)
    s = re.sub(r"<[^>]+>", "", s)
    s = s.replace("'''", "").replace("''", "")
    return re.sub(r"\s+", " ", s).strip(), list(dict.fromkeys(maps))


def build_story(refresh: bool):
    """メインストーリー（ストーリー章）を Wiki から取り込む。

    tarkov.dev のタスクにはストーリー章が 1 件も入っていない（トレーダーの
    タスクだけ）。座標も無いので地図にピンは出せない。ここでは章ごとの
    目標の一覧と、各目標がどのマップに関わるかだけを持つ。文面は Wiki の英語のまま。
    """
    api = "https://escapefromtarkov.fandom.com/api.php?action=parse&prop=wikitext&format=json&redirects=1&page="

    def wikitext(page: str, name: str) -> str:
        body = json.loads(fetch(api + urllib.parse.quote(page.replace(" ", "_")), name, refresh))
        return body["parse"]["wikitext"]["*"]

    index = wikitext("Story chapters", "story_index.json")
    chapters = []
    for target, label in re.findall(r"^\|\s*\[\[([^\[\]|]+)(?:\|([^\[\]]*))?\]\]\s*$", index, re.M):
        # 同じ表に章のバナー画像（[[File:…|450px]]）の列もある
        if not target.startswith("File:"):
            chapters.append((target.strip(), (label or target).strip()))

    out = []
    for target, title in chapters:
        slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
        text = wikitext(target, f"story_{slug}.json")
        text = re.sub(r"<gallery.*?</gallery>", "", text, flags=re.S)

        # 攻略の見出し（===目標文===）の下に出てくるマップを、その目標に足す。
        # 目標文そのものにマップのリンクが無くても、攻略にはマップ別の手順がある
        # （Batya の「BEAR 特殊部隊の痕跡」は ====Customs==== などに分かれている）。
        guide_maps = {}
        parts = re.split(r"^===([^=].*?)===\s*$", wiki_section(text, "Guide"), flags=re.M)
        for head, body in zip(parts[1::2], parts[2::2]):
            key, hm = wiki_plain(head)
            _, bm = wiki_plain(body)
            guide_maps.setdefault(key.lower(), []).extend(hm + bm)

        rows = []

        def add_lines(src: str, start: bool):
            for line in src.splitlines():
                line = line.strip()
                if not line or line.startswith(":"):
                    continue
                m = re.match(r"^(\*+)\s*(.*)$", line)
                h = re.match(r"^===(.*?)===$", line) or re.match(r"^'''(.*?)(?:''')?$", line)
                if m:
                    d, maps = wiki_plain(m.group(2))
                    opt = bool(re.match(r"^\(Optional\)\s*", d, re.I))
                    d = re.sub(r"^\(Optional\)\s*", "", d, flags=re.I)
                    maps = list(dict.fromkeys(maps + guide_maps.get(d.lower(), [])))
                    row = {"d": d, "t": "start" if start else "story"}
                    if len(m.group(1)) > 1:
                        row["ind"] = len(m.group(1)) - 1
                    if opt:
                        row["opt"] = 1
                    if maps:
                        row["sm"] = maps
                elif h or start:
                    d, maps = wiki_plain((h.group(1) if h else line))
                    row = {"d": d, "t": "start" if start else "branch"}
                    if maps and start:
                        row["sm"] = maps
                else:
                    continue
                if row["d"]:
                    rows.append(row)

        add_lines(wiki_section(text, "Requirements"), True)
        add_lines(wiki_section(text, "Objectives"), False)
        if not rows:
            print(f"  !! ストーリー「{title}」の目標を読めませんでした", file=sys.stderr)
            continue

        maps = list(dict.fromkeys(k for r in rows for k in r.get("sm", [])))
        out.append({
            "id": f"story-{slug}",
            "n": title,
            "tr": "Story",
            "story": 1,
            "mp": maps,
            "o": rows,
            "w": "https://escapefromtarkov.fandom.com/wiki/" + urllib.parse.quote(target.replace(" ", "_")),
        })

    write_atomic(DATA / "story.json", json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    print(f"  ストーリー {len(out)} 章 / 目標 {sum(len(c['o']) for c in out)} 行 / "
          f"{(DATA / 'story.json').stat().st_size:,} バイト", file=sys.stderr)
    return len(out)


def task_key(name: str) -> str:
    """タスク名を照合用に揃える。"[PVP ZONE]" の付け方や記号の違いは無視する。"""
    s = re.sub(r"\[pvp zone\]", "", (name or "").lower())
    return re.sub(r"[^a-z0-9]", "", s)


def supplement_from_wiki(refresh: bool, upstream_names: set, by_map: dict, prev_dir: Path):
    """tarkov.dev に無いタスクを Wiki のクエスト一覧で補う。

    2026-10 の時点で tarkov.dev は 1.0 で作り直された Lightkeeper のタスク
    （"To the Light - …"）を持っておらず、Make Amends 系は丸ごと消えていた。
    Wiki のクエスト一覧で今も確認できるものだけを足す。
      - 前回のビルドに入っていたもの（座標つき）は、そのまま残す
      - それ以外は Wiki の目標文とマップ名だけで載せる（座標は無い）
    アリーナ専用（Ref の Gladiator Life など、マップを名指ししないもの）と
    プレステージは対象にしない。by_map を直接書き換える。
    """
    api = "https://escapefromtarkov.fandom.com/api.php?action=parse&prop=wikitext&format=json&redirects=1&page=Quests"
    text = json.loads(fetch(api, "wiki_quests.json", refresh))["parse"]["wikitext"]["*"]
    traders = re.findall(r"class=wds-tabs__tab-label\|([^\]]+)\]\]", text)
    contents = text.split('<div class="wds-tab__content')[1:]

    have = {task_key(n) for n in upstream_names}
    # 前回のビルド。同じタスクがマップごとに 1 件ずつ入っている
    prev = {}
    for f in prev_dir.glob("*.json"):
        try:
            recs = json.loads(f.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        for r in recs:
            if r.get("wk"):
                continue  # 前回 Wiki から足したものは、今回も Wiki から作り直す
            prev.setdefault(task_key(r.get("n")), []).append((f.stem, r))

    kept = built = 0
    for trader, body in zip(traders, contents):
        # 上流のトレーダー名は normalizedName を整えたもの（"btr-driver" → "Btr Driver"）
        tr = trader.replace("-", " ").title()
        for row in body.split("\n|-")[1:]:
            m = re.match(r"\s*\|\s*\[\[([^\]|]+)(?:\|([^\]]*))?\]\]", row)
            if not m:
                continue
            target = m.group(1).strip()
            name = (m.group(2) or target).strip()
            key = task_key(name)
            if key in have or "(Prestige" in name:
                continue

            if key in prev:
                for map_key, r in prev[key]:
                    by_map.setdefault(map_key, []).append(r)
                have.add(key)
                kept += 1
                continue

            # 行は「| [[名前]] / | 目標の箇条書き / | 報酬」の 3 列
            cols = re.split(r"\n\|", "\n" + row.lstrip())
            at = next((i for i, c in enumerate(cols) if "[[" + target in c), -1)
            objectives = cols[at + 1] if 0 <= at < len(cols) - 1 else ""
            rows = []
            for line in objectives.splitlines():
                b = re.match(r"^\s*(\*+)\s*(.*)$", line)
                if not b:
                    continue
                d, maps = wiki_plain(b.group(2))
                opt = bool(re.match(r"^\(Optional\)\s*", d, re.I))
                d = re.sub(r"^\(Optional\)\s*", "", d, flags=re.I)
                if not d:
                    continue
                o = {"d": d, "t": "wiki"}
                if len(b.group(1)) > 1:
                    o["ind"] = len(b.group(1)) - 1
                if opt:
                    o["opt"] = 1
                if maps:
                    o["sm"] = maps
                rows.append(o)
            maps = list(dict.fromkeys(k for o in rows for k in o.get("sm", [])))
            if not rows or (trader == "Ref" and not maps):
                continue

            rec = {
                "id": "wiki-" + re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-"),
                "n": name,
                "tr": tr,
                "lv": None,
                "wk": 1,
                "o": rows,
                "w": "https://escapefromtarkov.fandom.com/wiki/" + urllib.parse.quote(target.replace(" ", "_")),
            }
            for map_key in maps or [ANY_MAP]:
                by_map.setdefault(map_key, []).append(dict(rec))
            have.add(key)
            built += 1

    print(f"  Wiki でタスクを補った: 前回のデータを残した {kept} 件 / Wiki の目標文で作った {built} 件",
          file=sys.stderr)


# スイッチを入れないと使えない脱出口と、入れる順のスイッチ。
#
# 上流の extracts[].switch は 2026-10 に壊れ、Customs の脱出口 28 か所すべてが
# 「ZB-013 Power Switch」を、Labs の 7 か所すべてが「Med Elevator Extract Button」を
# 要求することになった。壊れる前（2026-09）の上流は 10 か所だけを正しく結んでいたので、
# それと上流のスイッチ同士の関係（activatedBy / activates）から、ここで表にする。
# 脱出口の名前・スイッチの名前で引く（ID は上流で振り直されることがある）。
EXTRACT_SWITCHES = {
    "the-lab": {
        "Main Elevator": ["Main Elevator Power Button", "Main Elevator Call Button"],
        "Medical Block Elevator": ["Med Elevator Power Button", "Med Elevator Call Button"],
        "Cargo Elevator": ["Cargo Elevator Power Button", "Cargo Elevator Call Button"],
        "Hangar Gate": ["Hangar Gate Switch"],
        "Parking Gate": ["Parking Gate Switch"],
        "Sewage Conduit": ["Sewage Conduit Pump Button"],
    },
    "reserve": {
        "D-2": ["D-2 Power Switch", "D-2 Door Switch"],
        "Bunker Hermetic Door": ["Bunker Hermetic Door Power Switch"],
    },
    "interchange": {
        "Saferoom Exfil": ["Mall Main Power Switch", "Saferoom Exfil Unlock Switch", "Saferoom Exfil Switch"],
    },
    "customs": {
        # 2026-10 に脱出口が ZB-013 → ZB-1013 に改名された（座標は同じ）
        "ZB-1013": ["ZB-013 Power Switch"],
    },
}
# 脱出口の階を、高さからの判定ではなく名指しで決めるもの。
# Icebreaker のヘリポートは脱出範囲の中心（22.56m）が甲板の範囲（〜22.1m）を少し超え、
# 1 つ上の Lv3 と判定される。地図（re3mr）ではヘリポートは Lv2。
# 範囲の床の高さで判定する案は、Streets の Expo Checkpoint が B1 になるなど逆効果だった
EXTRACT_FLOOR_FIX = {
    ("icebreaker", "Helicopter"): "Lv2",
}
# 脱出口からこれ以内のスイッチは、その場で押すもの（呼び出しボタン）なので印を付けない (m)
SWITCH_AT_EXTRACT_M = 6.0


def floor_label(td, x, y, z):
    """その地点の階を「1F」「2F」「B1」の形で返す。階の無いマップは None。

    アプリの pickFloor（main.js）と同じ規則: 高さが範囲に入り、平面の矩形が
    あればその中にあるレイヤのうち、下限の高いものを採る。どれにも入らなければ地上。
    """
    layers = (td or {}).get("layers") or []
    if not layers:
        return None
    best = None
    for L in layers:
        for ex in L.get("extents") or []:
            lo, hi = (ex.get("height") or [-math.inf, math.inf])[:2]
            if not (lo <= y < hi):
                continue
            rects = ex.get("bounds") or []
            if rects and not any(
                min(r[0][0], r[1][0]) <= x <= max(r[0][0], r[1][0])
                and min(r[0][1], r[1][1]) <= z <= max(r[0][1], r[1][1])
                for r in rects
            ):
                continue
            if best is None or lo > best[1] or (lo == best[1] and hi - lo < best[2]):
                best = (L, lo, hi - lo)
    if best is None:
        return "1F"
    if best[0].get("label"):
        return best[0]["label"]
    name = best[0].get("name") or ""
    m = re.match(r"^(\d+)(?:st|nd|rd|th) Floor$", name)
    if m:
        return f"{m.group(1)}F"
    if name == "Second Level":
        return "2F"
    if name in ("Underground", "Tunnels", "Bunkers", "Technical", "Basement"):
        return "B1"
    return name


def annotate_extracts(entry: dict, switches: list, td):
    """脱出口に階と、要るスイッチ（記号 A, B, … つき）を書き込む。entry を直接書き換える。"""
    by_name = {(s.get("name") or "").lower(): s for s in switches if s.get("position")}
    table = EXTRACT_SWITCHES.get(entry["key"], {})
    code = 0
    for e in entry.get("extracts") or []:
        p = e.get("position")
        if p:
            fl = EXTRACT_FLOOR_FIX.get((entry["key"], e.get("name"))) or floor_label(td, p["x"], p["y"], p["z"])
            if fl:
                e["fl"] = fl
        names = table.get(e.get("name"))
        if not names:
            continue
        sw = []
        for n in names:
            s = by_name.get(n.lower())
            if not s:
                print(f"  !! {entry['key']} の脱出口「{e['name']}」のスイッチ「{n}」が上流に無い",
                      file=sys.stderr)
                continue
            q = s["position"]
            if p and math.dist((p["x"], p["z"]), (q["x"], q["z"])) <= SWITCH_AT_EXTRACT_M:
                continue
            rec = {"n": n, "p": [round(q["x"], 2), round(q["y"], 2), round(q["z"], 2)]}
            fl = floor_label(td, q["x"], q["y"], q["z"])
            if fl:
                rec["fl"] = fl
            sw.append(rec)
        # スイッチがすべて脱出口のそばでも、「要る」こと自体は示す
        e["sw"] = sw
        e["code"] = chr(ord("A") + code)
        code += 1
    # 同じ名前の脱出口（PMC 用とスカブ用）は同じ記号にする
    codes = {}
    for e in entry.get("extracts") or []:
        if "code" in e:
            codes.setdefault(e["name"], e["code"])
    for e in entry.get("extracts") or []:
        if e.get("name") in codes:
            e["code"] = codes[e["name"]]


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
    # artillery だけは {"zones": [...]} という形をしている
    for z in ((scene.get("artillery") or {}).get("zones")) or []:
        take(z)
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


def check_scene_aliases(merged: dict):
    """座標系を共有しているのに統合されていないマップ対を見つける。

    SCENE_ALIASES は手書きなので、上流に新しい夜／イベント版が増えたときに
    追記を忘れると、その 2 マップは互いの POI が距離 0 になり、判定の要である
    「2 位 / 1 位」の比が 1.0 に張り付いて機能しなくなる。
    書き忘れをビルドで落とす。
    """
    import itertools

    keys = sorted(merged)
    grids = {}
    for k in keys:
        # 1m 格子に落として集合で比べる。総当たりの距離計算は要らない
        grids[k] = {(round(x), round(z)) for x, _y, z in merged[k]["points"]}

    bad = []
    for a, b in itertools.combinations(keys, 2):
        ga, gb = grids[a], grids[b]
        if not ga or not gb:
            continue
        overlap = len(ga & gb)
        ratio = overlap / min(len(ga), len(gb))
        if ratio >= 0.90:
            bad.append((a, b, ratio))
    if bad:
        lines = "\n".join(
            f"    {a} と {b} の POI が {r * 100:.0f}% 一致" for a, b, r in bad
        )
        raise SystemExit(
            "座標系を共有しているのに統合されていないマップがあります。\n"
            f"{lines}\n"
            "  tools/build_data.py の SCENE_ALIASES に追記してください。\n"
            "  統合しないと、その 2 マップは互いに距離 0 になり判定が壊れます。"
        )


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


CLAMPED = []


def quantize(points):
    """デシメートル int16 に量子化して重複を落とす。

    ±3276.7m を超える点は clamp されるが、そのままだとマップの端に貼り付いた
    偽の POI になり、最近傍距離を静かに壊す。起きたら記録して警告する。
    """
    seen = set()
    for x, y, z in points:
        raw = (round(x * 10), round(y * 10), round(z * 10))
        t = tuple(max(-32768, min(32767, v)) for v in raw)
        if t != raw:
            CLAMPED.append((x, y, z))
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
    # Wiki が落ちていてもほかのデータは作れるようにする（前回の story.json は残る）
    try:
        story_count = build_story(args.refresh)
    except Exception as exc:  # noqa: BLE001 取り込み元が別サイトなので何が起きても続行
        print(f"  !! ストーリーを取り込めませんでした: {exc}", file=sys.stderr)
        story_count = len(json.loads((DATA / "story.json").read_text(encoding="utf-8")))             if (DATA / "story.json").exists() else 0
    item_count = build_items(args.refresh)
    gun_count, gun_mod_count, gun_ammo_count = build_guns(args.refresh)
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
            m["raidDuration"] = scene.get("raidDuration")
            m["switches"] = scene.get("switches") or []
            m["extracts"] = [
                {
                    "name": e.get("name"),
                    # スイッチが要るかどうかは、上流の e["switch"] ではなく
                    # EXTRACT_SWITCHES で決める（annotate_extracts を参照）
                    # 内部キーも残す。校正ツールの参照 ID に使うため、
                    # 表示名が変わっても対応点が迷子にならない。
                    "key": e.get("id") or e.get("name"),
                    "faction": e.get("faction"),
                    "position": e.get("position"),
                    "outline": e.get("outline") or [],
                }
                for e in (scene.get("extracts") or [])
            ]

    check_scene_aliases(merged)

    blob = bytearray()
    maps_out = []
    dropped_total = 0
    for key in sorted(merged):
        m = merged[key]
        raw, dropped = drop_outliers(m["points"], interactive.get(key))
        dropped_total += dropped
        m["dropped"] = dropped
        # 地図の範囲から大きく外れた脱出口は載せない。2026-10 に Ground Zero の
        # UN Roadblock と Scav Bunker が範囲の数百 m 外の座標で入ってきた。
        # 地図画像に無い場所なので、描いても地図の外に浮いた印にしかならない
        td_here = interactive.get(key)
        if td_here:
            kept = []
            for e in m.get("extracts") or []:
                p = e.get("position") or {}
                if all(k in p for k in "xyz") and not drop_outliers([(p["x"], p["y"], p["z"])], td_here)[0]:
                    print(f"  !! {key} の脱出口「{e.get('name')}」は地図の範囲外なので載せません", file=sys.stderr)
                    continue
                kept.append(e)
            m["extracts"] = kept
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
            "raidDuration": m.get("raidDuration"),
            # ワールドの +Z が真北から何度ずれているか。方位ローズに使う
            "northDeg": m.get("coordinateToCardinalRotation"),
            "taskCount": task_counts.get(key, 0),
            "taskFile": f"data/tasks/{key}.json" if task_counts.get(key) else None,
            "landmarkCounts": landmark_counts.get(key) or {},
            "landmarkFile": f"data/landmarks/{key}.json" if landmark_counts.get(key) else None,
            "affine": affine,
            "rms": (ov or {}).get("rms"),
            "calib": calib,
            "svg": ("maps/" + svg_name) if (svg_name and affine) else None,
            # 基準にする SVG のレイヤ。override が優先。指定が無ければ
            # tarkov-dev の svgLayer。どちらも無ければ全レイヤ表示になる
            "svgBaseLayer": ((ov or {}).get("svgLayer")
                             or ((td or {}).get("svgLayer") if td else None)),
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
        # 手動校正がフロアの定義を持っていれば置き換える（Icebreaker: re3mr の甲板 14 枚）
        if ov and ov.get("layers") and entry["tarkovDev"]:
            entry["tarkovDev"]["layers"] = ov["layers"]
        # 地図の出典。SVG 地図集以外の地図を使うマップだけが持つ
        if ov and ov.get("credit"):
            entry["credit"] = ov["credit"]
        annotate_extracts(entry, m.get("switches") or [], entry.get("tarkovDev"))
        maps_out.append(entry)

    DATA.mkdir(parents=True, exist_ok=True)
    write_atomic(DATA / "poi.bin", bytes(blob))
    svg_files = sorted(p.name for p in MAPS.glob("*.svg")) if MAPS.exists() else []
    any_count = task_counts.get(ANY_MAP, 0)
    db = {
        "itemFile": "data/items.json" if item_count else None,
        "itemCount": item_count,
        "gunFile": "data/guns.json" if gun_count else None,
        "gunCount": gun_count,
        "gunModCount": gun_mod_count,
        "gunAmmoCount": gun_ammo_count,
        "anyTaskFile": f"data/tasks/{ANY_MAP}.json" if any_count else None,
        "anyTaskCount": any_count,
        "storyFile": "data/story.json" if story_count else None,
        "storyCount": story_count,
        # スキーマを変えたら上げる。loadMapDb が照合して食い違いを知らせる
        "version": 2,
        "generated": "build_data.py",
        "builtAt": __import__("datetime").datetime.now().strftime("%Y-%m-%d %H:%M"),
        "svgFiles": svg_files,
        "poiUnit": "decimetre",
        "poiStride": 3,
        "poiTotal": len(blob) // 6,
        "maps": maps_out,
    }
    write_atomic(
        DATA / "mapdb.json",
        json.dumps(db, ensure_ascii=False, separators=(",", ":")),
    )

    if CLAMPED:
        print(f"  !! 座標が Int16 の範囲を超えて切り詰められました: {len(CLAMPED)} 点",
              file=sys.stderr)
        for p in CLAMPED[:3]:
            print(f"     {p}", file=sys.stderr)

    print(f"\n  {len(maps_out)} maps / {db['poiTotal']} points", file=sys.stderr)
    print(f"  data/poi.bin     {len(blob):>8,} bytes", file=sys.stderr)
    print(f"  data/mapdb.json  {(DATA / 'mapdb.json').stat().st_size:>8,} bytes", file=sys.stderr)
    print(file=sys.stderr)
    write_readme_summary(db, task_counts, landmark_counts)
    bump_service_worker(db["builtAt"])

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


def write_readme_summary(db: dict, task_counts: dict, landmark_counts: dict):
    """README の数値を書き換える。手で同期すると必ずずれるので機械にやらせる。"""
    readme = ROOT / "README.md"
    if not readme.exists():
        return
    text = readme.read_text(encoding="utf-8")
    begin, end = "<!-- data:begin -->", "<!-- data:end -->"
    if begin not in text or end not in text:
        return

    maps = db["maps"]
    with_map = [m for m in maps if m.get("svg")]
    task_total = sum(task_counts.values())
    any_tasks = task_counts.get(ANY_MAP, 0)
    lm_total = sum(sum(c.values()) for c in landmark_counts.values())

    def size(rel):
        p = ROOT / rel
        return p.stat().st_size if p.exists() else 0

    def dirsize(rel):
        p = ROOT / rel
        return sum(f.stat().st_size for f in p.glob("*.json")) if p.is_dir() else 0

    rows = [
        ("マップ", f"{len(maps)}（地図画像あり {len(with_map)}）", ""),
        ("POI", f"{db['poiTotal']:,} 点", f"data/poi.bin {size('data/poi.bin'):,} B"),
        ("脱出口", f"{sum(len(m.get('extracts') or []) for m in maps)} 箇所", ""),
        ("タスク", f"延べ {task_total} 件（うちマップ非依存 {any_tasks}）",
         f"data/tasks/ {dirsize('data/tasks'):,} B"),
        ("ストーリー", f"{db.get('storyCount', 0)} 章（Wiki から。地点データなし）",
         f"data/story.json {size('data/story.json'):,} B"),
        ("名前の付いた地点", f"{lm_total} 件", f"data/landmarks/ {dirsize('data/landmarks'):,} B"),
        ("アイテムの用途", f"{db.get('itemCount', 0)} 種",
         f"data/items.json {size('data/items.json'):,} B"),
        ("銃と部品", f"{db.get('gunCount', 0)} 丁 / 部品 {db.get('gunModCount', 0)} 点 / 弾 {db.get('gunAmmoCount', 0)} 種",
         f"data/guns.json {size('data/guns.json'):,} B"),
        ("メタデータ", "", f"data/mapdb.json {size('data/mapdb.json'):,} B"),
    ]
    table = ["| | | |", "|---|---|---|"]
    table += [f"| {a} | {b} | {c} |" for a, b, c in rows]
    table.append("")
    table.append(f"生成 {db['builtAt']} / スキーマ v{db['version']}")

    body = "\n".join(table)
    text = re.sub(
        re.escape(begin) + r".*?" + re.escape(end),
        begin + "\n" + body + "\n" + end,
        text,
        flags=re.S,
    )
    write_atomic(readme, text)
    print("  README の数値を更新", file=sys.stderr)


def bump_service_worker(built_at: str):
    """sw.js の VERSION をビルド時刻にする。

    手で上げる運用だと上げ忘れる。上げ忘れると、インストール時に
    先読みした古い一式がオフラインで残り続ける。
    """
    sw = ROOT / "sw.js"
    if not sw.exists():
        return
    text = sw.read_text(encoding="utf-8")
    stamp = "eft-gps-" + built_at.replace("-", "").replace(":", "").replace(" ", "-")
    new = re.sub(r"const VERSION = '[^']*';", f"const VERSION = '{stamp}';", text, count=1)
    if new != text:
        write_atomic(sw, new)
        print(f"  sw.js の VERSION を {stamp} に更新", file=sys.stderr)


if __name__ == "__main__":
    build()
