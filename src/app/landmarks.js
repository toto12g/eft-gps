/**
 * 名前の付いた地点（脱出口以外）。
 *
 * data/landmarks/<map>.json をマップ単位で遅延読み込みする。
 * 全 13 ファイルで 155KB。まとめて読むと起動が重くなるので、開いたマップだけ読む。
 *
 * 種類ごとに表示のオンオフができる。既定では地名だけを出す。
 * 全部出すと地図が記号で埋まって、肝心の現在地が見えなくなるため。
 */

const cache = new Map();

/**
 * 表示の種類。順番はそのまま UI の並びになる。
 *
 * keys を持つものは、データ側の複数のキーをまとめて 1 つのボタンで扱う。
 * 湧きは上流が「PMC 専用 / スカブ専用 / 両方が使える」の 3 種類を持つので、
 * 「両方が使える」点は PMC・スカブどちらのボタンでも出るようにしている。
 * どちらか片方に寄せて表示するのは、上流が言っていないことになるため。
 * color は地図の配色・脱出口（緑/橙/黄）・ピン（琥珀）・タスク（紫）・現在地（シアン）
 * のいずれとも衝突しないものを選んでいる。
 */
export const LAYERS = [
  { id: 'label',   name: '地名',     color: '#d7dedc', shape: 'text',    hint: 'Big Red, Dorms, Sawmill など' },
  { id: 'hazard',  name: '危険地帯', color: '#e5484d', shape: 'area',    hint: '地雷原・狙撃ゾーン' },
  { id: 'artillery', name: '砲撃',   color: '#ff8a3d', shape: 'area',    hint: '砲撃が落ちる範囲' },
  { id: 'spawnPmc',  name: 'PMC 湧き', color: '#ff9db0', shape: 'circle',
    keys: ['spawnPmc', 'spawnBoth'],
    hint: 'PMC 専用と、スカブと共通の湧き位置' },
  { id: 'spawnScav', name: 'スカブ湧き', color: '#8fd6ff', shape: 'circle',
    keys: ['spawnScav', 'spawnBoth'],
    hint: 'スカブ専用と、PMC と共通の湧き位置' },
  { id: 'lock',    name: '施錠扉',   color: '#9aa7b8', shape: 'square',  hint: '必要な鍵の名前つき' },
  { id: 'switch',  name: 'スイッチ', color: '#ffe066', shape: 'diamond', hint: '電源・扉の操作盤' },
  { id: 'transit', name: '乗り換え', color: '#4ea3ff', shape: 'triangle', hint: '他マップへの移動口' },
  { id: 'btr',     name: 'BTR',      color: '#4ea3ff', shape: 'square',  hint: '装甲車の停留所' },
  { id: 'boss',    name: 'ボス湧き', color: '#ff5fa2', shape: 'circle',  hint: '湧き位置（抜粋）' },
  { id: 'gun',     name: '固定武器', color: '#9aa7b8', shape: 'triangle', hint: '据置の重機関銃' },
];

export const DEFAULT_ENABLED = ['label'];

/**
 * 湧きの陣営ごとの色。
 *
 * PMC・スカブ共通の点は両方のボタンで出るので、どちらのボタンで出したかで
 * 色が変わってしまわないよう、点そのものが持つ陣営で色を決める。
 */
export const SIDE_COLOR = { pmc: '#ff9db0', scav: '#8fd6ff', all: '#8ef0a6' };

/** そのレイヤがデータ側で使うキー。 */
export function layerKeys(def) {
  return def.keys || [def.id];
}

/** そのレイヤが持つ地点の数。keys をまとめて数える。 */
export function layerCount(def, data) {
  if (!data) return 0;
  return layerKeys(def).reduce((n, key) => n + ((data[key] || []).length), 0);
}

/**
 * @param {string} mapKey
 * @param {string|null} file mapdb の landmarkFile
 * @returns {Promise<Object>} 種類 → 配列
 */
export async function loadLandmarks(mapKey, file) {
  if (cache.has(mapKey)) return cache.get(mapKey);
  if (!file) {
    cache.set(mapKey, {});
    return {};
  }
  try {
    // cache: 'no-cache' の理由は src/mapdb/index.js のコメントを参照
    const data = await fetch('./' + file, { cache: 'no-cache' }).then((r) => {
      if (!r.ok) throw new Error(String(r.status));
      return r.json();
    });
    const out = data && typeof data === 'object' ? data : {};
    cache.set(mapKey, out);
    return out;
  } catch (err) {
    // 失敗はキャッシュしない（tasks.js と同じ理由）。次に開いたら取り直す
    const failed = {};
    Object.defineProperty(failed, 'failed', { value: String(err && err.message ? err.message : err) });
    return failed;
  }
}

/** 危険地帯の名前を短く読みやすくする。 */
export function hazardLabel(item) {
  if (item.t === 'sniper') return '狙撃';
  if ((item.n || '').includes('地雷') || (item.t || '').toLowerCase().includes('mine')) return '地雷';
  return item.n || '危険';
}

/** ボス湧きの表示名。確率が分かるなら添える。 */
export function bossLabel(item) {
  const pct = typeof item.c === 'number' && item.c < 1 ? `${Math.round(item.c * 100)}%` : '';
  return pct ? `${item.n} ${pct}` : item.n || 'ボス';
}
