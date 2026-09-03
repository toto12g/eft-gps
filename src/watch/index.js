/**
 * スクリーンショットフォルダの監視 (File System Access API)。
 *
 * ここが安全域の境界そのものなので、守っている約束をコードにも書いておく:
 *
 *   - 読むのは **ファイル名** と `File.lastModified` (メタデータ) だけ。
 *     File オブジェクトは遅延ハンドルなので、arrayBuffer() / text() /
 *     createImageBitmap() を呼ばないかぎり画像のバイトは 1 バイトも読まれない。
 *     このファイルにはそれらの呼び出しが存在しない。
 *   - ゲームフォルダや Logs には触れない。ユーザーが明示的に選んだ 1 フォルダのみ。
 *   - ファイルの作成・削除・変更はしない。読み取り専用 (mode: 'read') で開く。
 *   - 何も外部に送信しない。
 *
 * FSA には変更通知が無いのでポーリングする。dirHandle.keys() は名前だけを返すので
 * いちばん安い。
 */

import { idbGet, idbSet, idbDel } from './idb.js';

const HANDLE_KEY = 'screenshotDir';

export const WATCH = {
  UNSUPPORTED: 'unsupported',
  IDLE: 'idle',
  NEED_PERMISSION: 'need-permission',
  WATCHING: 'watching',
  ERROR: 'error',
};

/** このブラウザで監視できるか (Chromium 系デスクトップのみ)。 */
export function isSupported() {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

const IMAGE_RE = /\.(png|jpe?g|bmp)$/i;

export class ScreenshotWatcher {
  /**
   * @param {{intervalMs?:number}} [opts]
   */
  constructor(opts = {}) {
    this.intervalMs = opts.intervalMs ?? 1000;
    this.dir = null;
    this.status = isSupported() ? WATCH.IDLE : WATCH.UNSUPPORTED;
    this.timer = null;
    this.polling = false;
    /** この時刻までは間隔を詰める（新着が続いている間） */
    this.busyUntil = 0;
    /**
     * 前回のポーリングで見えていたファイル名。差分が新着になる。
     * 「初めて見た時刻」を持って古いものを捨てる方式にすると、まだフォルダに
     * 残っているファイルを期限切れで忘れて再発火してしまう。この集合は
     * フォルダ内のファイル数で自然に頭打ちになり、削除も自動で反映される。
     * @type {Set<string>}
     */
    this.known = new Set();

    /** @type {(info:{name:string, lastModified:number|null}) => void} */
    this.onNew = () => {};
    /** @type {(status:string, detail?:string) => void} */
    this.onStatus = () => {};
    /** @type {(err:Error) => void} */
    this.onError = () => {};
  }

  get folderName() {
    return this.dir ? this.dir.name : null;
  }

  setStatus(status, detail) {
    this.status = status;
    this.onStatus(status, detail);
  }

  /**
   * 前回選んだフォルダを復元する。権限が残っていれば監視まで始める。
   * 権限が prompt に戻っていた場合は NEED_PERMISSION を返す
   * (requestPermission はユーザー操作が要るので、ボタンを 1 つ出すこと)。
   */
  async restore() {
    if (!isSupported()) return this.setStatus(WATCH.UNSUPPORTED);
    const handle = await idbGet(HANDLE_KEY);
    if (!handle) return this.setStatus(WATCH.IDLE);

    this.dir = handle;
    const perm = await this.queryPermission();
    if (perm === 'granted') return this.start();
    this.setStatus(WATCH.NEED_PERMISSION, handle.name);
  }

  /** フォルダを選び直す。ユーザー操作から呼ぶこと。 */
  async pick() {
    if (!isSupported()) return this.setStatus(WATCH.UNSUPPORTED);
    try {
      const handle = await window.showDirectoryPicker({
        id: 'eft-screenshots',
        mode: 'read',
        startIn: 'documents',
      });
      this.dir = handle;
      await idbSet(HANDLE_KEY, handle);
      this.known.clear();
      await this.start();
    } catch (err) {
      if (err && err.name === 'AbortError') return; // ユーザーがキャンセルしただけ
      this.fail(err);
    }
  }

  /** 保存済みハンドルの権限をユーザー操作で取り直す。 */
  async requestPermission() {
    if (!this.dir) return this.setStatus(WATCH.IDLE);
    try {
      const res = await this.dir.requestPermission({ mode: 'read' });
      if (res === 'granted') return this.start();
      this.setStatus(WATCH.NEED_PERMISSION, this.dir.name);
    } catch (err) {
      this.fail(err);
    }
  }

  async queryPermission() {
    try {
      return await this.dir.queryPermission({ mode: 'read' });
    } catch {
      return 'denied';
    }
  }

  /** 監視を始める。開始時点で既にあるファイルは「既読」にして、履歴を再生しない。 */
  async start() {
    if (!this.dir) return this.setStatus(WATCH.IDLE);
    this.stop();

    try {
      this.known = await this.listNames();
    } catch (err) {
      return this.fail(err);
    }

    this.schedule();
    this.setStatus(WATCH.WATCHING, this.dir.name);
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * 次のポーリングを予約する。
   * スクリーンショットを消さない人のフォルダは数千件まで育つので、
   * 件数に応じて間隔を伸ばす。新着が続く間は 1 秒に戻す。
   */
  schedule() {
    if (this.timer) clearTimeout(this.timer);
    const n = this.known.size;
    const base = n > 3000 ? 4000 : n > 1000 ? 2000 : this.intervalMs;
    const wait = this.busyUntil && Date.now() < this.busyUntil ? this.intervalMs : base;
    this.timer = setTimeout(async () => {
      await this.poll();
      if (this.dir) this.schedule();
    }, wait);
  }

  /** フォルダ内の画像ファイル名の集合。名前だけを読む。 */
  async listNames() {
    const names = new Set();
    for await (const name of this.dir.keys()) {
      if (IMAGE_RE.test(name)) names.add(name);
    }
    return names;
  }

  /** 監視をやめて、保存したハンドルも捨てる。 */
  async forget() {
    this.stop();
    this.dir = null;
    this.known.clear();
    await idbDel(HANDLE_KEY);
    this.setStatus(WATCH.IDLE);
  }

  async poll() {
    if (this.polling || !this.dir) return;
    this.polling = true;
    try {
      const current = await this.listNames();
      const fresh = [];
      for (const name of current) {
        if (!this.known.has(name)) fresh.push(name);
      }
      this.known = current; // 消えたファイルもここで自動的に落ちる
      // 新着が続く間は間隔を詰める
      if (fresh.length) this.busyUntil = Date.now() + 30000;
      // 同時に複数出てきたら名前順 (= 時刻順) に流す
      fresh.sort();
      for (const name of fresh) {
        this.onNew({ name, lastModified: await this.lastModified(name) });
      }
    } catch (err) {
      // 権限を剥がされた / フォルダが消えた
      this.stop();
      this.fail(err);
    } finally {
      this.polling = false;
    }
  }

  /**
   * ファイルの更新時刻だけを取る。
   * getFile() が返す File は遅延ハンドルで、ここではバイトを読まない。
   * @returns {Promise<number|null>}
   */
  async lastModified(name) {
    try {
      const fh = await this.dir.getFileHandle(name);
      const file = await fh.getFile();
      return file.lastModified;
    } catch {
      return null;
    }
  }

  /**
   * 過去のスクリーンショットを新しい順に読む (明示的な操作でのみ呼ぶ)。
   * 全ファイルに getFile() をかけないよう、まず名前の日時で絞ってから
   * 上位 limit 件だけメタデータを取る。
   * @param {number} limit
   * @returns {Promise<{name:string,lastModified:number|null}[]>}
   */
  async listRecent(limit = 20) {
    if (!this.dir) return [];
    const names = [];
    for await (const name of this.dir.keys()) {
      if (IMAGE_RE.test(name)) names.push(name);
    }
    names.sort().reverse(); // ファイル名の先頭が YYYY-MM-DD[HH-mm] なので名前順 = 時刻順
    const picked = names.slice(0, limit);
    const out = [];
    for (const name of picked) {
      out.push({ name, lastModified: await this.lastModified(name) });
      this.known.add(name);
    }
    return out.reverse(); // 古い順に返す (軌跡がつながるように)
  }

  fail(err) {
    this.setStatus(WATCH.ERROR, err && err.message ? err.message : String(err));
    this.onError(err);
  }
}
