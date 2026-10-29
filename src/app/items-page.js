/**
 * アイテムの用途の画面（#/items）。
 *
 * もとは items.html という別ページで、地図から別タブで開いていた。
 * 同じページの中の画面にしたので、行き来してもフォルダの監視が止まらない。
 *
 * 状態は URL に写す（?q= ?cat= ?use= ?sort= ?open=）。人に送ったり、
 * カスタムの部品の詳細から「このアイテムを開いた状態」で飛んできたりできる。
 * 画像は tarkov.dev の CDN から取る。URL はアイテムの ID から組み立てられる。
 */

import {
  loadItems, searchItems, useKinds, hideoutTotal, useSummary, hideoutStations,
} from './items.js';
import { hashFor } from './router.js';
import {
  escapeHtml as esc, crumbs, openModal, loadMeta, itemImage, readStore, writeStore,
} from './ui.js';

/** ハイドアウトの進み具合（施設の名前 → いまのレベル）。このブラウザの中だけに置く */
const HIDEOUT_KEY = 'eft-gps.hideout';

/** タスクの Wiki。データにはページ名だけを持たせている */
const WIKI = 'https://escapefromtarkov.fandom.com/wiki/';
/**
 * tarkov.dev のアイテムページ。
 * 相場はこちらでは持たず、常に最新が出る向こうへ送る。
 */
const DEV = 'https://tarkov.dev/item/';

const USES = [
  ['h', 'ハイドアウト'],
  ['t', 'タスク'],
  ['b', 'トレーダーとの交換'],
  ['c', '製作'],
  ['fir', 'FiR が要るもの'],
];
const SORTS = [
  ['uses', '用途の多い順'],
  ['hideout', 'ハイドアウトで要る数'],
  ['task', 'タスクの件数'],
  ['name', '名前順'],
];

const state = {
  el: null,
  items: null,
  list: [],
  cats: [],
  query: '',
  uses: new Set(),
  cat: '',
  sort: 'uses',
  /** ハイドアウトの進み具合。空なら「まだ何も建てていない」ではなく「使わない」扱い */
  hp: readStore(HIDEOUT_KEY, {}),
  stations: [],
};

/** 進み具合を 1 つでも入れていれば、残りで数える */
const progress = () => (Object.keys(state.hp).length ? state.hp : null);

/* ------------------------------------------------------------------ 入口 */

export function mount(el) {
  state.el = el;
  el.addEventListener('input', (ev) => {
    if (ev.target.id !== 'item-q') return;
    state.query = ev.target.value;
    syncUrl();
    renderGrid();
  });
  el.addEventListener('change', (ev) => {
    const t = ev.target;
    if (t.dataset.hp !== undefined) {
      const v = Number(t.value);
      state.hp = { ...state.hp, [t.dataset.hp]: v };
      writeStore(HIDEOUT_KEY, state.hp);
      const panel = document.querySelector('.hp summary');
      if (panel && !panel.querySelector('small')) panel.insertAdjacentHTML('beforeend', ' <small>入力済み</small>');
      renderGrid();
      return;
    }
    if (t.dataset.use) {
      if (t.checked) state.uses.add(t.dataset.use);
      else state.uses.delete(t.dataset.use);
    } else if (t.id === 'item-sort') {
      state.sort = t.value;
    } else {
      return;
    }
    syncUrl();
    renderGrid();
  });
  el.addEventListener('click', (ev) => {
    if (ev.target.closest('[data-act="hp-reset"]')) {
      state.hp = {};
      writeStore(HIDEOUT_KEY, {});
      const open = document.querySelector('details.hp')?.open;
      render();
      if (open) document.querySelector('details.hp').open = true;
      return;
    }
    const card = ev.target.closest('.item-card');
    if (card) openDetail(card.dataset.id);
  });
}

export async function show(el, ctx) {
  if (!state.items) {
    el.innerHTML = '<div class="page-inner"><p class="loading">読み込み中…</p></div>';
    try {
      const meta = await loadMeta();
      const items = await loadItems(meta.itemFile);
      if (items.failed) throw new Error(items.failed);
      state.items = items;
    } catch (err) {
      el.innerHTML = `<div class="page-inner"><p class="empty">アイテムのデータを読めませんでした（${esc(err.message || err)}）</p></div>`;
      return;
    }
    state.list = Object.entries(state.items).map(([id, it]) => ({ id, ...it }));
    // 分類は実際に出てくるものだけを並べる。使わない選択肢は迷うだけ
    const cats = new Map();
    for (const it of state.list) if (it.cat) cats.set(it.cat, (cats.get(it.cat) || 0) + 1);
    state.cats = [...cats.entries()].sort((a, b) => b[1] - a[1]);
    state.stations = hideoutStations(state.items);
  }

  const q = ctx.query;
  state.query = q.get('q') || '';
  state.cat = q.get('cat') || '';
  state.uses = new Set((q.get('use') || '').split(',').filter(Boolean));
  state.sort = SORTS.some(([k]) => k === q.get('sort')) ? q.get('sort') : 'uses';
  render();
  el.scrollTop = 0;

  // ?open= は「開いた状態で来る」ためだけのもの。開いたら URL から消して、
  // 再読み込みのたびに詳細が出てくることのないようにする
  const open = q.get('open');
  if (open && state.items[open]) {
    openDetail(open);
    syncUrl();
  }
}

/* ------------------------------------------------------------------ 画面 */

function render() {
  document.title = `${state.cat || 'アイテムの用途'} — EFT GPS`;
  const catLink = (cat, label, n) => {
    const href = hashFor('items', [], { cat, q: state.query, use: [...state.uses].join(','), sort: state.sort === 'uses' ? '' : state.sort });
    return `<a href="${href}"${state.cat === cat ? ' aria-current="page"' : ''}>
      <span>${esc(label)}</span><span class="n">${n}</span></a>`;
  };

  state.el.innerHTML = `<div class="page-inner">
    ${crumbs([
      { label: 'EFT GPS', href: '#/map' },
      { label: 'アイテムの用途', href: state.cat ? '#/items' : null },
      ...(state.cat ? [{ label: state.cat }] : []),
    ])}
    <header class="page-head">
      <h1>${state.cat ? esc(state.cat) : 'アイテムの用途'}</h1>
      <p class="lede">ハイドアウト・タスク・交換・製作で、どこに何個使うか。</p>
    </header>
    <div class="with-side">
      <aside class="side" aria-label="絞り込み">
        ${hideoutPanel()}
        <h2 class="side-h">分類</h2>
        <nav class="side-nav" aria-label="分類">
          ${catLink('', 'すべて', state.list.length)}
          ${state.cats.map(([name, n]) => catLink(name, name, n)).join('')}
        </nav>
        <h2 class="side-h">用途</h2>
        <div class="side-checks">
          ${USES.map(([k, label]) => `<label class="check"><input type="checkbox" data-use="${k}"
              ${state.uses.has(k) ? 'checked' : ''}><span>${label}</span></label>`).join('')}
        </div>
      </aside>
      <div class="side-main">
        <div class="list-tools">
          <input type="search" id="item-q" value="${esc(state.query)}" autocomplete="off"
                 placeholder="電線 / wires / ｹｸﾃｰﾌﾟ …" aria-label="アイテム名で探す">
          <label class="sel">並び
            <select id="item-sort">${SORTS.map(([k, label]) =>
              `<option value="${k}"${state.sort === k ? ' selected' : ''}>${label}</option>`).join('')}</select>
          </label>
          <span class="count" id="item-count"></span>
        </div>
        <div id="item-grid" class="item-grid"></div>
        <p id="item-empty" class="empty" hidden></p>
      </div>
    </div>
    <footer class="page-foot">
      <p>データ・画像: <a href="https://tarkov.dev/" target="_blank" rel="noopener noreferrer">tarkov.dev</a>。
        相場は毎日動くので持っていない（各アイテムから tarkov.dev へ）。</p>
      <p>非公式のファンツールです。Battlestate Games とは無関係で、承認も受けていません。</p>
    </footer>
  </div>`;
  renderGrid();
}

/**
 * ハイドアウトの進み具合。施設ごとに、いま建っているレベルを選ぶ。
 * 1 つでも入れると、一覧と詳細の「ハイドアウト ○ 個」が残りの数になる
 */
function hideoutPanel() {
  const set = Object.keys(state.hp).length;
  const rows = state.stations.map(([st, max]) => {
    const cur = state.hp[st] || 0;
    const opts = Array.from({ length: max + 1 }, (_, lv) =>
      `<option value="${lv}"${lv === cur ? ' selected' : ''}>${lv === 0 ? '未建設' : `Lv${lv}`}${lv === max ? '（最大）' : ''}</option>`).join('');
    return `<label class="hp-row"><span>${esc(st)}</span><select data-hp="${esc(st)}">${opts}</select></label>`;
  }).join('');
  return `<details class="hp">
    <summary>ハイドアウトの進み具合${set ? ' <small>入力済み</small>' : ''}</summary>
    <p class="hp-note">※いまのレベルを選ぶと、ハイドアウトで要る数が残りの分になる。このブラウザだけに保存</p>
    <div class="hp-rows">${rows}</div>
    ${set ? '<button type="button" class="btn mini" data-act="hp-reset">消す</button>' : ''}
  </details>`;
}

function filtered() {
  let rows = state.query.trim()
    ? searchItems(state.items, state.query, 2000).map((it) => ({ ...it }))
    : state.list.slice();

  if (state.cat) rows = rows.filter((it) => it.cat === state.cat);
  for (const u of state.uses) {
    rows = u === 'fir'
      ? rows.filter((it) => it.fir)
      : u === 'h' ? rows.filter((it) => hideoutTotal(it, progress()) > 0)
        : rows.filter((it) => (it[u] || []).length);
  }

  const byName = (a, b) => String(a.n).localeCompare(String(b.n), 'ja');
  const sorters = {
    uses: (a, b) => useKinds(b, progress()) - useKinds(a, progress())
      || hideoutTotal(b, progress()) - hideoutTotal(a, progress()) || byName(a, b),
    hideout: (a, b) => hideoutTotal(b, progress()) - hideoutTotal(a, progress()) || byName(a, b),
    task: (a, b) => (b.t || []).length - (a.t || []).length || byName(a, b),
    name: byName,
  };
  rows.sort(sorters[state.sort] || sorters.uses);
  return rows;
}

function renderGrid() {
  const rows = filtered();
  const grid = document.getElementById('item-grid');
  const empty = document.getElementById('item-empty');
  grid.innerHTML = '';
  document.getElementById('item-count').textContent = `${rows.length} / ${state.list.length} 種`;

  if (!rows.length) {
    empty.hidden = false;
    empty.innerHTML = state.query.trim()
      ? `「${esc(state.query.trim())}」は該当なし。ゲーム内の名前か英語名で。`
        + `<br>※載っているのは、ハイドアウト・タスク・交換・製作に出てくる ${state.list.length} 種だけ`
      : '該当なし。';
    return;
  }
  empty.hidden = true;

  // 1000 件以上を一度に描くと重いので、先頭だけ描く
  const LIMIT = 400;
  const frag = document.createDocumentFragment();
  for (const it of rows.slice(0, LIMIT)) frag.appendChild(card(it));
  grid.appendChild(frag);
  if (rows.length > LIMIT) {
    const more = document.createElement('p');
    more.className = 'empty';
    more.textContent = `ほか ${rows.length - LIMIT} 種（検索か絞り込みで）`;
    grid.appendChild(more);
  }
}

function card(it) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'item-card';
  el.dataset.id = it.id;
  el.innerHTML =
    `<span class="pic inv"><img loading="lazy" decoding="async" alt=""` +
    ` src="${itemImage(it.id)}" onerror="this.style.visibility='hidden'"></span>` +
    '<span class="txt">' +
    `<span class="nm">${esc(it.n)}</span>` +
    `<span class="en">${esc(it.ne || it.s || '')}</span>` +
    `<span class="use">${esc(useSummary(it, progress()))}</span>` +
    (it.fir ? '<span class="tag fir">FiR</span>' : '') +
    '</span>';
  return el;
}

/** 検索語や絞り込みを URL に写す。履歴は増やさない（戻るで 1 文字ずつ戻るのは困る） */
function syncUrl() {
  history.replaceState(null, '', hashFor('items', [], {
    q: state.query.trim(),
    cat: state.cat,
    use: [...state.uses].join(','),
    sort: state.sort === 'uses' ? '' : state.sort,
  }));
}

/* ------------------------------------------------------------------ 詳細 */

function openDetail(id) {
  const it = state.items[id];
  if (!it) return;

  // what に href を添えると、その行を Wiki へのリンクにする
  const section = (title, total, rows, sumLabel = '合計') => {
    if (!rows.length) return '';
    const sum = total !== undefined ? ` <small>${sumLabel} <b>${total} 個</b></small>` : '';
    return `<section class="detail-sec"><h3>${title}${sum}</h3><ul class="kv">` +
      rows.map(([what, c, href]) => {
        const label = href
          ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(what)}</a>`
          : esc(what);
        return `<li><span>${label}</span><b>${esc(c)}</b></li>`;
      }).join('') +
      '</ul></section>';
  };

  openModal(
    `<div class="detail-top">
       <span class="detail-pic inv"><img alt="" src="${itemImage(id, 'base-image')}"
             onerror="this.onerror=null;this.src='${itemImage(id)}'"></span>
       <div>
         <h2 id="modal-title">${esc(it.n)}</h2>
         <p class="detail-sub">${esc(it.ne || '')}${it.s ? ` / ${esc(it.s)}` : ''}${it.cat ? ` ・ ${esc(it.cat)}` : ''}</p>
         ${it.fir ? '<div class="need"><span class="tag fir">レイド発見品（FiR）が必要</span></div>' : ''}
       </div>
     </div>` +
    section('ハイドアウトの建設', hideoutTotal(it, progress()),
      (it.h || []).map(([st, lv, c]) => [`${st} Lv${lv}`,
        progress() && lv <= (state.hp[st] || 0) ? `済（${c} 個）` : `${c} 個`]),
      progress() ? '残り' : '合計') +
    section('タスク', undefined,
      (it.t || []).map(([nm, c, alt, slug]) => [
        nm,
        alt > 1 ? `${c} 個（${alt} 択）` : `${c} 個`,
        slug ? WIKI + slug : null,
      ])) +
    section('トレーダーとの交換で渡す', undefined,
      (it.b || []).map(([tr, lv, got, c]) => [`${tr} Lv${lv} → ${got}`, `${c} 個`])) +
    section('製作の材料', undefined,
      (it.c || []).map(([st, lv, prod, c]) => [`${st} Lv${lv} → ${prod}`, `${c} 個`])) +
    section('製作の道具として使う', undefined,
      (it.tool || []).map(([st, lv, prod]) => [`${st} Lv${lv} → ${prod}`, '減らない'])) +
    (it.out ? `<section class="detail-sec"><h3>自分で作れる</h3>
       <p class="detail-p">ハイドアウトで作れる（${it.out} 通り）</p></section>` : '') +
    (useKinds(it) === 0 ? '<p class="detail-p">用途の登録なし</p>' : '') +
    (it.fir
      ? '<p class="detail-p muted">※FiR はフリマで買えない。レイドで拾うこと</p>'
      : '') +
    '<div class="detail-links">' +
    (it.dev ? `<a href="${DEV}${esc(it.dev)}" target="_blank" rel="noopener noreferrer">tarkov.dev（相場）</a>` : '') +
    (it.w ? `<a href="${WIKI}${esc(it.w)}" target="_blank" rel="noopener noreferrer">Wiki</a>` : '') +
    '</div>',
  );
}
