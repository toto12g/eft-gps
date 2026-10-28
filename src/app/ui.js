/**
 * カスタム・アイテムの画面で使う部品。パンくず・モーダル・カルーセル・知らせ。
 *
 * 地図（main.js）はこれを使わない。地図はレイド中に開きっぱなしにするもので、
 * 見た目も操作も別の考え方で作ってあるため。
 */

export const $ = (id) => document.getElementById(id);

export const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** localStorage を読む。プライベートウィンドウなどで使えなくても止まらない。 */
export function readStore(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    const v = JSON.parse(raw);
    return v === null || v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

export function writeStore(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch { /* 保存できなくても動作には影響しない */ }
}

/**
 * data/mapdb.json だけを読む。地図用の poi.bin（100KB 近い）は要らないので
 * loadMapDb は使わない。失敗はキャッシュしない（items.js と同じ理由）。
 */
let metaPromise = null;
export function loadMeta() {
  if (!metaPromise) {
    // cache: 'no-cache' の理由は src/mapdb/index.js のコメントを参照
    metaPromise = fetch('./data/mapdb.json', { cache: 'no-cache' })
      .then((r) => {
        if (!r.ok) throw new Error(`mapdb.json: ${r.status}`);
        return r.json();
      })
      .catch((err) => {
        metaPromise = null;
        throw err;
      });
  }
  return metaPromise;
}

/** tarkov.dev の画像。URL はアイテムの ID から組み立てられるので、データには持たない */
export const itemImage = (id, kind = 'grid-image') => `https://assets.tarkov.dev/${id}-${kind}.webp`;

/**
 * 部品の小さな画像。tarkov.dev の grid-image は、ゲームの持ち物の画面のアイコンそのもの
 * （背景の色と、隅の略称まで焼き込まれている）なので、ふだん見ている姿で見分けられる。
 * 取れないとき（オフラインなど）は枠だけ残して、行の高さが変わらないようにする。
 */
export const partThumb = (id) =>
  `<span class="pthumb inv"><img loading="lazy" decoding="async" alt="" src="${itemImage(id)}"
     onerror="this.style.visibility='hidden'"></span>`;

/* ------------------------------------------------------------ パンくず */

/**
 * @param {{label:string, href?:string|null}[]} items 最後が今いるページ
 */
export function crumbs(items) {
  const li = items.map((it, i) => {
    if (i === items.length - 1 || !it.href) {
      return `<li><span${i === items.length - 1 ? ' aria-current="page"' : ''}>${escapeHtml(it.label)}</span></li>`;
    }
    return `<li><a href="${escapeHtml(it.href)}">${escapeHtml(it.label)}</a></li>`;
  });
  return `<nav class="crumbs" aria-label="いまいる場所"><ol>${li.join('')}</ol></nav>`;
}

/* ------------------------------------------------------------ モーダル */

/**
 * 1 つの <dialog> を使い回す。showModal() にすると、Esc で閉じる・後ろを押せなくする・
 * 閉じたら元のボタンに戻る、をブラウザがやってくれる。
 */
export function setupModal() {
  const dlg = $('modal');
  // 枠の外（暗い背景）を押したら閉じる。<dialog> 自身に余白を持たせていないので、
  // 背景を押したときだけ target が <dialog> になる
  dlg.addEventListener('click', (ev) => {
    if (ev.target === dlg) dlg.close();
  });
  dlg.querySelector('.modal-close').addEventListener('click', () => dlg.close());
}

/** @param {string} html 中身。見出しには id="modal-title" を付ける */
export function openModal(html) {
  const dlg = $('modal');
  const body = dlg.querySelector('.modal-body');
  body.innerHTML = html;
  if (!dlg.open) dlg.showModal();
  body.scrollTop = 0;
}

export function closeModal() {
  const dlg = $('modal');
  if (dlg.open) dlg.close();
}

/* ------------------------------------------------------------ カルーセル */

const CHEVRON = (d) =>
  `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

/**
 * 横に流す並び。中身の移動は CSS の scroll-snap に任せ、ここでは
 * 前後のボタンと、いまどこを見ているかの点を付けるだけにする。
 * 勝手に流れる動きは付けない（読んでいる途中で動くと読めない）。
 *
 * @param {{label:string, title?:string, items:string[], className?:string, dots?:boolean}} o
 */
export function carouselHtml({ label, title = '', items, className = '', dots = false }) {
  return `<div class="carousel ${className}" role="region" aria-roledescription="カルーセル"
               aria-label="${escapeHtml(label)}">
      <div class="carousel-head">
        ${title}
        <div class="carousel-nav">
          <button type="button" data-dir="-1" aria-label="前へ">${CHEVRON('M10 3 5 8l5 5')}</button>
          <button type="button" data-dir="1" aria-label="次へ">${CHEVRON('M6 3l5 5-5 5')}</button>
        </div>
      </div>
      <div class="carousel-track" tabindex="0">
        ${items.map((x) => `<div class="carousel-item">${x}</div>`).join('')}
      </div>
      ${dots ? '<div class="carousel-dots"></div>' : ''}
    </div>`;
}

/** root の中のカルーセルに、ボタンと点の動きを付ける。描き直すたびに呼ぶ。 */
export function setupCarousels(root) {
  for (const box of root.querySelectorAll('.carousel:not([data-ready])')) {
    box.dataset.ready = '1';
    const track = box.querySelector('.carousel-track');
    const items = [...track.children];
    const prev = box.querySelector('[data-dir="-1"]');
    const next = box.querySelector('[data-dir="1"]');
    const dots = box.querySelector('.carousel-dots');

    if (dots) {
      dots.innerHTML = items
        .map((_, i) => `<button type="button" aria-label="${i + 1} 枚目へ"></button>`)
        .join('');
      dots.addEventListener('click', (ev) => {
        const i = [...dots.children].indexOf(ev.target.closest('button'));
        if (i >= 0) track.scrollTo({ left: items[i].offsetLeft - track.offsetLeft, behavior: 'smooth' });
      });
    }

    const update = () => {
      const max = track.scrollWidth - track.clientWidth;
      prev.disabled = track.scrollLeft <= 2;
      next.disabled = track.scrollLeft >= max - 2;
      box.classList.toggle('static', max <= 2); // 全部見えているならボタンは要らない
      if (dots) {
        const x = track.scrollLeft + track.offsetLeft;
        let at = 0;
        items.forEach((it, i) => {
          if (Math.abs(it.offsetLeft - x) < Math.abs(items[at].offsetLeft - x)) at = i;
        });
        [...dots.children].forEach((d, i) => d.setAttribute('aria-current', String(i === at)));
      }
    };
    const page = (dir) => {
      // 1 枚ぶんずつ送る。幅は並びの最初の 1 枚から測る（CSS で変わるため）
      const w = items[0] ? items[0].getBoundingClientRect().width + 12 : track.clientWidth;
      track.scrollBy({ left: dir * Math.max(w, track.clientWidth - w), behavior: 'smooth' });
    };
    prev.addEventListener('click', () => page(-1));
    next.addEventListener('click', () => page(1));
    track.addEventListener('keydown', (ev) => {
      if (ev.key === 'ArrowLeft') { ev.preventDefault(); page(-1); }
      if (ev.key === 'ArrowRight') { ev.preventDefault(); page(1); }
    });
    let pending = false;
    track.addEventListener('scroll', () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => { pending = false; update(); });
    }, { passive: true });
    new ResizeObserver(update).observe(track);
    update();
  }
}

/* ------------------------------------------------------------ 知らせ */

let toastTimer = 0;
/** 画面の下に短い知らせを出す（「コピーしました」など）。 */
export function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
}

/* ------------------------------------------------------------ 数字の書き方 */

const MINUS = '−';
/** 符号つき。−60.2 / +19.5。0 は 0 */
export function signed(n, digits = 1) {
  const v = Number(n.toFixed(digits));
  if (v === 0) return '0';
  const s = Math.abs(v).toFixed(digits).replace(/\.0+$/, '');
  return (v < 0 ? MINUS : '+') + s;
}
/** 小数が無ければ整数で。69.5 / 40 */
export const trim1 = (n) => (Math.round(n * 10) / 10).toFixed(1).replace(/\.0$/, '');
export const rub = (n) => `₽${Math.round(n).toLocaleString('ja-JP')}`;
export const kg = (n) => `${n.toFixed(2)} kg`;
