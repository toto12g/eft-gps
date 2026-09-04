/**
 * サンプル検証器。
 *
 * マップを手動選択にした以上、選択ミスを黙って通さないのがこの層の仕事。
 * 「間違ったマップを選べばマーカーがマップ外に飛ぶから気づける」は成立しない。
 * 実測: Streets の座標 (203.07, 402.38) を 13 マップの変換に通すと、5 マップで
 * マップ内のもっともらしい場所に着地する。
 *
 * 独立した 3 つの信号を組み合わせる:
 *   S1 鮮度      File.lastModified          いま撮ったものか
 *   S2 時計整合  gameTime vs lastModified   レイド中なら一致。ハイドアウトはずれる
 *   S3 座標整合  POI 点群への最近傍         どのマップか
 *
 * ★ マップの判定は 1 枚では決めない。
 *   Customs のレイド 16 枚を実測したところ、単発の最近傍では 2 枚で別マップ
 *   (woods 5.40m など) が 1 位になった。ロード類の POI から離れた開けた場所では
 *   最寄り距離が 20〜28m まで伸び、2位/1位 も 1.3 倍程度まで縮むため。
 *   直近数枚の平均距離で見ると 16 枚すべてで customs が 1 位になり、
 *   窓を広げるほど分離が上がる (N=8 で 1.9 倍、N=16 で 4.2 倍)。
 *   そのため MapTracker で累積してから判断する。
 */

import { rankMaps, inBbox } from '../mapdb/index.js';
import { checkGameClock } from '../clock/index.js';

export const VERDICT = {
  /** 選択中のマップと一致。確信して描画してよい */
  ACCEPT: 'accept',
  /** 別のマップの座標に見える。切り替えを促す */
  WRONG_MAP: 'wrong-map',
  /** どのマップからも等距離 = 原点付近。ハイドアウト等。黙って無視する */
  NOT_IN_RAID: 'not-in-raid',
  /** 描画はするが確信がない。マーカーを破線にする */
  LOW_CONFIDENCE: 'accept-low-confidence',
};

/**
 * 閾値。実測 19 枚 (Streets 2 / ハイドアウト 1 / Customs 16) から決めている。
 *
 *   Streets の 2 枚      d1 0.65〜1.50m  比 30      → 単発でも確定できる
 *   Customs の 16 枚     d1 2.0〜27.9m   比 1.3〜44 → 単発では決められない
 *   ハイドアウト         d1 4.72m        比 1.39    → 時計が 3.79h ずれる
 */
export const DEFAULT_THRESHOLDS = {
  /** 単発で「そのマップ上にいる」と断定できる最近傍距離 (m) */
  nearM: 5,
  /** 単発で断定できる 2位/1位 の比 */
  ratio: 5,
  /** これを下回ると「どのマップからも等距離」= レイド外の候補 */
  ambiguousRatio: 2,
  /** 累積判定に必要な枚数 */
  trackerMinSamples: 3,
  /** 累積判定で切り替えを提案する比 */
  trackerRatio: 1.5,
  /** ゲーム内時計の許容差 (時間) */
  clockToleranceH: 0.02,
  /**
   * 選択中のマップの bbox からこれだけ外なら、そのマップの座標ではない (m)。
   * MapTracker の bbox 判定と同じ値。
   */
  bboxMargin: 40,
};

/**
 * そのレイドのサンプルを覚えて、マップを累積で判定する。
 *
 * ★ 窓でスライドさせてはいけない。
 *   Woods のレイド 22 枚で実際に起きた不具合: 1 枚目は 2位/1位 = 154 という
 *   決定的な証拠だったのに、直近 12 枚の窓がそこを通り過ぎると、
 *   ロードの少ない区間で Interchange が 1 位になり、地図が勝手に移った。
 *   レイド開始から全部を貯めれば、実測 3 レイド 38 枚すべてで誤りは 0 になる。
 *
 * ★ 距離はそのまま比べてはいけない。
 *   POI の密度がマップごとに 7 倍以上違う（Woods 771 点/km² に対し
 *   Reserve 5814 点/km²）。同じ 20m でも意味がまったく違うので、
 *   そのマップの「点の間隔」で割ってから比べる。
 *
 * ★ それでもマップの移動には追随する。
 *   トランジットで移った場合に備え、直近の数枚だけで見ても別マップが
 *   決定的なら、貯めたものを捨てて数え直す。
 */
export class MapTracker {
  /**
   * @param {{maxSamples?:number, gapResetMs?:number, switchWindow?:number, switchRatio?:number, bboxMargin?:number}} [opts]
   */
  constructor(opts = {}) {
    /** 1 レイドで貯める上限。これ以上は古いものから捨てる */
    this.maxSamples = opts.maxSamples ?? 400;
    /** これ以上間が空いたら別のレイドとみなして忘れる */
    this.gapResetMs = opts.gapResetMs ?? 10 * 60 * 1000;
    /** 移動を判定するのに見る直近の枚数 */
    this.switchWindow = opts.switchWindow ?? 4;
    /** 移動と認めるのに必要な、直近だけで見たときの比 */
    this.switchRatio = opts.switchRatio ?? 6;
    /** bbox 判定の余裕 (m) */
    this.bboxMargin = opts.bboxMargin ?? 40;
    /** bbox に収まっている必要があるサンプルの割合 */
    this.bboxFitRatio = opts.bboxFitRatio ?? 0.95;
    /**
     * レイド外（ハイドアウト・メニュー）を続けて何枚見たら、
     * レイドが終わったとみなすか。
     */
    this.outOfRaidToEnd = opts.outOfRaidToEnd ?? 2;
    /** レイド外を連続で見た枚数 */
    this.outOfRaidRun = 0;
    /** 直前の add で別レイドと判断した理由（表示に使う） */
    this.brokeAt = null;

    /** @type {{at:number, x:number, y:number, z:number, ranking:{key:string,d:number}[]}[]} */
    this.window = [];
    this.lastAt = null;
    this.db = null;
  }

  reset() {
    this.window = [];
    this.lastAt = null;
    this.brokeAt = null;
    this.outOfRaidRun = 0;
  }

  /**
   * レイド外（ハイドアウト・メニュー）のサンプルを見たことを伝える。
   *
   * 続けて何枚か見たら、レイドは終わったとみなして累積を捨てる。
   * 1 枚で切らないのは、レイド中でも POI から離れた開けた場所では
   * 「どのマップからも等距離」に見えることがあるため。
   *
   * 速さでレイドの切れ目を見つける案は、実測して捨てた。実レイド 3 本
   * 54 枚での最大移動速度は 4.6 m/s（276m / 60s）で人の速さの範囲だが、
   * レイドを続けて回るときの間隔（待機 + 読み込みで数分）では
   * 「大きく飛んだ」ようには見えない。速さでは切れ目が出ない。
   * なお同じマップを続けて回るぶんには累積しても答えは変わらないので、
   * 実害が出るのはマップが変わるときだけで、そこは移動判定が拾う。
   */
  noteOutOfRaid() {
    this.outOfRaidRun += 1;
    if (this.outOfRaidRun >= this.outOfRaidToEnd) {
      this.reset();
      this.brokeAt = 'out-of-raid';
      return true;
    }
    return false;
  }

  /**
   * 直前に足した 1 枚を取り消す。
   * レイド外（ハイドアウト・メニュー）と判定されたサンプルを累積に残すと、
   * 原点付近の座標が bbox 足切りを狂わせ、正解マップを候補から消してしまう。
   */
  undoLast() {
    this.window.pop();
    if (this.window.length === 0) this.lastAt = null;
  }

  get count() {
    return this.window.length;
  }

  /**
   * サンプルを 1 枚足す。
   * @param {{x:number,y:number,z:number}} sample
   * @param {{maps:Object[]}} db
   * @param {number|null} [atMs]
   */
  add(sample, db, atMs = null) {
    const at = atMs ?? Date.now();
    this.db = db;

    // 時間が飛んだ = 別のレイド
    this.brokeAt = null;
    if (this.lastAt !== null && Math.abs(at - this.lastAt) > this.gapResetMs) {
      this.reset();
      this.brokeAt = 'gap';
    }

    this.lastAt = at;
    this.outOfRaidRun = 0;

    const entry = {
      at,
      x: sample.x,
      y: sample.y,
      z: sample.z,
      ranking: rankMaps(db, sample.x, sample.y, sample.z),
    };
    this.window.push(entry);
    if (this.window.length > this.maxSamples) this.window.shift();

    // トランジットなどでマップが変わったなら、貯めたものを捨てる
    if (this.window.length > this.switchWindow) {
      const recent = this.window.slice(-this.switchWindow);
      const now = this.rank(this.window);
      const late = this.rank(recent);
      if (
        late.length > 1 &&
        late[0].key !== now[0].key &&
        late[0].score > 0 &&
        late[1].score / late[0].score >= this.switchRatio
      ) {
        this.window = recent;
      }
    }
    return this.scores();
  }

  /** そのマップの「点の間隔」。密度の違いを吸収するのに使う。 */
  spacingOf(map) {
    const b = map.bbox;
    const area = Math.max(1, (b.x[1] - b.x[0]) * (b.z[1] - b.z[0]));
    return Math.sqrt(area / Math.max(1, map.poiCount));
  }

  /** 与えたサンプル群を、そのマップらしさの順に並べる。 */
  rank(entries) {
    if (!this.db || entries.length === 0) return [];

    // 軌跡を収められないマップは候補から外す。
    // 全部が収まることを求める（every）と、レイド外の 1 枚が混ざっただけで
    // 正解マップが候補から丸ごと消える。95% でよいことにして、
    // 外れ値 1 枚に全体を壊されないようにする。
    const need = Math.ceil(entries.length * this.bboxFitRatio);
    const fits = this.db.maps.filter((m) => {
      const b = m.bbox;
      const g = this.bboxMargin;
      let inside = 0;
      for (const e of entries) {
        if (
          e.x >= b.x[0] - g && e.x <= b.x[1] + g &&
          e.z >= b.z[0] - g && e.z <= b.z[1] + g &&
          e.y >= b.y[0] - g && e.y <= b.y[1] + g
        ) inside++;
      }
      return inside >= need;
    });
    // 1 つも残らないなら足切りしない（誤って正解を消さないため）
    const candidates = fits.length ? fits : this.db.maps;

    const sum = new Map();
    for (const e of entries) {
      for (const r of e.ranking) sum.set(r.key, (sum.get(r.key) || 0) + r.d);
    }
    const out = [];
    for (const m of candidates) {
      const total = sum.get(m.key);
      if (total === undefined) continue;
      const mean = total / entries.length;
      out.push({ key: m.key, mean, score: mean / this.spacingOf(m) });
    }
    return out.sort((a, b) => a.score - b.score);
  }

  /** マップごとの成績を昇順で返す。 */
  scores() {
    return this.rank(this.window);
  }

  /**
   * 累積での判断。枚数が足りなければ null。
   * @returns {{best:string, mean:number, second:string|null, ratio:number, n:number}|null}
   */
  consensus() {
    const s = this.scores();
    if (s.length === 0) return null;
    const ratio = s.length > 1 && s[0].score > 0 ? s[1].score / s[0].score : Infinity;
    return {
      best: s[0].key,
      mean: s[0].mean,
      second: s.length > 1 ? s[1].key : null,
      ratio,
      n: this.window.length,
    };
  }
}

/**
 * @typedef {Object} Verdict
 * @property {string} verdict
 * @property {string} best               1 枚だけで見たときの最寄りマップ
 * @property {number} d1
 * @property {string|null} second
 * @property {number} d2
 * @property {number} ratio
 * @property {{best:string,mean:number,ratio:number,n:number}|null} consensus
 * @property {string} suggest            切り替え先 (WRONG_MAP のとき)
 * @property {{agrees:boolean,expected:number,diff:number,side:string}|null} clock
 * @property {string} reason
 * @property {{key:string,d:number}[]} ranking
 */

/**
 * @param {Object} args
 * @param {import('../parse/index.js').Sample} args.sample
 * @param {string} args.selectedKey
 * @param {{maps:Object[]}} args.db
 * @param {number|null} [args.fileModifiedMs]
 * @param {MapTracker|null} [args.tracker] 渡すと累積判定を使う
 * @param {Object} [args.thresholds]
 * @returns {Verdict}
 */
export function validateSample({
  sample,
  selectedKey,
  db,
  fileModifiedMs = null,
  tracker = null,
  thresholds,
}) {
  const th = { ...DEFAULT_THRESHOLDS, ...(thresholds || {}) };

  const ranking = rankMaps(db, sample.x, sample.y, sample.z);
  const d1 = ranking.length > 0 ? ranking[0].d : Infinity;
  const d2 = ranking.length > 1 ? ranking[1].d : Infinity;
  const best = ranking.length > 0 ? ranking[0].key : null;
  const second = ranking.length > 1 ? ranking[1].key : null;
  const ratio = d1 > 0 ? d2 / d1 : Infinity;

  const clock =
    fileModifiedMs !== null && sample.gameTime !== null && sample.gameTime !== undefined
      ? checkGameClock(sample.gameTime, fileModifiedMs, th.clockToleranceH)
      : null;
  const clockAgrees = clock !== null && clock.agrees;

  const consensus = tracker ? tracker.consensus() : null;
  const consensusUsable =
    consensus !== null && consensus.n >= th.trackerMinSamples && consensus.ratio >= th.trackerRatio;

  const base = { best, d1, second, d2, ratio, clock, consensus, ranking, suggest: best };

  // C: どのマップからも等距離 = 原点付近。ハイドアウトやメニュー。
  //    時計が合っていればレイド中と分かるし、累積で行き先が定まっていれば
  //    そちらを信じる。両方とも無いときだけ捨てる。
  if (ratio < th.ambiguousRatio && !clockAgrees && !consensusUsable) {
    return {
      ...base,
      verdict: VERDICT.NOT_IN_RAID,
      reason: `どのマップからも等距離 (2位/1位 = ${ratio.toFixed(2)} < ${th.ambiguousRatio})`,
    };
  }

  // B1: 累積で別マップに定まっている。これがマップ切り替えの主な根拠。
  if (consensusUsable && consensus.best !== selectedKey) {
    return {
      ...base,
      suggest: consensus.best,
      verdict: VERDICT.WRONG_MAP,
      // 複数枚の平均が根拠。1 枚の偶然では動かないので、そのまま切り替えてよい
      via: 'consensus',
      reason:
        `直近 ${consensus.n} 枚の平均で ${consensus.best} (${consensus.mean.toFixed(1)}m, ` +
        `2位/1位 = ${consensus.ratio.toFixed(2)})`,
    };
  }

  // B2: 1 枚だけでも決定的に別マップ (Streets の実測で比 30 のような場合)
  if (d1 < th.nearM && ratio > th.ratio && best !== selectedKey && !consensusUsable) {
    return {
      ...base,
      verdict: VERDICT.WRONG_MAP,
      // 1 枚だけが根拠。マップ同士の座標系は重なっているので、
      // これだけで切り替えると誤爆する（実測でレイドの 3.8%）
      via: 'single',
      reason: `${best} の座標に見える (${d1.toFixed(2)}m, 2位/1位 = ${ratio.toFixed(1)})`,
    };
  }

  // A: 選択中のマップで説明がつく
  if (consensusUsable && consensus.best === selectedKey) {
    return {
      ...base,
      verdict: VERDICT.ACCEPT,
      reason: `直近 ${consensus.n} 枚の平均で ${selectedKey} (${consensus.mean.toFixed(1)}m)`,
    };
  }
  if (d1 < th.nearM && ratio > th.ratio) {
    return { ...base, verdict: VERDICT.ACCEPT, reason: `${best} に一致 (${d1.toFixed(2)}m)` };
  }
  // ゲーム内時計が言えるのは「レイド中である」ことだけで、
  // 「どのマップにいるか」ではない。時計はどのマップでも同じように合う。
  //
  // ここで座標を確かめずに ACCEPT していたため、選択中のマップの座標では
  // ない点がそのまま描かれていた。全 11 マップの格子で調べたところ、
  // 画像の外に現在地が描かれる経路はすべてこの分岐だった
  // （最大 987m 外）。レイド序盤の 2 枚（累積がまだ効かない）で起きる。
  if (clockAgrees) {
    const sel = db.maps.find((m) => m.key === selectedKey);
    if (sel && inBbox(sel, sample.x, sample.y, sample.z, th.bboxMargin)) {
      return {
        ...base,
        verdict: VERDICT.ACCEPT,
        reason: `ゲーム内時計が一致 (差 ${(clock.diff * 60).toFixed(1)}分)`,
      };
    }
    return {
      ...base,
      verdict: VERDICT.WRONG_MAP,
      via: 'single',
      reason:
        `レイド中だが ${selectedKey} の範囲外 ` +
        `(最寄り ${best} ${d1.toFixed(1)}m)`,
    };
  }

  return {
    ...base,
    verdict: VERDICT.LOW_CONFIDENCE,
    reason: `確信できない (最寄り ${best} ${d1.toFixed(2)}m, 2位/1位 = ${ratio.toFixed(2)})`,
  };
}

/** 描画してよい判定か。 */
export function isDrawable(verdict) {
  return verdict === VERDICT.ACCEPT || verdict === VERDICT.LOW_CONFIDENCE;
}
