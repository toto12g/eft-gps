/**
 * 受け入れテスト。headless Chrome から test/index.html を開いて実行する。
 *
 *   py -m http.server 8731 --bind 127.0.0.1
 *   chrome --headless=new --dump-dom http://127.0.0.1:8731/test/
 *
 * ゴールデンデータは実機で撮った 3 枚。位置 2 枚は Streets、1 枚はハイドアウト。
 */

import {
  parseScreenshotName,
  toNumbers,
  parseTimestamp,
} from '../src/parse/index.js';
import {
  quatToYawDeg,
  quatToPitchDeg,
  quatToRollDeg,
  quatNorm,
  bearingDeg,
  angleDiffDeg,
  applyAffine,
  invertAffine,
  worldToLatLng,
  latLngToWorld,
  headingToScreenDeg,
  headingStrength,
  forwardVector,
  fitAffine,
} from '../src/geo/index.js';
import { tarkovTimeHours, checkGameClock, formatGameTime } from '../src/clock/index.js';
import { loadMapDb, rankMaps, nearestPoiDistance } from '../src/mapdb/index.js';
import { validateSample, VERDICT, MapTracker } from '../src/verify/index.js';
import { ScreenshotWatcher, isSupported } from '../src/watch/index.js';
import { addPin, removePin, renamePin, pinBearing, loadPins, savePins } from '../src/app/pins.js';
import {
  loadTasks, filterTasks, taskLabel, objectiveGeometry, taskPoints,
  taskKeyDoors, taskLoadout, objectiveApplies, OBJECTIVE_TYPE,
} from '../src/app/tasks.js';
import { loadLandmarks, LAYERS, DEFAULT_ENABLED, hazardLabel, bossLabel } from '../src/app/landmarks.js';

/* ------------------------------------------------------------ ゴールデンデータ */

const RAID1 =
  '2026-09-03[07-29]_203.07, 4.87, 402.38_0.07438, 0.66776, -0.06734, 0.73758_16.45 (0).png';
const RAID2 =
  '2026-09-03[07-31]_253.03, 4.36, 392.09_-0.02791, 0.97159, -0.18087, -0.15004_16.71 (0).png';
const HIDEOUT =
  '2026-09-03[08-06]_-12.28, 17.75, -10.74_0.41849, 0.37487, -0.19514, 0.80390_16.92 (0).png';

// File.lastModified の実測値 (JST)。ローカルタイムゾーンに依存しないよう epoch で持つ。
const MTIME = {
  raid1: 1788388176917, // 2026-09-03 07:29:36.917 JST
  raid2: 1788388307654, // 2026-09-03 07:31:47.654 JST
  hideout: 1788390367213, // 2026-09-03 08:06:07.213 JST
};

// Customs のレイド 1 回ぶん (実機 16 枚, 09:31〜09:52)。
// 単発判定では 2 枚で別マップが 1 位になる。累積判定の回帰テストに使う。
const CUSTOMS_RAID = [
  '2026-09-03[09-31]_646.96, 3.38, 46.96_-0.01187, 0.87094, -0.02110, -0.49079_6.71 (0).png',
  '2026-09-03[09-31]_647.17, 3.39, 47.10_0.00316, 0.20536, 0.00066, -0.97868_6.72 (0).png',
  '2026-09-03[09-31]_646.63, 2.95, 46.90_-0.42996, 0.56137, -0.56137, -0.42996_6.73 (0).png',
  '2026-09-03[09-32]_646.99, 3.39, 47.02_0.00658, 0.77965, 0.00820, -0.62613_6.74 (0).png',
  '2026-09-03[09-32]_625.35, 0.51, 31.28_0.00576, -0.94843, 0.01714, 0.31646_6.80 (0).png',
  '2026-09-03[09-33]_546.27, 8.89, 78.11_0.00121, -0.57485, 0.00052, 0.81826_6.87 (0).png',
  '2026-09-03[09-34]_487.43, 15.07, 132.54_-0.09094, 0.65248, -0.07942, -0.74812_7.01 (0).png',
  '2026-09-03[09-35]_379.84, 14.54, 179.53_-0.01916, 0.97700, -0.10012, -0.18731_7.12 (0).png',
  '2026-09-03[09-35]_390.17, 2.37, 80.81_-0.01312, -0.98180, 0.07397, -0.17444_7.17 (0).png',
  '2026-09-03[09-36]_478.27, 10.46, 77.33_-0.00725, -0.66954, 0.00660, -0.74271_7.22 (0).png',
  '2026-09-03[09-39]_370.83, 2.19, -2.82_0.02711, -0.88730, 0.05318, 0.45730_7.58 (0).png',
  '2026-09-03[09-39]_352.69, 2.00, -3.94_0.07658, -0.30945, 0.02502, 0.94750_7.60 (0).png',
  '2026-09-03[09-45]_263.00, 2.19, -79.82_-0.01201, -0.86119, 0.01301, -0.50797_8.36 (0).png',
  '2026-09-03[09-45]_263.00, 2.19, -79.82_0.00885, 0.86123, -0.01499, 0.50792_8.36 (0).png',
  '2026-09-03[09-47]_287.36, 3.05, -45.57_0.03668, 0.04744, -0.00176, 0.99820_8.49 (0).png',
  '2026-09-03[09-52]_68.35, 2.74, -70.32_-0.04888, 0.78687, -0.06282, -0.61197_9.08 (0).png',
];
// 報告のあった不具合の実データ。Woods のレイド中に Interchange へ飛ばされた。
// 直近 12 枚の窓で見ていたため、1 枚目の決定的な証拠（比 154）を捨てていた。
const WOODS_RAID = [
  "2026-09-04[01-48]_366.99, 14.41, -702.84_-0.02491, 0.62958, -0.02020, -0.77627_12.65 (0).png",
  "2026-09-04[01-48]_367.02, 14.42, -702.88_0.05623, 0.75479, 0.06526, -0.65029_12.62 (0).png",
  "2026-09-04[01-51]_210.47, 25.86, -691.79_0.07470, 0.16706, -0.01086, 0.98305_12.96 (0).png",
  "2026-09-04[01-51]_217.63, 25.81, -709.43_-0.04687, 0.79552, -0.06205, -0.60092_12.95 (0).png",
  "2026-09-04[01-52]_172.20, 11.27, -581.77_0.04343, -0.46194, 0.02408, 0.88552_13.07 (0).png",
  "2026-09-04[01-52]_75.08, 16.45, -460.30_0.04016, 0.26370, 0.01111, -0.96371_13.15 (0).png",
  "2026-09-04[01-52]_78.84, 14.70, -467.65_-0.04034, -0.26369, -0.01114, 0.96370_13.15 (0).png",
  "2026-09-04[01-53]_18.76, 30.44, -294.22_0.05830, -0.09780, 0.00563, 0.99348_13.26 (0).png",
  "2026-09-04[01-53]_47.41, 26.65, -392.26_0.06696, -0.40585, 0.02918, 0.91102_13.19 (0).png",
  "2026-09-04[01-54]_-143.29, 31.72, -193.06_-0.01491, -0.59962, -0.01118, 0.80007_13.39 (0).png",
  "2026-09-04[01-55]_-182.80, 35.85, -151.83_0.04693, -0.57468, 0.03039, 0.81647_13.46 (0).png",
  "2026-09-04[01-56]_-236.85, 8.62, 62.14_0.07244, 0.09060, -0.00643, 0.99323_13.63 (0).png",
  "2026-09-04[01-56]_-256.14, 10.04, 10.18_0.04167, -0.19503, 0.00829, 0.97988_13.60 (0).png",
  "2026-09-04[01-57]_-128.74, 10.45, 85.63_-0.03061, -0.78009, 0.03816, -0.62375_13.69 (0).png",
  "2026-09-04[01-58]_-76.69, 11.62, -68.57_0.03573, 0.81312, -0.05248, 0.57862_13.83 (0).png",
  "2026-09-04[01-59]_4.79, 8.14, -131.03_0.05208, 0.52089, -0.03158, 0.85145_13.90 (0).png",
  "2026-09-04[02-01]_113.30, 3.34, -103.95_-0.04267, -0.60481, 0.03365, -0.79452_14.15 (0).png",
  "2026-09-04[02-01]_177.37, 1.33, -51.14_0.04474, 0.12537, -0.00520, 0.99109_14.19 (0).png",
  "2026-09-04[02-01]_184.26, 2.34, -33.06_0.03656, 0.01019, -0.00327, 0.99927_14.21 (0).png",
  "2026-09-04[02-04]_398.33, -13.76, 196.38_0.03897, -0.41199, 0.01764, 0.91018_14.49 (0).png",
  "2026-09-04[02-04]_398.33, -13.76, 196.38_0.03897, -0.41199, 0.01764, 0.91018_14.49 (1).png",
  "2026-09-04[02-04]_398.33, -13.76, 196.38_0.03897, -0.41199, 0.01764, 0.91018_14.49 (2).png",
];

// 同じ夜の別レイド。こちらは本当に Interchange。
const INTERCHANGE_RAID = [
  "2026-09-04[00-57]_316.61, 24.82, 335.18_0.00000, 0.90267, 0.00000, -0.43033_6.70 (0).png",
  "2026-09-04[00-58]_275.50, 22.76, 59.42_0.00518, -0.99016, 0.04878, 0.13104_6.84 (0).png",
  "2026-09-04[00-58]_328.76, 27.63, 176.56_0.01076, -0.97126, 0.04697, 0.23307_6.78 (0).png",
  "2026-09-04[00-59]_278.86, 22.46, -17.27_0.00015, 0.99177, -0.00924, -0.12772_6.96 (0).png",
  "2026-09-04[01-00]_141.99, 22.75, 58.33_0.00417, -0.66430, 0.00371, 0.74744_7.10 (0).png",
  "2026-09-04[01-01]_86.45, 22.98, 75.64_-0.00372, 0.61541, -0.00617, -0.78817_7.17 (0).png",
  "2026-09-04[01-02]_-15.83, 23.01, 64.34_-0.05495, 0.74919, -0.06254, -0.65710_7.30 (0).png",
  "2026-09-04[01-02]_39.97, 28.53, 74.03_0.00966, -0.95570, 0.03547, 0.29204_7.26 (0).png",
  "2026-09-04[01-03]_-3.91, 22.90, 46.72_0.00833, 0.62907, -0.00693, 0.77727_7.40 (0).png",
  "2026-09-04[01-04]_-61.15, 22.84, 52.89_0.01315, -0.71412, 0.01239, 0.69979_7.47 (0).png",
  "2026-09-04[01-05]_-174.65, 22.81, 35.06_-0.00995, 0.95273, -0.03002, -0.30216_7.62 (0).png",
  "2026-09-04[01-07]_-241.99, 22.86, -314.31_0.03170, 0.65766, -0.02633, 0.75219_7.89 (0).png",
  "2026-09-04[01-09]_-199.08, 22.81, -354.18_-0.05486, -0.72565, 0.05439, -0.68372_8.12 (0).png",
  "2026-09-04[01-22]_79.32, 28.61, -30.95_-0.02490, 0.20882, -0.00564, -0.97762_9.66 (0).png",
  "2026-09-04[01-25]_-17.19, 28.47, 26.40_-0.02568, 0.70523, -0.02309, -0.70814_9.98 (0).png",
  "2026-09-04[01-30]_-341.95, 24.89, 221.98_-0.02590, -0.14245, 0.00254, -0.98946_10.61 (0).png",
];
// 真下を見て撮った 1 枚 (pitch 90°)。方位が定義できない。
const LOOK_DOWN = CUSTOMS_RAID[2];

/* ------------------------------------------------------------------ ハーネス */

const results = [];
let currentGroup = '';

function group(name) {
  currentGroup = name;
}

async function check(label, fn) {
  try {
    const detail = await fn();
    results.push({ group: currentGroup, label, ok: true, detail: detail ?? '' });
  } catch (err) {
    results.push({ group: currentGroup, label, ok: false, detail: String(err && err.message ? err.message : err) });
  }
}

function pending(label, note) {
  results.push({ group: currentGroup, label, ok: null, detail: note });
}

function eq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
}

function close(actual, expected, tol, msg) {
  if (!(Math.abs(actual - expected) <= tol)) {
    throw new Error(`${msg}: ${actual} != ${expected} (許容 ±${tol})`);
  }
}

function truthy(v, msg) {
  if (!v) throw new Error(msg);
}

/* --------------------------------------------------------------------- T1 */

group('T1 ファイル名パース');

await check('レイド1 の全フィールド', () => {
  const s = parseScreenshotName(RAID1);
  truthy(s, 'パース失敗');
  close(s.x, 203.07, 1e-9, 'x');
  close(s.y, 4.87, 1e-9, 'y');
  close(s.z, 402.38, 1e-9, 'z');
  eq(s.q.length, 4, 'quaternion の要素数');
  close(s.q[0], 0.07438, 1e-9, 'qx');
  close(s.q[3], 0.73758, 1e-9, 'qw');
  close(s.gameTime, 16.45, 1e-9, 'gameTime');
  eq(s.seq, 0, 'seq');
  eq(s.extras.length, 0, 'extras');
  eq(s.takenAtMs, new Date(2026, 8, 3, 7, 29, 0, 0).getTime(), 'takenAtMs');
  return `x=${s.x} y=${s.y} z=${s.z} gameTime=${s.gameTime} (${formatGameTime(s.gameTime)}) seq=${s.seq}`;
});

await check('レイド2 と ハイドアウト', () => {
  const a = parseScreenshotName(RAID2);
  const b = parseScreenshotName(HIDEOUT);
  close(a.x, 253.03, 1e-9, 'raid2 x');
  close(a.gameTime, 16.71, 1e-9, 'raid2 gameTime');
  close(b.x, -12.28, 1e-9, 'hideout x');
  close(b.y, 17.75, 1e-9, 'hideout y');
  close(b.gameTime, 16.92, 1e-9, 'hideout gameTime');
  return `raid2 ${formatGameTime(a.gameTime)} / hideout ${formatGameTime(b.gameTime)}`;
});

await check('拡張子なし・不正な名前を弾く', () => {
  eq(parseScreenshotName('IMG_0001.png'), null, '座標のない名前');
  eq(parseScreenshotName(''), null, '空文字');
  eq(parseTimestamp('not-a-date'), null, '不正な日時');
  return 'null を返す';
});

/* --------------------------------------------------------------------- T2 */

group('T2 quaternion → 姿勢');

await check('レイド1 の yaw / pitch / roll', () => {
  const s = parseScreenshotName(RAID1);
  close(quatNorm(s.q), 1, 1e-4, 'ノルム');
  close(quatToYawDeg(s.q), 84.311, 0.01, 'yaw');
  close(quatToPitchDeg(s.q), 11.517, 0.01, 'pitch');
  close(quatToRollDeg(s.q), 0, 0.01, 'roll');
  return `yaw=${quatToYawDeg(s.q).toFixed(2)}° pitch=${quatToPitchDeg(s.q).toFixed(2)}° roll=${quatToRollDeg(s.q).toFixed(2)}°`;
});

await check('レイド2 の yaw / roll', () => {
  const s = parseScreenshotName(RAID2);
  close(quatNorm(s.q), 1, 1e-4, 'ノルム');
  close(quatToYawDeg(s.q), 197.558, 0.01, 'yaw');
  close(quatToPitchDeg(s.q), 21.090, 0.01, 'pitch');
  close(quatToRollDeg(s.q), 0, 0.01, 'roll');
  return `yaw=${quatToYawDeg(s.q).toFixed(2)}° pitch=${quatToPitchDeg(s.q).toFixed(2)}°`;
});

await check('roll が 0 = カメラ回転である', () => {
  for (const f of [RAID1, RAID2, HIDEOUT]) {
    const s = parseScreenshotName(f);
    close(quatToRollDeg(s.q), 0, 0.01, 'roll');
  }
  return '3 枚とも roll = 0 (yaw と pitch だけの回転)';
});

await check('quaternion は Ry(yaw)·Rx(pitch) の形をしている', () => {
  // roll が無い前提が正しければ、yaw と pitch から quaternion を復元できる。
  for (const [file, label] of [[RAID1, 'raid1'], [RAID2, 'raid2'], [HIDEOUT, 'hideout']]) {
    const s = parseScreenshotName(file);
    const th = (quatToYawDeg(s.q) * Math.PI) / 180 / 2;
    const ph = (quatToPitchDeg(s.q) * Math.PI) / 180 / 2;
    const cy = Math.cos(th), sy = Math.sin(th), cx = Math.cos(ph), sx = Math.sin(ph);
    const rebuilt = [cy * sx, sy * cx, -sy * sx, cy * cx];
    for (let i = 0; i < 4; i++) {
      // 元の quaternion は符号が反転していることがある (q と -q は同じ回転)
      const d = Math.min(
        Math.abs(rebuilt[i] - s.q[i]),
        Math.abs(rebuilt[i] + s.q[i]),
      );
      close(d, 0, 3e-4, `${label} の成分 ${i}`);
    }
  }
  return '3 枚とも yaw/pitch のみから復元できる = roll 0 は構造的';
});

await check('参照実装の yaw 式は pitch でずれる (差分を固定)', () => {
  // TarkovMonitor / tarkovgps.com が使っている式
  const legacy = (q) => {
    const [x, y, z, w] = q;
    const d = (Math.atan2(2 * (w * y + x * z), 1 - 2 * (y * y + z * z)) * 180) / Math.PI;
    return ((d % 360) + 360) % 360;
  };
  const h = parseScreenshotName(HIDEOUT);
  const gap = Math.abs(angleDiffDeg(quatToYawDeg(h.q), legacy(h.q)));
  truthy(gap > 10, `差が出ていない: ${gap}`);
  const r1 = parseScreenshotName(RAID1);
  const gap1 = Math.abs(angleDiffDeg(quatToYawDeg(r1.q), legacy(r1.q)));
  truthy(gap1 < 0.5, `緩い pitch でも差が大きい: ${gap1}`);
  return `pitch ${quatToPitchDeg(h.q).toFixed(1)}° で ${gap.toFixed(1)}° / pitch ${quatToPitchDeg(r1.q).toFixed(1)}° で ${gap1.toFixed(2)}°`;
});

/* --------------------------------------------------------------------- T3 */

group('T3 進行方位との整合');

await check('レイド1→2 の方位 と 1 枚目の yaw', () => {
  const a = parseScreenshotName(RAID1);
  const b = parseScreenshotName(RAID2);
  const bearing = bearingDeg(a.x, a.z, b.x, b.z);
  close(bearing, 101.64, 0.02, '進行方位');
  const gap = Math.abs(angleDiffDeg(quatToYawDeg(a.q), bearing));
  truthy(gap < 20, `yaw と進行方位の差が大きい: ${gap.toFixed(1)}°`);
  return `方位=${bearing.toFixed(2)}° yaw=${quatToYawDeg(a.q).toFixed(2)}° 差=${gap.toFixed(1)}°`;
});

/* --------------------------------------------------------------------- T4 */

group('T4 ゲーム内時計');

await check('レイドの 2 枚は式と一致する', () => {
  const a = parseScreenshotName(RAID1);
  const b = parseScreenshotName(RAID2);
  close(tarkovTimeHours(MTIME.raid1), 16.455116, 1e-5, 'raid1 の式の値');
  close(tarkovTimeHours(MTIME.raid2), 16.709327, 1e-5, 'raid2 の式の値');
  const ca = checkGameClock(a.gameTime, MTIME.raid1);
  const cb = checkGameClock(b.gameTime, MTIME.raid2);
  truthy(ca.agrees, `raid1 が一致しない: 差 ${ca.diff}`);
  truthy(cb.agrees, `raid2 が一致しない: 差 ${cb.diff}`);
  eq(ca.side, 'left', 'raid1 は左時計');
  return `差 ${(ca.diff * 60).toFixed(2)}分 / ${(cb.diff * 60).toFixed(2)}分 (いずれも左時計)`;
});

await check('ハイドアウトは 3.79h ずれる', () => {
  const h = parseScreenshotName(HIDEOUT);
  const c = checkGameClock(h.gameTime, MTIME.hideout);
  truthy(!c.agrees, '一致してしまった');
  close(Math.abs(c.diff), 3.794, 0.01, 'ずれ幅');
  return `expected=${c.expected.toFixed(3)} actual=${h.gameTime} 差=${c.diff.toFixed(3)}h`;
});

/* --------------------------------------------------------------------- T8 */

group('T8 ロケール小数点カンマ');

await check('"253,03, 4,36, 392,09" を誤分割しない', () => {
  const n = toNumbers('253,03, 4,36, 392,09');
  truthy(n, 'null が返った');
  eq(n.length, 3, '要素数');
  close(n[0], 253.03, 1e-9, '1 番目');
  close(n[1], 4.36, 1e-9, '2 番目');
  close(n[2], 392.09, 1e-9, '3 番目');
  return n.join(' / ');
});

await check('カンマ小数のファイル名全体', () => {
  const f =
    '2026-09-03[07-31]_253,03, 4,36, 392,09_-0,02791, 0,97159, -0,18087, -0,15004_16,71 (0).png';
  const s = parseScreenshotName(f);
  truthy(s, 'パース失敗');
  close(s.x, 253.03, 1e-9, 'x');
  close(s.q[1], 0.97159, 1e-9, 'qy');
  close(s.gameTime, 16.71, 1e-9, 'gameTime');
  return `x=${s.x} qy=${s.q[1]} gameTime=${s.gameTime}`;
});

await check('空白なしのカンマ区切りも読める', () => {
  const n = toNumbers('253.03,4.36,392.09');
  eq(n.length, 3, '要素数');
  close(n[2], 392.09, 1e-9, '3 番目');
  return n.join(' / ');
});

/* --------------------------------------------------------------------- T9 */

group('T9 アフィン');

const SAMPLE_AFFINE = { a: 3.1, b: -0.4, c: 2048, d: 0.7, e: -3.05, f: 1900 };

await check('往復変換の誤差が 0.01m 未満', () => {
  let worst = 0;
  for (const [x, z] of [[0, 0], [203.07, 402.38], [-730.4, 446.8], [671.1, -324.7]]) {
    const [lat, lng] = worldToLatLng(SAMPLE_AFFINE, x, z);
    const back = latLngToWorld(SAMPLE_AFFINE, lat, lng);
    worst = Math.max(worst, Math.hypot(back.x - x, back.z - z));
  }
  truthy(worst < 0.01, `往復誤差 ${worst}`);
  return `最大往復誤差 ${worst.toExponential(2)} m`;
});

await check('特異なアフィンは null を返す', () => {
  eq(invertAffine({ a: 1, b: 2, c: 0, d: 2, e: 4, f: 0 }), null, '行列式 0');
  return 'null';
});

await check('fitAffine が既知のアフィンを復元する (4 点)', () => {
  const pts = [[0, 0], [100, 0], [0, 100], [250, -80]].map(([wx, wz]) => {
    const p = applyAffine(SAMPLE_AFFINE, wx, wz);
    return { wx, wz, px: p.px, py: p.py };
  });
  const fit = fitAffine(pts);
  truthy(fit, 'null が返った');
  for (const k of ['a', 'b', 'c', 'd', 'e', 'f']) {
    close(fit.affine[k], SAMPLE_AFFINE[k], 1e-6, `係数 ${k}`);
  }
  truthy(fit.rms < 1e-6, `rms=${fit.rms}`);
  return `rms=${fit.rms.toExponential(2)} px (4 点)`;
});

await check('fitAffine が誤差を rms として報告する', () => {
  const pts = [[0, 0], [100, 0], [0, 100], [250, -80]].map(([wx, wz], i) => {
    const p = applyAffine(SAMPLE_AFFINE, wx, wz);
    return { wx, wz, px: p.px + (i === 0 ? 10 : 0), py: p.py };
  });
  const fit = fitAffine(pts);
  truthy(fit.rms > 1, `ずれを検出できていない: rms=${fit.rms}`);
  return `1 点を 10px ずらすと rms=${fit.rms.toFixed(2)} px`;
});

await check('2 点フィット (相似変換) は北を上にする', () => {
  const fit = fitAffine([
    { wx: 0, wz: 0, px: 100, py: 200 },
    { wx: 100, wz: 0, px: 200, py: 200 },
  ]);
  truthy(fit, 'null が返った');
  // +Z (北) が画像の上 = py が減る方向になっているか
  const north = applyAffine(fit.affine, 0, 100);
  truthy(north.py < 200, `+Z が下を向いている: py=${north.py}`);
  return `+Z 100m → py ${north.py.toFixed(1)} (原点は 200)`;
});

await check('headingToScreenDeg が反転を正しく扱う', () => {
  // 北が上・等方スケールのアフィン (e が負 = y 反転)
  const northUp = { a: 1, b: 0, c: 0, d: 0, e: -1, f: 0 };
  close(headingToScreenDeg(northUp, 0), 0, 1e-9, '北を向く → 画面上');
  close(headingToScreenDeg(northUp, 90), 90, 1e-9, '東を向く → 画面右');
  close(headingToScreenDeg(northUp, 180), 180, 1e-9, '南を向く → 画面下');
  // 180 度回して描かれた地図では、同じ yaw が反対を向くはず
  const flipped = { a: -1, b: 0, c: 0, d: 0, e: 1, f: 0 };
  close(headingToScreenDeg(flipped, 0), 180, 1e-9, '反転地図で北 → 画面下');
  return '北上=0/90/180、反転地図で北=180';
});

/* ------------------------------------------------------- T5 / T6 (要データ) */

const db = await loadMapDb('../data/');

group('データ整合');

await check('mapdb.json と poi.bin が読める', () => {
  truthy(db.maps.length > 0, 'マップが 0 件');
  let pts = 0;
  for (const m of db.maps) {
    eq(m.poi.length, m.poiCount * 3, `${m.key} の POI 長`);
    pts += m.poiCount;
  }
  return `${db.maps.length} マップ / ${pts.toLocaleString()} 点`;
});

await check('座標系を共有するシーンが統合されている', () => {
  const factory = db.byKey.get('factory');
  truthy(factory, 'factory がない');
  const names = factory.scenes.map((s) => s.normalizedName);
  truthy(names.includes('night-factory'), `night-factory が統合されていない: ${names}`);
  truthy(!db.byKey.has('night-factory'), 'night-factory が独立して残っている');
  const gz = db.byKey.get('ground-zero');
  truthy(gz.scenes.length >= 2, 'ground-zero が統合されていない');
  return `factory ← ${names.join(', ')} / ground-zero ← ${gz.scenes.map((s) => s.normalizedName).join(', ')}`;
});

group('T5 サンプル検証');

await check('レイド 2 枚 = accept(streets)', () => {
  for (const [file, mt, label] of [[RAID1, MTIME.raid1, 'raid1'], [RAID2, MTIME.raid2, 'raid2']]) {
    const s = parseScreenshotName(file);
    const v = validateSample({ sample: s, selectedKey: 'streets-of-tarkov', db, fileModifiedMs: mt });
    eq(v.verdict, VERDICT.ACCEPT, `${label} の判定`);
    eq(v.best, 'streets-of-tarkov', `${label} の最寄りマップ`);
    truthy(v.d1 < 2, `${label} の距離 ${v.d1}`);
    truthy(v.ratio > 20, `${label} の比 ${v.ratio}`);
  }
  const v = validateSample({
    sample: parseScreenshotName(RAID1),
    selectedKey: 'streets-of-tarkov',
    db,
    fileModifiedMs: MTIME.raid1,
  });
  return `d1=${v.d1.toFixed(2)}m 2位=${v.second} d2=${v.d2.toFixed(2)}m 比=${v.ratio.toFixed(1)}`;
});

await check('ハイドアウト = not-in-raid', () => {
  const s = parseScreenshotName(HIDEOUT);
  const v = validateSample({ sample: s, selectedKey: 'streets-of-tarkov', db, fileModifiedMs: MTIME.hideout });
  eq(v.verdict, VERDICT.NOT_IN_RAID, '判定');
  truthy(v.ratio < 2, `比が大きすぎる: ${v.ratio}`);
  return `1位=${v.best} ${v.d1.toFixed(2)}m / 2位=${v.second} ${v.d2.toFixed(2)}m / 比=${v.ratio.toFixed(2)}`;
});

await check('マップを間違えると wrong-map になる', () => {
  const s = parseScreenshotName(RAID1);
  const v = validateSample({ sample: s, selectedKey: 'customs', db, fileModifiedMs: MTIME.raid1 });
  eq(v.verdict, VERDICT.WRONG_MAP, '判定');
  eq(v.best, 'streets-of-tarkov', '提案されるマップ');
  return v.reason;
});

await check('lastModified 無しでも判定できる', () => {
  const s = parseScreenshotName(RAID1);
  const v = validateSample({ sample: s, selectedKey: 'streets-of-tarkov', db, fileModifiedMs: null });
  eq(v.verdict, VERDICT.ACCEPT, '判定');
  eq(v.clock, null, '時計判定は省略される');
  return '座標だけで accept';
});

group('T6 誤ったマップ選択の網羅');

await check('13 マップすべてで streets 以外は accept しない', () => {
  const s = parseScreenshotName(RAID1);
  const accepted = [];
  for (const m of db.maps) {
    const v = validateSample({ sample: s, selectedKey: m.key, db, fileModifiedMs: MTIME.raid1 });
    if (v.verdict === VERDICT.ACCEPT) accepted.push(m.key);
  }
  eq(accepted.length, 1, `accept されたマップ: ${accepted.join(', ')}`);
  eq(accepted[0], 'streets-of-tarkov', '唯一 accept されたマップ');
  return `${db.maps.length} マップ中 accept は streets-of-tarkov のみ`;
});

await check('bbox だけでは 5 マップを弾けない (回帰用に固定)', () => {
  const s = parseScreenshotName(RAID1);
  const inBox = db.maps.filter((m) => {
    const b = m.bbox;
    return s.x >= b.x[0] && s.x <= b.x[1] && s.z >= b.z[0] && s.z <= b.z[1];
  });
  truthy(inBox.length >= 4, `bbox 内に入るマップが少なすぎる: ${inBox.length}`);
  return `bbox 内: ${inBox.map((m) => m.key).join(', ')} — 最近傍判定が必要な理由`;
});

await check('全マップの最近傍計算が 1 サンプル 5ms 未満', () => {
  const s = parseScreenshotName(RAID1);
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) rankMaps(db, s.x + i * 0.01, s.y, s.z);
  const per = (performance.now() - t0) / 20;
  truthy(per < 5, `1 サンプル ${per.toFixed(2)}ms`);
  return `1 サンプル ${per.toFixed(3)}ms (全 ${db.maps.length} マップ総当たり)`;
});

group('T7 校正');

const calibrated = db.maps.filter((m) => m.affine && m.svgViewBox);

await check('SVG のあるマップすべてにアフィンが入っている', () => {
  const withSvg = db.maps.filter((m) => m.svg);
  eq(calibrated.length, withSvg.length, 'アフィンの数');
  truthy(calibrated.length >= 10, `校正済みマップが少ない: ${calibrated.length}`);
  const missing = db.maps.filter((m) => !m.affine).map((m) => m.key);
  return `${calibrated.length} マップ校正済み / 未校正 ${missing.length}: ${missing.join(', ') || 'なし'}`;
});

await check('アフィンが可逆で、往復誤差が 0.01m 未満', () => {
  let worst = 0;
  for (const m of calibrated) {
    const inv = invertAffine(m.affine);
    truthy(inv, `${m.key} のアフィンが特異`);
    for (const [x, z] of [[m.bbox.x[0], m.bbox.z[0]], [m.bbox.x[1], m.bbox.z[1]], [0, 0]]) {
      const [lat, lng] = worldToLatLng(m.affine, x, z);
      const back = latLngToWorld(m.affine, lat, lng);
      worst = Math.max(worst, Math.hypot(back.x - x, back.z - z));
    }
  }
  truthy(worst < 0.01, `往復誤差 ${worst}`);
  return `${calibrated.length} マップ、最大往復誤差 ${worst.toExponential(2)} m`;
});

await check('POI の 95% 以上が viewBox 内に落ちる', () => {
  const rows = [];
  for (const m of calibrated) {
    const [vx, vy, vw, vh] = m.svgViewBox;
    let inside = 0;
    for (let i = 0; i < m.poiCount; i++) {
      const o = i * 3;
      const p = applyAffine(m.affine, m.poi[o] / 10, m.poi[o + 2] / 10);
      if (p.px >= vx && p.px <= vx + vw && p.py >= vy && p.py <= vy + vh) inside++;
    }
    const pct = (inside / m.poiCount) * 100;
    rows.push([m.key, pct]);
    truthy(pct >= 95, `${m.key} は ${pct.toFixed(1)}% しか入っていない`);
  }
  rows.sort((a, b) => a[1] - b[1]);
  return `最小 ${rows[0][0]} ${rows[0][1].toFixed(1)}% / 最大 ${rows[rows.length - 1][1].toFixed(1)}%`;
});

await check('脱出口がすべて viewBox +5% の範囲に落ちる', () => {
  // マップ端の脱出口は、SVG の描画が viewBox をわずかに超えている場所にあることがある
  // (customs_sniper_exit が上に 3.8%、factory Gate_o が左に 1.2%、woods RUAF Gate が下に 0.4%)。
  // 校正誤差ではないので 5% の余裕を持たせ、そのうえで「1 つも大きく外れない」ことを見る。
  const MARGIN = 0.05;
  let total = 0;
  let strict = 0;
  const bad = [];
  for (const m of calibrated) {
    const [vx, vy, vw, vh] = m.svgViewBox;
    for (const e of m.extracts || []) {
      if (!e.position) continue;
      total++;
      const p = applyAffine(m.affine, e.position.x, e.position.z);
      if (p.px >= vx && p.px <= vx + vw && p.py >= vy && p.py <= vy + vh) strict++;
      const okX = p.px >= vx - vw * MARGIN && p.px <= vx + vw * (1 + MARGIN);
      const okY = p.py >= vy - vh * MARGIN && p.py <= vy + vh * (1 + MARGIN);
      if (!okX || !okY) bad.push(`${m.key}/${e.name} (${p.px.toFixed(0)}, ${p.py.toFixed(0)})`);
    }
  }
  eq(bad.length, 0, `5% の余裕でも外れる脱出口: ${bad.join(', ')}`);
  return `${total} 箇所すべてが +5% 以内 (viewBox 厳密内は ${strict}/${total} = ${((strict / total) * 100).toFixed(1)}%)`;
});

await check('レターボックスが 2% 未満 (viewBox と bounds の縦横比が合っている)', () => {
  const worst = calibrated.reduce(
    (acc, m) => (m.calib.letterbox > acc.v ? { k: m.key, v: m.calib.letterbox } : acc),
    { k: '-', v: 0 },
  );
  truthy(worst.v < 0.02, `${worst.k} のレターボックスが ${(worst.v * 100).toFixed(2)}%`);
  return `最大 ${worst.k} ${(worst.v * 100).toFixed(2)}%`;
});

await check('実機サンプルが Streets の描画範囲に落ちる', () => {
  const m = db.byKey.get('streets-of-tarkov');
  truthy(m.affine, '校正なし');
  const [vx, vy, vw, vh] = m.svgViewBox;
  for (const [file, label] of [[RAID1, 'raid1'], [RAID2, 'raid2']]) {
    const s = parseScreenshotName(file);
    const p = applyAffine(m.affine, s.x, s.z);
    truthy(
      p.px > vx + vw * 0.05 && p.px < vx + vw * 0.95 && p.py > vy + vh * 0.05 && p.py < vy + vh * 0.95,
      `${label} が端に寄りすぎ: (${p.px.toFixed(1)}, ${p.py.toFixed(1)})`,
    );
  }
  const p1 = applyAffine(m.affine, parseScreenshotName(RAID1).x, parseScreenshotName(RAID1).z);
  const p2 = applyAffine(m.affine, parseScreenshotName(RAID2).x, parseScreenshotName(RAID2).z);
  // ワールドで 51m 離れている。SVG 上の距離もスケールと整合するはず
  const svgDist = Math.hypot(p2.px - p1.px, p2.py - p1.py);
  const scale = Math.hypot(m.affine.a, m.affine.d); // 1m あたりの SVG 単位
  close(svgDist / scale, 51.0, 1.0, 'SVG 上の距離をメートルに戻した値');
  return `(${p1.px.toFixed(0)}, ${p1.py.toFixed(0)}) → (${p2.px.toFixed(0)}, ${p2.py.toFixed(0)}) = ${(svgDist / scale).toFixed(1)}m`;
});

await check('mapdb.json の項目が loadMapDb を素通りしている', async () => {
  // svgFiles と anyTaskFile を返り値に含め忘れて、UI が空になる事故を 2 回起こした。
  // ファイル側にある項目が落ちていないことを機械的に見る
  const raw = await fetch('../data/mapdb.json').then((r) => r.json());
  const missing = [];
  for (const key of Object.keys(raw)) {
    if (key === 'maps' || key === 'generated') continue;
    if (db[key] === undefined) missing.push(key);
  }
  eq(missing.length, 0, `返り値から落ちている項目: ${missing.join(', ')}`);
  return `${Object.keys(raw).length - 2} 項目すべてが利用側に届いている`;
});

await check('mapdb が svgFiles を返している（校正ツールの素材一覧）', () => {
  truthy(Array.isArray(db.svgFiles), 'svgFiles が配列でない');
  truthy(db.svgFiles.length >= 10, `素材が少ない: ${db.svgFiles.length}`);
  for (const m of db.maps) {
    if (!m.svg) continue;
    const base = m.svg.replace('maps/', '');
    truthy(db.svgFiles.includes(base), `${m.key} の ${base} が svgFiles にない`);
  }
  return `${db.svgFiles.length} 個: ${db.svgFiles.slice(0, 3).join(', ')} …`;
});

await check('校正の出所が記録されている', () => {
  const bySource = {};
  for (const m of calibrated) {
    truthy(m.calib && m.calib.source, `${m.key} に calib.source がない`);
    bySource[m.calib.source] = (bySource[m.calib.source] || 0) + 1;
  }
  return Object.entries(bySource).map(([k, v]) => `${k === 'manual' ? '手動' : '解析'} ${v}`).join(' / ');
});

await check('校正ツールが初期値を厳密に復元できる', () => {
  // seedFromExisting -> fitAffine の往復。ツール全体の健全性チェック。
  const m = db.byKey.get('customs');
  const pts = (m.extracts || [])
    .filter((e) => e.position)
    .map((e) => {
      const p = applyAffine(m.affine, e.position.x, e.position.z);
      return { wx: e.position.x, wz: e.position.z, px: p.px, py: p.py };
    });
  truthy(pts.length >= 3, '参照点が足りない');
  const fit = fitAffine(pts);
  truthy(fit.rms < 1e-6, `rms=${fit.rms}`);
  for (const k of ['a', 'b', 'c', 'd', 'e', 'f']) {
    close(fit.affine[k], m.affine[k], 1e-6, `係数 ${k}`);
  }
  return `${pts.length} 点で rms=${fit.rms.toExponential(2)} px`;
});

await check('脱出口データが揃っている', () => {
  let total = 0;
  let outlined = 0;
  for (const m of db.maps) {
    for (const e of m.extracts || []) {
      total++;
      if ((e.outline || []).length >= 3) outlined++;
    }
  }
  truthy(total > 50, `脱出口が少なすぎる: ${total}`);
  return `${total} 箇所 (うち ${outlined} 箇所が outline ポリゴンを持つ = 校正の対応点候補)`;
});

/* --------------------------------------------------------------------- T11 */

group('T11 累積でのマップ判定');

await check('単発判定は実データで 16 枚中 2 枚を取り違える', () => {
  // この失敗こそが MapTracker を入れた理由。直ったつもりで戻さないよう固定する。
  const wrong = [];
  for (const f of CUSTOMS_RAID) {
    const s = parseScreenshotName(f);
    const r = rankMaps(db, s.x, s.y, s.z);
    if (r[0].key !== 'customs') wrong.push(`${r[0].key} ${r[0].d.toFixed(2)}m`);
  }
  eq(wrong.length, 2, `取り違えた枚数: ${wrong.join(', ')}`);
  return `単発 1 位が customs でない: ${wrong.join(' / ')}`;
});

await check('累積なら 3 枚目以降つねに customs', () => {
  const t = new MapTracker({ windowSize: 12 });
  const bad = [];
  CUSTOMS_RAID.forEach((f, i) => {
    const s = parseScreenshotName(f);
    t.add(s, db, 1788000000000 + i * 30000);
    const c = t.consensus();
    if (i >= 2 && c.best !== 'customs') bad.push(`${i + 1}枚目 ${c.best}`);
  });
  eq(bad.length, 0, `外した回数: ${bad.join(', ')}`);
  const c = t.consensus();
  return `${c.n} 枚で ${c.best} 平均 ${c.mean.toFixed(1)}m（2位との比 ${c.ratio.toFixed(2)}）`;
});

await check('tracker があれば一度も wrong-map を出さない', () => {
  const t = new MapTracker({ windowSize: 12 });
  const bad = [];
  CUSTOMS_RAID.forEach((f, i) => {
    const s = parseScreenshotName(f);
    t.add(s, db, 1788000000000 + i * 30000);
    const v = validateSample({ sample: s, selectedKey: 'customs', db, tracker: t });
    if (v.verdict === VERDICT.WRONG_MAP) bad.push(`${i + 1}枚目 → ${v.suggest}`);
  });
  eq(bad.length, 0, `誤って切り替えを提案: ${bad.join(', ')}`);
  return `16 枚すべて customs のまま`;
});

await check('時計が使えない条件では tracker の有無で結果が変わる', () => {
  // 夜 Factory や Lab は時刻が固定されて時計整合が効かない。
  // その条件 (fileModifiedMs なし) で単発判定に何が起きるかを固定する。
  const run = (useTracker) => {
    const t = useTracker ? new MapTracker({ windowSize: 12 }) : null;
    const counts = {};
    CUSTOMS_RAID.forEach((f, i) => {
      const s = parseScreenshotName(f);
      if (t) t.add(s, db, 1788000000000 + i * 30000);
      const v = validateSample({ sample: s, selectedKey: 'customs', db, tracker: t });
      counts[v.verdict] = (counts[v.verdict] || 0) + 1;
    });
    return counts;
  };
  const without = run(false);
  const with_ = run(true);
  const fmt = (c) => Object.entries(c).map(([k, n]) => `${k} ${n}`).join(', ');

  const dropped = without[VERDICT.NOT_IN_RAID] || 0;
  const droppedT = with_[VERDICT.NOT_IN_RAID] || 0;
  truthy(dropped > 0, `単発でも取りこぼしが無い（前提が変わった）: ${fmt(without)}`);
  truthy(droppedT < dropped, `tracker で改善していない: なし=${fmt(without)} / あり=${fmt(with_)}`);
  return `なし: ${fmt(without)} ／ あり: ${fmt(with_)}`;
});

await check('別マップに移ったら追随する', () => {
  const t = new MapTracker({ windowSize: 12 });
  for (let i = 0; i < 6; i++) {
    t.add(parseScreenshotName(CUSTOMS_RAID[i]), db, 1788000000000 + i * 30000);
  }
  eq(t.consensus().best, 'customs', '最初は customs');
  // Streets のサンプルを続けて入れる
  for (let i = 0; i < 12; i++) {
    t.add(parseScreenshotName(i % 2 ? RAID1 : RAID2), db, 1788000200000 + i * 30000);
  }
  eq(t.consensus().best, 'streets-of-tarkov', '移動後');
  return '窓が入れ替わって streets-of-tarkov に移る';
});

await check('間が空いたら別レイドとして忘れる', () => {
  const t = new MapTracker({ windowSize: 12, gapResetMs: 10 * 60 * 1000 });
  for (let i = 0; i < 6; i++) {
    t.add(parseScreenshotName(CUSTOMS_RAID[i]), db, 1788000000000 + i * 30000);
  }
  eq(t.count, 6, '蓄積');
  t.add(parseScreenshotName(RAID1), db, 1788000000000 + 40 * 60 * 1000);
  eq(t.count, 1, '窓がリセットされていない');
  eq(t.consensus().best, 'streets-of-tarkov', 'リセット後の判定');
  return '40 分空くと窓を捨てて新しいレイドとして扱う';
});

await check('ハイドアウトは累積があっても捨てられる', () => {
  const t = new MapTracker({ windowSize: 12 });
  const s = parseScreenshotName(HIDEOUT);
  const v = validateSample({
    sample: s, selectedKey: 'streets-of-tarkov', db, fileModifiedMs: MTIME.hideout, tracker: t,
  });
  eq(v.verdict, VERDICT.NOT_IN_RAID, '判定');
  return `累積 0 枚 + 時計不一致 + 比 ${v.ratio.toFixed(2)} → 除外`;
});

/* --------------------------------------------------------------------- T12 */

group('T12 実データ全 16 枚の整合');

await check('ゲーム内時計が全枚で一致する', () => {
  // 実際の mtime は分精度のファイル名からは復元できないので、
  // 時計が単調増加していること・実時間比が 7 倍前後であることを見る。
  const times = CUSTOMS_RAID.map((f) => parseScreenshotName(f));
  for (let i = 1; i < times.length; i++) {
    truthy(times[i].gameTime >= times[i - 1].gameTime, `${i} 枚目で時刻が巻き戻った`);
  }
  const dtGame = (times[times.length - 1].gameTime - times[0].gameTime) * 60;
  const dtReal = (times[times.length - 1].takenAtMs - times[0].takenAtMs) / 60000;
  const ratio = dtGame / dtReal;
  close(ratio, 7, 0.5, 'ゲーム内時間 / 実時間');
  return `${dtReal.toFixed(0)} 分で ${dtGame.toFixed(0)} ゲーム内分 = ${ratio.toFixed(2)} 倍`;
});

await check('roll は真下を向いた 1 枚を除いて 0', () => {
  const rolls = CUSTOMS_RAID.map((f) => Math.abs(quatToRollDeg(parseScreenshotName(f).q)));
  const big = rolls.filter((r) => r > 1);
  eq(big.length, 1, `roll が 0 でない枚数: ${big.map((r) => r.toFixed(1)).join(', ')}`);
  return `15/16 枚で |roll| < 1°、残り 1 枚は真下向き（ジンバルロック）`;
});

await check('真下を向いた 1 枚では方位を出さない', () => {
  const s = parseScreenshotName(LOOK_DOWN);
  close(quatToPitchDeg(s.q), 90, 0.5, 'pitch');
  const strength = headingStrength(s.q);
  truthy(strength < 0.09, `方位の確からしさが残っている: ${strength}`);
  const f = forwardVector(s.q);
  close(f.y, -1, 1e-3, '前方ベクトルが真下');
  return `pitch ${quatToPitchDeg(s.q).toFixed(1)}°, 水平成分 ${strength.toExponential(1)} → 矢印を描かない`;
});

await check('全 19 枚の連番が (0)', () => {
  const all = [RAID1, RAID2, HIDEOUT, ...CUSTOMS_RAID];
  const seqs = new Set(all.map((f) => parseScreenshotName(f).seq));
  eq(seqs.size, 1, `連番の種類: ${[...seqs].join(', ')}`);
  eq([...seqs][0], 0, '値');
  return `${all.length} 枚すべて (0)。同一分・同一座標の連写 2 枚も (0) のまま`;
});

await check('同一分・同一座標の連写でも名前が衝突しない', () => {
  const a = parseScreenshotName(CUSTOMS_RAID[12]);
  const b = parseScreenshotName(CUSTOMS_RAID[13]);
  close(a.x, b.x, 1e-9, 'x');
  close(a.z, b.z, 1e-9, 'z');
  close(a.gameTime, b.gameTime, 1e-9, 'gameTime');
  truthy(CUSTOMS_RAID[12] !== CUSTOMS_RAID[13], '同名になっている');
  const ya = quatToYawDeg(a.q);
  const yb = quatToYawDeg(b.q);
  close(Math.abs(angleDiffDeg(ya, yb)), 0, 0.1, '向きも同じ');
  return `位置も時刻も向きも同じだが quaternion の符号が反転していて別名になる`;
});

/* --------------------------------------------------------------------- T10 */

group('T10 フォルダ監視');

/** FileSystemDirectoryHandle のふり。keys() と getFileHandle() だけ持つ。 */
function fakeDir(names) {
  const set = new Set(names);
  const order = [...names];
  return {
    name: 'Screenshots',
    set,
    async *keys() {
      for (const n of set) yield n;
    },
    async getFileHandle(n) {
      if (!set.has(n)) throw new Error('not found');
      return { async getFile() { return { lastModified: 1000 + order.indexOf(n) }; } };
    },
  };
}

async function makeWatcher(names) {
  const w = new ScreenshotWatcher({ intervalMs: 1e9 });
  w.dir = fakeDir(names);
  const seen = [];
  w.onNew = (info) => seen.push(info.name);
  await w.start();
  w.stop(); // ポーリングは手で回す
  return { w, seen };
}

await check('開始時点のファイルは再生しない', async () => {
  const { w, seen } = await makeWatcher([RAID1, RAID2]);
  eq(seen.length, 0, '起動直後の発火数');
  eq(w.known.size, 2, 'known の件数');
  return '既存 2 枚を既読にして 0 件発火';
});

await check('新しいファイルだけを 1 回ずつ流す', async () => {
  const { w, seen } = await makeWatcher([RAID1]);
  w.dir.set.add(RAID2);
  await w.poll();
  eq(seen.length, 1, '1 回目の発火数');
  eq(seen[0], RAID2, '発火したファイル');
  await w.poll();
  await w.poll();
  eq(seen.length, 1, '同じファイルが再発火していない');
  return '追加 1 枚 → 1 回だけ発火、以降は無視';
});

await check('画像以外は無視する', async () => {
  const { w, seen } = await makeWatcher([]);
  w.dir.set.add('notes.txt');
  w.dir.set.add('desktop.ini');
  w.dir.set.add(RAID1);
  await w.poll();
  eq(seen.length, 1, '発火数');
  eq(seen[0], RAID1, '発火したファイル');
  return '.txt / .ini を無視して .png のみ';
});

await check('削除されたファイルは known から落ちる', async () => {
  const { w, seen } = await makeWatcher([RAID1, RAID2]);
  w.dir.set.delete(RAID2);
  await w.poll();
  eq(w.known.size, 1, '削除後の known');
  eq(seen.length, 0, '削除で発火しない');
  // 同名で作り直されたら新着として扱う
  w.dir.set.add(RAID2);
  await w.poll();
  eq(seen.length, 1, '再作成で発火');
  return '削除で縮み、再作成で再発火する（TTL 方式だと残存ファイルを誤発火する）';
});

await check('同時に複数できたら時刻順に流す', async () => {
  const { w, seen } = await makeWatcher([]);
  w.dir.set.add(HIDEOUT); // 08-06
  w.dir.set.add(RAID1); // 07-29
  w.dir.set.add(RAID2); // 07-31
  await w.poll();
  eq(seen.length, 3, '発火数');
  eq(seen[0], RAID1, '1 番目');
  eq(seen[1], RAID2, '2 番目');
  eq(seen[2], HIDEOUT, '3 番目');
  return 'ファイル名順 = 撮影時刻順';
});

await check('listRecent は古い順に返し、以後は再発火しない', async () => {
  const { w, seen } = await makeWatcher([]);
  w.known.clear();
  w.dir.set.add(RAID1);
  w.dir.set.add(RAID2);
  w.dir.set.add(HIDEOUT);
  const recent = await w.listRecent(2);
  eq(recent.length, 2, '件数');
  eq(recent[0].name, RAID2, '古いほう');
  eq(recent[1].name, HIDEOUT, '新しいほう');
  truthy(recent[0].lastModified !== null, 'lastModified が取れている');
  await w.poll();
  eq(seen.filter((n) => n === HIDEOUT).length, 0, '読み込み済みが再発火した');
  return '新しい 2 枚を古い順で返し、既読に入れる';
});

await check('ポーリングが重ならない', async () => {
  const { w } = await makeWatcher([RAID1]);
  let concurrent = 0;
  let maxConcurrent = 0;
  const origList = w.listNames.bind(w);
  w.listNames = async () => {
    concurrent++;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise((r) => setTimeout(r, 5));
    const res = await origList();
    concurrent--;
    return res;
  };
  await Promise.all([w.poll(), w.poll(), w.poll()]);
  eq(maxConcurrent, 1, '同時実行数');
  return '前のポーリングが終わるまで次を走らせない';
});

await check('監視できないブラウザを検出できる', () => {
  const supported = isSupported();
  truthy(typeof supported === 'boolean', '真偽値を返す');
  return `showDirectoryPicker: ${supported ? 'あり' : 'なし'}（このブラウザ）`;
});

/* --------------------------------------------------------------------- T17 */

group('T17 名前の付いた地点');

const customsLm = await loadLandmarks('customs', '../data/landmarks/customs.json');

await check('マップごとの地点ファイルが読める', async () => {
  const withFile = db.maps.filter((m) => m.landmarkFile);
  truthy(withFile.length >= 10, `landmarkFile を持つマップが少ない: ${withFile.length}`);
  let total = 0;
  for (const m of withFile) {
    const data = await loadLandmarks(m.key, '../' + m.landmarkFile);
    truthy(!data.failed, `${m.key} の読み込みに失敗: ${data.failed}`);
    for (const [kind, list] of Object.entries(m.landmarkCounts || {})) {
      eq((data[kind] || []).length, list, `${m.key}/${kind} の件数が mapdb と食い違う`);
      total += list;
    }
  }
  return `${withFile.length} マップ / のべ ${total} 地点`;
});

await check('地名が実際の呼び名になっている', () => {
  const names = (customsLm.label || []).map((l) => l.n);
  truthy(names.length >= 20, `Customs の地名が少ない: ${names.length}`);
  for (const known of ['Big Red', 'Dorms', 'New Gas', 'Old Gas', 'Fortress']) {
    truthy(names.includes(known), `「${known}」が無い`);
  }
  return `${names.length} 件: ${names.slice(0, 5).join(' / ')} …`;
});

await check('地点の座標がそのマップの範囲に入っている', () => {
  const b = db.byKey.get('customs').bbox;
  const margin = 250;
  let n = 0;
  const out = [];
  for (const def of LAYERS) {
    for (const it of customsLm[def.id] || []) {
      n++;
      const [x, , z] = it.p;
      if (x < b.x[0] - margin || x > b.x[1] + margin || z < b.z[0] - margin || z > b.z[1] + margin) {
        out.push(`${def.id}:${it.n || ''} (${x},${z})`);
      }
    }
  }
  truthy(n > 50, `検査した地点が少ない: ${n}`);
  eq(out.length, 0, `範囲外: ${out.slice(0, 3).join(' / ')}`);
  return `${n} 地点すべてが Customs の範囲内`;
});

await check('施錠扉に鍵の名前が入っている', () => {
  const locks = customsLm.lock || [];
  truthy(locks.length > 10, `施錠扉が少ない: ${locks.length}`);
  const named = locks.filter((l) => l.n);
  truthy(named.length / locks.length > 0.5, `鍵名の付いた割合が低い: ${named.length}/${locks.length}`);
  // 略称ではなく正式名称であること（"USEC" ではなく "USECの隠し倉庫の鍵"）
  const longEnough = named.filter((l) => l.n.length >= 4);
  truthy(longEnough.length === named.length, `略称のままのものがある: ${named.find((l) => l.n.length < 4)?.n}`);
  return `${named.length}/${locks.length} 件に鍵名（例: ${named[0].n}）`;
});

await check('危険地帯とボスの表示名が読める形になる', () => {
  const hz = customsLm.hazard || [];
  truthy(hz.length > 0, '危険地帯が無い');
  const kinds = new Set(hz.map(hazardLabel));
  for (const k of kinds) truthy(k && k.length <= 6, `危険地帯の表示が長すぎる: ${k}`);
  const boss = customsLm.boss || [];
  truthy(boss.length > 0, 'ボス湧きが無い');
  const label = bossLabel(boss[0]);
  truthy(label && label.length > 0, 'ボス名が空');
  return `危険 ${[...kinds].join('・')} / ボス例「${label}」`;
});

await check('ボス湧きが間引かれている', () => {
  // 間引かないと 1 マップで数百点になり、地図が埋まる
  for (const m of db.maps) {
    const n = (m.landmarkCounts || {}).boss || 0;
    truthy(n <= 90, `${m.key} のボス湧きが多すぎる: ${n}`);
  }
  const total = db.maps.reduce((s, m) => s + ((m.landmarkCounts || {}).boss || 0), 0);
  return `全マップ合計 ${total} 点`;
});

await check('レイヤ定義が一貫している', () => {
  const ids = new Set();
  for (const def of LAYERS) {
    truthy(def.id && def.name && def.color && def.shape, `定義が欠けている: ${JSON.stringify(def)}`);
    truthy(!ids.has(def.id), `id が重複: ${def.id}`);
    ids.add(def.id);
    truthy(/^#[0-9a-f]{6}$/i.test(def.color), `色の形式が不正: ${def.color}`);
  }
  for (const id of DEFAULT_ENABLED) truthy(ids.has(id), `既定で有効な ${id} が定義に無い`);
  // 既存の用途と色がぶつかっていないこと
  const taken = ['#6fd66f', '#ff7a5c', '#ffc848', '#b48cff', '#22e0ff'];
  const clash = LAYERS.filter((d) => taken.includes(d.color.toLowerCase()));
  eq(clash.length, 0, `脱出口・ピン・タスク・現在地と同じ色: ${clash.map((d) => d.id).join(', ')}`);
  return `${LAYERS.length} 種類 / 既定で有効: ${DEFAULT_ENABLED.join(', ')}`;
});

await check('データにあるすべての種類が UI で出せる', () => {
  const known = new Set(LAYERS.map((d) => d.id));
  const missing = new Set();
  for (const m of db.maps) {
    for (const kind of Object.keys(m.landmarkCounts || {})) {
      if (!known.has(kind)) missing.add(kind);
    }
  }
  eq(missing.size, 0, `UI に無い種類: ${[...missing].join(', ')}`);
  return `データ側の種類がすべて LAYERS に定義済み`;
});

/* --------------------------------------------------------------------- T16 */

group('T16 タスクの目標地点');

// テストページは /test/ 配下にあるので、アプリ（ルート）より 1 段深い
const customsTasks = await loadTasks('customs', '../data/tasks/customs.json', '../data/tasks/_any.json');

await check('マップごとのタスクファイルが読める', async () => {
  truthy(customsTasks.length > 20, `Customs のタスクが少ない: ${customsTasks.length}`);
  const withFile = db.maps.filter((m) => m.taskFile);
  truthy(withFile.length >= 10, `taskFile を持つマップが少ない: ${withFile.length}`);
  let sum = 0;
  for (const m of withFile) {
    // 「任意のマップ」のぶんは別ファイルなので、ここではマップ固有だけを数える
    const list = await loadTasks('__count_' + m.key, '../' + m.taskFile, null);
    eq(list.length, m.taskCount, `${m.key} の件数が mapdb と食い違う`);
    sum += list.length;
  }
  const anyCount = customsTasks.filter((t) => t.any).length;
  truthy(anyCount > 50, `任意マップのタスクが少ない: ${anyCount}`);
  return `${withFile.length} マップ / マップ固有 ${sum} + 任意 ${anyCount} = Customs の一覧 ${customsTasks.length} 件`;
});

await check('タスク名と目標の説明が翻訳済み', () => {
  const badName = customsTasks.filter((t) => /^[0-9a-f]{24}\s+name$/i.test(t.n || ''));
  eq(badName.length, 0, `未翻訳のタスク名: ${badName.length} 件`);
  let objs = 0;
  const badDesc = [];
  for (const t of customsTasks) {
    for (const o of t.o || []) {
      objs++;
      if (/^[0-9a-f]{24}$/i.test(o.d || '')) badDesc.push(o.d);
    }
  }
  eq(badDesc.length, 0, `未翻訳の目標説明: ${badDesc.length} 件`);
  return `タスク ${customsTasks.length} / 目標 ${objs} 件すべて解決済み`;
});

await check('目標の地点が正しいマップの範囲に入っている', () => {
  const m = db.byKey.get('customs');
  const b = m.bbox;
  const margin = 200; // 座標は丸めてあるうえ、地図外の演出用ゾーンもありうる
  let checked = 0;
  const out = [];
  for (const t of customsTasks) {
    for (const o of t.o || []) {
      const g = objectiveGeometry(o, 'customs');
      for (const z of g.zones) {
        checked++;
        const [x, , z2] = z.p;
        if (x < b.x[0] - margin || x > b.x[1] + margin || z2 < b.z[0] - margin || z2 > b.z[1] + margin) {
          out.push(`${t.n}: ${x},${z2}`);
        }
      }
    }
  }
  truthy(checked > 40, `検査したゾーンが少ない: ${checked}`);
  eq(out.length, 0, `範囲外: ${out.slice(0, 3).join(' / ')}`);
  return `${checked} ゾーンすべてが Customs の範囲内`;
});

await check('別マップの地点は混ざらない', () => {
  // 複数マップにまたがるタスクでも、objectiveGeometry は指定マップぶんだけ返す
  const multi = customsTasks.find((t) =>
    (t.o || []).some((o) => (o.z || []).some((z) => z.m !== 'customs')),
  );
  truthy(multi, '複数マップにまたがるタスクが見つからない');
  let mine = 0;
  let theirs = 0;
  for (const o of multi.o) {
    const g = objectiveGeometry(o, 'customs');
    mine += g.zones.length;
    theirs += (o.z || []).filter((z) => z.m !== 'customs').length;
  }
  truthy(theirs > 0, '別マップの地点が無い');
  for (const o of multi.o) {
    for (const z of objectiveGeometry(o, 'customs').zones) {
      eq(z.m, 'customs', '別マップの地点が混ざった');
    }
  }
  return `「${multi.n}」 Customs ${mine} 箇所 / 他マップ ${theirs} 箇所を分離`;
});

await check('検索でタスクを絞れる', () => {
  eq(filterTasks(customsTasks, '').length, customsTasks.length, '空検索は全件');
  const byTrader = filterTasks(customsTasks, 'prapor');
  truthy(byTrader.length > 0, 'トレーダー名で引けない');
  // 目標の説明にトレーダー名が出るものもある（「Prapor に渡す」など）。
  // 名前・トレーダー・説明のどれかに含まれていればよい
  const hit = (t, q) =>
    (t.n || '').toLowerCase().includes(q) ||
    (t.tr || '').toLowerCase().includes(q) ||
    (t.o || []).some((o) => (o.d || '').toLowerCase().includes(q));
  truthy(byTrader.every((t) => hit(t, 'prapor')), '無関係なものが混ざる');
  const byName = filterTasks(customsTasks, customsTasks[0].n.slice(0, 6));
  truthy(byName.length > 0, 'タスク名で引けない');
  const none = filterTasks(customsTasks, 'zzzzzz該当なしzzzzzz');
  eq(none.length, 0, '該当なしのとき 0 件');
  return `prapor で ${byTrader.length} 件 / 該当なしは 0 件`;
});

await check('一覧ラベルにトレーダーとレベルが入る', () => {
  const t = customsTasks.find((x) => x.lv);
  const label = taskLabel(t);
  truthy(label.includes(t.tr), 'トレーダー名が無い');
  truthy(label.includes(`Lv${t.lv}`), 'レベルが無い');
  truthy(label.includes(t.n), 'タスク名が無い');
  return label;
});

await check('目標までの距離が実サンプルから出る', () => {
  const s = parseScreenshotName(CUSTOMS_RAID[0]);
  let best = null;
  for (const t of customsTasks) {
    for (const p of taskPoints(t, 'customs')) {
      const b = pinBearing(s, p, quatToYawDeg(s.q));
      if (!best || b.dist < best.d) best = { d: b.dist, b: b.bearing, n: t.n };
    }
  }
  truthy(best, '地点が 1 つも取れない');
  truthy(best.d < 2000, `距離が異常: ${best.d}`);
  return `最寄りの目標は「${best.n}」 ${best.d.toFixed(0)}m 方位 ${best.b.toFixed(0)}°`;
});

await check('目標の種類に日本語表示がある', () => {
  const types = new Set();
  for (const t of customsTasks) for (const o of t.o || []) types.add(o.t);
  const known = [...types].filter((t) => OBJECTIVE_TYPE[t]);
  truthy(known.length >= 4, `対応している種類が少ない: ${known.length}/${types.size}`);
  return `${known.length}/${types.size} 種類に日本語表示（${known.slice(0, 4).map((t) => OBJECTIVE_TYPE[t]).join('・')} …）`;
});

/* --------------------------------------------------------------------- T20 */

group('T20 クエストアイテムと任意マップ');

await check('クエストアイテムが持ち物に出る', () => {
  // これらの目標は items ではなく questItem を持つ。items だけを見ていたころは
  // 222 目標ぶんが持ち物にまったく出てこなかった
  let planted = 0;
  let found = 0;
  const examples = [];
  for (const t of customsTasks) {
    const lo = taskLoadout(t, 'customs');
    for (const b of lo.bring) if (b.quest) { planted++; if (examples.length < 2) examples.push(`設置 ${b.n}`); }
    for (const f of lo.find) { found++; if (examples.length < 4) examples.push(`${f.kind === 'hand' ? '引渡' : '探す'} ${f.n}`); }
  }
  truthy(planted + found > 10, `クエストアイテムが出ていない: 設置 ${planted} / 探す ${found}`);
  return `設置 ${planted} 件 / 探す・引渡 ${found} 件（${examples.join(' / ')}）`;
});

await check('クエストアイテムの名前が解決されている', () => {
  const bad = [];
  for (const t of customsTasks) {
    for (const o of t.o || []) {
      if (!o.qi) continue;
      if (!o.qi.n || /^[0-9a-f]{24}/.test(o.qi.n) || o.qi.n === 'クエストアイテム') bad.push(o.qi.n);
    }
  }
  eq(bad.length, 0, `未解決: ${bad.slice(0, 3).join(', ')}`);
  const all = customsTasks.flatMap((t) => (t.o || []).filter((o) => o.qi).map((o) => o.qi.n));
  return `${all.length} 件（例: ${[...new Set(all)].slice(0, 2).join(' / ')}）`;
});

await check('持ち込むものと探すものが重複しない', () => {
  for (const t of customsTasks) {
    const lo = taskLoadout(t, 'customs');
    const ids = new Set(lo.bring.map((b) => b.i));
    for (const f of lo.find) truthy(!ids.has(f.i), `${t.n}: ${f.n} が両方に出ている`);
  }
  return '同じアイテムが「設置」と「探す」に二重に出ない';
});

await check('任意マップのタスクが一覧に入る', () => {
  const any = customsTasks.filter((t) => t.any);
  truthy(any.length > 50, `任意マップのタスクが少ない: ${any.length}`);
  for (const t of any.slice(0, 20)) {
    truthy(taskLabel(t).startsWith('〈任意〉'), `印が付いていない: ${taskLabel(t)}`);
  }
  return `${any.length} 件（例: ${taskLabel(any[0])}）`;
});

await check('任意マップのタスクはどのマップでも同じ数', async () => {
  const woods = await loadTasks('woods', '../data/tasks/woods.json', '../data/tasks/_any.json');
  const a1 = customsTasks.filter((t) => t.any).length;
  const a2 = woods.filter((t) => t.any).length;
  eq(a1, a2, '任意マップのタスク数がマップで違う');
  // マップ固有のぶんは当然違う
  truthy(customsTasks.length !== woods.length, 'マップ固有のタスクが反映されていない');
  return `任意 ${a1} 件は共通 / Customs ${customsTasks.length} 件 vs Woods ${woods.length} 件`;
});

await check('場所を持たない目標は「別マップ」にしない', () => {
  // 「スカブを 10 体倒す」のような目標は、どのマップでも意味がある
  const any = customsTasks.filter((t) => t.any);
  let placeless = 0;
  for (const t of any) {
    for (const o of t.o || []) {
      if (!(o.z || []).length && !(o.l || []).length) {
        placeless++;
        truthy(objectiveApplies(o, 'customs'), `場所なしの目標が除外された: ${o.d}`);
        truthy(objectiveApplies(o, 'woods'), '別マップでも通るはず');
      }
    }
  }
  truthy(placeless > 20, `場所を持たない目標が少ない: ${placeless}`);
  return `${placeless} 目標がどのマップでも有効`;
});

await check('目標の種別すべてに日本語表示がある', () => {
  const missing = new Set();
  for (const t of customsTasks) {
    for (const o of t.o || []) if (!OBJECTIVE_TYPE[o.t]) missing.add(o.t);
  }
  eq(missing.size, 0, `未対応: ${[...missing].join(', ')}`);
  const kinds = new Set(customsTasks.flatMap((t) => (t.o || []).map((o) => o.t)));
  return `${kinds.size} 種類すべてに日本語表示`;
});

/* --------------------------------------------------------------------- T19 */

group('T19 マップ誤判定の回帰（報告された不具合）');

await check('Woods のレイド中に他マップへ移らない', () => {
  // 直近 12 枚の窓で見ていたころは、レイド途中で Interchange に飛んでいた。
  // 1 枚目の 2位/1位 = 154 という決定的な証拠を、窓が通り過ぎて捨てていたため。
  const t = new MapTracker();
  const wrong = [];
  WOODS_RAID.forEach((f, i) => {
    const s = parseScreenshotName(f);
    t.add(s, db, 1788000000000 + i * 20000);
    const c = t.consensus();
    if (c && c.best !== 'woods') wrong.push(`${i + 1}枚目 → ${c.best}`);
  });
  eq(wrong.length, 0, `別マップに移った: ${wrong.slice(0, 5).join(', ')}`);
  const c = t.consensus();
  return `${c.n} 枚すべて woods（最終 平均 ${c.mean.toFixed(1)}m, 比 ${c.ratio.toFixed(2)}）`;
});

await check('窓でスライドさせると再現する（原因の固定）', () => {
  // 直近 12 枚だけを見ると、実際に Interchange が 1 位になる区間がある。
  // これが再現しなくなったら、この回帰テストの前提が変わったということ。
  const others = new Set();
  for (let i = 12; i <= WOODS_RAID.length; i++) {
    const t = new MapTracker();
    WOODS_RAID.slice(i - 12, i).forEach((f, j) => {
      t.add(parseScreenshotName(f), db, 1788000000000 + j * 20000);
    });
    // 密度正規化と bbox は効かせたまま、窓だけを狭めた場合
    const sc = t.scores();
    if (sc[0].key !== 'woods') others.add(sc[0].key);
  }
  return others.size
    ? `窓 12 枚だと ${[...others].join(', ')} が 1 位になる区間がある`
    : '窓 12 枚でも誤らない（密度正規化と bbox 足切りの効果）';
});

await check('同じ夜の Interchange レイドは Interchange と判定する', () => {
  // 「Woods を必ず選ぶ」ような直し方をしていないことの確認
  const t = new MapTracker();
  const wrong = [];
  INTERCHANGE_RAID.forEach((f, i) => {
    const s = parseScreenshotName(f);
    t.add(s, db, 1788000000000 + i * 20000);
    const c = t.consensus();
    if (i >= 2 && c && c.best !== 'interchange') wrong.push(`${i + 1}枚目 → ${c.best}`);
  });
  eq(wrong.length, 0, `別マップになった: ${wrong.slice(0, 5).join(', ')}`);
  const c = t.consensus();
  return `${c.n} 枚で interchange（平均 ${c.mean.toFixed(1)}m, 比 ${c.ratio.toFixed(2)}）`;
});

await check('レイドが変われば追随する', () => {
  // Interchange のレイドのあと 18 分空けて Woods。実際の並びと同じ
  const t = new MapTracker();
  INTERCHANGE_RAID.forEach((f, i) => t.add(parseScreenshotName(f), db, 1788000000000 + i * 20000));
  eq(t.consensus().best, 'interchange', '1 本目');
  const base = 1788000000000 + 18 * 60 * 1000;
  WOODS_RAID.forEach((f, i) => t.add(parseScreenshotName(f), db, base + i * 20000));
  eq(t.consensus().best, 'woods', '2 本目');
  eq(t.count, WOODS_RAID.length, '前のレイドを引きずっている');
  return '18 分の間隔で切り替わり、前のレイドを引きずらない';
});

await check('POI 密度の違いを吸収している', () => {
  // 密度は 7 倍以上違う。距離をそのまま比べると密なマップが有利になる
  const t = new MapTracker();
  t.db = db;
  const woods = db.byKey.get('woods');
  const reserve = db.byKey.get('reserve');
  const sw = t.spacingOf(woods);
  const sr = t.spacingOf(reserve);
  truthy(sw > sr * 2, `間隔の差が小さい: woods ${sw.toFixed(1)} / reserve ${sr.toFixed(1)}`);
  return `点の間隔: woods ${sw.toFixed(0)}m / reserve ${sr.toFixed(0)}m / interchange ${t.spacingOf(db.byKey.get('interchange')).toFixed(0)}m`;
});

/* --------------------------------------------------------------------- T18 */

group('T18 タスクの持ち物と鍵→扉');

await check('鍵の要るタスクに鍵名が入っている', () => {
  const withKeys = customsTasks.filter((t) => (t.k || []).length);
  truthy(withKeys.length >= 10, `鍵の要るタスクが少ない: ${withKeys.length}`);
  for (const t of withKeys) {
    for (const k of t.k) {
      truthy(k.i && k.n, `鍵の情報が欠けている: ${JSON.stringify(k)}`);
      truthy(k.n !== '?', `鍵名が解決できていない: ${t.n}`);
      truthy(k.n.length >= 4, `略称のまま: ${k.n}`);
    }
  }
  return `${withKeys.length} タスク（例: ${withKeys[0].k[0].n}）`;
});

await check('鍵が施錠扉と ID で結びつく', () => {
  let matched = 0;
  let checked = 0;
  const examples = [];
  for (const t of customsTasks) {
    if (!(t.k || []).length) continue;
    checked++;
    const doors = taskKeyDoors(t, customsLm);
    eq(doors.length, t.k.length, '鍵の数と結果の数が違う');
    for (const d of doors) {
      if (d.locks.length) {
        matched++;
        // 名前一致ではなく ID 一致であること
        for (const lock of d.locks) eq(lock.k, d.key.i, '別の鍵の扉が混ざった');
        if (examples.length < 2) examples.push(`${d.key.n} → 扉 ${d.locks.length} 箇所`);
      }
    }
  }
  truthy(matched > 0, '扉と結びつく鍵が 1 つも無い');
  return `${checked} タスク中 ${matched} 件の鍵が扉と一致（${examples.join(' / ')}）`;
});

await check('持ち物が集約される', () => {
  let found = null;
  for (const t of customsTasks) {
    const lo = taskLoadout(t, 'customs');
    if (lo.bring.length) { found = { t, lo }; break; }
  }
  truthy(found, '持ち物のあるタスクが無い');
  for (const b of found.lo.bring) {
    truthy(b.i && b.n, `アイテム情報が欠けている: ${JSON.stringify(b)}`);
    truthy(['marker', 'give', 'plant'].includes(b.kind), `種別が不正: ${b.kind}`);
  }
  // 同じものが 2 回出てきたら 1 行にまとまること
  const ids = found.lo.bring.map((b) => b.i);
  eq(new Set(ids).size, ids.length, '同じアイテムが重複している');
  return `「${found.t.n}」: ${found.lo.bring.map((b) => b.n).join(' / ')}`;
});

await check('見つける系は持ち物に入らない', () => {
  // findItem / findQuestItem は現地調達なので持ち込むものではない
  for (const t of customsTasks) {
    for (const o of t.o || []) {
      if (['findItem', 'findQuestItem', 'visit', 'extract', 'shoot'].includes(o.t)) {
        eq(o.it, undefined, `${t.n} の ${o.t} に持ち物が付いている`);
      }
    }
  }
  return '渡す・設置する系だけが持ち物になる';
});

await check('武器指定は数だけを持つ', () => {
  // usingWeapon は 1 目標に数十丁並ぶ。一覧にすると使い物にならないので数だけ
  let withWeapon = 0;
  for (const t of customsTasks) {
    for (const o of t.o || []) {
      if (o.wp) {
        withWeapon++;
        eq(typeof o.wp, 'number', 'wp が数値でない');
        truthy(o.wp > 0, 'wp が 0');
      }
    }
  }
  return withWeapon ? `${withWeapon} 目標に武器指定（数のみ保持）` : '武器指定のある目標は Customs には無し';
});

await check('カッパ必須フラグが鍵と衝突していない', () => {
  // 以前は両方 "k" を使っていて、鍵を入れた時点で ★ が壊れる状態だった
  const kappa = customsTasks.filter((t) => t.kap);
  truthy(kappa.length > 0, 'カッパ必須のタスクが無い');
  for (const t of kappa) {
    truthy(taskLabel(t).includes('★'), `★ が付かない: ${t.n}`);
    if (t.k) truthy(Array.isArray(t.k), 'k が配列でない（フラグと混ざった）');
  }
  return `${kappa.length} タスクが ★ 付き`;
});

await check('別マップの持ち物は出さない', () => {
  // 複数マップにまたがるタスクで、そのマップに目標が無いものの持ち物は出さない
  const multi = customsTasks.find((t) =>
    (t.o || []).some((o) => (o.z || []).length && !(o.z || []).some((z) => z.m === 'customs')),
  );
  if (!multi) return '該当するタスクが無いため確認省略';
  const lo = taskLoadout(multi, 'customs');
  const isHere = (o) => (o.z || []).some((z) => z.m === 'customs') || (o.l || []).some((l) => l.m === 'customs');
  const hereIds = new Set(
    (multi.o || []).filter(isHere).flatMap((o) => [...(o.it || []).map((i) => i.i), ...(o.mk ? [o.mk.i] : [])]),
  );
  // 同じ道具を両方のマップで使うことがある（MS2000 マーカーなど）。
  // 「別マップの目標にしか出てこないもの」だけが除外対象。
  const awayOnly = (multi.o || [])
    .filter((o) => (o.z || []).length && !isHere(o))
    .flatMap((o) => [...(o.it || []).map((i) => i.i), ...(o.mk ? [o.mk.i] : [])])
    .filter((id) => !hereIds.has(id));
  for (const id of awayOnly) {
    truthy(!lo.bring.some((b) => b.i === id), `別マップだけの持ち物が出ている: ${id}`);
  }
  return `「${multi.n}」で別マップ専用の持ち物 ${awayOnly.length} 件を除外（共用は残す）`;
});

/* --------------------------------------------------------------------- T15 */

group('T15 ピン（タスクの目的地）');

await check('ピンの追加・削除・改名', () => {
  let pins = [];
  pins = addPin(pins, { name: '目的地A', x: 100, y: 3, z: -50 });
  pins = addPin(pins, { name: '目的地B', x: 200, y: 4, z: 60 });
  eq(pins.length, 2, '件数');
  eq(pins[0].name, '目的地B', '新しいものが先頭');
  truthy(pins[0].id !== pins[1].id, 'ID が重複している');
  pins = renamePin(pins, pins[1].id, 'Debut の目標');
  eq(pins[1].name, 'Debut の目標', '改名');
  pins = removePin(pins, pins[0].id);
  eq(pins.length, 1, '削除後');
  eq(pins[0].name, 'Debut の目標', '残ったもの');
  return '追加 2 / 改名 1 / 削除 1';
});

await check('名前が空でも壊れない', () => {
  const pins = addPin([], { name: '   ', x: 0, y: 0, z: 0 });
  eq(pins[0].name, '名前なし', '既定名');
  const p2 = addPin([], { name: 'x', x: 1, z: 2 }); // y なし
  eq(p2[0].y, 0, 'y の既定値');
  return '空名は「名前なし」、y 省略は 0';
});

await check('距離と方位が正しい', () => {
  // 現在地 (0,0) から真東 (+X) に 100m
  const east = { id: 'a', name: 'e', x: 100, y: 0, z: 0, at: 0 };
  const b1 = pinBearing({ x: 0, z: 0 }, east, null);
  close(b1.dist, 100, 1e-9, '距離');
  close(b1.bearing, 90, 1e-9, '方位（+X = 90°）');
  eq(b1.relative, null, 'yaw なしでは相対角なし');

  // 真北 (+Z) に 50m
  const north = { id: 'b', name: 'n', x: 0, y: 0, z: 50, at: 0 };
  close(pinBearing({ x: 0, z: 0 }, north, null).bearing, 0, 1e-9, '方位（+Z = 0°）');

  // 北を向いているときに東のピンは右 90°
  const b2 = pinBearing({ x: 0, z: 0 }, east, 0);
  close(b2.relative, 90, 1e-9, '相対角');
  // 東を向いていれば正面
  close(pinBearing({ x: 0, z: 0 }, east, 90).relative, 0, 1e-9, '正面');
  // 西を向いていれば真後ろ
  close(Math.abs(pinBearing({ x: 0, z: 0 }, east, 270).relative), 180, 1e-9, '真後ろ');
  return '+X=90° / +Z=0° / 相対角も一致';
});

await check('実データで目的地までの距離が出る', () => {
  // Streets の実サンプルから Crash Site（脱出口）をピンに見立てる
  const s = parseScreenshotName(RAID2);
  const m = db.byKey.get('streets-of-tarkov');
  const crash = (m.extracts || []).find((e) => e.name === 'Crash Site');
  truthy(crash, 'Crash Site が見つからない');
  const pin = { id: 'x', name: crash.name, x: crash.position.x, y: crash.position.y, z: crash.position.z, at: 0 };
  const b = pinBearing(s, pin, quatToYawDeg(s.q));
  close(b.dist, 61, 1.5, '距離');
  close(b.bearing, 77, 2, '方位');
  return `${crash.name} まで ${b.dist.toFixed(0)}m 方位 ${b.bearing.toFixed(0)}°（相対 ${b.relative.toFixed(0)}°）`;
});

await check('保存と読み込みがマップ単位で分かれる', () => {
  const a = addPin([], { name: 'customs のピン', x: 1, y: 0, z: 2 });
  const b = addPin([], { name: 'woods のピン', x: 3, y: 0, z: 4 });
  savePins('__test_customs', a);
  savePins('__test_woods', b);
  const ra = loadPins('__test_customs');
  const rb = loadPins('__test_woods');
  eq(ra.length, 1, 'customs の件数');
  eq(rb.length, 1, 'woods の件数');
  eq(ra[0].name, 'customs のピン', 'customs の内容');
  eq(rb[0].name, 'woods のピン', 'woods の内容');
  eq(loadPins('__test_nothing').length, 0, '未保存のマップ');
  localStorage.removeItem('eft-gps.pins.__test_customs');
  localStorage.removeItem('eft-gps.pins.__test_woods');
  return 'マップごとに独立して保存される';
});

await check('壊れた保存データを読んでも落ちない', () => {
  localStorage.setItem('eft-gps.pins.__test_broken', '{ not json');
  eq(loadPins('__test_broken').length, 0, '不正 JSON');
  localStorage.setItem('eft-gps.pins.__test_broken', '[{"id":"a"},{"id":"b","x":1,"z":2},"ゴミ",null]');
  const r = loadPins('__test_broken');
  eq(r.length, 1, '壊れた項目を捨てる');
  eq(r[0].id, 'b', '残った項目');
  localStorage.removeItem('eft-gps.pins.__test_broken');
  return '不正な保存データは静かに捨てて 0 件または有効分のみ返す';
});

/* --------------------------------------------------------------------- T14 */

group('T14 表示名の解決');

// tarkov.dev の API は翻訳キーを返す。辞書 (maps_ja / maps_en) を当てないと
// 脱出口名が内部キーのまま出る。単に読みにくいだけでなく、Woods の
// "Factory Gate" が実際には Friendship Bridge (Co-Op) だったように、
// 別の場所の名前として読めてしまうものがある。
await check('マップ名が翻訳キーのまま残っていない', () => {
  const bad = db.maps.filter((m) => /^[0-9a-f]{24}\s+(Name|Description)$/.test(m.name || ''));
  eq(bad.length, 0, `未解決: ${bad.map((m) => `${m.key}=${m.name}`).join(', ')}`);
  const named = db.maps.filter((m) => m.name && m.name !== m.key);
  truthy(named.length >= 10, `名前が付いたマップが少ない: ${named.length}`);
  return `${named.length} マップ: ${named.slice(0, 4).map((m) => m.name).join(' / ')} …`;
});

await check('脱出口名に内部キーの痕跡が無い', () => {
  // 内部キーに特徴的な形: snake_case、先頭が小文字の接頭辞、EXFIL_ 接頭辞など
  const KEY_LIKE = [
    /^EXFIL[_ ]/i,
    /^(scav|lab|wood|woods|customs|streets|lighthouse|reserve|groundzero|shoreline|factory|labyrinth|labir)_/i,
    /_(exit|free|scav|coop|secret|alp|sec)$/i,
    /^E\d+(_|$)/,
    /^Exit\d+$/i,
  ];
  const bad = [];
  for (const m of db.maps) {
    for (const e of m.extracts || []) {
      const n = String(e.name || '');
      if (KEY_LIKE.some((re) => re.test(n))) bad.push(`${m.key}/${n}`);
    }
  }
  eq(bad.length, 0, `内部キーのまま: ${bad.slice(0, 8).join(', ')}${bad.length > 8 ? ` ほか ${bad.length - 8} 件` : ''}`);
  const total = db.maps.reduce((n, m) => n + (m.extracts || []).length, 0);
  return `${total} 件すべて解決済み`;
});

await check('既知の誤表示が直っている（回帰）', () => {
  // 実際に間違って表示されていたもの。名前だけでなく場所も別だった。
  const expect = [
    ['woods', 'Friendship Bridge (Co-Op)', 'Factory Gate と表示されていた'],
    ['woods', 'Eastern Rocks', 'West Border と表示されていた（東西が逆）'],
    ['woods', 'Scav Bunker', 'East Gate と表示されていた'],
    ['customs', 'Military Base CP', 'Shack と表示されていた'],
    ['customs', 'Scav Checkpoint', 'Military Checkpoint と表示されていた'],
    ['interchange', 'Emercom Checkpoint', 'SE Exfil と表示されていた'],
    ['streets-of-tarkov', 'Stylobate Building Elevator', 'E1 と表示されていた'],
    ['streets-of-tarkov', 'Entrance to Catacombs', 'scav_e2 と表示されていた'],
    ['the-lab', 'Medical Block Elevator', 'lab_Elevator_Med と表示されていた'],
  ];
  const missing = [];
  for (const [key, name, note] of expect) {
    const m = db.byKey.get(key);
    if (!m || !(m.extracts || []).some((e) => e.name === name)) missing.push(`${key}/${name}（${note}）`);
  }
  eq(missing.length, 0, `見つからない: ${missing.join(' , ')}`);
  return `${expect.length} 件の既知の誤表示を確認`;
});

await check('校正の参照 ID は内部キーを使う', () => {
  // 表示名が変わっても、既存の校正データの対応点が迷子にならないようにする
  let withKey = 0;
  let total = 0;
  for (const m of db.maps) {
    for (const e of m.extracts || []) {
      total++;
      if (e.key) withKey++;
    }
  }
  eq(withKey, total, `key を持たない脱出口が ${total - withKey} 件`);
  return `${total} 件すべてが表示名と内部キーの両方を持つ`;
});

/* --------------------------------------------------------------------- T13 */

group('T13 配布物の整合 (PWA / 静的配信)');

await check('manifest が有効で必要な項目が揃っている', async () => {
  const m = await fetch('../manifest.webmanifest').then((r) => r.json());
  for (const k of ['name', 'short_name', 'start_url', 'scope', 'display', 'icons']) {
    truthy(m[k], `${k} が無い`);
  }
  eq(m.display, 'standalone', 'display');
  truthy(m.start_url.startsWith('./'), `start_url が相対でない: ${m.start_url}`);
  truthy(m.scope.startsWith('./'), `scope が相対でない: ${m.scope}`);
  const sizes = m.icons.map((i) => i.sizes);
  truthy(sizes.includes('192x192') && sizes.includes('512x512'), `アイコンの寸法: ${sizes}`);
  truthy(m.icons.some((i) => i.purpose === 'maskable'), 'maskable アイコンが無い');
  return `${m.short_name} / display ${m.display} / アイコン ${m.icons.length} 件`;
});

await check('manifest のアイコンが実在する', async () => {
  const m = await fetch('../manifest.webmanifest').then((r) => r.json());
  const missing = [];
  for (const icon of m.icons) {
    const res = await fetch('../' + icon.src.replace(/^\.\//, ''));
    if (!res.ok) missing.push(icon.src);
  }
  eq(missing.length, 0, `見つからない: ${missing.join(', ')}`);
  return `${new Set(m.icons.map((i) => i.src)).size} ファイルすべて配信できる`;
});

await check('sw.js の precache リストが全部実在する', async () => {
  const src = await fetch('../sw.js').then((r) => r.text());
  const block = src.match(/const PRECACHE = \[([\s\S]*?)\];/);
  truthy(block, 'PRECACHE が見つからない');
  const urls = [...block[1].matchAll(/'([^']+)'/g)].map((m2) => m2[1]);
  truthy(urls.length >= 15, `件数が少ない: ${urls.length}`);
  const missing = [];
  for (const u of urls) {
    const rel = '../' + u.replace(/^\.\//, '');
    const res = await fetch(rel);
    if (!res.ok) missing.push(u);
  }
  eq(missing.length, 0, `404 になる: ${missing.join(', ')}`);
  return `${urls.length} 件すべて 200`;
});

await check('index.html が manifest と Service Worker を繋いでいる', async () => {
  const html = await fetch('../index.html').then((r) => r.text());
  truthy(/rel="manifest"/.test(html), 'manifest への link が無い');
  truthy(/theme-color/.test(html), 'theme-color が無い');
  truthy(/rel="icon"/.test(html), 'favicon が無い');
  const main = await fetch('../src/app/main.js').then((r) => r.text());
  truthy(/serviceWorker\.register\('\.\/sw\.js'\)/.test(main), 'sw.js の登録が無い');
  truthy(/location\.protocol\.startsWith\('http'\)/.test(main), 'file:// での例外処理が無い');
  return 'manifest link / theme-color / icon / sw 登録 すべてあり';
});

await check('参照パスがすべて相対（サブパス配信に耐える）', async () => {
  const bad = [];
  for (const f of ['../index.html', '../calibrate.html']) {
    const html = await fetch(f).then((r) => r.text());
    for (const m2 of html.matchAll(/(?:src|href)="(\/[^"]*)"/g)) bad.push(`${f} → ${m2[1]}`);
  }
  const m3 = await fetch('../manifest.webmanifest').then((r) => r.json());
  for (const icon of m3.icons) if (icon.src.startsWith('/')) bad.push(`manifest → ${icon.src}`);
  eq(bad.length, 0, `絶対パス: ${bad.join(', ')}`);
  return 'ルート絶対パスの参照なし';
});

/* -------------------------------------------------------------------- 出力 */

const pass = results.filter((r) => r.ok === true).length;
const fail = results.filter((r) => r.ok === false).length;
const skip = results.filter((r) => r.ok === null).length;

const lines = [];
let g = null;
for (const r of results) {
  if (r.group !== g) {
    g = r.group;
    lines.push('');
    lines.push('── ' + g);
  }
  const mark = r.ok === true ? 'PASS' : r.ok === false ? 'FAIL' : 'SKIP';
  lines.push(`  ${mark}  ${r.label}`);
  if (r.detail) lines.push(`        ${r.detail}`);
}
lines.push('');
lines.push(`RESULT pass=${pass} fail=${fail} skip=${skip}`);

document.getElementById('out').textContent = lines.join('\n').trim();
document.title = fail === 0 ? `OK ${pass}/${pass + fail}` : `FAIL ${fail}`;
