/**
 * おすすめカスタムの計算。
 *
 * 銃は差し込み口の木になっている（レシーバーにハンドガードが付き、ハンドガードに
 * マウントが付き、マウントにフォアグリップが付く）。部品ごとの反動とエルゴは足し算
 * なので、差し込み口ごとに「その下まで含めていちばん良いもの」を選べば全体も最良になる。
 * 部品同士の相性（同時に付けられない組み合わせ）だけは木の外の制約なので、
 * 選んだあとで見つけたら片方を外して選び直す。
 *
 * ゲーム内の式（tarkov.dev の値をそのまま使う）:
 *   反動 = 銃の素の反動 × (1 + 部品の反動補正の合計 / 100)
 *   エルゴ = 銃の素のエルゴ + 部品のエルゴの合計（0〜100 に収まる）
 *
 * DOM には触らない。test/run.js から直接呼べる。
 */

let cache = null;

/**
 * @param {string|null} file mapdb の gunFile
 */
export async function loadGuns(file) {
  if (cache) return cache;
  if (!file) return { failed: 'データがありません' };
  try {
    // cache: 'no-cache' の理由は src/mapdb/index.js のコメントを参照
    const raw = await fetch('./' + file, { cache: 'no-cache' }).then((r) => {
      if (!r.ok) throw new Error(String(r.status));
      return r.json();
    });
    cache = decodeGuns(raw);
    return cache;
  } catch (err) {
    // 失敗はキャッシュしない（items.js と同じ理由）
    return { failed: String(err && err.message ? err.message : err) };
  }
}

/** 読み込んだ JSON を、引きやすい形にする。 */
export function decodeGuns(raw) {
  const mods = raw.mods.map((m, i) => ({ ...m, i, conf: new Set() }));
  // 上流の相性は片側にしか書かれていないことが多い（2000 件以上）。両側に揃える。
  // 自分自身を挙げている部品もあるが、同じ部品を 2 つ付けるのは別の話なので除く
  for (const m of mods) {
    for (const x of m.x || []) {
      if (x === m.i) continue;
      m.conf.add(x);
      mods[x].conf.add(m.i);
    }
  }
  const guns = raw.guns.map((g) => ({ ...g, defaults: new Set(g.d || []) }));
  return {
    builtAt: raw.builtAt,
    categories: raw.categories.map(([key, label, count]) => ({ key, label, count })),
    traders: raw.traders.map(([key, name]) => ({ key, name })),
    slotLabel: raw.slots,
    lists: raw.lists,
    mods,
    guns,
    bySlug: new Map(guns.map((g) => [g.slug, g])),
    byId: new Map(mods.map((m) => [m.id, m])),
  };
}

/** 条件の既定。トレーダーは全員 LL4、フリマあり、サプレッサーなし。 */
export const DEFAULT_COND = Object.freeze({ ll: 4, flea: true, suppressor: false });

/** エルゴの上限。超えたぶんは何の役にも立たない */
export const ERGO_CAP = 100;

/* ------------------------------------------------------------ 入手先 */

/**
 * その部品をどこで手に入れるか。条件の中でいちばん手軽なものを 1 つ返す。
 * 手に入らなければ null。
 *
 * 優先: 銃に最初から付いている > トレーダーで現金 > トレーダーと物々交換 > フリマ
 */
export function sourceOf(mod, cond, gun) {
  if (gun && gun.defaults.has(mod.i)) return { kind: 'stock' };
  const cash = (mod.b || []).filter(([, ll]) => ll <= cond.ll);
  if (cash.length) {
    // 低い LL で買えるほうを優先。同じなら安いほう
    const [t, ll, price, quest] = cash.slice().sort((x, y) => x[1] - y[1] || x[2] - y[2])[0];
    return { kind: 'trader', t, ll, price, quest: !!quest };
  }
  const barter = (mod.bt || []).filter(([, ll]) => ll <= cond.ll);
  if (barter.length) {
    const [t, ll, quest] = barter.slice().sort((x, y) => x[1] - y[1])[0];
    return { kind: 'barter', t, ll, quest: !!quest };
  }
  if (cond.flea && mod.fl !== undefined) return { kind: 'flea', level: mod.fl };
  return null;
}

/* ------------------------------------------------------------ 計算 */

// 第 2・第 3 の基準。第 1 の基準の差をひっくり返さない程度に小さくする。
// 反動の最小差は 0.05% ほど、エルゴの幅は最大 100 ほど → 1e-4 × 100 = 0.01 < 0.05
const SECONDARY = 1e-4;
// 同じ点なら軽いほうを選ぶ（重さはゲーム内でエルゴの実効値を下げる）
const LIGHTER = 1e-6;
const EPS = 1e-9;
const MAX_DEPTH = 14;
/** 相性の解決で解き直す回数の上限。実データでは多くて数百回で収まる */
const SEARCH_BUDGET = 800;

/** マガジンの差し込み口か。 */
const isMagSlot = (slotId) => slotId === 'mod_magazine';

/**
 * 銃と条件ごとに 1 回だけ作る下ごしらえ。
 *   ok      その部品を候補にしてよいか（入手先とサプレッサーの設定だけで決まる）
 *   parents 部品 → それを付けられる部品。候補を外したとき、計算し直す範囲を決めるのに使う
 *   memo    重み s ごとの答え。スライダーを往復しても計算し直さない
 */
const contexts = new WeakMap();
function contextFor(db, gun, cond) {
  const key = `${cond.ll}|${cond.flea ? 1 : 0}|${cond.suppressor ? 1 : 0}`;
  let byCond = contexts.get(gun);
  if (!byCond) contexts.set(gun, (byCond = new Map()));
  let ctx = byCond.get(key);
  if (ctx) return ctx;

  const ok = new Map();
  const parents = new Map();
  const stack = [];
  const link = (child, parent) => {
    let ps = parents.get(child);
    if (!ps) {
      parents.set(child, (ps = new Set()));
      stack.push(child);
    }
    if (parent !== null) ps.add(parent);
  };
  for (const [, , ref] of gun.sl) for (const i of db.lists[ref]) link(i, null);
  while (stack.length) {
    const i = stack.pop();
    const m = db.mods[i];
    // サプレッサーを外す設定でも、銃に最初から付いているもの（PB や VSK-94 の
    // 一体型など）は残す。外すと標準の状態より悪い答えになる
    ok.set(i, (cond.suppressor || !m.sup || gun.defaults.has(i)) && sourceOf(m, cond, gun) !== null);
    for (const [, , ref] of m.sl || []) for (const c of db.lists[ref]) link(c, i);
  }
  let magFloor = 0;
  for (const i of gun.defaults) magFloor = Math.max(magFloor, db.mods[i].cap || 0);

  ctx = { db, gun, cond, ok, parents, magFloor, memo: new Map() };
  byCond.set(key, ctx);
  return ctx;
}

/** 外した部品の祖先（答えが変わりうる部品）をすべて集める。 */
function dirtyFrom(ctx, drop) {
  const out = new Set();
  const stack = [...drop];
  while (stack.length) {
    const i = stack.pop();
    if (out.has(i)) continue;
    out.add(i);
    for (const p of ctx.parents.get(i) || []) stack.push(p);
  }
  return out;
}

/**
 * 1 回だけ解く。相性は見ない。
 *
 * base と dirty を渡すと、前に解いた答えのうち、外した部品に関係しない部分をそのまま使う。
 * 相性の探索では 1 回に 1〜数十個しか外さないので、解き直すのは祖先の数段だけで済む。
 *
 * @param {{a:number,b:number}} w 価値 = a·エルゴ − b·反動補正 − 軽さの小さな重み
 * @returns {{v:number, picks:Array, memo:Map}|null} 必須の口が埋まらなければ null
 */
function solveOnce(ctx, w, banned, base = null, dirty = null) {
  const { db, gun, ok, magFloor } = ctx;
  const memo = new Map(base || undefined);
  if (dirty) for (const i of dirty) memo.delete(i);
  const visiting = new Set();
  const own = (m) => w.a * (m.e || 0) - w.b * (m.r || 0) - LIGHTER * (m.w || 0);

  function bestMod(i, depth) {
    if (memo.has(i)) return memo.get(i);
    // 部品が自分自身の祖先に付く循環は、上流のデータでまれにある。そこで打ち切る
    if (visiting.has(i) || depth > MAX_DEPTH) return null;
    visiting.add(i);
    const m = db.mods[i];
    let v = own(m);
    const picks = [];
    let feasible = true;
    for (const [slotId, req, ref] of m.sl || []) {
      const r = bestSlot(slotId, req, ref, depth + 1);
      if (r === null) { feasible = false; break; }
      v += r.v;
      if (r.pick) picks.push(r.pick);
    }
    visiting.delete(i);
    const res = feasible ? { v, picks } : null;
    memo.set(i, res);
    return res;
  }

  function bestIn(slotId, ref, depth, floor) {
    let best = null;
    for (const i of db.lists[ref]) {
      if (!ok.get(i) || banned.has(i)) continue;
      if (floor && (db.mods[i].cap || 0) < floor) continue;
      const r = bestMod(i, depth);
      if (!r) continue;
      if (!best || r.v > best.v + EPS) {
        best = { v: r.v, pick: { slot: slotId, mod: i, children: r.picks } };
      }
    }
    return best;
  }

  function bestSlot(slotId, req, ref, depth) {
    if (isMagSlot(slotId)) {
      // マガジンは上流では「必須でない」が、無いと撃てない。必ず入れる。
      // 装弾数の少ないマガジンは軽くてエルゴが高いので、放っておくと
      // 10 発マガジンが選ばれる。標準と同じ装弾数以上に絞る
      const best = bestIn(slotId, ref, depth, magFloor) || bestIn(slotId, ref, depth, 0);
      return best || { v: 0, pick: null };
    }
    const best = bestIn(slotId, ref, depth, 0);
    if (req) return best; // 必須の口が埋まらなければ、この部品ごと使えない
    if (!best || best.v <= EPS) return { v: 0, pick: null };
    return best;
  }

  let v = 0;
  const picks = [];
  for (const [slotId, req, ref] of gun.sl) {
    const r = bestSlot(slotId, req, ref, 1);
    if (r === null) return null;
    v += r.v;
    if (r.pick) picks.push(r.pick);
  }
  return { v, picks, memo };
}

/** 選んだ部品の中で、同時に付けられない 2 つを探す。 */
function findConflict(db, picks) {
  const chosen = new Set();
  const walk = (ps) => ps.forEach((p) => { chosen.add(p.mod); walk(p.children); });
  walk(picks);
  for (const i of chosen) {
    for (const x of db.mods[i].conf) {
      if (chosen.has(x)) return [i, x];
    }
  }
  return null;
}

/**
 * 相性まで含めて解く（分枝限定法）。
 *
 * 相性を無視して解いた値は、相性を守った答えの値の上限になる。
 * ぶつかる組 (p, q) が見つかったら、相手の多いほう（p とする）について
 * 「p を使わない」「p を使う ＝ p とぶつかるものを全部使わない」の 2 つに分けて
 * 解き直す。どんな答えもどちらかに入るので、取りこぼしは無い。
 * 上限のいちばん高いものから順に調べ、最初に見つかったぶつかりの無い答えが最良。
 *
 * 「p か q のどちらかを外す」で分けると、ストック一体型のグリップ（CQR）のように
 * 何十本ものストックとぶつかる部品で、ストックを 1 本ずつ外す枝が延々と続く。
 */
function solveFeasible(ctx, w) {
  const { db } = ctx;
  const first = solveOnce(ctx, w, new Set());
  if (!first) return null;
  if (!findConflict(db, first.picks)) return first;
  const open = [{ res: first, banned: new Set() }];
  const tried = new Set();
  let best = null; // ここまでに見つかった、ぶつかりの無い答え
  let budget = SEARCH_BUDGET;
  while (open.length && budget > 0) {
    let k = 0;
    for (let j = 1; j < open.length; j++) if (open[j].res.v > open[k].res.v) k = j;
    const node = open.splice(k, 1)[0];
    if (best && node.res.v <= best.v + EPS) break; // 残りはどれも今の答えを超えない
    const pair = findConflict(db, node.res.picks);
    if (!pair) return node.res;
    const [a, b] = pair;
    const hub = db.mods[a].conf.size >= db.mods[b].conf.size ? a : b;
    for (const drop of [[hub], [...db.mods[hub].conf]]) {
      const banned = new Set(node.banned);
      for (const d of drop) banned.add(d);
      const key = [...banned].sort((x, y) => x - y).join(',');
      if (tried.has(key)) continue;
      tried.add(key);
      budget--;
      const r = solveOnce(ctx, w, banned, node.res.memo, dirtyFrom(ctx, drop));
      if (!r || (best && r.v <= best.v + EPS)) continue;
      if (!findConflict(db, r.picks)) best = r;
      else open.push({ res: r, banned });
    }
  }
  return best;
}

/** 木を、表に並べやすい 1 列に開く。path は差し込み口の名前を / で繋いだもの。 */
function flatten(db, picks, parentPath = '', depth = 0, out = []) {
  for (const p of picks) {
    const path = parentPath ? `${parentPath}/${p.slot}` : p.slot;
    out.push({ path, slot: p.slot, mod: db.mods[p.mod], depth });
    flatten(db, p.children, path, depth + 1, out);
  }
  return out;
}

/**
 * 部品の一覧から、ゲーム内に出る数値と、揃えるのに要るものを数える。
 * @param {Array<{mod:Object}>} parts
 */
export function buildStats(db, gun, parts, cond) {
  let ergo = gun.e;
  let recoil = 0;
  let weight = gun.w;
  let price = 0;
  const traders = new Map(); // トレーダー番号 → 要る LL
  let flea = 0;
  let barter = 0;
  let stock = 0;
  let quest = 0;
  for (const p of parts) {
    const m = p.mod;
    ergo += m.e || 0;
    recoil += m.r || 0;
    weight += m.w || 0;
    const src = sourceOf(m, cond, gun);
    p.source = src;
    if (!src) continue;
    if (src.kind === 'stock') stock++;
    else if (src.kind === 'flea') flea++;
    else {
      traders.set(src.t, Math.max(traders.get(src.t) || 0, src.ll));
      if (src.kind === 'trader') price += src.price;
      else barter++;
      if (src.quest) quest++;
    }
  }
  const k = 1 + recoil / 100;
  return {
    ergoRaw: ergo,
    ergo: Math.max(0, Math.min(ERGO_CAP, ergo)),
    recoil, // 合計の補正（%）。負ほど良い
    rv: Math.round(gun.rv * k),
    rh: Math.round(gun.rh * k),
    weight,
    price,
    traders,
    flea,
    barter,
    stock,
    quest,
    count: parts.length,
  };
}

/** 生の重み s（0 = 反動だけ, 1 = エルゴだけ）で解いて、表に出せる形にする。 */
function solveAt(ctx, s) {
  if (ctx.memo.has(s)) return ctx.memo.get(s);
  const w = {
    a: Math.max(s, SECONDARY),
    b: Math.max(1 - s, SECONDARY),
  };
  const res = solveFeasible(ctx, w);
  let out = null;
  if (res) {
    const parts = flatten(ctx.db, res.picks);
    out = { s, parts, stats: buildStats(ctx.db, ctx.gun, parts, ctx.cond) };
  }
  ctx.memo.set(s, out);
  return out;
}

/**
 * エルゴが上限を超えている答えを、上限ちょうどまで反動側へ寄せる。
 * 重み s を大きくするほどエルゴは増える（減ることはない）ので、
 * 「上限に届く最小の s」を二分探索で探す。10 回で s の幅は 1/1000 になり、
 * 部品の組み合わせが変わる境目はそれより粗い。
 */
function capErgo(ctx, build) {
  if (!build || build.stats.ergoRaw <= ERGO_CAP) return build;
  let lo = 0;
  let hi = build.s;
  let best = build;
  for (let k = 0; k < 10; k++) {
    const mid = (lo + hi) / 2;
    const b = solveAt(ctx, mid);
    if (b && b.stats.ergoRaw >= ERGO_CAP) {
      best = b;
      hi = mid;
    } else {
      lo = mid;
    }
  }
  return best;
}

/**
 * 3 つの代表と、その間を動かすための尺度を出す。
 *
 * 反動の % とエルゴの点は単位が違うので、そのまま足すと幅の大きいエルゴが勝つ。
 * 両端（反動最小とエルゴ最大）の差で割って、どちらも 0〜1 の幅に揃えてから混ぜる。
 * 「バランス」は両者を同じ重みにしたもの。
 *
 * @returns {null|{recoil, balanced, ergo, scale:{dE,dR}}} 組めない銃は null
 */
export function bestBuilds(db, gun, cond = DEFAULT_COND) {
  const ctx = contextFor(db, gun, cond);
  const recoil = solveAt(ctx, 0);
  if (!recoil) return null;
  const ergo = capErgo(ctx, solveAt(ctx, 1)) || recoil;
  const dE = Math.max(ergo.stats.ergo - recoil.stats.ergo, 1);
  const dR = Math.max(ergo.stats.recoil - recoil.stats.recoil, 0.1);
  const scale = { dE, dR };
  const balanced = buildAt(db, gun, cond, 0.5, scale) || recoil;
  return { recoil, balanced, ergo, scale };
}

/**
 * 配分 t（0 = 反動だけ、1 = エルゴだけ、どちらも幅で正規化したもの）で解く。
 * スライダーから呼ぶ。
 */
export function buildAt(db, gun, cond, t, scale) {
  const ctx = contextFor(db, gun, cond);
  if (t <= 0) return solveAt(ctx, 0);
  const ke = t / scale.dE;
  const kr = (1 - t) / scale.dR;
  return capErgo(ctx, solveAt(ctx, ke / (ke + kr)));
}

/** 反動最小だけを出す。一覧で全銃を並べるときに使う（3 つ全部より軽い）。 */
export function lowestRecoil(db, gun, cond = DEFAULT_COND) {
  return solveAt(contextFor(db, gun, cond), 0);
}

/** 買ったままの状態（標準の部品だけ）の数値。 */
export function stockStats(db, gun, cond = DEFAULT_COND) {
  const parts = [...gun.defaults].map((i) => ({ mod: db.mods[i] }));
  return buildStats(db, gun, parts, cond);
}

/**
 * いくつかの組み合わせを並べて比べる表の行。
 * 差し込み口の道筋（レシーバー/ハンドガード/フォアグリップ）を行にして、
 * どれかの組み合わせに出てくる口をすべて、木の順に並べる。
 * @returns {Array<{path, slot, depth, cells: Array<Object|null>, differs: boolean}>}
 */
export function compareRows(builds) {
  const order = [];
  const index = new Map();
  for (const b of builds) {
    if (!b) continue;
    for (const p of b.parts) {
      if (index.has(p.path)) continue;
      // 親の行の、いちばん後ろの子孫の次に差し込む
      const parent = p.path.includes('/') ? p.path.slice(0, p.path.lastIndexOf('/')) : '';
      let at = order.length;
      if (parent && index.has(parent)) {
        at = order.indexOf(parent) + 1;
        while (at < order.length && order[at].startsWith(parent + '/')) at++;
      }
      order.splice(at, 0, p.path);
      index.set(p.path, p);
    }
  }
  return order.map((path) => {
    const p = index.get(path);
    const cells = builds.map((b) => (b ? b.parts.find((x) => x.path === path) || null : null));
    const ids = cells.map((c) => (c ? c.mod.id : ''));
    return {
      path,
      slot: p.slot,
      depth: p.depth,
      cells,
      differs: ids.some((id) => id !== ids[0]),
    };
  });
}

/** 同じ口径の銃。自分は除く。 */
export function sameCaliber(db, gun) {
  return db.guns.filter((g) => g.cal === gun.cal && g.id !== gun.id);
}

/** 銃の名前で探す（略称・正式名・URL 名・口径のどれでも）。 */
export function searchGuns(db, query, normalize = (s) => s.toLowerCase()) {
  const terms = String(query || '').trim().split(/\s+/).map(normalize).filter(Boolean);
  if (!terms.length) return db.guns.slice();
  return db.guns.filter((g) => {
    const hay = normalize(`${g.s || ''} ${g.n} ${g.slug} ${g.cal}`);
    return terms.every((t) => hay.includes(t));
  });
}
