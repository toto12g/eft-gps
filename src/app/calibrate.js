/**
 * 校正ツール (S6)。
 *
 * ワールド座標が確定している点 (脱出口・スイッチ・BTR 停留所) を地図画像の上で
 * クリックして対応づけ、最小二乗でアフィンを解く。残差 RMS がその場で出るので、
 * 「たぶん合っている」ではなく数値で確かめられる。
 *
 * 出力は data/calib-overrides.json に貼る JSON。tools/build_data.py が
 * 解析的な初期値より優先して取り込む。
 */

import { fitAffine, applyAffine, invertAffine } from '../geo/index.js';
import { loadMapDb } from '../mapdb/index.js';

const $ = (id) => document.getElementById(id);
const NS = 'http://www.w3.org/2000/svg';

const state = {
  db: null,
  map: null,
  svgFile: null,
  viewBox: [0, 0, 100, 100],
  refs: [],          // {id, label, wx, wz, px, py|null}
  selected: 0,
  fit: null,
  view: { scale: 1, tx: 0, ty: 0 },
};

/* ------------------------------------------------------------------ 起動 */

async function boot() {
  state.db = await loadMapDb('./data/');

  const mapSel = $('map-select');
  for (const m of state.db.maps) {
    const opt = document.createElement('option');
    opt.value = m.key;
    opt.textContent = m.affine ? `${m.key}（校正済み）` : `${m.key}（未校正）`;
    mapSel.appendChild(opt);
  }
  const wanted = new URLSearchParams(location.search).get('map');
  mapSel.value = state.db.byKey.has(wanted) ? wanted : state.db.maps[0].key;
  mapSel.addEventListener('change', () => loadMap(mapSel.value));

  const svgSel = $('svg-select');
  for (const f of state.db.svgFiles || []) {
    const opt = document.createElement('option');
    opt.value = f;
    opt.textContent = f;
    svgSel.appendChild(opt);
  }
  svgSel.addEventListener('change', () => setSvg(svgSel.value));

  $('btn-reset').addEventListener('click', () => {
    for (const r of state.refs) { r.px = null; r.py = null; }
    state.selected = 0;
    refit();
  });
  $('btn-seed').addEventListener('click', seedFromExisting);
  $('btn-copy').addEventListener('click', copyJson);
  $('btn-fitview').addEventListener('click', fitView);

  setupCanvas();
  await loadMap(mapSel.value);

  // ?seed=1 で初期値からの出発を自動実行する (動作確認用)
  if (new URLSearchParams(location.search).get('seed') === '1') seedFromExisting();
}

/* ------------------------------------------------------------------ 読み込み */

async function loadMap(key) {
  state.map = state.db.byKey.get(key);
  state.refs = collectRefs(state.map);
  state.selected = 0;
  state.fit = null;

  // その地図の既定の SVG があれば選ぶ
  const guess =
    (state.map.svg && state.map.svg.replace('maps/', '')) ||
    guessSvgName(key, state.db.svgFiles || []);
  $('svg-select').value = guess || '';
  await setSvg(guess);
}

// 名前から機械的に推測できないもの。tarkov-dev の maps.json が svgPath を
// 持っていないマップでも、SVG リポジトリには素材があることがある。
const SVG_HINT = {
  'the-lab': 'Labs.svg',
  'ground-zero': 'GroundZero.svg',
  'streets-of-tarkov': 'StreetsOfTarkov.svg',
};

function guessSvgName(key, files) {
  const hint = SVG_HINT[key];
  if (hint && files.includes(hint)) return hint;
  const norm = key.replace(/-/g, '').slice(0, 5);
  return files.find((f) => f.toLowerCase().replace(/[^a-z]/g, '').startsWith(norm)) || '';
}

/** ワールド座標が確定している点を集める。 */
function collectRefs(map) {
  const out = [];
  for (const e of map.extracts || []) {
    if (!e.position) continue;
    out.push({
      id: 'extract:' + e.name,
      label: String(e.name || '').replace(/^EXFIL[_ ]?/i, ''),
      kind: e.faction || 'extract',
      wx: e.position.x,
      wz: e.position.z,
      px: null,
      py: null,
    });
  }
  out.sort((a, b) => a.label.localeCompare(b.label));
  return out;
}

async function setSvg(file) {
  state.svgFile = file || null;
  const host = $('svg-host');
  host.innerHTML = '';
  if (!file) {
    $('hint').textContent = 'この地図に使う SVG が maps/ にありません。';
    renderRefs();
    return;
  }
  const text = await fetch('./maps/' + file).then((r) => r.text());
  host.innerHTML = text;
  const svg = host.querySelector('svg');
  const vb = (svg.getAttribute('viewBox') || '0 0 100 100').split(/[\s,]+/).map(Number);
  state.viewBox = vb;
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  svg.style.display = 'block';

  const over = $('overlay');
  over.setAttribute('viewBox', vb.join(' '));
  over.setAttribute('preserveAspectRatio', 'none');

  fitView();
  refit();
}

/* -------------------------------------------------------------- 画面操作 */

function setupCanvas() {
  const stage = $('stage');

  stage.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const rect = stage.getBoundingClientRect();
    const cx = ev.clientX - rect.left;
    const cy = ev.clientY - rect.top;
    const k = ev.deltaY < 0 ? 1.15 : 1 / 1.15;
    const v = state.view;
    v.tx = cx - (cx - v.tx) * k;
    v.ty = cy - (cy - v.ty) * k;
    v.scale *= k;
    applyView();
  }, { passive: false });

  let dragging = false;
  let moved = 0;
  let lastX = 0;
  let lastY = 0;

  stage.addEventListener('pointerdown', (ev) => {
    dragging = true;
    moved = 0;
    lastX = ev.clientX;
    lastY = ev.clientY;
    stage.setPointerCapture(ev.pointerId);
  });
  stage.addEventListener('pointermove', (ev) => {
    if (!dragging) return;
    const dx = ev.clientX - lastX;
    const dy = ev.clientY - lastY;
    moved += Math.abs(dx) + Math.abs(dy);
    lastX = ev.clientX;
    lastY = ev.clientY;
    state.view.tx += dx;
    state.view.ty += dy;
    applyView();
  });
  stage.addEventListener('pointerup', (ev) => {
    dragging = false;
    if (moved < 4) placePoint(ev); // ドラッグでなくクリックなら点を打つ
  });
}

function applyView() {
  const v = state.view;
  $('canvas').style.transform = `translate(${v.tx}px, ${v.ty}px) scale(${v.scale})`;
}

function fitView() {
  const stage = $('stage').getBoundingClientRect();
  const [, , vw, vh] = state.viewBox;
  const k = Math.min(stage.width / vw, stage.height / vh) * 0.92;
  state.view = { scale: k, tx: (stage.width - vw * k) / 2, ty: (stage.height - vh * k) / 2 };
  $('canvas').style.width = vw + 'px';
  $('canvas').style.height = vh + 'px';
  $('canvas').style.transformOrigin = '0 0';
  applyView();
}

/** クリック位置を SVG のユーザ座標に直して、選択中の参照点に割り当てる。 */
function placePoint(ev) {
  const ref = state.refs[state.selected];
  if (!ref || !state.svgFile) return;
  const over = $('overlay');
  const pt = over.createSVGPoint();
  pt.x = ev.clientX;
  pt.y = ev.clientY;
  const ctm = over.getScreenCTM();
  if (!ctm) return;
  const p = pt.matrixTransform(ctm.inverse());
  ref.px = p.x;
  ref.py = p.y;

  // 次の未設定の点へ自動で進む
  const next = state.refs.findIndex((r, i) => i > state.selected && r.px === null);
  state.selected = next >= 0 ? next : state.selected;
  refit();
}

/** いまの校正 (解析的初期値) から対応点を自動生成して出発点にする。 */
function seedFromExisting() {
  const aff = state.map && state.map.affine;
  if (!aff) {
    $('hint').textContent = 'このマップには初期値がありません。手で 3 点以上打ってください。';
    return;
  }
  for (const r of state.refs) {
    const p = applyAffine(aff, r.wx, r.wz);
    r.px = p.px;
    r.py = p.py;
  }
  refit();
}

/* ------------------------------------------------------------------ フィット */

function refit() {
  const pts = state.refs.filter((r) => r.px !== null);
  state.fit = pts.length >= 2 ? fitAffine(pts.map((r) => ({ wx: r.wx, wz: r.wz, px: r.px, py: r.py }))) : null;
  renderRefs();
  renderOverlay();
  renderResult();
}

function renderResult() {
  const box = $('result');
  const n = state.refs.filter((r) => r.px !== null).length;
  if (!state.fit) {
    box.innerHTML = `<div class="hint">対応点 ${n} / 2 点以上で相似変換、3 点以上でフルアフィンになります。</div>`;
    $('btn-copy').disabled = true;
    return;
  }
  const { affine, rms, residuals } = state.fit;
  const worst = Math.max(...residuals);
  const [, , vw] = state.viewBox;
  const scale = Math.hypot(affine.a, affine.d); // 1m あたりの SVG 単位
  const rmsM = scale > 0 ? rms / scale : NaN;

  const cls = rms < 10 ? 'ok' : rms < 25 ? 'low' : 'warn';
  box.innerHTML =
    `<div class="status ${cls}">RMS ${rms.toFixed(2)} px（約 ${rmsM.toFixed(2)} m）　最悪 ${worst.toFixed(2)} px　${n} 点</div>` +
    `<div class="mono">a ${affine.a.toFixed(5)}　b ${affine.b.toFixed(5)}　c ${affine.c.toFixed(2)}<br>` +
    `d ${affine.d.toFixed(5)}　e ${affine.e.toFixed(5)}　f ${affine.f.toFixed(2)}</div>` +
    `<div class="hint">1 m ≒ ${scale.toFixed(3)} SVG 単位　/　viewBox 幅 ${vw.toFixed(0)}</div>`;
  $('btn-copy').disabled = false;
}

function renderRefs() {
  const list = $('refs');
  list.innerHTML = '';
  state.refs.forEach((r, i) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'ref' + (i === state.selected ? ' sel' : '') + (r.px !== null ? ' set' : '');
    const resid =
      state.fit && r.px !== null
        ? (() => {
            const q = applyAffine(state.fit.affine, r.wx, r.wz);
            return Math.hypot(q.px - r.px, q.py - r.py);
          })()
        : null;
    row.innerHTML =
      `<span class="nm">${escapeHtml(r.label)}</span>` +
      `<span class="co">${r.wx.toFixed(0)}, ${r.wz.toFixed(0)}</span>` +
      `<span class="st">${r.px === null ? '—' : resid === null ? '●' : resid.toFixed(1) + 'px'}</span>`;
    row.addEventListener('click', () => {
      state.selected = i;
      renderRefs();
    });
    list.appendChild(row);
  });
  const ref = state.refs[state.selected];
  $('hint').textContent = ref
    ? `「${ref.label}」（ワールド ${ref.wx.toFixed(0)}, ${ref.wz.toFixed(0)}）の場所を地図上でクリック。ドラッグで移動、ホイールで拡大。`
    : 'この地図には参照に使える点がありません。';
}

function renderOverlay() {
  const over = $('overlay');
  over.innerHTML = '';
  const [vx, vy, vw, vh] = state.viewBox;
  const unit = Math.max(vw, vh) / 400;

  const el = (name, attrs) => {
    const n = document.createElementNS(NS, name);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    over.appendChild(n);
    return n;
  };

  // 打った点 (実測) と、フィット結果が予測する位置
  state.refs.forEach((r, i) => {
    if (r.px !== null) {
      const c = i === state.selected ? '#ffffff' : '#c79a4e';
      el('circle', { cx: r.px, cy: r.py, r: unit * 2.5, fill: 'none', stroke: c, 'stroke-width': unit * 0.9 });
      el('line', { x1: r.px - unit * 4, y1: r.py, x2: r.px + unit * 4, y2: r.py, stroke: c, 'stroke-width': unit * 0.5 });
      el('line', { x1: r.px, y1: r.py - unit * 4, x2: r.px, y2: r.py + unit * 4, stroke: c, 'stroke-width': unit * 0.5 });
    }
    if (state.fit) {
      const q = applyAffine(state.fit.affine, r.wx, r.wz);
      el('circle', { cx: q.px, cy: q.py, r: unit * 1.6, fill: '#7fa877', 'fill-opacity': 0.85 });
      if (r.px !== null) {
        el('line', { x1: r.px, y1: r.py, x2: q.px, y2: q.py, stroke: '#c9776c', 'stroke-width': unit * 0.6 });
      }
    }
  });

  // POI 点群。フィットが合っていれば図の描画範囲に重なる
  if (state.fit && $('show-poi').checked) {
    const m = state.map;
    const step = Math.max(1, Math.floor(m.poiCount / 1200));
    for (let i = 0; i < m.poiCount; i += step) {
      const o = i * 3;
      const p = applyAffine(state.fit.affine, m.poi[o] / 10, m.poi[o + 2] / 10);
      el('circle', { cx: p.px, cy: p.py, r: unit * 0.5, fill: '#7fa6c4', 'fill-opacity': 0.45 });
    }
  }

  el('rect', {
    x: vx, y: vy, width: vw, height: vh,
    fill: 'none', stroke: '#c79a4e', 'stroke-width': unit * 0.5, 'stroke-dasharray': unit * 3,
  });
}

/* ------------------------------------------------------------------ 出力 */

function copyJson() {
  if (!state.fit) return;
  const pts = state.refs.filter((r) => r.px !== null);
  const payload = {
    [state.map.key]: {
      svg: 'maps/' + state.svgFile,
      svgViewBox: state.viewBox,
      affine: round(state.fit.affine),
      rms: Number(state.fit.rms.toFixed(3)),
      points: pts.map((r) => ({
        ref: r.id,
        wx: Number(r.wx.toFixed(3)),
        wz: Number(r.wz.toFixed(3)),
        px: Number(r.px.toFixed(2)),
        py: Number(r.py.toFixed(2)),
      })),
    },
  };
  const text = JSON.stringify(payload, null, 2);
  $('json').value = text;
  $('json').hidden = false;
  navigator.clipboard?.writeText(text).then(
    () => ($('hint').textContent = 'クリップボードにコピーしました。data/calib-overrides.json に貼って py tools/build_data.py を実行してください。'),
    () => ($('hint').textContent = '下のテキストを data/calib-overrides.json に貼ってください。'),
  );
}

function round(a) {
  const o = {};
  for (const k of ['a', 'b', 'c', 'd', 'e', 'f']) o[k] = Number(a[k].toFixed(8));
  return o;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

$('show-poi').addEventListener('change', renderOverlay);
window.addEventListener('resize', fitView);

boot().catch((err) => {
  document.body.insertAdjacentHTML(
    'afterbegin',
    `<pre style="color:#c9776c;padding:1rem">${escapeHtml(err && err.stack ? err.stack : err)}</pre>`,
  );
});

// 未使用だが、逆変換の健全性を保つために公開しておく (テストから参照する)
export { invertAffine };
