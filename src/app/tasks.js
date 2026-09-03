/**
 * クエスト（タスク）の目標地点。
 *
 * data/tasks/<map>.json をマップ単位で遅延読み込みする。全 11 ファイルで
 * 234KB あるので、まとめて読むと起動が重くなる。開いているマップのぶんだけ読む。
 *
 * データの形（バイト数を抑えるため短いキーにしてある）:
 *   { id, n: 名前, tr: トレーダー, lv: 必要レベル, k: カッパ必須, w: wiki,
 *     o: [ { d: 説明, t: 種類, opt: 任意, z: [ゾーン], l: [候補地点] } ] }
 *   ゾーン       { m: マップ, p: [x,y,z], o: [[x,z], …] 外形 }
 *   候補地点     { m: マップ, p: [[x,y,z], …] }
 */

const cache = new Map();

/** 目標の種類の表示名。未知の種類はそのまま出す。 */
export const OBJECTIVE_TYPE = {
  visit: '到達',
  plantItem: '設置',
  plantQuestItem: '設置',
  findQuestItem: '発見',
  giveQuestItem: '引き渡し',
  findItem: '入手',
  giveItem: '納品',
  shoot: '討伐',
  extract: '脱出',
  mark: 'マーキング',
  useItem: '使用',
  buildWeapon: '製作',
  experience: '条件達成',
  skill: 'スキル',
  traderLevel: 'トレーダー',
  traderStanding: '信頼度',
  taskStatus: '前提',
  playerLevel: 'レベル',
};

/**
 * そのマップのタスク一覧を読む。二度目からはキャッシュを返す。
 * @param {string} mapKey
 * @param {string|null} file mapdb の taskFile。無ければ空配列
 * @returns {Promise<Object[]>}
 */
export async function loadTasks(mapKey, file) {
  if (cache.has(mapKey)) return cache.get(mapKey);
  if (!file) {
    cache.set(mapKey, []);
    return [];
  }
  try {
    // cache: 'no-cache' の理由は src/mapdb/index.js のコメントを参照
    const list = await fetch('./' + file, { cache: 'no-cache' }).then((r) => {
      if (!r.ok) throw new Error(String(r.status));
      return r.json();
    });
    const out = Array.isArray(list) ? list : [];
    cache.set(mapKey, out);
    return out;
  } catch (err) {
    // タスクが読めなくても測位は動く。ただし「無い」のか「読めなかった」のかは
    // 区別できるようにする。黙って空にすると原因が追えない。
    const failed = [];
    failed.failed = String(err && err.message ? err.message : err);
    cache.set(mapKey, failed);
    return failed;
  }
}

/** キャッシュを捨てて読み直せるようにする（診断用）。 */
export function clearTaskCache() {
  cache.clear();
}

/**
 * 1 つの目標から、指定マップ上の地点をすべて取り出す。
 * @returns {{zones: {p:number[], o:number[][]}[], spots: number[][]}}
 */
export function objectiveGeometry(objective, mapKey) {
  const zones = (objective.z || []).filter((z) => z.m === mapKey);
  const spots = [];
  for (const loc of objective.l || []) {
    if (loc.m === mapKey) spots.push(...loc.p);
  }
  return { zones, spots };
}

/** そのタスクが指定マップ上に持つ地点の代表点（距離計算用）。 */
export function taskPoints(task, mapKey) {
  const pts = [];
  for (const o of task.o || []) {
    const g = objectiveGeometry(o, mapKey);
    for (const z of g.zones) pts.push({ x: z.p[0], y: z.p[1], z: z.p[2] });
    for (const s of g.spots) pts.push({ x: s[0], y: s[1], z: s[2] });
  }
  return pts;
}

/** 検索語でタスクを絞る。名前・トレーダー・目標の説明を対象にする。 */
export function filterTasks(tasks, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return tasks;
  return tasks.filter((t) => {
    if ((t.n || '').toLowerCase().includes(q)) return true;
    if ((t.tr || '').toLowerCase().includes(q)) return true;
    return (t.o || []).some((o) => (o.d || '').toLowerCase().includes(q));
  });
}

/**
 * そのタスクで使う鍵に対応する施錠扉を、地点データから拾う。
 * 名前の文字列ではなく鍵の ID で照合する。
 * @param {Object} task
 * @param {Object} landmarks loadLandmarks の戻り値
 * @returns {{key:Object, locks:Object[]}[]}
 */
export function taskKeyDoors(task, landmarks) {
  const locks = (landmarks && landmarks.lock) || [];
  return (task.k || []).map((key) => ({
    key,
    locks: locks.filter((l) => l.k === key.i),
  }));
}

/** そのタスクで持っていくものを 1 つの配列にまとめる。 */
export function taskLoadout(task, mapKey) {
  const bring = [];
  let weaponSpec = 0;
  for (const o of task.o || []) {
    const g = objectiveGeometry(o, mapKey);
    // 別マップの目標の持ち物は出さない（そのマップには要らない）
    const here = g.zones.length > 0 || g.spots.length > 0 || !(o.z || o.l);
    if (!here) continue;
    if (o.mk) bring.push({ ...o.mk, kind: 'marker' });
    for (const it of o.it || []) bring.push({ ...it, kind: o.t === 'giveItem' ? 'give' : 'plant' });
    if (o.wp) weaponSpec = Math.max(weaponSpec, o.wp);
  }
  // 同じものが複数の目標に出てきたらまとめる
  const merged = new Map();
  for (const b of bring) {
    const prev = merged.get(b.i);
    if (prev) prev.c = (prev.c || 1) + (b.c || 1);
    else merged.set(b.i, { ...b });
  }
  return { bring: [...merged.values()], weaponSpec };
}

/** 一覧に出すラベル。 */
export function taskLabel(task) {
  const lv = task.lv ? ` Lv${task.lv}` : '';
  return `[${task.tr}${lv}] ${task.n}${task.kap ? ' ★' : ''}`;
}
