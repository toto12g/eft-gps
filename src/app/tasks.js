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
  sellItem: '売却',
  globalVariable: '進行状況',
  dialogue: '会話',
};

/**
 * そのマップのタスク一覧を読む。二度目からはキャッシュを返す。
 * @param {string} mapKey
 * @param {string|null} file mapdb の taskFile。無ければ空配列
 * @returns {Promise<Object[]>}
 */
async function fetchList(file) {
  // cache: 'no-cache' の理由は src/mapdb/index.js のコメントを参照
  const list = await fetch('./' + file, { cache: 'no-cache' }).then((r) => {
    if (!r.ok) throw new Error(String(r.status));
    return r.json();
  });
  return Array.isArray(list) ? list : [];
}

/**
 * @param {string} mapKey
 * @param {string|null} file mapdb の taskFile
 * @param {string|null} [anyFile] マップを問わないタスクのファイル
 */
export async function loadTasks(mapKey, file, anyFile = null) {
  if (cache.has(mapKey)) return cache.get(mapKey);
  if (!file && !anyFile) {
    cache.set(mapKey, []);
    return [];
  }
  try {
    // マップ固有のものと、マップを問わないものを合わせて 1 つの一覧にする。
    // 「任意のマップ」のタスクを全マップのファイルに複製すると重複するので、
    // 別ファイルにして読み込み時に混ぜている。
    const [own, any] = await Promise.all([
      file ? fetchList(file) : Promise.resolve([]),
      anyFile ? fetchList(anyFile) : Promise.resolve([]),
    ]);
    const out = [...own, ...any];
    cache.set(mapKey, out);
    return out;
  } catch (err) {
    // 失敗はキャッシュしない。一瞬の通信断で「以後ずっと読めない」状態に
    // 固まってしまう。次に同じマップを開いたときに取り直す。
    const failed = [];
    failed.failed = String(err && err.message ? err.message : err);
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

/** その目標が、このマップで意味を持つか。 */
export function objectiveApplies(objective, mapKey) {
  const hasPlace = (objective.z || []).length || (objective.l || []).length;
  if (!hasPlace) return true; // 場所を持たない目標はどのマップでも意味がある
  const g = objectiveGeometry(objective, mapKey);
  return g.zones.length > 0 || g.spots.length > 0;
}

/**
 * そのタスクで持っていくもの／探すものをまとめる。
 *
 * クエストアイテムは items ではなく questItem に入っているので、別に拾う。
 * ここを見落としていると、222 目標ぶんが持ち物にまったく出てこない。
 */
export function taskLoadout(task, mapKey) {
  const bring = [];
  const find = [];
  let weaponSpec = 0;

  for (const o of task.o || []) {
    if (!objectiveApplies(o, mapKey)) continue;
    if (o.mk) bring.push({ ...o.mk, kind: 'marker' });
    for (const it of o.it || []) bring.push({ ...it, kind: o.t === 'giveItem' ? 'give' : 'plant' });
    if (o.qi) {
      // 持ち込む(plant) / 探す(find) / 引き渡す(give) で意味が違う
      if (o.t === 'plantQuestItem') bring.push({ ...o.qi, kind: 'plant', quest: 1 });
      else find.push({ ...o.qi, kind: o.t === 'giveQuestItem' ? 'hand' : 'find' });
    }
    if (o.wp) weaponSpec = Math.max(weaponSpec, o.wp);
  }

  const dedupe = (list) => {
    const merged = new Map();
    for (const b of list) {
      const prev = merged.get(b.i);
      if (prev) prev.c = (prev.c || 1) + (b.c || 1);
      else merged.set(b.i, { ...b });
    }
    return [...merged.values()];
  };
  const bringIds = new Set(bring.map((b) => b.i));
  return {
    bring: dedupe(bring),
    // 持ち込むものと重複する場合は「探す」側から落とす
    find: dedupe(find).filter((f) => !bringIds.has(f.i)),
    weaponSpec,
  };
}

/** 一覧に出すラベル。 */
export function taskLabel(task) {
  const lv = task.lv ? ` Lv${task.lv}` : '';
  const any = task.any ? '〈任意〉' : '';
  return `${any}[${task.tr}${lv}] ${task.n}${task.kap ? ' ★' : ''}`;
}
