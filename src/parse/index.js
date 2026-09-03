/**
 * EFT のスクリーンショットファイル名を解析する。
 *
 *   2026-09-03[07-31]_253.03, 4.36, 392.09_-0.02791, 0.97159, -0.18087, -0.15004_16.71 (0).png
 *   ^ 日時(分精度)   ^ position x,y,z    ^ quaternion x,y,z,w                  ^ゲーム内時刻 ^連番
 *
 * 固定桁数の正規表現は使わない。ゲーム側の書式が変わっても壊れないよう
 * 「_ で分割し、カンマ区切りの数値が 3 個の塊を position、4 個の塊を
 * quaternion とみなす」構造で拾う。
 *
 * このモジュールは DOM にもファイルシステムにも依存しない純関数のみ。
 */

const EXT_RE = /\.(png|jpe?g|bmp)$/i;
const SEQ_RE = /\s*\((\d+)\)\s*$/;
const TS_RE = /^(\d{4})-(\d{2})-(\d{2})\[(\d{1,2})-(\d{1,2})(?:-(\d{1,2}))?\]/;
const NUM_RE = /^-?\d+(?:[.,]\d+)?$/;

/**
 * @typedef {Object} Sample
 * @property {string} filename          元のファイル名
 * @property {number} x                 ワールド座標 (m)
 * @property {number} y                 高さ (m)
 * @property {number} z                 ワールド座標 (m)
 * @property {number[]} q               quaternion [qx, qy, qz, qw]
 * @property {number|null} gameTime     ゲーム内時刻 (10進時, 0..24)。無ければ null
 * @property {number[]} extras          gameTime 以外の末尾スカラ。将来の書式追加への保険
 * @property {number|null} seq          末尾 "(n)" の n
 * @property {number|null} takenAtMs    ファイル名の日時 (ローカル時刻, 分精度) の epoch ms
 */

/**
 * 1 つの塊をカンマ区切りの数値配列にする。解釈できなければ null。
 *
 * EFT は ", " (カンマ + 空白) で並べる。小数点がカンマになるロケールでも
 * 小数点の直後には空白が来ないので、この区切りで分ければ誤分割しない。
 * 空白なしの ",", 区切りだった場合だけ、素のカンマ分割に落とす。
 *
 * @param {string} chunk
 * @returns {number[]|null}
 */
export function toNumbers(chunk) {
  if (typeof chunk !== 'string' || chunk.length === 0) return null;

  let parts = chunk.split(/,\s+/);

  // 分けられなかった場合だけ素のカンマ分割に落とす。ただしその塊自体が
  // 数値として読めるなら落とさない ("16,71" を [16, 71] にしないため)。
  if (parts.length === 1 && chunk.includes(',') && !NUM_RE.test(chunk.trim())) {
    parts = chunk.split(',');
  }

  parts = parts.map((s) => s.trim()).filter((s) => s.length > 0);
  if (parts.length === 0) return null;
  if (!parts.every((p) => NUM_RE.test(p))) return null;

  return parts.map((p) => parseFloat(p.replace(',', '.')));
}

/**
 * "2026-09-03[07-31]" 形式からローカル時刻の epoch ms を作る。失敗時は null。
 * 秒はファイル名に含まれないことがある (通常は含まれない)。
 *
 * @param {string} chunk
 * @returns {number|null}
 */
export function parseTimestamp(chunk) {
  const m = TS_RE.exec(String(chunk ?? ''));
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0, 0);
  const ms = d.getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * ファイル名 (拡張子込み) を解析する。position が取れなければ null。
 *
 * @param {string} filename
 * @returns {Sample|null}
 */
export function parseScreenshotName(filename) {
  const name = String(filename ?? '');
  const base = name.replace(EXT_RE, '');

  let seq = null;
  let trimmed = base;
  const seqMatch = base.match(SEQ_RE);
  if (seqMatch) {
    seq = Number(seqMatch[1]);
    trimmed = base.replace(SEQ_RE, '');
  }

  const chunks = trimmed.split('_');

  let position = null;
  let rotation = null;
  let posIdx = -1;
  let rotIdx = -1;

  for (let i = 0; i < chunks.length; i++) {
    const nums = toNumbers(chunks[i]);
    if (!nums) continue;
    if (nums.length === 3 && position === null) {
      position = nums;
      posIdx = i;
    } else if (nums.length === 4 && rotation === null) {
      rotation = nums;
      rotIdx = i;
    }
  }

  if (position === null) return null;

  // position / quaternion より後ろにある単独のスカラを拾う。
  // 最初の 1 つで 0..24 の範囲に収まるものをゲーム内時刻とみなす。
  const extras = [];
  let gameTime = null;
  for (let i = Math.max(posIdx, rotIdx) + 1; i < chunks.length; i++) {
    const nums = toNumbers(chunks[i]);
    if (!nums || nums.length !== 1) continue;
    const v = nums[0];
    if (gameTime === null && v >= 0 && v < 24) gameTime = v;
    else extras.push(v);
  }

  return {
    filename: name,
    x: position[0],
    y: position[1],
    z: position[2],
    q: rotation === null ? [0, 0, 0, 1] : rotation,
    hasRotation: rotation !== null,
    gameTime,
    extras,
    seq,
    takenAtMs: parseTimestamp(chunks[0]),
  };
}

/** スクリーンショットとして扱う拡張子か。 */
export function isScreenshotName(filename) {
  return EXT_RE.test(String(filename ?? ''));
}
