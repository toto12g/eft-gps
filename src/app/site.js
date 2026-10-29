/**
 * サイトの枠。上の帯のサイト内の移動、左から出るメニュー、画面の切り替え。
 *
 * 地図・カスタム・アイテムの用途は 1 枚のページの中の画面として切り替える。
 * 別ページへ移ると地図のページが閉じてスクリーンショットのフォルダ監視が止まり、
 * 戻るたびに権限の確認からやり直しになる。別タブで開けば止まりはしないが、
 * 道具ごとにタブが増えていく（ここに集約したいという要望から作った）。
 *
 * 地図の画面は消さずに下に残し、ほかの画面はその上に重ねて出す。
 * Leaflet は表示されていない間に大きさを測れないので、隠すと戻ったときに崩れる。
 */

import { parseHash, hashFor } from './router.js';
import { $, setupModal, closeModal, loadMeta, escapeHtml as esc } from './ui.js';

const PAGES = {
  builds: () => import('./builds-page.js'),
  items: () => import('./items-page.js'),
};
const mounted = new Map();
let renderSeq = 0;

/* ------------------------------------------------------------ 画面の切り替え */

async function render() {
  const seq = ++renderSeq;
  const ctx = parseHash(location.hash);
  document.body.dataset.route = ctx.route;
  for (const a of document.querySelectorAll('[data-route-link]')) {
    if (a.dataset.routeLink === ctx.route) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  // 重ねた画面の下にある地図には、キーボードでも入れないようにする
  $('view-map').inert = ctx.route !== 'map';
  closeMenu();
  closeModal();

  if (ctx.route === 'map') {
    document.title = 'EFT 測位クライアント';
    // 地図側（main.js）が ?m= を見てマップを切り替える
    window.dispatchEvent(new CustomEvent('eft:route', { detail: ctx }));
    return;
  }

  const el = document.querySelector(`.page[data-view="${ctx.route}"]`);
  let page = mounted.get(ctx.route);
  if (!page) {
    page = await PAGES[ctx.route]();
    page.mount(el);
    mounted.set(ctx.route, page);
  }
  if (seq !== renderSeq) return; // 読み込んでいる間に別の画面へ移った
  await page.show(el, ctx);
}

/* ------------------------------------------------------------ メニュー */

/**
 * 左から出るメニュー。上の帯に並べきれないもの（マップの一覧、銃の種類、
 * アイテムの絞り込み、セットアップの手順）をここにまとめる。
 * 狭い画面では上の帯のサイト内リンクも隠れるので、ここが唯一の入口になる。
 */
function openMenu() {
  const menu = $('site-menu');
  menu.hidden = false;
  $('btn-menu').setAttribute('aria-expanded', 'true');
  menu.querySelector('.sheet a, .sheet button').focus();
}

function closeMenu() {
  const menu = $('site-menu');
  if (menu.hidden) return;
  menu.hidden = true;
  $('btn-menu').setAttribute('aria-expanded', 'false');
}

async function setupMenu() {
  const menu = $('site-menu');
  $('btn-menu').addEventListener('click', () => (menu.hidden ? openMenu() : closeMenu()));
  menu.addEventListener('click', (ev) => {
    if (ev.target.classList.contains('scrim') || ev.target.closest('.menu-close')) closeMenu();
    // 同じ画面へのリンクでは hashchange が起きないので、ここで閉じる
    else if (ev.target.closest('a[href^="#"]')) closeMenu();
    const act = ev.target.closest('[data-act]');
    if (act && act.dataset.act === 'setup') {
      closeMenu();
      location.hash = '#/map';
      // 手順の画面は地図側（main.js）が持っている
      setTimeout(() => $('btn-setup')?.click(), 0);
    }
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !menu.hidden) {
      closeMenu();
      $('btn-menu').focus();
    }
  });

  // マップの一覧と銃の種類はデータから作る。読めなくてもメニューの残りは使える
  try {
    const meta = await loadMeta();
    const label = (m) => (m.name && !/^[0-9a-f]{24} /.test(m.name) ? m.name : m.key);
    $('menu-maps').innerHTML = meta.maps
      .map((m) => `<a href="${hashFor('map', [], { m: m.key })}">${esc(label(m))}</a>`)
      .join('');
    $('menu-stamp').textContent = `データ ${meta.builtAt}`;
  } catch {
    $('menu-maps').innerHTML = '<a href="#/map">地図を開く</a>';
  }
}

/* ------------------------------------------------------------------ 起動 */

// tarkovkit の Weapon Builder の URL の後ろ（?w=銃の ID&m=部品の ID,…）を、このサイトの URL に
// 付けて開いたとき。# の前に来るので、カスタムの画面の形に直してから描く
{
  const sp = new URLSearchParams(location.search);
  if (sp.get('w')) {
    const q = new URLSearchParams({ w: sp.get('w') });
    if (sp.get('m')) q.set('m', sp.get('m'));
    history.replaceState(null, '', `${location.pathname}#/builds?${q.toString().replace(/%2C/g, ',')}`);
  }
}

setupModal();
setupMenu();
function showError(err) {
  console.error(err);
  const ctx = parseHash(location.hash);
  const el = document.querySelector(`.page[data-view="${ctx.route}"]`);
  if (!el) return;
  el.innerHTML = `<div class="page-inner"><p class="empty">画面を開けませんでした:
    ${esc(err && err.message ? err.message : err)}</p></div>`;
}

window.addEventListener('hashchange', () => render().catch(showError));
render().catch(showError);
