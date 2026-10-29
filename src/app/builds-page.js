/**
 * カスタムの画面（#/builds と #/builds/<銃>）。
 *
 * 計算は builds.js、兼ね合いのグラフは build-chart.js にある。ここは並べ方と操作だけを持つ。
 * 一覧は 価格.com の比較表のように「数字を横に並べて見比べる」形を、
 * 1 丁のページは部品を差し込み口ごとに縦に並べる形（PC パーツの構成表のような）を取った。
 *
 * 画面の文章は短くする。使い方と計算のきまりは「使い方」の小窓 1 か所にまとめ、
 * 各所には ※ の注記だけを置く（節ごとに説明文を付けると、画面が取扱説明書になる）。
 */

import {
  loadGuns, bestBuilds, buildAt, stockStats, compareRows, sameCaliber, searchGuns,
  lowestRecoil, sourceOf, buildStats, condKey, traderLL, rawWeight, ammoFor, condForLevel,
  treeFromParts, stockTree, builderRows, partsFromTree, setPart, checkTree, encodeTree, decodeTree,
  DEFAULT_COND, ERGO_CAP,
} from './builds.js';
import { drawTradeoff } from './build-chart.js';
import { loadItems, useSummary, useKinds } from './items.js';
import { normalizeQuery } from './tasks.js';
import { hashFor } from './router.js';
import {
  escapeHtml as esc, crumbs, openModal, closeModal, carouselHtml, setupCarousels, readStore,
  writeStore, loadMeta, itemImage, partThumb, toast, signed, trim1, rub, kg,
} from './ui.js';

const COND_KEY = 'eft-gps.buildCond';
const RECENT_KEY = 'eft-gps.recentGuns';
const RECENT_MAX = 8;
/** 保存した組み合わせ。このブラウザの中だけに置く（人ごとに別々。サーバは無い） */
const SAVED_KEY = 'eft-gps.savedBuilds';
const DEV = 'https://tarkov.dev/item/';
const WIKI = 'https://escapefromtarkov.fandom.com/wiki/';
/** スライダーの刻み。0〜MIX_STEPS を ÷MIX_STEPS して配分にする */
const MIX_STEPS = 20;

/** 3 つの組み合わせの呼び名。色は site.css の --k-* と対応 */
const KINDS = [
  { key: 'recoil', label: '反動最小' },
  { key: 'balanced', label: 'バランス' },
  { key: 'ergo', label: 'エルゴ最大' },
];
const START_LABEL = {
  recoil: '反動最小', balanced: 'バランス', ergo: 'エルゴ最大', stock: '標準', mix: 'スライダー',
};

/** 弾の表で並べ替えられる列 */
const AMMO_SORT = [['pen', '貫通'], ['dmg', 'ダメージ'], ['ad', 'アーマー'], ['fg', '断片化'], ['v', '初速'], ['r', '反動']];
/** 貫通の棒の幅の上限。アーマークラス 6 の目安（60）より少し上まで */
const PEN_MAX = 70;

/**
 * 銃のページのタブ。1 ページに全部を縦に積むと 7000px を超え、目的の場所まで延々とスクロールする。
 * ゲーム内のウェポンビルダーやトレーダーの画面と同じく、見たいものだけを切り替えて出す
 */
const TABS = [
  ['best', 'おすすめ'],
  ['build', '自分で組む'],
  ['mix', '反動とエルゴ'],
  ['level', 'レベル別'],
  ['ammo', '弾'],
];

/** レベル別の表に並べるプレイヤーレベル。トレーダーの LL が上がる辺り（6〜42）を 5 刻みで */
const LEVELS = [5, 10, 15, 20, 25, 30, 35, 40, 45];

/** メニューに並べるトレーダーの順。ゲーム内の並びに合わせ、残りは名前順 */
const TRADER_ORDER = ['prapor', 'therapist', 'skier', 'peacekeeper', 'mechanic', 'ragman', 'jaeger', 'ref'];

const state = {
  el: null,
  db: null,
  items: null,
  /** 保存する条件。tl はトレーダーごとの LL（キーはトレーダーの名前。番号はデータでずれるため） */
  store: { ...DEFAULT_COND, budget: 0, tl: {}, ...readStore(COND_KEY, {}) },
  /** 計算に渡す条件（store から作る） */
  cond: { ...DEFAULT_COND },
  /** 部品を売っているトレーダーの番号 */
  sellers: [],
  /** いま開いている銃（一覧のときは null） */
  gun: null,
  builds: null,
  stock: null,
  /** 配分のスライダー 0〜MIX_STEPS */
  mix: MIX_STEPS / 2,
  /** グラフの点。条件と銃ごとに覚える */
  points: new Map(),
  pointsJob: 0,
  /** 自分で組んでいる木と、その出発点 */
  tree: null,
  treeGun: null,
  treeFrom: 'balanced',
  /** 部品を選ぶ小窓で選んでいる口 */
  pick: null,
  /** 自分で組む表に、空いている任意の口も出すか */
  showEmpty: false,
  /** 「個別に」を開いているか（描き直しても閉じないように） */
  tlOpen: false,
  /** 弾の表の並び */
  ammoSort: 'pen',
  /** 銃のページで開いているタブ */
  tab: 'best',
  /** レベル別の表。銃と条件ごとに覚える */
  levelCache: new Map(),
  levelJob: 0,
  /** 一覧の「最小反動」の列。条件ごとに覚えておく */
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
  // 部品を選ぶ小窓はページの外（共通の <dialog>）にあるので、そちらにも付ける
  const modal = document.getElementById('modal');
  modal.addEventListener('click', onPickClick);
  modal.addEventListener('input', (ev) => {
    if (ev.target.id === 'pick-q' && state.pick) {
      state.pick.query = ev.target.value;
      renderPickList();
    }
  });
  modal.addEventListener('close', () => { state.pick = null; });
  let width = 0;
  new ResizeObserver(() => {
    // 幅が変わったときだけグラフを描き直す（高さの変化では描き直さない）
    if (el.clientWidth !== width) {
      width = el.clientWidth;
      if (state.gun) renderChart();
    }
  }).observe(el);
}

export async function show(el, ctx) {
  state.ctx = ctx;
  if (!state.db) {
    el.innerHTML = '<div class="page-inner"><p class="loading">読み込み中…</p></div>';
    try {
      const meta = await loadMeta();
      const db = await loadGuns(meta.gunFile);
      if (db.failed) throw new Error(db.failed);
      state.db = db;
      state.sellers = sellersOf(db);
      state.cond = runtimeCond();
      // 用途（タスクで使う・ハイドアウトで使う）は部品の詳細に添えるだけなので、待たない
      loadItems(meta.itemFile).then((items) => { state.items = items.failed ? null : items; });
    } catch (err) {
      el.innerHTML = `<div class="page-inner"><p class="empty">部品のデータを読めませんでした（${esc(err.message || err)}）。
        再読み込みしても直らなければ、ネットワークを確認してください。</p></div>`;
      return;
    }
  }
  const slug = ctx.parts[0];
  if (slug) renderGun(slug);
  else renderIndex();
  el.scrollTop = 0;
}

/* ------------------------------------------------------------------ 条件 */

function sellersOf(db) {
  const has = new Set();
  for (const m of db.mods) {
    for (const [t] of m.b || []) has.add(t);
    for (const [t] of m.bt || []) has.add(t);
  }
  const rank = (t) => {
    const i = TRADER_ORDER.indexOf(db.traders[t].key);
    return i < 0 ? TRADER_ORDER.length : i;
  };
  return [...has].sort((a, b) => rank(a) - rank(b) || db.traders[a].name.localeCompare(db.traders[b].name));
}

/** レベル別の表と「プレイヤー Lv」に共通する、レベル以外の条件 */
function baseCond() {
  const s = state.store;
  return { ll: s.ll, flea: !!s.flea, suppressor: !!s.suppressor, budget: Number(s.budget) || 0 };
}

function runtimeCond() {
  const s = state.store;
  const cond = baseCond();
  // プレイヤー Lv を決めたら、LL・フリマ・タスクの解放はそこから決める
  if (state.db && s.level) return condForLevel(state.db, s.level, cond);
  const tl = s.tl || {};
  if (state.db && Object.keys(tl).length) {
    cond.lv = state.db.traders.map((t) => (tl[t.key] !== undefined ? tl[t.key] : s.ll));
  }
  return cond;
}

function condBar() {
  const s = state.store;
  const seg = (attr, value, current) => [1, 2, 3, 4].map((n) =>
    `<button type="button" ${attr}="${n}"${value ? ` data-tr="${value}"` : ''} aria-pressed="${current === n}">${n}</button>`).join('');
  const tl = s.tl || {};
  const custom = Object.entries(tl).filter(([, v]) => v !== s.ll);
  const names = new Map(state.db.traders.map((t) => [t.key, t.name]));
  const rows = state.sellers.map((t) => {
    const tr = state.db.traders[t];
    const cur = traderLL(state.cond, t);
    return `<div class="tl-row"><span class="tl-name">${esc(tr.name)}</span>
      <span class="seg" role="group" aria-label="${esc(tr.name)} の LL">${seg('data-tl', tr.key, cur)}</span></div>`;
  }).join('');
  return `<div class="cond" role="group" aria-label="計算の条件">
      <label class="cond-item budget"><span class="k">プレイヤー Lv</span>
        <input type="number" id="plevel" min="1" max="79" inputmode="numeric" placeholder="なし"
               value="${s.level || ''}" aria-label="プレイヤーレベル"></label>
      <span class="cond-item"><span class="k" id="ll-label">トレーダー LL</span>
        <span class="seg" role="group" aria-labelledby="ll-label">${seg('data-ll', '', s.level || custom.length ? 0 : s.ll)}</span></span>
      <label class="cond-item check"><input type="checkbox" data-cond="flea" ${s.flea ? 'checked' : ''}
        ${s.budget ? 'disabled' : ''}><span>フリマ</span></label>
      <label class="cond-item check"><input type="checkbox" data-cond="suppressor" ${s.suppressor ? 'checked' : ''}>
        <span>サプレッサー</span></label>
      <label class="cond-item budget"><span class="k">予算</span>
        <input type="number" id="budget" min="0" step="10000" inputmode="numeric" placeholder="なし"
               value="${s.budget || ''}" aria-label="部品代の上限（ルーブル）"><span class="unit">₽</span></label>
      <details class="cond-more" ${state.tlOpen || (custom.length && !s.level) ? 'open' : ''}>
        <summary>個別に${custom.length && !s.level
          ? `<span class="cond-note">（${custom.map(([k, v]) => `${esc(names.get(k) || k)} ${v}`).join('・')}）</span>` : ''}</summary>
        <div class="tl-grid">${rows}</div>
        <p class="cond-note">※左の LL を押すと個別の設定は消える</p>
      </details>
      ${s.level ? `<p class="cond-note wide">※Lv${s.level} で上がれる LL・使えるフリマ・解放済みのタスクの品物だけで組む（信頼度は足りている前提）。
        LL を押すと Lv の指定は消える</p>` : ''}
      ${s.budget ? '<p class="cond-note wide">※予算ありのときはフリマ・交換を使わない（値段を持っていないため）。銃本体は含まない</p>' : ''}
    </div>`;
}

function setStore(patch) {
  state.store = { ...state.store, ...patch };
  writeStore(COND_KEY, state.store);
  state.cond = runtimeCond();
  const keep = state.el.scrollTop;
  if (state.gun) renderGun(state.gun.slug);
  else renderIndex();
  state.el.scrollTop = keep;
}

/* ------------------------------------------------------------------ 一覧 */

function renderIndex() {
  const { db, ctx } = state;
  state.gun = null;
  state.pointsJob++;
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
      <h1>${cat ? esc(cat.label) : 'カスタム'}</h1>
      <p class="lede">反動最小・バランス・エルゴ最大の 3 通りと、自分で組むための表。</p>
    </header>
    ${condBar()}
    ${savedList(null)}
    ${recentHtml()}
    <nav class="tabs" aria-label="銃の種類">${tabs}</nav>
    <div class="list-tools">
      <input type="search" id="gun-q" value="${esc(q)}" placeholder="m4 / akm / 9x19 …"
             aria-label="銃の名前・口径で探す" autocomplete="off">
      <label class="sel">並び
        <select id="gun-sort">
          <option value="">種類</option>
          <option value="low"${sort === 'low' ? ' selected' : ''}>最小反動</option>
          <option value="ergo"${sort === 'ergo' ? ' selected' : ''}>素のエルゴ</option>
          <option value="cal"${sort === 'cal' ? ' selected' : ''}>口径</option>
        </select>
      </label>
      <span class="count" id="gun-count"></span>
    </div>
    <div class="table-scroll">
      <table class="gun-table">
        <thead><tr>
          <th class="pic-col"><span class="visually-hidden">画像</span></th>
          <th>銃</th>
          <th>口径</th>
          <th class="num">素のエルゴ</th>
          <th class="num">標準の縦反動</th>
          <th class="num">最小反動</th>
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

function filteredGuns() {
  const { db, ctx } = state;
  const cat = ctx.query.get('cat') || '';
  const q = ctx.query.get('q') || '';
  let rows = searchGuns(db, q, normalizeQuery);
  if (cat) rows = rows.filter((g) => g.cat === cat);
  const sort = ctx.query.get('sort') || '';
  const low = state.lowCache.get(condKey(state.cond)) || new Map();
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
  const low = state.lowCache.get(condKey(state.cond)) || new Map();
  const catLabel = new Map(state.db.categories.map((c) => [c.key, c.label]));
  const showCat = !state.ctx.query.get('cat');
  body.innerHTML = rows.map((g) => {
    const st = stockStats(state.db, g, state.cond);
    return `<tr data-href="${hashFor('builds', [g.slug])}">
      <td class="pic-col"><span class="thumb inv"><img loading="lazy" decoding="async" alt=""
          src="${itemImage(g.img || g.id)}" onerror="this.style.visibility='hidden'"></span></td>
      <td class="gun-name"><a href="${hashFor('builds', [g.slug])}">${esc(g.s || g.n)}</a>
        ${showCat ? `<small>${esc(catLabel.get(g.cat))}<span class="m-cal"> ・ ${esc(g.cal)}</span></small>` : `<small class="m-cal">${esc(g.cal)}</small>`}</td>
      <td class="cal">${esc(g.cal)}</td>
      <td class="num">${trim1(g.e)}</td>
      <td class="num">${st.rv}</td>
      <td class="num low" data-slug="${esc(g.slug)}">${lowCell(low.get(g.slug))}</td>
    </tr>`;
  }).join('');
  document.getElementById('gun-count').textContent = `${rows.length} 丁`;
  const empty = document.getElementById('gun-empty');
  empty.hidden = rows.length > 0;
  if (!rows.length) empty.textContent = '該当なし。略称（M4A1 / AKM）か口径（5.56x45）で。';
}

function lowCell(b) {
  if (b === undefined) return '<span class="wait">…</span>';
  if (b === null) return '<span class="wait">組めない</span>';
  return `${b.stats.rv} <span class="d">${signed(b.stats.recoil)}%</span>`;
}

/**
 * 一覧の「最小反動」の列を、画面を止めないよう少しずつ埋める。
 * 全 160 丁で 0.5 秒ほど（予算を決めるとその十数倍）かかるので、一度に計算すると一覧が出るのが遅れる。
 */
function fillLowColumn() {
  const job = ++state.lowJob;
  const key = condKey(state.cond);
  if (!state.lowCache.has(key)) state.lowCache.set(key, new Map());
  const low = state.lowCache.get(key);
  const todo = state.db.guns.filter((g) => !low.has(g.slug));
  const step = () => {
    if (job !== state.lowJob || state.gun) return; // 条件が変わったか、別の画面に移った
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
    <small>${esc(g.cal)} ・ エルゴ ${trim1(st.ergo)} ・ 縦 ${st.rv}</small>
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
      <p class="empty">「${esc(slug)}」は見つかりませんでした。<a href="#/builds">一覧へ</a></p>
    </div>`;
    return;
  }
  const fresh = state.gun !== gun;
  if (fresh) state.mix = MIX_STEPS / 2;
  state.gun = gun;
  rememberRecent(slug);
  const cat = db.categories.find((c) => c.key === gun.cat);
  const name = gun.s || gun.n;
  document.title = `${name} のカスタム — EFT GPS`;

  state.stock = stockStats(db, gun, state.cond);
  state.builds = bestBuilds(db, gun, state.cond);
  const b = state.builds;

  // 自分で組む木。URL に載っていればそれを、無ければバランスから始める。
  // 条件を変えて描き直すときは、組みかけのものを残す。同じ銃を開いたまま
  // 別の共有リンクを開いたときは、そちらに入れ替える
  const shared = state.ctx.query.get('b');
  const changed = shared && state.tree && state.treeGun === slug
    && shared !== encodeTree(db, gun, state.tree);
  if (state.treeGun !== slug || changed) {
    state.treeGun = slug;
    const decoded = shared ? decodeTree(db, gun, shared) : null;
    if (shared && !decoded) toast('共有された組み合わせを読めませんでした（データが更新されたため）');
    state.tree = decoded || (b ? treeFromParts(b.balanced.parts) : stockTree(db, gun));
    state.treeFrom = decoded ? 'shared' : b ? 'balanced' : 'stock';
  }

  state.el.innerHTML = `<div class="page-inner">
    ${crumbs([
      { label: 'EFT GPS', href: '#/map' },
      { label: 'カスタム', href: '#/builds' },
      { label: cat ? cat.label : '', href: hashFor('builds', [], { cat: gun.cat }) },
      { label: name },
    ])}
    ${gunHead(gun, cat)}
    ${condBar()}
    <nav class="gtabs" role="tablist" aria-label="表示の切り替え">
      ${TABS.filter(([k]) => b || k === 'build' || k === 'ammo').map(([k, label]) =>
        `<button type="button" role="tab" data-gtab="${k}" aria-selected="false">${label}</button>`).join('')}
    </nav>
    ${b ? `
      <section aria-labelledby="h-three" class="gtab" data-tab="best">
        <h2 id="h-three">おすすめ 3 通り <small>${esc(sameNote(b))}</small></h2>
        ${carouselHtml({
          label: 'おすすめ 3 通り',
          className: 'cards',
          dots: true,
          items: KINDS.map((k) => buildCard(k, b[k.key])),
        })}
      </section>
      ${levelSection()}
      <section aria-labelledby="h-parts" class="gtab" data-tab="best">
        <h2 id="h-parts">部品の比較
          <label class="check h-tool"><input type="checkbox" id="diff-only"><span>差分だけ</span></label></h2>
        ${compareTable(b)}
      </section>
      <section aria-labelledby="h-mix" class="mixer gtab" data-tab="mix">
        <h2 id="h-mix">反動とエルゴ</h2>
        <div class="tradeoff-wrap">
          <div class="tradeoff" id="tradeoff"><p class="loading">計算中…</p></div>
          <ul class="legend" aria-label="凡例">
            ${KINDS.map((k) => `<li><span class="key dot k-${k.key}"></span>${esc(k.label)}</li>`).join('')}
            <li><span class="key ring-stock"></span>標準</li>
            <li><span class="key ring-current"></span>いまの配分</li>
            <li><span class="key line"></span>作れる限界</li>
          </ul>
        </div>
        <div class="mixer-row">
          <span class="end">反動</span>
          <input type="range" id="mix" min="0" max="${MIX_STEPS}" step="1" value="${state.mix}"
                 aria-label="反動とエルゴの配分" aria-valuetext="${mixText(state.mix)}">
          <span class="end">エルゴ</span>
        </div>
        <div id="mix-out"></div>
        <details class="acc"><summary>表で見る</summary>
          <div class="acc-body" id="tradeoff-table"></div></details>
      </section>`
    : `<p class="empty">${state.cond.budget
      ? 'この予算では組めません。必須の部品（レシーバー・バレルなど）だけで超えます。'
      : 'この条件では組めません。必須の部品が、この LL でもフリマでも手に入りません。'}</p>`}
    <section aria-labelledby="h-build" id="builder" class="builder gtab" data-tab="build">
      <h2 id="h-build">自分で組む <small id="bld-from"></small></h2>
      <div class="bld-start" role="group" aria-label="やり直す">
        <span class="k">やり直す</span>
        ${b ? KINDS.map((k) => `<button type="button" class="btn" data-start="${k.key}">${esc(k.label)}</button>`).join('') : ''}
        <button type="button" class="btn" data-start="stock">標準</button>
        ${b ? '<button type="button" class="btn" data-start="mix">スライダー</button>' : ''}
      </div>
      <div id="bld-out"></div>
    </section>
    ${ammoSection(gun)}
    ${notes()}
    ${sameCaliberHtml(gun)}
    ${pageFoot()}
  </div>`;
  setupCarousels(state.el);
  if (b) {
    renderMix();
    fillPoints();
  }
  fillLevels();
  renderBuilder();
  const want = state.ctx.query.get('tab') || state.tab;
  showTab(!b && ['best', 'mix', 'level'].includes(want) ? 'build' : want);
}

function showTab(tab) {
  if (!TABS.some(([k]) => k === tab)) tab = 'best';
  state.tab = tab;
  for (const sec of state.el.querySelectorAll('.gtab')) sec.classList.toggle('on', sec.dataset.tab === tab);
  for (const btn of state.el.querySelectorAll('[data-gtab]')) btn.setAttribute('aria-selected', String(btn.dataset.gtab === tab));
  // グラフは隠れている間に幅を測れないので、出したときに描き直す
  if (tab === 'mix') renderChart();
}

/** タブを URL に写す（再読み込みや共有で同じタブが開く） */
function syncTabUrl() {
  const q = new URLSearchParams(state.ctx.query);
  if (state.tab === 'best') q.delete('tab');
  else q.set('tab', state.tab);
  state.ctx.query = q;
  const qs = q.toString();
  history.replaceState(null, '', `${hashFor('builds', [state.gun.slug])}${qs ? `?${qs}` : ''}`);
}

/* ------------------------------------------------------------ レベル別 */

function levelSection() {
  const cur = state.store.level;
  const head = KINDS.map((k) => `<th scope="col" data-kind="${k.key}"><span class="swatch"></span>${esc(k.label)}</th>`).join('');
  return `<section aria-labelledby="h-level" class="gtab" data-tab="level">
    <h2 id="h-level">レベル別 <small>※そのレベルで買える部品だけで組んだもの</small></h2>
    <div class="table-scroll">
      <table class="lvl">
        <thead><tr><th scope="col">プレイヤー Lv</th>${head}<th scope="col">フリマ</th></tr></thead>
        <tbody>${LEVELS.map((lv) => `<tr data-lv="${lv}" class="${cur === lv ? 'cur' : ''}" tabindex="0"
            aria-label="Lv${lv} の条件で見る">
          <th scope="row">Lv${lv}</th>
          <td colspan="4" class="wait">…</td></tr>`).join('')}</tbody>
      </table>
    </div>
  </section>`;
}

/** 1 行ぶんの中身。縦反動と補正、エルゴ */
function levelCells(lv, b) {
  if (!b) return '<td colspan="3" class="wait">組めない（必須の部品が手に入らない）</td><td>—</td>';
  const cell = (x) => `<td><span class="lv-rv">${x.stats.rv}</span> <span class="d">${signed(x.stats.recoil)}%</span>
    <span class="lv-e">エルゴ ${trim1(x.stats.ergo)}</span></td>`;
  const flea = state.store.flea && lv >= state.db.fleaLevel ? '使える' : '—';
  return KINDS.map((k) => cell(b[k.key])).join('') + `<td class="flea-col">${flea}</td>`;
}

/**
 * レベル別の表を、画面を止めないよう 1 行ずつ埋める。
 * 1 行で 3 通りを解くので M4A1 で 0.1 秒ほど。9 行なら 1 秒弱
 */
function fillLevels() {
  const job = ++state.levelJob;
  const gun = state.gun;
  const key = `${gun.slug}|${condKey(baseCond())}`;
  if (!state.levelCache.has(key)) state.levelCache.set(key, new Map());
  const done = state.levelCache.get(key);
  const paint = (lv) => {
    const row = state.el.querySelector(`tr[data-lv="${lv}"]`);
    if (row) row.innerHTML = `<th scope="row">Lv${lv}</th>${levelCells(lv, done.get(lv))}`;
  };
  const todo = LEVELS.filter((lv) => !done.has(lv));
  LEVELS.filter((lv) => done.has(lv)).forEach(paint);
  const step = () => {
    if (job !== state.levelJob || state.gun !== gun || !todo.length) return;
    const lv = todo.shift();
    done.set(lv, bestBuilds(state.db, gun, condForLevel(state.db, lv, baseCond())));
    paint(lv);
    setTimeout(step, 0);
  };
  setTimeout(step, 0);
}

function gunHead(gun, cat) {
  const st = state.stock;
  return `<header class="gun-head">
    <div class="gun-pic inv"><img alt="" src="${itemImage(gun.img || gun.id, '512')}"
         onerror="this.onerror=null;this.src='${itemImage(gun.img || gun.id)}'"></div>
    <div>
      <p class="kicker">${esc(cat ? cat.label : '')} ・ ${esc(gun.cal)}${gun.fr ? ` ・ ${gun.fr} 発/分` : ''}</p>
      <h1>${esc(gun.s || gun.n)}</h1>
      <p class="sub">${esc(gun.n)}</p>
      <dl class="spec-line">
        <div><dt>標準</dt><dd>エルゴ ${trim1(st.ergo)}</dd><dd>縦 ${st.rv} / 横 ${st.rh}</dd></div>
        <div><dt>素</dt><dd>縦 ${gun.rv} / 横 ${gun.rh}</dd></div>
      </dl>
      <div class="actions">
        <button type="button" class="btn" data-act="help">使い方</button>
        <button type="button" class="btn" data-act="copy">共有</button>
        ${gun.dev ? `<a class="btn" href="${DEV}${esc(gun.dev)}" target="_blank" rel="noopener noreferrer">tarkov.dev</a>` : ''}
        ${gun.wiki ? `<a class="btn" href="${WIKI}${esc(gun.wiki)}" target="_blank" rel="noopener noreferrer">Wiki</a>` : ''}
      </div>
    </div>
  </header>`;
}

const sig = (build) => build.parts.map((p) => p.mod.id).join(',');

/** 3 つのうち同じ組み合わせになったものがあれば、見出しの横で断っておく */
function sameNote(b) {
  const [r, m, e] = [sig(b.recoil), sig(b.balanced), sig(b.ergo)];
  if (r === m && m === e) {
    return b.recoil.stats.ergo >= ERGO_CAP ? '※反動最小でもエルゴ 100 に届くので 3 つとも同じ' : '※選べる部品が少なく 3 つとも同じ';
  }
  if (r === m) return '※バランス = 反動最小';
  if (m === e) return '※バランス = エルゴ最大';
  return '';
}

function needTags(st) {
  const t = [...st.traders.entries()]
    .sort((x, y) => y[1] - x[1])
    .map(([i, ll]) => `<span class="tag">${esc(state.db.traders[i].name)} <b>LL${ll}</b></span>`);
  if (st.flea) t.push(`<span class="tag flea">フリマ ${st.flea}</span>`);
  if (st.barter) t.push(`<span class="tag barter">交換 ${st.barter}</span>`);
  if (st.stock) t.push(`<span class="tag stock">標準 ${st.stock}</span>`);
  return t.join('');
}

function buildCard(kind, build) {
  const st = build.stats;
  const stock = state.stock;
  // 反動の % は素の銃からの補正（ゲーム内の表示と同じ）。標準との差は別の行に分ける。
  // 1 つの数字の横に違う基準の差を並べると、何と比べた差なのか読めなくなる
  return `<article class="build-card" data-kind="${kind.key}">
    <h3>${esc(kind.label)}</h3>
    <div class="big">
      <div class="stat"><span class="k">縦反動</span><span class="v">${st.rv}</span>
        <span class="d">${signed(st.recoil)}%</span></div>
      <div class="stat"><span class="k">エルゴ</span><span class="v">${trim1(st.ergo)}</span></div>
    </div>
    <div class="meters" aria-hidden="true">
      <span>反動減</span><span class="meter"><i style="width:${Math.min(100, -st.recoil)}%"></i></span><span>${trim1(-st.recoil)}%</span>
      <span>エルゴ</span><span class="meter"><i style="width:${st.ergo}%"></i></span><span>${trim1(st.ergo)}</span>
    </div>
    <dl class="mini">
      <dt>横反動</dt><dd>${st.rh}</dd>
      <dt>標準比</dt><dd>縦 ${signed(st.rv - stock.rv, 0)} ・ エルゴ ${signed(st.ergo - stock.ergo)}</dd>
      <dt>重さ</dt><dd>${kg(st.weight)}</dd>
      <dt>部品</dt><dd>${st.count} 点</dd>
      <dt>定価</dt><dd>${rub(st.price)}${st.flea || st.barter ? '<sup>※</sup>' : ''}</dd>
    </dl>
    <div class="need" aria-label="揃えるのに要るもの">${needTags(st)}</div>
    <button type="button" class="btn card-start" data-start="${kind.key}">これで組む</button>
  </article>`;
}

/* ------------------------------------------------------------ 比較の表 */

function partEffect(m) {
  const out = [];
  // マガジンは略称が同じもの（GEN M3 の 10 / 20 / 30 / 40 発）が並ぶので、装弾数で見分けられるようにする
  if (m.cap) out.push(`${m.cap} 発`);
  if (m.e) out.push(`エルゴ ${signed(m.e)}`);
  if (m.r) out.push(`反動 ${signed(m.r)}%`);
  return out.join(' ・ ') || '変化なし';
}

function sourceTag(src, never = false) {
  if (!src) return never ? '<span class="tag never">店売りなし</span>' : '<span class="tag off">手に入らない</span>';
  const tr = (i) => esc(state.db.traders[i].name);
  switch (src.kind) {
    case 'stock': return '<span class="tag stock">標準</span>';
    case 'trader': return `<span class="tag${src.quest ? ' quest' : ''}"${src.quest ? ' title="タスクを終えると買えるようになる"' : ''}>${tr(src.t)} LL${src.ll}${src.quest ? ` ・ 要タスク${src.questLevel > 1 ? ` Lv${src.questLevel}` : ''}` : ''}</span>`;
    case 'barter': return `<span class="tag barter">${tr(src.t)} LL${src.ll} 交換</span>`;
    case 'flea': return `<span class="tag flea">フリマ${src.level ? ` Lv${src.level}〜` : ''}</span>`;
    default: return '';
  }
}

function partCell(p) {
  if (!p) return '<span class="none">—</span>';
  const m = p.mod;
  return `<div class="pcell"><button type="button" class="part" data-mod="${m.i}" title="${esc(m.n)}">
      ${partThumb(m.id)}
      <span class="ptx"><span class="pn">${esc(m.s || m.n)}</span>
      <span class="pm">${partEffect(m)}</span></span>
    </button>${sourceTag(p.source)}</div>`;
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
    stat('定価', (s) => s.price, 'low', rub),
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

/* ------------------------------------------------------------ 配分とグラフ */

function mixText(v) {
  const t = v / MIX_STEPS;
  if (t === 0) return '反動だけ';
  if (t === 1) return 'エルゴだけ';
  if (t === 0.5) return '半々（バランス）';
  return `反動 ${Math.round((1 - t) * 100)} : エルゴ ${Math.round(t * 100)}`;
}

function mixBuild(v = state.mix) {
  const t = v / MIX_STEPS;
  return t === 0.5 ? state.builds.balanced
    : buildAt(state.db, state.gun, state.cond, t, state.builds.scale);
}

function renderMix() {
  const out = document.getElementById('mix-out');
  if (!out || !state.builds) return;
  const build = mixBuild();
  if (!build) {
    out.innerHTML = '<p class="empty">この配分では組めません。</p>';
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
      <div><span class="k">定価</span><span class="v">${Math.round(st.price).toLocaleString('ja-JP')}</span><span class="d">₽</span></div>
    </div>
    <div class="need">${needTags(st)}</div>
    <div class="mix-actions"><button type="button" class="btn" data-start="mix">これで組む</button></div>
    <details class="acc">
      <summary>部品 ${st.count} 点</summary>
      <div class="acc-body">
        <ul class="parts-list">${build.parts.map((p) => `<li style="--d:${p.depth}">
          <span class="slot${p.depth ? ' sub' : ''}">${label(p.slot)}</span>
          ${partCell(p)}
        </li>`).join('')}</ul>
      </div>
    </details>`;
  renderChart();
}

/**
 * グラフの点。スライダーの 21 か所で組み、同じ組み合わせはまとめる。
 * M4A1 で 1 か所 40ms ほどかかるので、画面を止めないよう少しずつ計算して、そのたびに描き直す。
 */
function fillPoints() {
  const job = ++state.pointsJob;
  const key = `${state.gun.slug}|${condKey(state.cond)}`;
  if (!state.points.has(key)) state.points.set(key, []);
  const done = state.points.get(key);
  let v = done.length;
  const step = () => {
    if (job !== state.pointsJob) return;
    const until = performance.now() + 30;
    while (v <= MIX_STEPS && performance.now() < until) {
      done.push(mixBuild(v));
      v++;
    }
    renderChart();
    if (v <= MIX_STEPS) setTimeout(step, 0);
  };
  if (v <= MIX_STEPS) setTimeout(step, 0);
  else renderChart();
}

function chartPoints() {
  const key = `${state.gun.slug}|${condKey(state.cond)}`;
  const builds = state.points.get(key) || [];
  const byId = new Map();
  builds.forEach((b, v) => {
    if (!b) return;
    const id = sig(b);
    if (!byId.has(id)) byId.set(id, { build: b, vs: [] });
    byId.get(id).vs.push(v);
  });
  return [...byId.values()].map(({ build, vs }) => ({
    ergo: build.stats.ergo,
    red: -build.stats.recoil,
    rv: build.stats.rv,
    vs,
    label: vs.length === 1 ? mixText(vs[0]) : `${mixText(vs[0])} 〜 ${mixText(vs[vs.length - 1])}`,
  }));
}

function renderChart() {
  const box = document.getElementById('tradeoff');
  if (!box || !state.builds) return;
  const points = chartPoints();
  if (!points.length) return;
  const b = state.builds;
  drawTradeoff(box, {
    points,
    marks: KINDS.map((k) => ({ key: k.key, label: k.label, ergo: b[k.key].stats.ergo, red: -b[k.key].stats.recoil })),
    stock: { ergo: state.stock.ergo, red: -state.stock.recoil },
    current: state.mix,
    onPick: (v) => setMix(v),
  });
  const table = document.getElementById('tradeoff-table');
  if (table) {
    table.innerHTML = `<table class="mini-table"><thead><tr><th>配分</th><th class="num">エルゴ</th>
      <th class="num">反動減</th><th class="num">縦反動</th></tr></thead><tbody>
      ${points.slice().sort((x, y) => x.vs[0] - y.vs[0]).map((p) => `<tr><td>${esc(p.label)}</td>
        <td class="num">${trim1(p.ergo)}</td><td class="num">${trim1(p.red)}%</td><td class="num">${p.rv}</td></tr>`).join('')}
      </tbody></table>`;
  }
}

function setMix(v) {
  state.mix = v;
  const input = document.getElementById('mix');
  if (input) {
    input.value = String(v);
    input.setAttribute('aria-valuetext', mixText(v));
  }
  renderMix();
}

/* ------------------------------------------------------------ 自分で組む */

function startTree(from) {
  const { db, gun, builds } = state;
  if (from === 'stock') state.tree = stockTree(db, gun);
  else if (from === 'mix') state.tree = treeFromParts((mixBuild() || builds.balanced).parts);
  else state.tree = treeFromParts(builds[from].parts);
  state.treeFrom = from;
  renderBuilder();
  showTab('build');
  syncTabUrl();
  document.querySelector('.gtabs')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** 組みかけを URL に写す。再読み込みしても、人に送っても同じものが出る */
function syncTreeUrl() {
  const q = new URLSearchParams(state.ctx.query);
  q.set('b', encodeTree(state.db, state.gun, state.tree));
  state.ctx.query = q;
  history.replaceState(null, '', `${hashFor('builds', [state.gun.slug])}?${q.toString()}`);
}

/** 比べる相手（出発点）の数値。共有されたものは標準と比べる */
function originStats() {
  const f = state.treeFrom;
  if (f === 'stock' || f === 'shared' || f === 'saved' || !state.builds) return { label: '標準', stats: state.stock };
  if (f === 'mix') return { label: 'スライダー', stats: (mixBuild() || state.builds.balanced).stats };
  return { label: START_LABEL[f], stats: state.builds[f].stats };
}

function renderBuilder() {
  const out = document.getElementById('bld-out');
  if (!out) return;
  const { db, gun, cond } = state;
  const rows = builderRows(db, gun, state.tree);
  const parts = partsFromTree(db, gun, state.tree);
  const st = buildStats(db, gun, parts, cond);
  const issues = checkTree(db, gun, cond, state.tree);
  const origin = originStats();
  document.getElementById('bld-from').textContent = state.treeFrom === 'shared' ? '共有されたもの'
    : state.treeFrom === 'saved' ? `保存: ${state.treeName}` : `元: ${START_LABEL[state.treeFrom]}`;
  const label = (slot) => esc(db.slotLabel[slot] || slot);
  const diff = (now, was, digits, better) => {
    const d = now - was;
    if (Math.abs(d) < 1e-9) return '';
    const good = better === 'low' ? d < 0 : d > 0;
    // 色だけで良し悪しを言わないよう、言葉も添える（反動は − が良い、エルゴは + が良い）
    return `<span class="delta ${good ? 'up' : 'down'}">${signed(d, digits)}<span class="dw">${good ? '良' : '悪'}</span></span>`;
  };

  const warn = [];
  for (const p of issues.missing) warn.push(`<li>${label(p.split('/').pop())}（必須）が空き。組み上がらない</li>`);
  for (const [a, b] of issues.conflicts) warn.push(`<li>${esc(a.s || a.n)} と ${esc(b.s || b.n)} は同時に付かない</li>`);
  if (issues.unavailable.length) warn.push(`<li>この条件で手に入らない部品が ${issues.unavailable.length} 点</li>`);
  if (cond.budget && st.price > cond.budget) warn.push(`<li>予算を ${rub(st.price - cond.budget)} 超えている</li>`);

  out.innerHTML = `<div class="bld-stats">
      <div><span class="k">縦反動</span><span class="v">${st.rv}</span>${diff(st.rv, origin.stats.rv, 0, 'low')}</div>
      <div><span class="k">横反動</span><span class="v">${st.rh}</span>${diff(st.rh, origin.stats.rh, 0, 'low')}</div>
      <div><span class="k">反動の補正</span><span class="v">${signed(st.recoil)}%</span>${diff(st.recoil, origin.stats.recoil, 1, 'low')}</div>
      <div><span class="k">エルゴ</span><span class="v">${trim1(st.ergo)}</span>${diff(st.ergo, origin.stats.ergo, 1, 'high')}</div>
      <div><span class="k">重さ</span><span class="v">${st.weight.toFixed(2)}</span><span class="u">kg</span>${diff(st.weight, origin.stats.weight, 2, 'low')}</div>
      <div><span class="k">定価</span><span class="v">${Math.round(st.price).toLocaleString('ja-JP')}</span><span class="u">₽</span></div>
    </div>
    <p class="bld-vs">差は${esc(origin.label)}と比べたもの</p>
    <div class="need">${needTags(st)}</div>
    ${warn.length ? `<ul class="bld-warn" role="status">${warn.join('')}</ul>` : '<p class="bld-ok">組み上がる</p>'}
    <div class="bld-actions">
      <span class="save-row">
        <input type="text" id="bld-name" maxlength="40" placeholder="名前（いつもの M4 など）" aria-label="保存する名前"
               value="${state.treeFrom === 'saved' ? esc(state.treeName) : ''}">
        <button type="button" class="btn" data-act="save-build">保存</button>
      </span>
      <button type="button" class="btn" data-act="copy-build">共有</button>
      <label class="check"><input type="checkbox" id="bld-empty" ${state.showEmpty ? 'checked' : ''}><span>空き口も表示</span></label>
    </div>
    ${savedList(gun)}
    <div class="table-scroll">
      <table class="bld">
        <thead><tr><th scope="col">差し込み口</th><th scope="col">部品</th><th scope="col"><span class="visually-hidden">操作</span></th></tr></thead>
        <tbody>${rows.filter((r) => r.mod || r.required || state.showEmpty).map((r) => {
          const src = r.mod ? sourceOf(r.mod, cond, gun) : null;
          const cls = [r.mod ? '' : 'empty', !r.mod && r.required ? 'missing' : ''].filter(Boolean).join(' ');
          return `<tr class="${cls}" style="--d:${r.depth}">
            <th scope="row" style="--d:${r.depth}"><span class="slot${r.depth ? ' sub' : ''}">${label(r.slot)}</span>${r.required ? '<span class="req">必須</span>' : ''}</th>
            <td>${r.mod ? partCell({ mod: r.mod, source: src }) : '<span class="none">空き</span>'}</td>
            <td class="ops"><div class="ops-in">
              <button type="button" class="btn mini" data-bld-pick="${esc(r.path)}">${r.mod ? '替える' : '付ける'}</button>
              ${r.mod && !r.required ? `<button type="button" class="btn mini" data-bld-drop="${esc(r.path)}">外す</button>` : ''}
            </div></td>
          </tr>`;
        }).join('')}</tbody>
      </table>
    </div>`;
}

/* ------------------------------------------------------------ 保存 */

/**
 * 保存した組み合わせの一覧。gun を渡すとその銃の分だけ、null なら全部。
 * 数値はその場で計算し直す（保存したときの条件ではなく、いまの条件での値）
 */
function savedList(gun) {
  const all = readStore(SAVED_KEY, []).filter((x) => state.db.bySlug.has(x.slug));
  const list = gun ? all.filter((x) => x.slug === gun.slug) : all;
  if (!list.length) return '';
  const rows = list.map((x) => {
    const g = state.db.bySlug.get(x.slug);
    const tree = decodeTree(state.db, g, x.b);
    const st = tree ? buildStats(state.db, g, partsFromTree(state.db, g, tree), state.cond) : null;
    const href = `${hashFor('builds', [g.slug])}?b=${encodeURIComponent(x.b)}`;
    return `<li>
      ${gun ? `<button type="button" class="saved-name" data-load="${esc(x.id)}">${esc(x.name)}</button>`
        : `<a class="saved-name" href="${href}">${esc(x.name)}</a><span class="saved-gun">${esc(g.s || g.n)}</span>`}
      <span class="saved-stat">${st ? `縦 ${st.rv} ・ エルゴ ${trim1(st.ergo)}` : 'データ更新で読めない'}</span>
      <span class="saved-at">${esc(x.at)}</span>
      <button type="button" class="btn mini" data-del="${esc(x.id)}" aria-label="${esc(x.name)} を削除">削除</button>
    </li>`;
  }).join('');
  return `<section class="saved" aria-label="保存した組み合わせ">
    <h3 class="saved-h">保存したもの <small>${list.length} 件・このブラウザだけに保存</small></h3>
    <ul class="saved-list">${rows}</ul>
  </section>`;
}

function saveBuild() {
  const { gun } = state;
  const input = document.getElementById('bld-name');
  const all = readStore(SAVED_KEY, []);
  const name = (input && input.value.trim()) || `${gun.s || gun.n} ${all.filter((x) => x.slug === gun.slug).length + 1}`;
  const b = encodeTree(state.db, gun, state.tree);
  // 同じ銃・同じ名前なら上書き（名前を変えずに組み直して保存し直すことが多い）
  const rest = all.filter((x) => !(x.slug === gun.slug && x.name === name));
  const d = new Date();
  const at = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  rest.unshift({ id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, slug: gun.slug, name, b, at });
  writeStore(SAVED_KEY, rest);
  state.treeFrom = 'saved';
  state.treeName = name;
  toast(`「${name}」を保存しました`);
  renderBuilder();
  syncTreeUrl();
}

function loadSaved(id) {
  const x = readStore(SAVED_KEY, []).find((y) => y.id === id);
  if (!x) return;
  const tree = decodeTree(state.db, state.gun, x.b);
  if (!tree) {
    toast('データが更新されたため読めませんでした');
    return;
  }
  state.tree = tree;
  state.treeFrom = 'saved';
  state.treeName = x.name;
  renderBuilder();
  syncTreeUrl();
}

/** 部品を選ぶ小窓。その口に付く部品を、いまの配分で良い順に並べる */
function openPicker(path) {
  const { db, gun, tree } = state;
  const row = builderRows(db, gun, tree).find((r) => r.path === path);
  if (!row) return;
  state.pick = { path, row, sort: 'value', query: '' };
  const where = path.split('/').map((s) => db.slotLabel[s] || s).join(' › ');
  openModal(`<h2 id="modal-title">${esc(db.slotLabel[row.slot] || row.slot)}</h2>
    <p class="detail-sub">${esc(gun.s || gun.n)} ・ ${esc(where)} ・ ${db.lists[row.ref].length} 点</p>
    <div class="pick-tools">
      <input type="search" id="pick-q" placeholder="名前で絞る" aria-label="名前で絞る" autocomplete="off">
      <span class="seg" role="group" aria-label="並び">
        <button type="button" data-psort="value" aria-pressed="true">おすすめ</button>
        <button type="button" data-psort="recoil" aria-pressed="false">反動</button>
        <button type="button" data-psort="ergo" aria-pressed="false">エルゴ</button>
      </span>
    </div>
    <p class="detail-p muted">※部品単体の数値。下の口は選んだあとで埋まる</p>
    <ul class="pick-list" id="pick-list"></ul>`);
  renderPickList();
}

function renderPickList() {
  const box = document.getElementById('pick-list');
  if (!box || !state.pick) return;
  const { db, gun, cond, builds } = state;
  const { row, sort, query } = state.pick;
  const s = builds ? rawWeight(state.mix / MIX_STEPS, builds.scale) : 0.5;
  const value = (m) => s * (m.e || 0) - (1 - s) * (m.r || 0);
  const norm = normalizeQuery(query);
  let list = db.lists[row.ref].map((i) => db.mods[i])
    .filter((m) => !norm || normalizeQuery(`${m.n} ${m.s || ''}`).includes(norm));
  const sorters = {
    value: (a, b) => value(b) - value(a),
    recoil: (a, b) => (a.r || 0) - (b.r || 0) || (b.e || 0) - (a.e || 0),
    ergo: (a, b) => (b.e || 0) - (a.e || 0) || (a.r || 0) - (b.r || 0),
  };
  list.sort(sorters[sort]);
  // 手に入らないものは後ろへ。選べはする（先の計画を立てるのに使える）
  list = [...list.filter((m) => sourceOf(m, cond, gun)), ...list.filter((m) => !sourceOf(m, cond, gun))];
  const cur = row.mod ? row.mod.i : null;
  box.innerHTML = (row.required ? '' : `<li><button type="button" class="pick-row none-row" data-pick="none">
      <span class="pn">${row.mod ? '外す' : '付けない'}</span></button></li>`)
    + list.map((m) => `<li><button type="button" class="pick-row${m.i === cur ? ' cur' : ''}" data-pick="${m.i}" title="${esc(m.n)}"
        ${m.i === cur ? 'aria-current="true"' : ''}>
        ${partThumb(m.id)}
        <span class="pn">${esc(m.s || m.n)}${m.i === cur ? ' <small>（いま）</small>' : ''}</span>
        <span class="pm">${partEffect(m)}</span>
        ${sourceTag(sourceOf(m, cond, gun))}
      </button></li>`).join('')
    + (list.length ? '' : '<li class="none">該当なし</li>');
  for (const b of document.querySelectorAll('[data-psort]')) b.setAttribute('aria-pressed', String(b.dataset.psort === sort));
}

function onPickClick(ev) {
  if (!state.pick) return;
  const sortBtn = ev.target.closest('[data-psort]');
  if (sortBtn) {
    state.pick.sort = sortBtn.dataset.psort;
    renderPickList();
    return;
  }
  const pick = ev.target.closest('[data-pick]');
  if (!pick) return;
  const { db, gun, cond, builds } = state;
  const mod = pick.dataset.pick === 'none' ? null : Number(pick.dataset.pick);
  const s = builds ? rawWeight(state.mix / MIX_STEPS, builds.scale) : 0.5;
  state.tree = setPart(db, gun, cond, state.tree, state.pick.path, mod, s);
  closeModal();
  renderBuilder();
  syncTreeUrl();
}

/* ------------------------------------------------------------ 弾 */

/**
 * その銃で撃てる弾の表。貫通は棒でも出し、アーマークラス × 10 の目盛りを引く。
 * 「貫通がクラス × 10 以上なら、新品のそのクラスでも抜きやすい」という、よく使われる目安。
 * 実際に抜けるかは、アーマーの耐久や当たり方で変わる。
 */
function ammoSection(gun) {
  const list = ammoFor(state.db, gun, state.ammoSort);
  if (!list.length) return '';
  return `<section aria-labelledby="h-ammo" id="ammo" class="gtab" data-tab="ammo">
    <h2 id="h-ammo">弾 <small>${list.length} 種</small></h2>
    <div class="table-scroll">${ammoTable(list)}</div>
    <p class="note">※目盛りはアーマークラス × 10。越えるほどそのクラスを抜きやすい（目安）。反動は銃の反動に足される</p>
  </section>`;
}

function ammoTable(list) {
  const cond = { ...state.cond, budget: 0 }; // 弾は予算の対象にしない
  const th = (key, labelText, cls = 'num') => {
    const on = state.ammoSort === key;
    return `<th scope="col" class="${cls}" aria-sort="${on ? (key === 'r' ? 'ascending' : 'descending') : 'none'}">
      <button type="button" class="sort${on ? ' on' : ''}" data-asort="${key}">${labelText}</button></th>`;
  };
  const ticks = [1, 2, 3, 4, 5, 6].map((c) =>
    `<span style="left:${(c * 10 / PEN_MAX) * 100}%">${c}</span>`).join('');
  const rows = list.map((a) => {
    const src = sourceOf(a, cond, null);
    const never = !(a.b || a.bt || a.fl !== undefined);
    const dmg = a.pc ? `${a.dmg}<small>×${a.pc}</small>` : String(a.dmg);
    // 入手先は狭い画面では名前の下に回す（Peacekeeper のような長い名前が列からはみ出すため）
    return `<tr>
      <th scope="row"><div class="ammo-name">${partThumb(a.id)}
        <span><b>${esc(a.s || a.n)}</b>${a.tr ? '<span class="tag tracer">曳光</span>' : ''}
        <small>${esc(a.n)}</small><span class="m-src">${sourceTag(src, never)}</span></span></div></th>
      <td class="num">${dmg}</td>
      <td class="num pen">${a.pen}</td>
      <td class="penbar-cell"><span class="penbar"><i style="width:${Math.min(100, (a.pen / PEN_MAX) * 100)}%"></i></span></td>
      <td class="num">${a.ad}%</td>
      <td class="num">${a.fg}%</td>
      <td class="num">${a.v}</td>
      <td class="num">${a.r ? `${signed(a.r)}%` : '—'}</td>
      <td>${sourceTag(src, never)}</td>
    </tr>`;
  }).join('');
  return `<table class="ammo" id="ammo-table">
    <thead><tr>
      <th scope="col">弾</th>
      ${th('dmg', 'ダメージ')}
      ${th('pen', '貫通')}
      <th scope="col" class="penbar-cell"><span class="pen-ticks" aria-label="アーマークラスの目安">${ticks}</span></th>
      ${th('ad', 'アーマー')}
      ${th('fg', '断片化')}
      ${th('v', '初速')}
      ${th('r', '反動')}
      <th scope="col">入手</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

/* ------------------------------------------------------------ 部品の詳細・使い方 */

function openPart(i) {
  const { db } = state;
  const m = db.mods[i];
  if (!m) return;
  const gun = state.gun;
  const tr = (t) => esc(db.traders[t].name);

  const where = [];
  if (gun && gun.defaults.has(m.i)) where.push(['この銃の標準部品', '']);
  for (const [t, ll, price, quest] of m.b || []) {
    where.push([`${tr(t)} LL${ll}（Lv${state.db.traders[t].levels[ll - 1] || 1}〜）${quest ? `・要タスク${quest > 1 ? ` Lv${quest}〜` : ''}` : ''}`, rub(price)]);
  }
  for (const [t, ll, quest] of m.bt || []) {
    where.push([`${tr(t)} LL${ll}（Lv${state.db.traders[t].levels[ll - 1] || 1}〜）交換${quest ? `・要タスク${quest > 1 ? ` Lv${quest}〜` : ''}` : ''}`, '']);
  }
  where.push(m.fl !== undefined
    ? [`フリマ${m.fl ? `（Lv${m.fl}〜）` : ''}`, '相場は tarkov.dev']
    : ['フリマ不可', '']);
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
        <p class="detail-p"><a href="${hashFor('items', [], { open: m.id })}">アイテムの用途へ</a></p>
      </section>`
    : '';

  openModal(`<div class="detail-top">
      <span class="detail-pic inv"><img alt="" src="${itemImage(m.id, 'base-image')}"
            onerror="this.onerror=null;this.src='${itemImage(m.id)}'"></span>
      <div>
        <h2 id="modal-title">${esc(m.n)}</h2>
        <p class="detail-sub">${m.s ? esc(m.s) : ''}</p>
        <div class="need">${sourceTag(src)}</div>
      </div>
    </div>
    <section class="detail-sec"><h3>数値</h3>
      <ul class="kv">${stats.map(([k, v]) => `<li><span>${k}</span><b>${v}</b></li>`).join('')}</ul>
    </section>
    <section class="detail-sec"><h3>入手</h3>
      <ul class="kv">${where.map(([k, v]) => `<li><span>${k}</span><b>${v}</b></li>`).join('')}</ul>
    </section>
    ${useBlock}
    <div class="detail-links">
      ${m.dev ? `<a href="${DEV}${esc(m.dev)}" target="_blank" rel="noopener noreferrer">tarkov.dev（相場）</a>` : ''}
    </div>`);
}

/** 使い方と計算のきまり。画面には書かず、ここ 1 か所にまとめる */
function openHelp() {
  const gun = state.gun;
  const li = (items) => `<ul class="help-list">${items.map((x) => `<li>${x}</li>`).join('')}</ul>`;
  openModal(`<h2 id="modal-title">使い方</h2>
    <section class="detail-sec"><h3>画面</h3>${li([
      '<b>おすすめ 3 通り</b> — 反動最小・バランス・エルゴ最大。バランスは、反動の減りとエルゴの伸びを両端の差でそろえ、同じ重さで足したもの',
      '<b>部品の比較</b> — 色の付いた行は 3 通りで部品が違うところ。部品を押すと数値と入手先',
      '<b>反動とエルゴ</b> — 点はこの銃で作れる組み合わせの限界（これより右上は作れない）。点かスライダーで配分を選ぶ',
      '<b>自分で組む</b> — 口ごとに部品を替える。下の口は、付くものは引き継ぎ、残りはスライダーの配分で埋まる。「共有」で URL をコピー',
      '<b>弾</b> — この銃で撃てる弾。見出しを押すと並べ替え',
    ])}</section>
    <section class="detail-sec"><h3>計算のきまり</h3>${li([
      `反動 = 素の反動 × (1 + 部品の補正の合計)。エルゴ = 素のエルゴ + 部品の合計（上限 100）${gun ? `。${esc(gun.s || gun.n)} の素は 縦 ${gun.rv} / 横 ${gun.rh}、エルゴ ${trim1(gun.e)}` : ''}`,
      'エルゴが 100 を超えるときは、100 に届く範囲でいちばん反動の小さいものを選ぶ',
      'マガジンは標準と同じ装弾数以上から（自分で組むときはどれでも可）',
      '同時に付けられない部品は tarkov.dev の相性データで避ける。データの漏れはゲーム内で確かめて',
      '「個別に」で決めたトレーダーはその LL、ほかは左の LL まで',
      'プレイヤー Lv を決めると、トレーダーの LL はそのレベルで上がれるところまで（信頼度・取引額は足りている前提）。フリマは Lv15 から、部品ごとの解放レベルも見る。タスクで解放される品物は、そのタスク（前提のタスクを含む）を受けられるレベルから',
      '予算は部品代だけ。値段で少しずつ安い部品へ寄せて探すので、予算ちょうどの最良とは限らない（必ず収まる）',
    ])}</section>`);
}

/** 画面に残す注記。詳しいことは「使い方」へ */
function notes() {
  const q = (title, body) => `<details class="acc"><summary>${title}</summary><div class="acc-body">${body}</div></details>`;
  return `<section aria-labelledby="h-notes">
    <h2 id="h-notes">注記</h2>
    ${q('入っていない部品', `<p>スコープ・ドットサイト・ライト・レーザーは入れていない（反動に効かず、エルゴが下がるだけ）。
      サプレッサーは条件で入れたときだけ。PB・VSS のような一体型は残す。M4A1 などは許してもマズルブレーキのほうが効くので選ばれない。</p>`)}
    ${q('値段', `<p>定価はトレーダーから現金で買う部品だけの合計。フリマと交換の部品は入らない（※の付いた合計）。
      フリマの相場は毎日動くので持っていない。部品の詳細から tarkov.dev へ。</p>`)}
    ${q('データの時点', `<p>${esc(state.db.builtAt)} に tarkov.dev から取り込み。アップデートで数値が変わることがあるので、ゲーム内のウェポンビルダーで確かめてから買うこと。</p>`)}
  </section>`;
}

function sameCaliberHtml(gun) {
  const list = sameCaliber(state.db, gun);
  if (!list.length) return '';
  return `<section class="same-cal">
    ${carouselHtml({
      label: `同じ口径（${gun.cal}）の銃`,
      title: `<h2 class="h-sub">同じ口径 <small>${esc(gun.cal)} ・ ${list.length} 丁</small></h2>`,
      items: list.map(gunCard),
    })}
  </section>`;
}

function pageFoot() {
  return `<footer class="page-foot">
    <p>データ・画像: <a href="https://tarkov.dev/" target="_blank" rel="noopener noreferrer">tarkov.dev</a>（${esc(state.db.builtAt)} 取り込み）</p>
    <p>非公式のファンツールです。Battlestate Games とは無関係で、承認も受けていません。</p>
  </footer>`;
}

/* ------------------------------------------------------------------ 操作 */

function onClick(ev) {
  const gtab = ev.target.closest('[data-gtab]');
  if (gtab) {
    showTab(gtab.dataset.gtab);
    syncTabUrl();
    return;
  }
  const ll = ev.target.closest('[data-ll]');
  if (ll) {
    // 全員まとめての LL。個別の設定は消す
    setStore({ ll: Number(ll.dataset.ll), tl: {}, level: 0 });
    return;
  }
  const tl = ev.target.closest('[data-tl]');
  if (tl) {
    state.tlOpen = true;
    setStore({ tl: { ...(state.store.tl || {}), [tl.dataset.tr]: Number(tl.dataset.tl) }, level: 0 });
    return;
  }
  const part = ev.target.closest('.part[data-mod]');
  if (part) {
    openPart(Number(part.dataset.mod));
    return;
  }
  const start = ev.target.closest('[data-start]');
  if (start) {
    startTree(start.dataset.start);
    syncTreeUrl();
    return;
  }
  const pickBtn = ev.target.closest('[data-bld-pick]');
  if (pickBtn) {
    openPicker(pickBtn.dataset.bldPick);
    return;
  }
  const drop = ev.target.closest('[data-bld-drop]');
  if (drop) {
    state.tree = setPart(state.db, state.gun, state.cond, state.tree, drop.dataset.bldDrop, null, 0.5);
    renderBuilder();
    syncTreeUrl();
    return;
  }
  const lvRow = ev.target.closest('[data-lv]');
  if (lvRow) {
    state.tab = 'best';
    state.ctx.query.delete('tab');
    setStore({ level: Number(lvRow.dataset.lv) });
    document.querySelector('.gtabs')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  const asort = ev.target.closest('[data-asort]');
  if (asort) {
    state.ammoSort = asort.dataset.asort;
    const table = document.getElementById('ammo-table');
    if (table) table.outerHTML = ammoTable(ammoFor(state.db, state.gun, state.ammoSort));
    return;
  }
  const act = ev.target.closest('[data-act]');
  if (act && act.dataset.act === 'help') {
    openHelp();
    return;
  }
  if (act && act.dataset.act === 'copy') {
    copyUrl(location.href.replace(/[?&]b=[^&]*/, ''));
    return;
  }
  if (act && act.dataset.act === 'save-build') {
    saveBuild();
    return;
  }
  const load = ev.target.closest('[data-load]');
  if (load) {
    loadSaved(load.dataset.load);
    return;
  }
  const del = ev.target.closest('[data-del]');
  if (del) {
    writeStore(SAVED_KEY, readStore(SAVED_KEY, []).filter((x) => x.id !== del.dataset.del));
    toast('削除しました');
    if (state.gun) renderBuilder();
    else renderIndex();
    return;
  }
  if (act && act.dataset.act === 'copy-build') {
    syncTreeUrl();
    copyUrl(location.href);
    return;
  }
  // 一覧の行は、どこを押してもその銃へ（名前のリンクはキーボードで辿れるように残す）
  const row = ev.target.closest('tr[data-href]');
  if (row && !ev.target.closest('a')) location.hash = row.dataset.href;
}

function onChange(ev) {
  const t = ev.target;
  if (t.dataset.cond) {
    setStore({ [t.dataset.cond]: t.checked });
  } else if (t.id === 'plevel') {
    const v = Math.max(0, Math.min(79, Math.round(Number(t.value) || 0)));
    setStore({ level: v });
  } else if (t.id === 'budget') {
    const v = Math.max(0, Math.round(Number(t.value) || 0));
    setStore({ budget: v });
  } else if (t.id === 'gun-sort') {
    setQuery({ sort: t.value });
    renderGunRows();
  } else if (t.id === 'diff-only') {
    document.getElementById('compare').classList.toggle('diff-only', t.checked);
  } else if (t.id === 'bld-empty') {
    state.showEmpty = t.checked;
    renderBuilder();
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

// 「個別に」を開いているかどうか（描き直しても閉じないように）
document.addEventListener('toggle', (ev) => {
  if (ev.target.classList && ev.target.classList.contains('cond-more')) state.tlOpen = ev.target.open;
}, true);

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

async function copyUrl(url) {
  try {
    await navigator.clipboard.writeText(url);
    toast('URL をコピーしました');
  } catch {
    toast('コピーできませんでした。アドレス欄からどうぞ');
  }
}
