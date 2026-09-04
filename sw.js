/**
 * Service Worker。
 *
 * 目的は 2 つ。
 *   1. インストールできるアプリにする（デスクトップにアイコンを置いて、
 *      ブラウザの UI 無しで開けるようにする）
 *   2. 一度開いたあとはオフラインでも動くようにする
 *
 * 方針は「ネットワーク優先・キャッシュ退避」。
 * キャッシュ優先にすると、こちらを更新しても古い版が残り続けて
 * 「直したのに直らない」という最悪の事故になる。オンラインならつねに
 * 最新を取りに行き、取れなかったときだけキャッシュを返す。
 * 資産は 2MB ほどしかないので、この方式でも体感は変わらない。
 */

const VERSION = 'eft-gps-20260904-1004';

/** 最初に取り込んでおくもの。ここに無いものも、一度読めばキャッシュに入る。 */
const PRECACHE = [
  './',
  './index.html',
  './calibrate.html',
  './manifest.webmanifest',
  './data/mapdb.json',
  './data/poi.bin',
  './vendor/leaflet/leaflet.js',
  './vendor/leaflet/leaflet.css',
  './src/app/main.js',
  './src/app/map.js',
  './src/parse/index.js',
  './src/geo/index.js',
  './src/clock/index.js',
  './src/mapdb/index.js',
  './src/verify/index.js',
  './src/watch/index.js',
  './src/watch/idb.js',
  './src/app/tasks.js',
  './src/app/landmarks.js',
  './src/app/pins.js',
  './src/app/calibrate.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(VERSION);
      await Promise.all(PRECACHE.map((url) => cache.add(url).catch(() => {})));

      // タスクのデータはマップごとに分かれている。一覧を手で持つと
      // マップが増えたときに更新し忘れるので、mapdb から拾う。
      try {
        const db = await cache.match('./data/mapdb.json').then((r) => r && r.json());
        // 地図の SVG もここで入れる。入れないとインストール直後に
        // オフラインへ行ったとき、地図が 1 枚も出ない。
        const files = [
          ...(db?.maps || []).flatMap((m) => [m.taskFile, m.landmarkFile, m.svg]),
          db?.anyTaskFile,
        ].filter(Boolean);
        await Promise.all(files.map((f) => cache.add('./' + f).catch(() => {})));
      } catch {
        /* 取れなくても本体は動く。使うときに取りに行く */
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 外部は素通し（そもそも無い）

  event.respondWith(
    fetch(req)
      .then((res) => {
        // 正常に取れたものだけ控えておく
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(VERSION).then((cache) => cache.put(req, copy).catch(() => {}));
        }
        return res;
      })
      .catch(async () => {
        const hit = await caches.match(req);
        if (hit) return hit;
        // ナビゲーションだけは入口ページに退避させる
        if (req.mode === 'navigate') {
          const index = await caches.match('./index.html');
          if (index) return index;
        }
        return new Response('オフラインです', {
          status: 503,
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }),
  );
});
