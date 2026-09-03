/**
 * 手動ピン。タスクの目的地や集合場所など、任意の点に印を置く。
 *
 * マップごとに localStorage へ保存する。座標はワールド座標で持つので、
 * 地図画像や校正を差し替えてもピンの位置は動かない。
 */

const KEY_PREFIX = 'eft-gps.pins.';
const MAX_PINS = 60;

/**
 * @typedef {Object} Pin
 * @property {string} id
 * @property {string} name
 * @property {number} x
 * @property {number} y
 * @property {number} z
 * @property {number} at   作成時刻 (epoch ms)
 */

function storageKey(mapKey) {
  return KEY_PREFIX + mapKey;
}

/**
 * @param {string} mapKey
 * @returns {Pin[]}
 */
export function loadPins(mapKey) {
  try {
    const raw = localStorage.getItem(storageKey(mapKey));
    if (!raw) return [];
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    // 壊れた項目は静かに捨てる。ここで例外を投げるとアプリが起動しなくなる。
    return list.filter(
      (p) => p && typeof p.id === 'string' && Number.isFinite(p.x) && Number.isFinite(p.z),
    );
  } catch {
    return [];
  }
}

/**
 * @param {string} mapKey
 * @param {Pin[]} pins
 */
export function savePins(mapKey, pins) {
  try {
    localStorage.setItem(storageKey(mapKey), JSON.stringify(pins.slice(0, MAX_PINS)));
  } catch {
    /* 容量超過などは無視する。ピンが消えてもアプリは動く */
  }
}

/**
 * @param {Pin[]} pins
 * @param {{name:string, x:number, y:number, z:number}} data
 * @returns {Pin[]} 追加後の配列（新しいものが先頭）
 */
export function addPin(pins, data) {
  const pin = {
    id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: String(data.name || '').trim() || '名前なし',
    x: data.x,
    y: Number.isFinite(data.y) ? data.y : 0,
    z: data.z,
    at: Date.now(),
  };
  return [pin, ...pins].slice(0, MAX_PINS);
}

export function removePin(pins, id) {
  return pins.filter((p) => p.id !== id);
}

export function renamePin(pins, id, name) {
  return pins.map((p) => (p.id === id ? { ...p, name: String(name).trim() || p.name } : p));
}

/**
 * 現在地からピンまでの距離と方位。
 * @param {{x:number,z:number}} from
 * @param {Pin} pin
 * @param {number|null} yawDeg 進行方位。あれば相対角も返す
 */
export function pinBearing(from, pin, yawDeg) {
  const dx = pin.x - from.x;
  const dz = pin.z - from.z;
  const dist = Math.hypot(dx, dz);
  const bearing = ((Math.atan2(dx, dz) * 180) / Math.PI + 360) % 360;
  let relative = null;
  if (yawDeg !== null && yawDeg !== undefined) {
    relative = ((bearing - yawDeg) % 360 + 540) % 360 - 180;
  }
  return { dist, bearing, relative };
}
