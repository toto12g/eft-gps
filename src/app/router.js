/**
 * 画面の切り替え先を URL の # から読む。
 *
 *   #/map                 地図（既定）
 *   #/map?m=customs       地図を開いて、そのマップに切り替える
 *   #/builds              カスタムの一覧
 *   #/builds?cat=smg      種類で絞った一覧
 *   #/builds/m4a1         1 丁のカスタム
 *   #/items?q=電線        アイテムの用途
 *
 * # を使うのは、GitHub Pages のような置くだけのサーバで、どの URL を直接開いても
 * index.html が返るようにするため（/builds/m4a1 のような普通の道筋だと 404 になる）。
 * 地図の初期指定に使っている ?map= ?sample= は # の前なので、ここでは触らない。
 *
 * DOM には触らない。test/run.js から直接呼べる。
 */

export const ROUTES = ['map', 'builds', 'items'];

/**
 * @param {string} hash location.hash
 * @returns {{route:string, parts:string[], query:URLSearchParams}}
 */
export function parseHash(hash) {
  const raw = String(hash || '').replace(/^#\/?/, '');
  const at = raw.indexOf('?');
  const path = at < 0 ? raw : raw.slice(0, at);
  const qs = at < 0 ? '' : raw.slice(at + 1);
  const parts = path.split('/').filter(Boolean).map((p) => {
    try {
      return decodeURIComponent(p);
    } catch {
      return p; // 壊れた % を含む URL でも画面は出す
    }
  });
  const route = ROUTES.includes(parts[0]) ? parts[0] : 'map';
  return { route, parts: route === parts[0] ? parts.slice(1) : [], query: new URLSearchParams(qs) };
}

/**
 * parseHash の逆。空の値は URL に載せない。
 * @param {string} route
 * @param {string[]} [parts]
 * @param {Object<string, string|number|null|undefined>} [query]
 */
export function hashFor(route, parts = [], query = {}) {
  const path = [route, ...parts].map((p) => encodeURIComponent(p)).join('/');
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== null && v !== undefined && v !== '') qs.set(k, String(v));
  }
  const s = qs.toString();
  return `#/${path}${s ? `?${s}` : ''}`;
}
