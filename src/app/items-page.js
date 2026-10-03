/**
 * items.html の中身。
 *
 * 用途の一覧は情報が多く、地図の脇に置くと両方が読みにくくなるので別ページに分けた。
 * 画像は tarkov.dev の CDN から取る。URL はアイテムの ID から組み立てられるので、
 * データに持たせる必要はない（634 件ぶんの URL は 50KB 近くになる）。
 */

import { loadMapDb } from '../mapdb/index.js';
import {
  loadItems, searchItems, useKinds, hideoutTotal, useSummary,
} from './items.js';
import { normalizeQuery } from './tasks.js';

const $ = (id) => document.getElementById(id);

const state = {
  items: {},
  list: [],
  query: '',
  uses: new Set(),
  cat: '',
  sort: 'uses',
};

/** 在庫画像の URL。ID から組み立てる。 */
const gridImage = (id) => `https://assets.tarkov.dev/${id}-grid-image.webp`;
const bigImage = (id) => `https://assets.tarkov.dev/${id}-base-image.webp`;

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/* ------------------------------------------------------------------ 起動 */

async function boot() {
  const db = await loadMapDb('./data/');
  state.items = await loadItems(db.itemFile);
  if (state.items.failed) {
    $('empty').hidden = false;
    $('empty').textContent = `アイテムのデータを読めませんでした（${state.items.failed}）`;
    return;
  }
  state.list = Object.entries(state.items).map(([id, it]) => ({ id, ...it }));

  // 分類は実際に出てくるものだけを並べる。使わない選択肢は迷うだけ
  const cats = new Map();
  for (const it of state.list) {
    if (it.cat) cats.set(it.cat, (cats.get(it.cat) || 0) + 1);
  }
  const sel = $('cat');
  for (const [name, n] of [...cats.entries()].sort((a, b) => b[1] - a[1])) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = `${name}（${n}）`;
    sel.appendChild(opt);
  }

  $('q').addEventListener('input', (ev) => { state.query = ev.target.value; render(); });
  $('useFilter').addEventListener('change', () => {
    state.uses = new Set(
      [...$('useFilter').querySelectorAll('input')].filter((i) => i.checked).map((i) => i.value),
    );
    render();
  });
  sel.addEventListener('change', () => { state.cat = sel.value; render(); });
  $('sort').addEventListener('change', () => { state.sort = $('sort').value; render(); });

  $('grid').addEventListener('click', (ev) => {
    const card = ev.target.closest('.card');
    if (card) openDetail(card.dataset.id);
  });
  $('detail').addEventListener('click', (ev) => {
    if (ev.target.id === 'detail' || ev.target.id === 'close') closeDetail();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') closeDetail();
  });

  // ?q= で開いたときの初期検索（地図側からの受け渡しに使う）
  const q = new URLSearchParams(location.search).get('q');
  if (q) {
    $('q').value = state.query = q;
  }
  render();
}

/* ------------------------------------------------------------------ 一覧 */

function filtered() {
  let rows = state.query.trim()
    ? searchItems(state.items, state.query, 2000).map((it) => ({ ...it }))
    : state.list.slice();

  if (state.cat) rows = rows.filter((it) => it.cat === state.cat);
  for (const u of state.uses) {
    rows = u === 'fir'
      ? rows.filter((it) => it.fir)
      : rows.filter((it) => (it[u] || []).length);
  }

  const byName = (a, b) => String(a.n).localeCompare(String(b.n), 'ja');
  const sorters = {
    uses: (a, b) => useKinds(b) - useKinds(a)
      || hideoutTotal(b) - hideoutTotal(a) || byName(a, b),
    hideout: (a, b) => hideoutTotal(b) - hideoutTotal(a) || byName(a, b),
    task: (a, b) => (b.t || []).length - (a.t || []).length || byName(a, b),
    name: byName,
  };
  rows.sort(sorters[state.sort] || sorters.uses);
  return rows;
}

function render() {
  const rows = filtered();
  const grid = $('grid');
  grid.innerHTML = '';
  $('count').textContent = `${rows.length} / ${state.list.length} 種`;

  if (!rows.length) {
    $('empty').hidden = false;
    $('empty').innerHTML = state.query.trim()
      ? `「${escapeHtml(state.query.trim())}」に一致するアイテムはありません。<br>`
        + 'ゲーム内の表示名か英語名で探してください。'
        + '用途が分かっているのは、ハイドアウト・タスク・交換・製作に出てくる 634 種だけです。'
      : '絞り込みに一致するアイテムがありません。';
    return;
  }
  $('empty').hidden = true;

  // 1000 件以上を一度に描くと重いので、先頭だけ描いて残りは必要になったら足す
  const frag = document.createDocumentFragment();
  for (const it of rows.slice(0, 400)) frag.appendChild(card(it));
  grid.appendChild(frag);
  if (rows.length > 400) {
    const more = document.createElement('div');
    more.className = 'empty';
    more.textContent = `ほか ${rows.length - 400} 種。検索か絞り込みで減らしてください。`;
    grid.appendChild(more);
  }
}

function card(it) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'card';
  el.dataset.id = it.id;
  el.innerHTML =
    `<span class="pic"><img loading="lazy" decoding="async" alt=""` +
    ` src="${gridImage(it.id)}" onerror="this.style.display='none'"></span>` +
    `<span>` +
    `<span class="nm">${escapeHtml(it.n)}</span>` +
    `<span class="en">${escapeHtml(it.ne || it.s || '')}</span>` +
    `<span class="use">${escapeHtml(useSummary(it))}</span>` +
    (it.fir ? '<span class="tags"><span class="fir">FiR</span></span>' : '') +
    `</span>`;
  return el;
}

/* ------------------------------------------------------------------ 詳細 */

function openDetail(id) {
  const it = state.items[id];
  if (!it) return;
  const panel = $('panel');

  const section = (title, total, rows) => {
    if (!rows.length) return '';
    const sum = total !== undefined ? ` 合計 <b>${total} 個</b>` : '';
    return `<section><h3>${title}${sum}</h3><ul>` +
      rows.map(([what, c]) =>
        `<li><span>${escapeHtml(what)}</span><span class="c">${escapeHtml(c)}</span></li>`).join('') +
      '</ul></section>';
  };

  panel.innerHTML =
    `<div class="top">
       <span class="pic"><img alt="" src="${bigImage(id)}"
             onerror="this.src='${gridImage(id)}'"></span>
       <div>
         <h2 id="dtitle">${escapeHtml(it.n)}</h2>
         <div class="en2">${escapeHtml(it.ne || '')}${it.s ? ` / ${escapeHtml(it.s)}` : ''}` +
         `${it.cat ? ` ・ ${escapeHtml(it.cat)}` : ''}</div>
         <div class="tags">` +
         (it.fir ? '<span class="fir">レイド発見品(FiR)が必要</span>' : '') + `</div>
       </div>
       <button type="button" id="close" aria-label="閉じる">×</button>
     </div>
     <div class="body">` +
    section('ハイドアウトの建設', hideoutTotal(it),
      (it.h || []).map(([st, lv, c]) => [`${st} Lv${lv}`, `${c} 個`])) +
    section('タスク', undefined,
      (it.t || []).map(([nm, c, alt]) => [nm, alt > 1 ? `${c} 個（${alt} 択）` : `${c} 個`])) +
    section('トレーダーとの交換で渡す', undefined,
      (it.b || []).map(([tr, lv, got, c]) => [`${tr} Lv${lv} → ${got}`, `${c} 個`])) +
    section('製作の材料', undefined,
      (it.c || []).map(([st, lv, prod, c]) => [`${st} Lv${lv} → ${prod}`, `${c} 個`])) +
    section('製作の道具として使う', undefined,
      (it.tool || []).map(([st, lv, prod]) => [`${st} Lv${lv} → ${prod}`, '減らない'])) +
    (it.out ? `<section><h3>自分で作れる</h3>
       <div class="note">ハイドアウトの製作 ${it.out} 通りで手に入ります。</div></section>` : '') +
    (useKinds(it) === 0
      ? '<div class="note">登録された用途はありません。</div>'
      : '') +
    (it.fir
      ? '<div class="note">レイド発見品(FiR)が要るものはフリーマーケットで買えません。'
        + '見つけたその場で拾う必要があります。</div>'
      : '') +
    (it.w ? `<a class="wikilink" href="${escapeHtml(it.w)}" target="_blank"
               rel="noopener noreferrer">Wiki で詳しく見る</a>` : '') +
    '</div>';

  $('detail').hidden = false;
  $('close').focus();
}

function closeDetail() {
  $('detail').hidden = true;
}

boot().catch((err) => {
  $('empty').hidden = false;
  $('empty').textContent = `起動に失敗しました: ${err && err.message ? err.message : err}`;
});
