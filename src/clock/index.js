/**
 * EFT のゲーム内時計。
 *
 * ワールド時計は実時間の 7 倍速で進み、2 つのサーバ時刻が 12 時間ずれている。
 *   tarkovTime = ( offset + realEpochMs * 7 ) mod 24h
 *   offset = 3h (左時計) / 15h (右時計)      3h はロシアの UTC+3
 *
 * スクリーンショットのファイル名末尾の値がこれと一致することを実測で確認済み:
 *   mtime 07:29:36.917 JST -> 式 16.455 / ファイル名 16.45
 *   mtime 07:31:47.654 JST -> 式 16.709 / ファイル名 16.71
 * 一方ハイドアウトで撮ったものは 3.79h ずれた (ハイドアウトはワールド時計を使わない)。
 *
 * 注意: 夜 Factory や Lab は時刻が固定されるため一致しない。
 *       この一致は「確実にレイド中」という肯定の証拠にだけ使い、
 *       不一致を理由にサンプルを捨ててはいけない。
 *
 * 出典: the-hideout/tarkov-dev src/components/Time.jsx (realTimeToTarkovTime)
 *       もとは adamburgess/tarkov-time。
 */

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * 実時刻からゲーム内時刻を 10 進時 (0..24) で返す。
 * @param {number} epochMs
 * @param {boolean} [right=false] 右 (第 2) 時計を使う
 * @returns {number}
 */
export function tarkovTimeHours(epochMs, right = false) {
  const offset = right ? 15 * HOUR_MS : 3 * HOUR_MS;
  const t = (offset + epochMs * 7) % DAY_MS;
  return ((t % DAY_MS) + DAY_MS) % DAY_MS / HOUR_MS;
}

/**
 * 2 つのゲーム内時刻の差を -12..12 時間で返す (24 時をまたぐ差を正しく扱う)。
 * @param {number} a
 * @param {number} b
 */
export function hourDiff(a, b) {
  return ((a - b) % 24 + 36) % 24 - 12;
}

/**
 * ファイル名のゲーム内時刻が、実際の撮影時刻から計算した値と一致するか。
 * 左右どちらの時計かは分からないので、近いほうを採用する。
 *
 * @param {number} gameTime  ファイル名の値 (10進時)
 * @param {number} epochMs   撮影時刻 (File.lastModified)
 * @param {number} [toleranceH=0.02] 許容差 (時間)。0.02h = 72 秒相当のゲーム内時間
 * @returns {{agrees:boolean, expected:number, diff:number, side:'left'|'right'}}
 */
export function checkGameClock(gameTime, epochMs, toleranceH = 0.02) {
  const left = tarkovTimeHours(epochMs, false);
  const right = tarkovTimeHours(epochMs, true);
  const dl = hourDiff(gameTime, left);
  const dr = hourDiff(gameTime, right);
  const useLeft = Math.abs(dl) <= Math.abs(dr);
  const diff = useLeft ? dl : dr;
  return {
    agrees: Math.abs(diff) <= toleranceH,
    expected: useLeft ? left : right,
    diff,
    side: useLeft ? 'left' : 'right',
  };
}

/** 10 進時を "16:42" 形式にする。 */
export function formatGameTime(hours) {
  if (hours === null || hours === undefined || !Number.isFinite(hours)) return '--:--';
  const total = Math.round(hours * 60);
  const h = Math.floor(total / 60) % 24;
  const m = total % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}
