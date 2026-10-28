/**
 * カスタムの画面（#/builds と #/builds/<銃>）。
 *
 * 計算は builds.js にある。ここは並べ方だけを持つ。
 * 一覧は 価格.com の比較表のように「数字を横に並べて見比べる」形を、
 * 1 丁のページは部品を差し込み口ごとに縦に並べる形（PC パーツの構成表のような）を取った。
 */

import {
  loadGuns, bestBuilds, buildAt, stockStats, compareRows, sameCaliber, searchGuns,
  lowestRecoil, sourceOf, DEFAULT_COND, ERGO_CAP,
} from './builds.js';
import { loadItems, useSummary, useKinds } from './items.js';
import { normalizeQuery } from './tasks.js';
import { hashFor } from './router.js';
import {
  escapeHtml as esc, crumbs, openModal, carouselHtml, setupCarousels, readStore, writeStore,
  loadMeta, itemImage, toast, signed, trim1, rub, kg,
} from './ui.js';

const COND_KEY = 'eft-gps.buildCond';
const RECENT_KEY = 'eft-gps.recentGuns';
const RECENT_MAX = 8;
const DEV = 'https://tarkov.dev/item/';
const WIKI = 'https://escapefromtarkov.fandom.com/wiki/';

/** 3 つの組み合わせの呼び名と、ひとことの説明。色は site.css の --k-* と対応 */
const KINDS = [
  { key: 'recoil', label: '反動を最小に', why: 'エルゴを捨ててでも反動を抑える' },
  { key: 'balanced', label: 'バランス', why: '反動の減り幅とエルゴの伸び幅を同じ重さで' },
  { key: 'ergo', label: 'エルゴを最大に', why: `エルゴ ${ERGO_CAP} を目指し、届いたら反動を抑える` },
];

const state = {
  el: null,
  db: null,
  items: null,
  cond: { ...DEFAULT_COND, ...readStore(COND_KEY, {}) },
  /** いま開いている銃（一覧のときは null） */
  gun: null,
  builds: null,
  stock: null,
  /** 配分のスライダー 0〜20（÷20 して使う） */
  mix: 10,
  /** 一覧の「最小にしたとき」の列。条件ごとに覚えておく */
  lowCache: new Map(),
  lowJob: 0,
  ctx: null,
};

/* ------------------------------------------------------------------ 入口 */

export function mount(el) {
  state.el = el;
  el.addEventListener('click', onClick);
  el.addEventListener('change', onChange);
  el.addEventListener('input', onInput);
}

export async function show(el, ctx) {
  state.ctx = ctx;
  if (!state.db) {
    el.innerHTML = '<div class="page-inner"><p class="loading">部品のデータを読み込んでいます…</p></div>';
    try {
      const meta = await loadMeta();
      const db = await loadGuns(meta.gunFile);
      if (db.failed) throw new Error(db.failed);
      state.db = db;
      // 用途（タスクで使う・ハイドアウトで使う）は部品の詳細に添えるだけなので、待たない
      loadItems(meta.itemFile).then((items) => { state.items = items.failed ? null : items; });
    } catch (err) {
      el.innerHTML = `<div class="page-inner"><p class="empty">部品のデータを読めませんでした（${esc(err.message || err)}）。
        再読み込みしても直らない場合は、ネットワークの状態を確かめてください。</p></div>`;
      return;
    }
  }
  const slug = ctx.parts[0];
  if (slug) renderGun(slug);
  else renderIndex();
  el.scrollTop = 0;
}

/* ------------------------------------------------------------------ 条件 */

function condBar() {
  const c = state.cond;
  const ll = [1, 2, 3, 4].map((n) =>
    `<button type="button" data-ll="${n}" aria-pressed="${c.ll === n}">${n}</button>`).join('');
  return `<div class="cond" role="group" aria-label="計算の条件">
      <span class="cond-item"><span class="k" id="ll-label">トレーダーの LL</span>
        <span class="seg" role="group" aria-labelledby="ll-label">${ll}</span></span>
      <label class="cond-item check"><input type="checkbox" data-cond="flea" ${c.flea ? 'checked' : ''}>
        <span>フリマで買う</span></label>
      <label class="cond-item check"><input type="checkbox" data-cond="suppressor" ${c.suppressor ? 'checked' : ''}>
        <span>サプレッサーも使う</span></label>
      <span class="cond-note">全トレーダーをこの LL として計算します</span>
    </div>`;
}

function setCond(patch) {
  state.cond = { ...state.cond, ...patch };
  writeStore(COND_KEY, state.cond);
  const keep = state.el.scrollTop;
  if (state.gun) renderGun(state.gun.slug);
  else renderIndex();
  state.el.scrollTop = keep;
}

/* ------------------------------------------------------------------ 一覧 */

function renderIndex() {
  const { db, ctx } = state;
  state.gun = null;
  const cat = db.categories.find((c) => c.key === ctx.query.get('cat')) || null;
  const q = ctx.query.get('q') || '';
  const sort = ctx.query.get('sort') || '';
  document.title = `${cat ? cat.label : 'カスタム'} — EFT GPS`;

  const tabs = [{ key: '', label: 'すべて', count: db.guns.length }, ...db.categories]
    .map((c) => {
      const current = (cat ? cat.key : '') === c.key;
      return `<a href="${hashFor('builds', [], { cat: c.key, q })}"${current ? ' aria-current="page"' : ''}>
        ${esc(c.label)}<span class="n">${c.count}</span></a>`;
    }).join('');

  state.el.innerHTML = `<div class="page-inner">
    ${crumbs([
      { label: 'EFT GPS', href: '#/map' },
      { label: 'カスタム', href: cat ? '#/builds' : null },
      ...(cat ? [{ label: cat.label }] : []),
    ])}
    <header class="page-head">
      <h1>${cat ? `${esc(cat.label)}のカスタム` : '銃ごとのおすすめカスタム'}</h1>
      <p class="lede">銃ごとに、反動がいちばん小さくなる部品の組み合わせ、エルゴがいちばん高くなる組み合わせ、
        その中間の 3 通りを出しています。tarkov.dev の部品データから、このページの中で計算しています。
        下の条件を変えると、その条件で手に入る部品だけで計算し直します。</p>
    </header>
    ${condBar()}
    ${recentHtml()}
    <nav class="tabs" aria-label="銃の種類">${tabs}</nav>
    <div class="list-tools">
      <input type="search" id="gun-q" value="${esc(q)}" placeholder="名前・口径で探す（m4 / akm / 9x19 …）"
             aria-label="銃の名前・口径で探す" autocomplete="off">
      <label class="sel">並び
        <select id="gun-sort">
          <option value="">種類順</option>
          <option value="low"${sort === 'low' ? ' selected' : ''}>最小にしたときの縦反動が小さい順</option>
          <option value="ergo"${sort === 'ergo' ? ' selected' : ''}>素のエルゴが高い順</option>
          <option value="cal"${sort === 'cal' ? ' selected' : ''}>口径順</option>
        </select>
      </label>
      <span class="count" id="gun-count"></span>
    </div>
    <div class="table-scroll flat">
      <table class="gun-table">
        <thead><tr>
          <th class="pic-col"><span class="visually-hidden">画像</span></th>
          <th>銃</th>
          <th>口径</th>
          <th class="num">素のエルゴ</th>
          <th class="num">買ったままの縦反動</th>
          <th class="num">反動を最小にすると</th>
        </tr></thead>
        <tbody id="gun-rows"></tbody>
      </table>
    </div>
    <p class="empty" id="gun-empty" hidden></p>
    ${pageFoot()}
  </div>`;
  setupCarousels(state.el);
  renderGunRows();
  fillLowColumn();
}

function lowKey() {
  const c = state.cond;
  return `${c.ll}|${c.flea ? 1 : 0}|${c.suppressor ? 1 : 0}`;
}

function filteredGuns() {
  const { db, ctx } = state;
  const cat = ctx.query.get('cat') || '';
  const q = ctx.query.get('q') || '';
  let rows = searchGuns(db, q, normalizeQuery);
  if (cat) rows = rows.filter((g) => g.cat === cat);
  const sort = ctx.query.get('sort') || '';
  const low = state.lowCache.get(lowKey()) || new Map();
  if (sort === 'low') {
    // まだ計算していないものは後ろに回す
    rows.sort((a, b) => (low.get(a.slug)?.stats.rv ?? 1e9) - (low.get(b.slug)?.stats.rv ?? 1e9));
  } else if (sort === 'ergo') {
    rows.sort((a, b) => b.e - a.e);
  } else if (sort === 'cal') {
    rows.sort((a, b) => a.cal.localeCompare(b.cal, 'en', { numeric: true }));
  }
  return rows;
}

function renderGunRows() {
  const rows = filteredGuns();
  const body = document.getElementById('gun-rows');
  if (!body) return;
  const low = state.lowCache.get(lowKey()) || new Map();
  const catLabel = new Map(state.db.categories.map((c) => [c.key, c.label]));
  const showCat = !state.ctx.query.get('cat');
  body.innerHTML = rows.map((g) => {
    const st = stockStats(state.db, g, state.cond);
    return `<tr data-href="${hashFor('builds', [g.slug])}">
      <td class="pic-col"><span class="thumb inv"><img loading="lazy" decoding="async" alt=""
          src="${itemImage(g.img || g.id)}" onerror="this.style.visibility='hidden'"></span></td>
      <td class="gun-name"><a href="${hashFor('builds', [g.slug])}">${esc(g.s || g.n)}</a>
        <small>${showCat ? `${esc(catLabel.get(g.cat))} ・ ` : ''}<span class="full">${esc(g.n)}</span><span class="m-cal">${esc(g.cal)}</span></small></td>
      <td class="cal">${esc(g.cal)}</td>
      <td class="num">${trim1(g.e)}</td>
      <td class="num">${st.rv}</td>
      <td class="num low" data-slug="${esc(g.slug)}">${lowCell(low.get(g.slug))}</td>
    </tr>`;
  }).join('');
  document.getElementById('gun-count').textContent = `${rows.length} 丁`;
  const empty = document.getElementById('gun-empty');
  empty.hidden = rows.length > 0;
  if (!rows.length) {
    empty.textContent = '一致する銃がありません。略称（M4A1 / AKM）か、口径（5.56x45）で探してみてください。';
  }
}

function lowCell(b) {
  if (b === undefined) return '<span class="wait">…</span>';
  if (b === null) return '<span class="wait">組めない</span>';
  return `${b.stats.rv} <span class="d">${signed(b.stats.recoil)}%</span>`;
}

/**
 * 一覧の「反動を最小にすると」の列を、画面を止めないよう少しずつ埋める。
 * 全 160 丁で 0.5 秒ほどかかるので、一度に計算すると一覧が出るのが遅れる。
 */
function fillLowColumn() {
  const job = ++state.lowJob;
  const key = lowKey();
  if (!state.lowCache.has(key)) state.lowCache.set(key, new Map());
  const low = state.lowCache.get(key);
  const todo = state.db.guns.filter((g) => !low.has(g.slug));
  const step = () => {
    if (job !== state.lowJob) return; // 条件が変わったか、別の画面に移った
    const until = performance.now() + 12;
    while (todo.length && performance.now() < until) {
      const g = todo.shift();
      const b = lowestRecoil(state.db, g, state.cond);
      low.set(g.slug, b);
      const cell = state.el.querySelector(`td.low[data-slug="${CSS.escape(g.slug)}"]`);
      if (cell) cell.innerHTML = lowCell(b);
    }
    if (todo.length) setTimeout(step, 0);
    else if (state.ctx.query.get('sort') === 'low') renderGunRows();
  };
  setTimeout(step, 0);
}

function recentHtml() {
  const slugs = readStore(RECENT_KEY, []).filter((s) => state.db.bySlug.has(s));
  if (slugs.length < 2) return ''; // 1 丁だけなら並べる意味がない
  return `<section class="recent">
    ${carouselHtml({
      label: '最近見た銃',
      title: '<h2 class="h-sub">最近見た銃</h2>',
      items: slugs.map((s) => gunCard(state.db.bySlug.get(s))),
    })}
  </section>`;
}

function gunCard(g) {
  const st = stockStats(state.db, g, state.cond);
  return `<a class="gun-card" href="${hashFor('builds', [g.slug])}">
    <span class="inv"><img loading="lazy" decoding="async" alt="" src="${itemImage(g.img || g.id)}"
          onerror="this.style.visibility='hidden'"></span>
    <b>${esc(g.s || g.n)}</b>
    <small>${esc(g.cal)} ・ エルゴ ${trim1(st.ergo)} ・ 縦反動 ${st.rv}</small>
  </a>`;
}

function rememberRecent(slug) {
  const list = readStore(RECENT_KEY, []).filter((s) => s !== slug);
  list.unshift(slug);
  writeStore(RECENT_KEY, list.slice(0, RECENT_MAX));
}

/* ------------------------------------------------------------------ 1 丁 */

function renderGun(slug) {
  const { db } = state;
  const gun = db.bySlug.get(slug);
  if (!gun) {
    state.gun = null;
    state.el.innerHTML = `<div class="page-inner">
      ${crumbs([{ label: 'EFT GPS', href: '#/map' }, { label: 'カスタム', href: '#/builds' }, { label: slug }])}
      <p class="empty">「${esc(slug)}」という銃は見つかりませんでした。<a href="#/builds">一覧から探す</a></p>
    </div>`;
    return;
  }
  if (state.gun !== gun) state.mix = 10;
  state.gun = gun;
  rememberRecent(slug);
  const cat = db.categories.find((c) => c.key === gun.cat);
  const name = gun.s || gun.n;
  document.title = `${name} のカスタム — EFT GPS`;

  state.stock = stockStats(db, gun, state.cond);
  state.builds = bestBuilds(db, gun, state.cond);
  const b = state.builds;

  state.el.innerHTML = `<div class="page-inner">
    ${crumbs([
      { label: 'EFT GPS', href: '#/map' },
      { label: 'カスタム', href: '#/builds' },
      { label: cat ? cat.label : '', href: hashFor('builds', [], { cat: gun.cat }) },
      { label: name },
    ])}
    ${gunHead(gun, cat)}
    ${condBar()}
    ${b ? `
      <section aria-labelledby="h-three">
        <h2 id="h-three">3 通りの組み合わせ <small>${esc(sameNote(b))}</small></h2>
        ${carouselHtml({
          label: '3 通りの組み合わせ',
          className: 'cards',
          dots: true,
          items: KINDS.map((k) => buildCard(k, b[k.key])),
        })}
      </section>
      <section aria-labelledby="h-parts">
        <h2 id="h-parts">部品を並べて比べる
          <label class="check h-tool"><input type="checkbox" id="diff-only"><span>違う部品だけ表示</span></label></h2>
        ${compareTable(b)}
        <p class="note">部品の名前を押すと、数値と入手先が出ます。色の付いた行は、3 つで選んだ部品が違うところです。</p>
      </section>
      <section aria-labelledby="h-mix" class="mixer">
        <h2 id="h-mix">配分を自分で決める</h2>
        <p class="note">左に寄せるほど反動を、右に寄せるほどエルゴを重く見ます。真ん中が上の「バランス」です。
          間の位置にも、それぞれいちばん良い組み合わせがあります。</p>
        <div class="mixer-row">
          <span class="end">反動</span>
          <input type="range" id="mix" min="0" max="20" step="1" value="${state.mix}"
                 aria-label="反動とエルゴの配分" aria-valuetext="${mixText(state.mix)}">
          <span class="end">エルゴ</span>
        </div>
        <div id="mix-out"></div>
      </section>`
    : `<p class="empty">この条件では組めませんでした。必須の部品（レシーバーやバレルなど）が、
         この LL のトレーダーでもフリマでも手に入りません。LL を上げるか、フリマを使う設定にしてください。</p>`}
    ${faq(gun)}
    ${sameCaliberHtml(gun)}
    ${pageFoot()}
  </div>`;
  setupCarousels(state.el);
  if (b) renderMix();
}

function gunHead(gun, cat) {
  const st = state.stock;
  return `<header class="gun-head">
    <div class="gun-pic inv"><img alt="" src="${itemImage(gun.img || gun.id, '512')}"
         onerror="this.onerror=null;this.src='${itemImage(gun.img || gun.id)}'"></div>
    <div>
      <p class="kicker">${esc(cat ? cat.label : '')} ・ ${esc(gun.cal)}${gun.fr ? ` ・ 毎分 ${gun.fr} 発` : ''}</p>
      <h1>${esc(gun.s || gun.n)} のカスタム</h1>
      <p class="sub">${esc(gun.n)}</p>
      <dl class="spec-line">
        <div><dt>買ったまま</dt><dd>エルゴ ${trim1(st.ergo)}</dd><dd>縦 ${st.rv} / 横 ${st.rh}</dd></div>
        <div><dt>素の反動</dt><dd>縦 ${gun.rv} / 横 ${gun.rh}</dd></div>
      </dl>
      <div class="actions">
        ${gun.dev ? `<a class="btn" href="${DEV}${esc(gun.dev)}" target="_blank" rel="noopener noreferrer">tarkov.dev で見る</a>` : ''}
        ${gun.wiki ? `<a class="btn" href="${WIKI}${esc(gun.wiki)}" target="_blank" rel="noopener noreferrer">Wiki</a>` : ''}
        <button type="button" class="btn" data-act="copy">このページの URL をコピー</button>
      </div>
    </div>
  </header>`;
}

/** 3 つのうち同じ組み合わせになったものがあれば、見出しの横で断っておく */
function sameNote(b) {
  const id = (x) => x.parts.map((p) => p.mod.id).join(',');
  const [r, m, e] = [id(b.recoil), id(b.balanced), id(b.ergo)];
  if (r === m && m === e) {
    return b.recoil.stats.ergo >= ERGO_CAP
      ? '反動を最小にしてもエルゴが上限の 100 に届くので、3 つとも同じです'
      : 'この銃は選べる部品が少なく、3 つとも同じになりました';
  }
  if (r === m) return 'バランスは「反動を最小に」と同じです';
  if (m === e) return 'バランスは「エルゴを最大に」と同じです';
  return '';
}

function needTags(st) {
  const t = [...st.traders.entries()]
    .sort((x, y) => y[1] - x[1])
    .map(([i, ll]) => `<span class="tag">${esc(state.db.traders[i].name)} <b>LL${ll}</b></span>`);
  if (st.flea) t.push(`<span class="tag flea">フリマ ${st.flea} 点</span>`);
  if (st.barter) t.push(`<span class="tag barter">交換 ${st.barter} 点</span>`);
  if (st.stock) t.push(`<span class="tag stock">標準のまま ${st.stock} 点</span>`);
  return t.join('');
}

function buildCard(kind, build) {
  const st = build.stats;
  const stock = state.stock;
  // 反動の % は素の銃からの補正（ゲーム内の表示と同じ）。買ったままとの差は別の行に分ける。
  // 1 つの数字の横に違う基準の差を並べると、何と比べた差なのか読めなくなる
  return `<article class="build-card" data-kind="${kind.key}">
    <h3>${esc(kind.label)}</h3>
    <p class="why">${esc(kind.why)}</p>
    <div class="big">
      <div class="stat"><span class="k">縦反動</span><span class="v">${st.rv}</span>
        <span class="d">${signed(st.recoil)}%</span></div>
      <div class="stat"><span class="k">エルゴ</span><span class="v">${trim1(st.ergo)}</span></div>
    </div>
    <div class="meters" aria-hidden="true">
      <span>反動の減り</span><span class="meter"><i style="width:${Math.min(100, -st.recoil)}%"></i></span><span>${trim1(-st.recoil)}%</span>
      <span>エルゴ</span><span class="meter"><i style="width:${st.ergo}%"></i></span><span>${trim1(st.ergo)}</span>
    </div>
    <dl class="mini">
      <dt>横反動</dt><dd>${st.rh}</dd>
      <dt>買ったままとの差</dt><dd>縦 ${signed(st.rv - stock.rv, 0)} ・ エルゴ ${signed(st.ergo - stock.ergo)}</dd>
      <dt>重さ</dt><dd>${kg(st.weight)}</dd>
      <dt>部品</dt><dd>${st.count} 点</dd>
      <dt>定価の合計</dt><dd>${rub(st.price)}${st.flea || st.barter ? '<sup>※</sup>' : ''}</dd>
    </dl>
    <div class="need" aria-label="揃えるのに要るもの">${needTags(st)}</div>
  </article>`;
}

/* ------------------------------------------------------------ 比較の表 */

function partEffect(m) {
  const out = [];
  if (m.e) out.push(`エルゴ ${signed(m.e)}`);
  if (m.r) out.push(`反動 ${signed(m.r)}%`);
  return out.join(' ・ ') || '数値の変化なし';
}

function sourceTag(src) {
  if (!src) return '';
  const tr = (i) => esc(state.db.traders[i].name);
  switch (src.kind) {
    case 'stock': return '<span class="tag stock">標準</span>';
    case 'trader': return `<span class="tag${src.quest ? ' quest' : ''}"${src.quest ? ' title="タスクを終えると買えるようになる"' : ''}>${tr(src.t)} LL${src.ll}${src.quest ? ' ・ 要タスク' : ''}</span>`;
    case 'barter': return `<span class="tag barter">${tr(src.t)} LL${src.ll} 交換</span>`;
    case 'flea': return `<span class="tag flea">フリマ${src.level ? ` Lv${src.level}〜` : ''}</span>`;
    default: return '';
  }
}

function partCell(p) {
  if (!p) return '<span class="none">—</span>';
  const m = p.mod;
  return `<button type="button" class="part" data-mod="${m.i}">
      <span class="pn">${esc(m.s || m.n)}</span>
      <span class="pm">${partEffect(m)}</span>
    </button>${sourceTag(p.source)}`;
}

function compareTable(b) {
  const list = [b.recoil, b.balanced, b.ergo];
  const rows = compareRows(list);
  const label = (slot) => esc(state.db.slotLabel[slot] || slot);
  const body = rows.map((r) => `<tr class="${r.differs ? 'differs' : ''}">
      <th scope="row" style="--d:${r.depth}"><span class="slot${r.depth ? ' sub' : ''}">${label(r.slot)}</span></th>
      ${r.cells.map((c) => `<td>${partCell(c)}</td>`).join('')}
    </tr>`).join('');

  // 合計の行。いちばん良い値に印を付ける（同点はどれも）
  const stat = (name, get, better, fmt) => {
    const vals = list.map((x) => get(x.stats));
    const best = better === 'low' ? Math.min(...vals) : Math.max(...vals);
    return `<tr><th scope="row">${name}</th>${vals.map((v) =>
      `<td class="${Math.abs(v - best) < 1e-9 ? 'best' : ''}">${fmt(v)}</td>`).join('')}</tr>`;
  };
  const foot = [
    stat('縦反動', (s) => s.rv, 'low', String),
    stat('横反動', (s) => s.rh, 'low', String),
    stat('反動の補正', (s) => s.recoil, 'low', (v) => `${signed(v)}%`),
    stat('エルゴ', (s) => s.ergo, 'high', trim1),
    stat('重さ', (s) => s.weight, 'low', kg),
    stat('定価の合計', (s) => s.price, 'low', rub),
  ].join('');

  return `<div class="table-scroll">
    <table class="compare" id="compare">
      <thead><tr><th scope="col">差し込み口</th>
        ${KINDS.map((k) => `<th scope="col" data-kind="${k.key}"><span class="swatch"></span>${esc(k.label)}</th>`).join('')}
      </tr></thead>
      <tbody>${body}</tbody>
      <tfoot>${foot}</tfoot>
    </table>
  </div>`;
}

/* ------------------------------------------------------------ 配分 */

function mixText(v) {
  const t = v / 20;
  if (t === 0) return '反動だけを見る';
  if (t === 1) return 'エルゴだけを見る';
  if (t === 0.5) return '半々（バランスと同じ）';
  return `反動 ${Math.round((1 - t) * 100)} : エルゴ ${Math.round(t * 100)}`;
}

function renderMix() {
  const out = document.getElementById('mix-out');
  if (!out || !state.builds) return;
  const t = state.mix / 20;
  const build = t === 0.5 ? state.builds.balanced
    : buildAt(state.db, state.gun, state.cond, t, state.builds.scale);
  if (!build) {
    out.innerHTML = '<p class="empty">この配分では組めませんでした。</p>';
    return;
  }
  const st = build.stats;
  const label = (slot) => esc(state.db.slotLabel[slot] || slot);
  out.innerHTML = `<p class="mix-label">${esc(mixText(state.mix))}</p>
    <div class="mix-stats">
      <div><span class="k">縦反動</span><span class="v">${st.rv}</span><span class="d">${signed(st.recoil)}%</span></div>
      <div><span class="k">横反動</span><span class="v">${st.rh}</span></div>
      <div><span class="k">エルゴ</span><span class="v">${trim1(st.ergo)}</span></div>
      <div><span class="k">重さ</span><span class="v">${st.weight.toFixed(2)}</span><span class="d">kg</span></div>
      <div><span class="k">定価の合計</span><span class="v">${Math.round(st.price).toLocaleString('ja-JP')}</span><span class="d">₽</span></div>
    </div>
    <div class="need">${needTags(st)}</div>
    <details class="acc">
      <summary>部品 ${st.count} 点を見る</summary>
      <div class="acc-body">
        <ul class="parts-list">${build.parts.map((p) => `<li style="--d:${p.depth}">
          <span class="slot${p.depth ? ' sub' : ''}">${label(p.slot)}</span>
          ${partCell(p)}
        </li>`).join('')}</ul>
      </div>
    </details>`;
}

/* ------------------------------------------------------------ 部品の詳細 */

function openPart(i) {
  const { db } = state;
  const m = db.mods[i];
  if (!m) return;
  const gun = state.gun;
  const tr = (t) => esc(db.traders[t].name);

  const where = [];
  if (gun && gun.defaults.has(m.i)) where.push(['この銃に最初から付いている', '']);
  for (const [t, ll, price, quest] of m.b || []) {
    where.push([`${tr(t)} LL${ll}${quest ? '（タスクを終えると買える）' : ''}`, rub(price)]);
  }
  for (const [t, ll, quest] of m.bt || []) {
    where.push([`${tr(t)} LL${ll} で物々交換${quest ? '（タスクを終えると）' : ''}`, '']);
  }
  where.push(m.fl !== undefined
    ? [`フリーマーケット${m.fl ? `（プレイヤー Lv${m.fl} から）` : ''}`, '相場は tarkov.dev で']
    : ['フリーマーケットでは買えない', '']);
  const src = sourceOf(m, state.cond, gun);

  const stats = [
    ['エルゴ', m.e ? signed(m.e) : '0'],
    ['反動の補正', m.r ? `${signed(m.r)}%` : '0%'],
    ['重さ', kg(m.w || 0)],
  ];
  if (m.cap) stats.push(['装弾数', `${m.cap} 発`]);
  if (m.sup) stats.push(['種類', 'サプレッサー']);

  const use = state.items && state.items[m.id];
  const useBlock = use && useKinds(use)
    ? `<section class="detail-sec"><h3>ほかの用途</h3>
        <p class="detail-p">${esc(useSummary(use))}</p>
        <p class="detail-p"><a href="${hashFor('items', [], { open: m.id })}">アイテムの用途で詳しく見る</a></p>
      </section>`
    : '';

  openModal(`<div class="detail-top">
      <span class="detail-pic inv"><img alt="" src="${itemImage(m.id, 'base-image')}"
            onerror="this.onerror=null;this.src='${itemImage(m.id)}'"></span>
      <div>
        <h2 id="modal-title">${esc(m.n)}</h2>
        <p class="detail-sub">${m.s ? esc(m.s) : ''}</p>
        <div class="need">${sourceTag(src) || '<span class="tag">この条件では手に入らない</span>'}</div>
      </div>
    </div>
    <section class="detail-sec"><h3>数値</h3>
      <ul class="kv">${stats.map(([k, v]) => `<li><span>${k}</span><b>${v}</b></li>`).join('')}</ul>
    </section>
    <section class="detail-sec"><h3>入手先</h3>
      <ul class="kv">${where.map(([k, v]) => `<li><span>${k}</span><b>${v}</b></li>`).join('')}</ul>
    </section>
    ${useBlock}
    <div class="detail-links">
      ${m.dev ? `<a href="${DEV}${esc(m.dev)}" target="_blank" rel="noopener noreferrer">tarkov.dev で相場を見る</a>` : ''}
    </div>`);
}

/* ------------------------------------------------------------ よくある質問・同じ口径 */

function faq(gun) {
  const q = (title, body) => `<details class="acc"><summary>${title}</summary><div class="acc-body">${body}</div></details>`;
  return `<section aria-labelledby="h-faq">
    <h2 id="h-faq">この計算について</h2>
    ${q('何を比べているのか', `<p>ゲーム内のウェポンビルダーに出る「縦反動・横反動」と「エルゴ」です。
      反動は、銃の素の値に部品の補正（%）を全部足して掛けたもの、エルゴは銃の素の値に部品の値を全部足したものです。
      ${esc(gun.s || gun.n)} の素の値は 縦 ${gun.rv} / 横 ${gun.rh}、エルゴ ${trim1(gun.e)} です。</p>`)}
    ${q('入れていない部品', `<p>スコープ・ドットサイト・ライト・レーザーは入れていません。どれも反動には効かず、
      エルゴが下がるだけなので、入れると「何も付けない」が最良になってしまいます。好みで足してください（エルゴが数ポイント下がります）。</p>
      <p>サプレッサーは既定では入れていません。音の出方が変わるので、使うかどうかは条件の「サプレッサーも使う」で選んでください。
      使う設定にしても、マズルブレーキのほうが反動の減る銃（M4A1 など）では選ばれません。
      最初から一体になっている銃（PB、VSS など）は、外すと元より悪くなるので残しています。</p>`)}
    ${q('マガジンの選び方', `<p>買ったときに付いているマガジンと同じ装弾数以上のものから選んでいます。
      そうしないと、軽くてエルゴの高い 10 発マガジンが選ばれてしまうためです。</p>`)}
    ${q('エルゴの上限', `<p>エルゴは 100 で頭打ちです。「エルゴを最大に」で 100 を超える組み合わせがあるときは、
      100 に届く範囲でいちばん反動の小さいものを選んでいます。</p>`)}
    ${q('同時に付けられない部品', `<p>ハンドガードとガスブロックのように、形がぶつかって同時に付けられない組み合わせがあります。
      これは tarkov.dev のデータにある相性の情報で避けています。データに漏れがあれば、ゲーム内で付かないことがあります。</p>`)}
    ${q('値段について', `<p>「定価の合計」は、トレーダーから現金で買う部品の値段だけを足したものです。
      フリマで買う部品と物々交換の部品は入っていません（※の付いている合計）。
      フリマの相場は毎日動くので、このページには持たせていません。部品の詳細から tarkov.dev へ移ると、いまの相場が見られます。</p>`)}
    ${q('データの時点', `<p>部品のデータは ${esc(state.db.builtAt)} に tarkov.dev から取り込んだものです。
      アップデートで数値が変わることがあるので、ゲーム内のウェポンビルダーで確かめてから買ってください。</p>`)}
  </section>`;
}

function sameCaliberHtml(gun) {
  const list = sameCaliber(state.db, gun);
  if (!list.length) return '';
  return `<section class="same-cal">
    ${carouselHtml({
      label: `同じ口径（${gun.cal}）の銃`,
      title: `<h2 class="h-sub">同じ口径（${esc(gun.cal)}）の銃 <small>${list.length} 丁</small></h2>`,
      items: list.map(gunCard),
    })}
  </section>`;
}

function pageFoot() {
  return `<footer class="page-foot">
    <p>部品の数値・相性・入手先は <a href="https://tarkov.dev/" target="_blank" rel="noopener noreferrer">tarkov.dev</a>
      のデータ（${esc(state.db.builtAt)} 取り込み）。画像も tarkov.dev のものを表示しています。</p>
    <p>非公式のファンツールです。Battlestate Games とは無関係で、承認も受けていません。</p>
  </footer>`;
}

/* ------------------------------------------------------------------ 操作 */

function onClick(ev) {
  const ll = ev.target.closest('[data-ll]');
  if (ll) {
    setCond({ ll: Number(ll.dataset.ll) });
    return;
  }
  const part = ev.target.closest('.part[data-mod]');
  if (part) {
    openPart(Number(part.dataset.mod));
    return;
  }
  if (ev.target.closest('[data-act="copy"]')) {
    copyUrl();
    return;
  }
  // 一覧の行は、どこを押してもその銃へ（名前のリンクはキーボードで辿れるように残す）
  const row = ev.target.closest('tr[data-href]');
  if (row && !ev.target.closest('a')) location.hash = row.dataset.href;
}

function onChange(ev) {
  const t = ev.target;
  if (t.dataset.cond) {
    setCond({ [t.dataset.cond]: t.checked });
  } else if (t.id === 'gun-sort') {
    setQuery({ sort: t.value });
    renderGunRows();
  } else if (t.id === 'diff-only') {
    document.getElementById('compare').classList.toggle('diff-only', t.checked);
  }
}

let mixFrame = 0;
function onInput(ev) {
  const t = ev.target;
  if (t.id === 'gun-q') {
    setQuery({ q: t.value });
    renderGunRows();
  } else if (t.id === 'mix') {
    state.mix = Number(t.value);
    t.setAttribute('aria-valuetext', mixText(state.mix));
    // つまみを動かしている間は、描くのを 1 フレームに 1 回にまとめる
    cancelAnimationFrame(mixFrame);
    mixFrame = requestAnimationFrame(renderMix);
  }
}

/** 検索語などを URL に写す。履歴は増やさない（戻るで 1 文字ずつ戻るのは困る） */
function setQuery(patch) {
  const q = state.ctx.query;
  for (const [k, v] of Object.entries(patch)) {
    if (v) q.set(k, v);
    else q.delete(k);
  }
  const s = q.toString();
  history.replaceState(null, '', `#/builds${s ? `?${s}` : ''}`);
}

async function copyUrl() {
  try {
    await navigator.clipboard.writeText(location.href);
    toast('URL をコピーしました');
  } catch {
    toast('コピーできませんでした。アドレス欄からコピーしてください');
  }
}
