/**
 * 同梱データ (data/mapdb.json + data/poi.bin) の読み込みとアクセサ。
 *
 * poi.bin は Int16 の (x, y, z) 三つ組をデシメートル単位で連結したもの。
 * 1 点 6 バイト、全 13 マップで約 113KB。実行時に tarkov.dev は叩かない。
 *
 * 最近傍距離は素の総当たりで求める。全マップ合計でも 19,295 点しかなく、
 * 1 サンプルあたり数十マイクロ秒で終わるので空間インデックスは要らない。
 */

/**
 * @typedef {Object} MapEntry
 * @property {string} key
 * @property {string|null} name
 * @property {{normalizedName:string,nameId:string,scenePath:string}[]} scenes
 * @property {number} poiOffset
 * @property {number} poiCount
 * @property {Int16Array} poi          デシメートル単位の (x,y,z) 三つ組
 * @property {{x:number[],y:number[],z:number[]}} bbox
 * @property {Object[]} extracts
 * @property {import('../geo/index.js').Affine|null} affine
 * @property {number|null} rms
 * @property {Object|null} tarkovDev
 */

/**
 * @param {string} [baseUrl]
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{version:number, maps:MapEntry[], byKey:Map<string,MapEntry>}>}
 */
export async function loadMapDb(baseUrl = './data/', fetchImpl = fetch) {
  // cache: 'no-cache' で毎回サーバに確認しに行く（中身が同じなら 304 で軽い）。
  // GitHub Pages は Cache-Control: max-age=600 を返すため、これが無いと
  // 10 分間ブラウザが古いデータを使い続け、新しいコードと組み合わさって
  // 「一覧が空になる」ような食い違いが起きる。
  const opts = { cache: 'no-cache' };
  const [meta, buf] = await Promise.all([
    fetchImpl(baseUrl + 'mapdb.json', opts).then((r) => {
      if (!r.ok) throw new Error(`mapdb.json: ${r.status}`);
      return r.json();
    }),
    fetchImpl(baseUrl + 'poi.bin', opts).then((r) => {
      if (!r.ok) throw new Error(`poi.bin: ${r.status}`);
      return r.arrayBuffer();
    }),
  ]);

  const all = new Int16Array(buf);
  if (all.length !== meta.poiTotal * 3) {
    throw new Error(`poi.bin のサイズが mapdb.json と一致しません: ${all.length / 3} != ${meta.poiTotal}`);
  }

  const maps = meta.maps.map((m) => ({
    ...m,
    poi: all.subarray(m.poiOffset * 3, (m.poiOffset + m.poiCount) * 3),
  }));

  // ファイルの中身をそのまま通す。項目を 1 つずつ書き写していたころ、
  // svgFiles と anyTaskFile を書き忘れて UI が空になる事故を 2 回起こした。
  // 新しい項目を足しても自動的に利用側へ届くようにしておく。
  return {
    ...meta,
    builtAt: meta.builtAt || null,
    svgFiles: meta.svgFiles || [],
    anyTaskFile: meta.anyTaskFile || null,
    anyTaskCount: meta.anyTaskCount || 0,
    maps,
    byKey: new Map(maps.map((m) => [m.key, m])),
  };
}

/**
 * そのマップの POI 点群への最短距離 (m)。3 次元で測る。
 * y を含めるのは、ハイドアウトのように平面上は近くても高さが違う点を
 * 分離できるようにするため。
 *
 * @param {MapEntry} map
 * @returns {number}
 */
export function nearestPoiDistance(map, x, y, z) {
  const p = map.poi;
  const n = p.length;
  // 比較は 2 乗のまま行い、平方根は最後に 1 回だけ取る
  const X = x * 10;
  const Y = y * 10;
  const Z = z * 10;
  let best = Infinity;
  for (let i = 0; i < n; i += 3) {
    const dx = p[i] - X;
    const dy = p[i + 1] - Y;
    const dz = p[i + 2] - Z;
    const d = dx * dx + dy * dy + dz * dz;
    if (d < best) best = d;
  }
  return Math.sqrt(best) / 10;
}

/**
 * 全マップを最近傍距離の昇順で返す。
 * @param {{maps:MapEntry[]}} db
 * @returns {{key:string, d:number}[]}
 */
export function rankMaps(db, x, y, z) {
  return db.maps
    .map((m) => ({ key: m.key, d: nearestPoiDistance(m, x, y, z) }))
    .sort((a, b) => a.d - b.d);
}

/** ワールド座標がそのマップの bbox に入っているか (粗いフィルタ)。 */
export function inBbox(map, x, y, z, margin = 0) {
  const b = map.bbox;
  return (
    x >= b.x[0] - margin && x <= b.x[1] + margin &&
    y >= b.y[0] - margin && y <= b.y[1] + margin &&
    z >= b.z[0] - margin && z <= b.z[1] + margin
  );
}
