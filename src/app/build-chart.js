/**
 * 反動とエルゴの兼ね合いのグラフ（カスタムの「配分を自分で決める」に出す）。
 *
 * 横がエルゴ、縦が反動の減り（%）。どちらも大きいほど良いので、右上ほど良い。
 * 配分のスライダーを端から端まで動かしたときに出てくる組み合わせを点で打ち、
 * エルゴの順に線で結ぶ。この線より右上の組み合わせは、どう部品を選んでも作れない。
 *
 * 点の上にポインタを置くか、キーボードで点に移ると数値が出る。押すとその配分に移る。
 * 同じ値は、グラフの下の表（builds-page.js が出す）でも読める。
 */

const NS = 'http://www.w3.org/2000/svg';

/** 目盛りの間隔。だいたい 4〜7 本になるように 1, 2, 5, 10, 20 から選ぶ */
function tickStep(span) {
  for (const s of [1, 2, 5, 10, 20, 25, 50]) if (span / s <= 7) return s;
  return 100;
}

function domain(values, pad, lo = -Infinity, hi = Infinity) {
  let min = Math.min(...values) - pad;
  let max = Math.max(...values) + pad;
  if (max - min < 4) { min -= 2; max += 2; }
  const step = tickStep(max - min);
  return {
    min: Math.max(lo, Math.floor(min / step) * step),
    max: Math.min(hi, Math.ceil(max / step) * step),
    step,
  };
}

function el(name, attrs, parent) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  if (parent) parent.appendChild(node);
  return node;
}

/**
 * @param {HTMLElement} box 描く先。中身は描くたびに作り直す
 * @param {Object} o
 * @param {Array<{ergo:number, red:number, rv:number, vs:number[], label:string}>} o.points
 *        スライダーの位置 vs（0〜20）ごとに出てきた組み合わせ。red は反動の減り（%、正の数）
 * @param {Array<{key:string, label:string, ergo:number, red:number}>} o.marks 3 通りの代表
 * @param {{ergo:number, red:number}} o.stock 買ったまま
 * @param {number} o.current いまのスライダーの位置（0〜20）
 * @param {(v:number) => void} o.onPick 点を押したとき
 */
export function drawTradeoff(box, { points, marks, stock, current, onPick }) {
  box.textContent = '';
  if (!points.length) return;
  const W = Math.max(280, box.clientWidth || 640);
  const H = W < 520 ? 230 : 290;
  const m = { l: 46, r: 18, t: 14, b: 40 };
  const all = [...points, ...marks, stock];
  const xd = domain(all.map((p) => p.ergo), 2, 0, 100);
  const yd = domain(all.map((p) => p.red), 2, 0, 100);
  const x = (v) => m.l + ((v - xd.min) / (xd.max - xd.min)) * (W - m.l - m.r);
  const y = (v) => H - m.b - ((v - yd.min) / (yd.max - yd.min)) * (H - m.t - m.b);

  const svg = el('svg', {
    width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: 'tradeoff-svg',
    role: 'img', 'aria-label': 'エルゴと反動の減りの兼ね合い。右上ほど良い',
  }, box);

  // 目盛りと格子（横線だけ。縦は目盛りの数字で足りる）
  for (let v = yd.min; v <= yd.max + 1e-9; v += yd.step) {
    el('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), class: 'grid' }, svg);
    el('text', { x: m.l - 8, y: y(v) + 4, class: 'tick', 'text-anchor': 'end' }, svg).textContent = `${v}%`;
  }
  for (let v = xd.min; v <= xd.max + 1e-9; v += xd.step) {
    el('line', { x1: x(v), x2: x(v), y1: H - m.b, y2: H - m.b + 4, class: 'axis' }, svg);
    el('text', { x: x(v), y: H - m.b + 17, class: 'tick', 'text-anchor': 'middle' }, svg).textContent = String(v);
  }
  el('line', { x1: m.l, x2: W - m.r, y1: H - m.b, y2: H - m.b, class: 'axis' }, svg);
  el('text', { x: W - m.r, y: H - 4, class: 'axis-label', 'text-anchor': 'end' }, svg).textContent = 'エルゴ →';
  el('text', { x: m.l, y: m.t - 2, class: 'axis-label', 'text-anchor': 'start' }, svg).textContent = '↑ 反動の減り';

  // 作れる組み合わせの線
  const sorted = points.slice().sort((a, b) => a.ergo - b.ergo || b.red - a.red);
  el('polyline', {
    points: sorted.map((p) => `${x(p.ergo)},${y(p.red)}`).join(' '), class: 'frontier',
  }, svg);

  // 買ったまま（中抜きの丸）
  el('circle', { cx: x(stock.ergo), cy: y(stock.red), r: 5, class: 'stock' }, svg);

  // 途中の点
  for (const p of points) el('circle', { cx: x(p.ergo), cy: y(p.red), r: 4, class: 'pt' }, svg);

  // 3 通りの代表。同じ位置に重なるときは後のものが上に来る
  for (const mk of marks) {
    el('circle', { cx: x(mk.ergo), cy: y(mk.red), r: 6, class: `mark k-${mk.key}` }, svg);
  }

  // いまのスライダーの位置
  const cur = points.find((p) => p.vs.includes(current));
  if (cur) el('circle', { cx: x(cur.ergo), cy: y(cur.red), r: 10, class: 'current' }, svg);

  // 押せる範囲。点そのものより大きくして、狙わなくても当たるようにする
  const tip = document.createElement('div');
  tip.className = 'tradeoff-tip';
  tip.hidden = true;
  box.appendChild(tip);
  const show = (p, cx, cy) => {
    tip.textContent = '';
    const v = document.createElement('b');
    v.textContent = `エルゴ ${p.ergo.toFixed(1).replace(/\.0$/, '')} ・ 反動の減り ${p.red.toFixed(1)}%`;
    const s = document.createElement('span');
    s.textContent = `縦反動 ${p.rv} ・ ${p.label}`;
    tip.append(v, s);
    tip.hidden = false;
    const left = Math.min(Math.max(cx - tip.offsetWidth / 2, 0), W - tip.offsetWidth);
    tip.style.left = `${left}px`;
    tip.style.top = `${Math.max(cy - tip.offsetHeight - 14, 0)}px`;
  };
  for (const p of points) {
    const cx = x(p.ergo);
    const cy = y(p.red);
    const hit = el('circle', {
      cx, cy, r: 12, class: 'hit', tabindex: 0, role: 'button',
      'aria-label': `エルゴ ${p.ergo.toFixed(1)}、反動の減り ${p.red.toFixed(1)}%、${p.label}。押すとこの配分にする`,
    }, svg);
    const pick = () => onPick(p.vs[Math.floor(p.vs.length / 2)]);
    hit.addEventListener('pointerenter', () => show(p, cx, cy));
    hit.addEventListener('focus', () => show(p, cx, cy));
    hit.addEventListener('pointerleave', () => { tip.hidden = true; });
    hit.addEventListener('blur', () => { tip.hidden = true; });
    hit.addEventListener('click', pick);
    hit.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); pick(); }
    });
  }
}
