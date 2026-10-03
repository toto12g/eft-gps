/**
 * アイテムが何に使われるか。
 *
 * 「これは拾う価値があるのか」が分からない、という声から作った層。
 * data/items.json はハイドアウト・タスク・交換・製作の 4 つを横断して
 * 集めたもので、634 種・248KB ある。起動時には読まず、使うときに取りに行く。
 *
 * 大事なのは「要る／要らない」ではなく個数。「射撃場 Lv2 に 6 個」のように
 * どこに何個要るかまで出さないと、持ち帰る判断には使えない。
 */

import { normalizeQuery } from './tasks.js';

let cache = null;

/**
 * @param {string|null} file mapdb の itemFile
 * @returns {Promise<Object>} id → 用途
 */
export async function loadItems(file) {
  if (cache) return cache;
  if (!file) return {};
  try {
    // cache: 'no-cache' の理由は src/mapdb/index.js のコメントを参照
    const data = await fetch('./' + file, { cache: 'no-cache' }).then((r) => {
      if (!r.ok) throw new Error(String(r.status));
      return r.json();
    });
    cache = data && typeof data === 'object' ? data : {};
    return cache;
  } catch (err) {
    // 失敗はキャッシュしない。一瞬の通信断で「以後ずっと読めない」状態に
    // 固めないため（tasks.js と同じ理由）
    const failed = {};
    Object.defineProperty(failed, 'failed', {
      value: String(err && err.message ? err.message : err),
    });
    return failed;
  }
}

/** 何種類の用途を持つか。多いほど「とりあえず拾っておく」価値がある。 */
export function useKinds(item) {
  return ['h', 't', 'b', 'c'].filter((k) => (item[k] || []).length).length;
}

/**
 * 持ち帰る優先度。
 *
 * 用途の数を軸にして、レイド発見品が要るものを一段上げる。
 * FiR はフリーマーケットで買えないので、見つけたその場で拾うしかない。
 * @returns {{rank:number, label:string, cls:string}}
 */
export function priority(item) {
  const kinds = useKinds(item);
  const score = kinds + (item.fir ? 1 : 0);
  if (score >= 4) return { rank: 3, label: '必ず拾う', cls: 'p3' };
  if (score >= 2) return { rank: 2, label: '拾う価値あり', cls: 'p2' };
  if (score >= 1) return { rank: 1, label: '使い道はある', cls: 'p1' };
  return { rank: 0, label: '用途なし', cls: 'p0' };
}

/** ハイドアウトで要る総数。 */
export function hideoutTotal(item) {
  return (item.h || []).reduce((n, [, , c]) => n + (c || 0), 0);
}

/** タスクで要る総数（「候補のうち 1 つ」のものは数に入れない）。 */
export function taskTotal(item) {
  return (item.t || []).reduce((n, [, c, alt]) => n + (alt === 1 ? c || 0 : 0), 0);
}

/**
 * 名前で探す。タスク検索と同じ正規化なので、半角カナでもひらがなでも引ける。
 * @param {Object} items loadItems の戻り値
 * @param {string} query
 * @param {number} limit
 */
export function searchItems(items, query, limit = 30) {
  const terms = String(query || '').trim().split(/\s+/).map(normalizeQuery).filter(Boolean);
  if (!terms.length) return [];
  const out = [];
  for (const [id, it] of Object.entries(items)) {
    const hay = normalizeQuery(`${it.n || ''} ${it.ne || ''} ${it.s || ''}`);
    if (!terms.every((t) => hay.includes(t))) continue;
    out.push({ id, ...it });
  }
  // 用途が多いものを先に。同じなら名前順
  out.sort((a, b) => priority(b).rank - priority(a).rank
    || hideoutTotal(b) - hideoutTotal(a)
    || String(a.n).localeCompare(String(b.n), 'ja'));
  return out.slice(0, limit);
}

/** 「必ず拾う」ものを上から並べる。何を覚えればいいか分からない人向け。 */
export function topItems(items, limit = 40) {
  const out = Object.entries(items).map(([id, it]) => ({ id, ...it }));
  out.sort((a, b) => priority(b).rank - priority(a).rank
    || useKinds(b) - useKinds(a)
    || hideoutTotal(b) - hideoutTotal(a));
  return out.slice(0, limit);
}

/** 用途を 1 行にまとめる。 */
export function useSummary(item) {
  const parts = [];
  const h = hideoutTotal(item);
  if (h) parts.push(`ハイドアウト ${h} 個`);
  if ((item.t || []).length) parts.push(`タスク ${item.t.length} 件`);
  if ((item.b || []).length) parts.push(`交換 ${item.b.length} 件`);
  if ((item.c || []).length) parts.push(`製作の材料 ${item.c.length} 件`);
  if ((item.tool || []).length) parts.push(`製作の道具 ${item.tool.length} 件`);
  return parts.join(' / ') || '登録された用途なし';
}
