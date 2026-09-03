/**
 * FileSystemDirectoryHandle を置いておくためだけの、最小の IndexedDB ラッパ。
 *
 * ハンドルは structured clone 可能なので IndexedDB に保存できる。localStorage には
 * 入らない。保存されるのは「どのフォルダを選んだか」だけで、ファイルの中身も
 * ファイル名も保存しない。
 */

const DB_NAME = 'eft-gps';
const DB_VERSION = 1;
const STORE = 'kv';

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        t.oncomplete = () => resolve(req ? req.result : undefined);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}

export function idbGet(key) {
  return tx('readonly', (s) => s.get(key)).catch(() => undefined);
}

export function idbSet(key, value) {
  return tx('readwrite', (s) => s.put(value, key)).catch(() => undefined);
}

export function idbDel(key) {
  return tx('readwrite', (s) => s.delete(key)).catch(() => undefined);
}
