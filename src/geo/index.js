/**
 * 姿勢とアフィン変換。DOM にも Leaflet にも依存しない純関数のみ。
 *
 * 座標系:
 *   ワールドは Unity 左手系。y が高さ。2D 表示に使うのは (x, z)。
 *   quaternion は (qx, qy, qz, qw) の順で、カメラ (視線) の回転。roll は常に 0。
 *   yaw は 0deg = ワールド +Z、+X 側へ増える (「+X 右 / +Z 上」に描いた図で時計回り)。
 *
 * 画像へのマッピングは 6 パラメータのフルアフィン 1 本で表す:
 *   px = a·wx + b·wz + c
 *   py = d·wx + e·wz + f
 * 回転・スケール・反転・せん断を 1 つの形で扱えるので、tarkov.dev のように
 * 「回転が 90/270 のときだけ +180」といった特殊ケースが要らない。
 *
 * @typedef {{a:number,b:number,c:number,d:number,e:number,f:number}} Affine
 * @typedef {{wx:number,wz:number,px:number,py:number,ref?:string}} CalibPoint
 */

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

/* ---------------------------------------------------------------- quaternion */

/** @param {number[]} q [qx,qy,qz,qw] */
export function quatNorm(q) {
  return Math.hypot(q[0], q[1], q[2], q[3]);
}

/**
 * quaternion で (0,0,1) を回した前方ベクトルを返す。
 * 方位も見上げ角もここから導く。
 * @param {number[]} q [qx,qy,qz,qw]
 * @returns {{x:number,y:number,z:number}}
 */
export function forwardVector(q) {
  const [x, y, z, w] = q;
  return {
    x: 2 * (x * z + w * y),
    y: 2 * (y * z - w * x),
    z: 1 - 2 * (x * x + y * y),
  };
}

/**
 * 方位を度で返す。0..360 に正規化。0deg = ワールド +Z、増える向きが +X 側。
 *
 * 前方ベクトルの水平成分の方位角として求める。
 *
 * 注意: TarkovMonitor と tarkovgps.com は
 *       atan2( 2(w·y + x·z), 1 − 2(y² + z²) ) を使っているが、これは
 *       「Y 軸まわりの回転量」であって前方の方位ではなく、見上げ角が
 *       つくと系統的にずれる。yaw=45° で pitch=30° なら 4.1°、
 *       pitch=60° なら 18.4° ずれる (実測サンプルでも、見下ろし 55° の
 *       1 枚で 15.6° の差が出た)。ここでは正しい方位を返す。
 *
 * @param {number[]} q [qx,qy,qz,qw]
 */
export function quatToYawDeg(q) {
  const f = forwardVector(q);
  const deg = Math.atan2(f.x, f.z) * DEG;
  return ((deg % 360) + 360) % 360;
}

/**
 * 見上げ角を度で返す (-90..90)。正が見下ろし。
 * @param {number[]} q [qx,qy,qz,qw]
 */
export function quatToPitchDeg(q) {
  const f = forwardVector(q);
  let s = -f.y;
  if (s > 1) s = 1;
  else if (s < -1) s = -1;
  return Math.asin(s) * DEG;
}

/**
 * 方位の確からしさ (0..1)。前方ベクトルの水平成分の長さ = cos(pitch)。
 * 真上・真下を向いていると方位が定義できないので、その検出に使う。
 * @param {number[]} q [qx,qy,qz,qw]
 */
export function headingStrength(q) {
  const f = forwardVector(q);
  return Math.hypot(f.x, f.z);
}

/**
 * ロールを度で返す。カメラ回転なら実測上つねに 0 になる。
 * 0 から離れる場合、そのファイル名は想定外の書式である可能性が高い。
 * @param {number[]} q [qx,qy,qz,qw]
 */
export function quatToRollDeg(q) {
  const [x, y, z, w] = q;
  return Math.atan2(2 * (w * z + x * y), 1 - 2 * (x * x + z * z)) * DEG;
}

/**
 * 2 点間の進行方位を度で返す。yaw と同じ規約 (0 = +Z, +X 側へ増える)。
 */
export function bearingDeg(x0, z0, x1, z1) {
  const deg = Math.atan2(x1 - x0, z1 - z0) * DEG;
  return ((deg % 360) + 360) % 360;
}

/** 2 つの角度の差を -180..180 で返す。 */
export function angleDiffDeg(a, b) {
  let d = ((a - b) % 360 + 540) % 360 - 180;
  return d;
}

/* ------------------------------------------------------------------- affine */

/** @param {Affine} t */
export function applyAffine(t, wx, wz) {
  return { px: t.a * wx + t.b * wz + t.c, py: t.d * wx + t.e * wz + t.f };
}

/**
 * 逆アフィン。行列式が 0 なら null。
 * @param {Affine} t
 * @returns {Affine|null}
 */
export function invertAffine(t) {
  const det = t.a * t.e - t.b * t.d;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  const ia = t.e / det;
  const ib = -t.b / det;
  const id = -t.d / det;
  const ie = t.a / det;
  return {
    a: ia,
    b: ib,
    c: -(ia * t.c + ib * t.f),
    d: id,
    e: ie,
    f: -(id * t.c + ie * t.f),
  };
}

/**
 * ワールド (x, z) を Leaflet の latLng に変換する。
 * この設計では CRS を「画像のピクセル座標そのもの」にしているので
 * lat = 画像 y、lng = 画像 x。CRS.Simple と恒等変換だけで済む。
 * @param {Affine} t
 * @returns {[number, number]}
 */
export function worldToLatLng(t, x, z) {
  const p = applyAffine(t, x, z);
  return [p.py, p.px];
}

/**
 * latLng (= 画像ピクセル) をワールド (x, z) に戻す。
 * @param {Affine} t
 */
export function latLngToWorld(t, lat, lng) {
  const inv = invertAffine(t);
  if (!inv) return null;
  const w = applyAffine(inv, lng, lat);
  return { x: w.px, z: w.py };
}

/**
 * yaw を画面上の回転角 (度・時計回り・0 が上) に変換する。
 *
 * 進行ベクトルを画像空間へ写してから角度を取るので、アフィンが
 * 回転・反転・せん断のどれを含んでいても正しい向きになる。
 *
 * @param {Affine} t
 * @param {number} yawDeg
 */
export function headingToScreenDeg(t, yawDeg) {
  const r = yawDeg * RAD;
  const wx = Math.sin(r);
  const wz = Math.cos(r);
  const dx = t.a * wx + t.b * wz;
  const dy = t.d * wx + t.e * wz;
  const deg = Math.atan2(dx, -dy) * DEG;
  return ((deg % 360) + 360) % 360;
}

/* ---------------------------------------------------------------- 最小二乗 */

/** 3x3 の連立方程式をガウス消去で解く。特異なら null。 */
export function solve3(M, r) {
  const a = [
    [M[0][0], M[0][1], M[0][2], r[0]],
    [M[1][0], M[1][1], M[1][2], r[1]],
    [M[2][0], M[2][1], M[2][2], r[2]],
  ];
  for (let i = 0; i < 3; i++) {
    let piv = i;
    for (let k = i + 1; k < 3; k++) {
      if (Math.abs(a[k][i]) > Math.abs(a[piv][i])) piv = k;
    }
    if (Math.abs(a[piv][i]) < 1e-12) return null;
    if (piv !== i) {
      const tmp = a[i];
      a[i] = a[piv];
      a[piv] = tmp;
    }
    for (let k = i + 1; k < 3; k++) {
      const f = a[k][i] / a[i][i];
      for (let j = i; j < 4; j++) a[k][j] -= f * a[i][j];
    }
  }
  const out = [0, 0, 0];
  for (let i = 2; i >= 0; i--) {
    let s = a[i][3];
    for (let j = i + 1; j < 3; j++) s -= a[i][j] * out[j];
    out[i] = s / a[i][i];
  }
  return out;
}

/**
 * 対応点からアフィンを求める。
 *   3 点以上 → 最小二乗でフルアフィン (6 自由度)
 *   2 点     → 相似変換 (回転 + 等方スケール + 平行移動)
 *
 * ゲームの +Z が北、画像の +Y が下向きなので、2 点の場合は既定で wz の符号を
 * 反転して「北が上の地図」に合わせる。鏡像で描かれた地図では mirror を立てる。
 *
 * @param {CalibPoint[]} points
 * @param {{mirror?: boolean}} [opts]
 * @returns {{affine: Affine, rms: number, n: number, residuals: number[]}|null}
 */
export function fitAffine(points, opts = {}) {
  if (!Array.isArray(points) || points.length < 2) return null;

  let affine = null;

  if (points.length === 2) {
    const m = opts.mirror ? 1 : -1;
    const [p1, p2] = points;
    const du = p2.wx - p1.wx;
    const dv = m * (p2.wz - p1.wz);
    const den = du * du + dv * dv;
    if (den < 1e-9) return null;

    const dpx = p2.px - p1.px;
    const dpy = p2.py - p1.py;
    const sa = (dpx * du + dpy * dv) / den;
    const sb = (dpy * du - dpx * dv) / den;

    const a = sa;
    const b = -sb * m;
    const d = sb;
    const e = sa * m;
    affine = {
      a,
      b,
      c: p1.px - (a * p1.wx + b * p1.wz),
      d,
      e,
      f: p1.py - (d * p1.wx + e * p1.wz),
    };
  } else {
    const M = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
    const rx = [0, 0, 0];
    const ry = [0, 0, 0];
    for (const p of points) {
      const row = [p.wx, p.wz, 1];
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) M[i][j] += row[i] * row[j];
        rx[i] += row[i] * p.px;
        ry[i] += row[i] * p.py;
      }
    }
    const sx = solve3(M, rx);
    const sy = solve3(M, ry);
    if (!sx || !sy) return null;
    affine = { a: sx[0], b: sx[1], c: sx[2], d: sy[0], e: sy[1], f: sy[2] };
  }

  const residuals = points.map((p) => {
    const q = applyAffine(affine, p.wx, p.wz);
    return Math.hypot(q.px - p.px, q.py - p.py);
  });
  const rms = Math.sqrt(residuals.reduce((s, r) => s + r * r, 0) / residuals.length);

  return { affine, rms, n: points.length, residuals };
}
