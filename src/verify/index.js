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

import { rankMaps } from '../mapdb/index.js';
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
};

/**
 * 直近のサンプルを覚えて、マップを累積で判定する。
 * 1 枚ごとの判定より圧倒的に安定する (上のコメント参照)。
 */
export class MapTracker {
  /**
   * @param {{windowSize?:number, gapResetMs?:number}} [opts]
   */
  constructor(opts = {}) {
    this.windowSize = opts.windowSize ?? 12;
    /** これ以上間が空いたら別のレイドとみなして忘れる */
    this.gapResetMs = opts.gapResetMs ?? 10 * 60 * 1000;
    /** @type {{at:number, ranking:{key:string,d:number}[]}[]} */
    this.window = [];
    this.lastAt = null;
  }

  reset() {
    this.window = [];
    this.lastAt = null;
  }

  get count() {
    return this.window.length;
  }

  /**
   * サンプルを 1 枚足す。時刻が大きく飛んでいたら窓を捨てる。
   * @param {{x:number,y:number,z:number}} sample
   * @param {{maps:Object[]}} db
   * @param {number|null} [atMs]
   */
  add(sample, db, atMs = null) {
    const at = atMs ?? Date.now();
    if (this.lastAt !== null && Math.abs(at - this.lastAt) > this.gapResetMs) this.reset();
    this.lastAt = at;
    this.window.push({ at, ranking: rankMaps(db, sample.x, sample.y, sample.z) });
    if (this.window.length > this.windowSize) this.window.shift();
    return this.scores();
  }

  /** マップごとの平均最近傍距離を昇順で返す。 */
  scores() {
    const sum = new Map();
    for (const entry of this.window) {
      for (const r of entry.ranking) sum.set(r.key, (sum.get(r.key) || 0) + r.d);
    }
    const n = this.window.length || 1;
    return [...sum]
      .map(([key, s]) => ({ key, mean: s / n }))
      .sort((a, b) => a.mean - b.mean);
  }

  /**
   * 累積での判断。枚数が足りなければ null。
   * @returns {{best:string, mean:number, second:string|null, ratio:number, n:number}|null}
   */
  consensus() {
    if (this.window.length === 0) return null;
    const s = this.scores();
    if (s.length === 0) return null;
    const ratio = s.length > 1 && s[0].mean > 0 ? s[1].mean / s[0].mean : Infinity;
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
  if (clockAgrees) {
    return {
      ...base,
      verdict: VERDICT.ACCEPT,
      reason: `ゲーム内時計が一致 (差 ${(clock.diff * 60).toFixed(1)}分)`,
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
