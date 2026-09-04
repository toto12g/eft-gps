/**
 * アプリ本体。
 *
 * S5 でスクリーンショットフォルダの監視を繋いだ。フォルダを選ぶと、以後は
 * ゲーム内でスクリーンショットを撮るたびにマーカーが動く。
 * ファイル名の貼り付けと座標の直接入力も残してある (動作確認・振り返り用)。
 */

import { parseScreenshotName } from '../parse/index.js';
import {
  quatToYawDeg, quatToPitchDeg, headingStrength, bearingDeg, angleDiffDeg,
} from '../geo/index.js';
import { formatGameTime, tarkovTimeHours } from '../clock/index.js';
import { loadMapDb, nearestPoiPoint } from '../mapdb/index.js';
import { validateSample, VERDICT, isDrawable, MapTracker } from '../verify/index.js';
import { ScreenshotWatcher, WATCH, isSupported } from '../watch/index.js';
import { MapView } from './map.js';
import { loadPins, savePins, addPin, removePin, renamePin, pinBearing } from './pins.js';
import {
  loadTasks, filterTasks, taskLabel, objectiveGeometry, objectiveApplies,
  taskKeyDoors, taskLoadout, taskPoints, OBJECTIVE_TYPE,
} from './tasks.js';
import {
  loadLandmarks, LAYERS, DEFAULT_ENABLED, layerCount, hazardLabel, bossLabel,
} from './landmarks.js';

const $ = (id) => document.getElementById(id);

/**
 * localStorage の値を安全に読む。
 *
 * ここはモジュール評価中に走るので、例外を投げると boot().catch() の
 * エラー表示より前で死に、画面が真っ黒のまま何も出ない。
 * 壊れていた項目は捨てて既定値に戻し、起動後に 1 行知らせる。
 */
const restoreFailures = [];
function safeParse(key, fallback) {
  let raw = null;
  try {
    raw = localStorage.getItem(key);
  } catch {
    return fallback; // プライベートウィンドウなどで localStorage 自体が使えない
  }
  if (raw === null) return fallback;
  try {
    const value = JSON.parse(raw);
    return value === null || value === undefined ? fallback : value;
  } catch {
    restoreFailures.push(key);
    try {
      localStorage.removeItem(key);
    } catch {
      /* 消せなくても既定値で続行する */
    }
    return fallback;
  }
}

const VERDICT_TEXT = {
  [VERDICT.ACCEPT]: ['一致', 'ok'],
  [VERDICT.WRONG_MAP]: ['マップが違う', 'warn'],
  [VERDICT.NOT_IN_RAID]: ['レイド外', 'off'],
  [VERDICT.LOW_CONFIDENCE]: ['確信度 低', 'low'],
};

const WATCH_TEXT = {
  [WATCH.UNSUPPORTED]: ['このブラウザでは監視できません（Chrome / Edge が必要）', 'warn'],
  [WATCH.IDLE]: ['フォルダ未接続', 'idle'],
  [WATCH.NEED_PERMISSION]: ['権限の確認が必要です', 'low'],
  [WATCH.WATCHING]: ['監視中', 'ok'],
  [WATCH.ERROR]: ['監視エラー', 'warn'],
};

const state = {
  db: null,
  view: null,
  watcher: null,
  tracker: new MapTracker(),
  factions: new Set(safeParse('eft-gps.factions', ['pmc', 'scav', 'shared'])),
  selectedKey: localStorage.getItem('eft-gps.map') || 'customs',
  // 既定 ON。発火条件は d1 < 5m かつ 2位/1位 > 5 で、実測マージンは 30 倍ある。
  // 手動選択を置き換えるのではなく、明らかに間違っているときだけ直す。
  autoSwitch: (localStorage.getItem('eft-gps.autoSwitch') ?? '1') === '1',
  lastSample: null,
  lastModified: null,
  lastVerdict: null,
  shownAt: null,
  floorLocked: safeParse('eft-gps.floorLocked', false),
  wantTaskId: localStorage.getItem('eft-gps.task') || null,
  wantFloor: localStorage.getItem('eft-gps.floor') || null,
  floorIds: [],
  pins: [],
  landmarks: {},
  layers: new Set(safeParse('eft-gps.layers', DEFAULT_ENABLED)),
  tasks: [],
  taskFilter: '',
  /** 終わったタスクの id。ゲーム側からは読めないので手で印を付けてもらう */
  doneTasks: new Set(safeParse('eft-gps.doneTasks', [])),
  hideDone: localStorage.getItem('eft-gps.hideDone') === '1',
  activeTask: null,
  activePinId: localStorage.getItem('eft-gps.activePin') || null,
  placing: false,
  measuring: false,
  received: 0,
  skipped: 0,
  /** 直前の 1 枚が提案した切替先。2 枚続けて同じことを言うまで動かさない */
  pendingSwitch: null,
  /** 書き出し用の記録。1 レイド分だけ持つ（増え続けないよう上限つき） */
  log: [],
};

/* ------------------------------------------------------------------ 起動 */

async function boot() {
  state.db = await loadMapDb('./data/');
  state.view = new MapView(window.L, $('map'));

  // ?map= ?sample= ?layers= で初期状態を指定できる (動作確認のスクリーンショット用)
  const params = new URLSearchParams(location.search);
  if (params.get('map')) state.selectedKey = params.get('map');
  if (params.get('layers')) {
    state.layers = new Set(params.get('layers').split(',').filter(Boolean));
  }

  const sel = $('map-select');
  for (const m of state.db.maps) {
    const opt = document.createElement('option');
    opt.value = m.key;
    const label = m.name && !/^[0-9a-f]{24} /.test(m.name) ? `${m.name}（${m.key}）` : m.key;
    opt.textContent = m.affine ? label : `${label}／地図なし`;
    sel.appendChild(opt);
  }
  if (!state.db.byKey.has(state.selectedKey)) state.selectedKey = state.db.maps[0].key;
  sel.value = state.selectedKey;
  sel.addEventListener('change', () => selectMap(sel.value));

  $('input-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    handleInput($('input-text').value);
  });
  $('btn-clear').addEventListener('click', () => {
    state.view.clearTrail();
    state.tracker.reset();
    state.lastSample = null;
    state.lastModified = null;
    state.lastVerdict = null;
    state.shownAt = null;
    updateAge();
    renderSample(null, null);
  });
  $('floor-select').addEventListener('change', (ev) => {
    state.view.setFloor(ev.target.value || null);
    state.wantFloor = ev.target.value || null;
    try {
      if (state.wantFloor) localStorage.setItem('eft-gps.floor', state.wantFloor);
      else localStorage.removeItem('eft-gps.floor');
    } catch { /* 保存できなくても動作には影響しない */ }
  });
  const lock = $('floor-lock-input');
  lock.checked = state.floorLocked;
  lock.addEventListener('change', () => {
    state.floorLocked = lock.checked;
    localStorage.setItem('eft-gps.floorLocked', JSON.stringify(lock.checked));
    if (!lock.checked && state.lastSample) syncFloor(state.lastSample);
  });

  const auto = $('auto-switch');
  auto.checked = state.autoSwitch;
  auto.addEventListener('change', () => {
    state.autoSwitch = auto.checked;
    localStorage.setItem('eft-gps.autoSwitch', auto.checked ? '1' : '0');
  });

  const filter = $('faction-filter');
  for (const input of filter.querySelectorAll('input')) {
    input.checked = state.factions.has(input.value);
    input.addEventListener('change', () => {
      state.factions = new Set(
        [...filter.querySelectorAll('input')].filter((i) => i.checked).map((i) => i.value),
      );
      localStorage.setItem('eft-gps.factions', JSON.stringify([...state.factions]));
      state.view.setFactions(state.factions);
      // 最寄り脱出口の案内も同じ集合で出し直す
      if (state.lastSample) renderSample(state.lastSample, state.lastVerdict);
    });
  }
  state.view.factions = new Set(state.factions);

  setupLayers();
  setupWatcher();
  setupGuide();
  setupPins();
  setupSidebar();
  setupExport();
  setupTasks();

  await selectMap(state.selectedKey);
  tickClock();
  setInterval(() => {
    tickClock();
    updateAge();
  }, 1000);

  // ?task=<id> でタスクを指定できる。特定の目標地点を人に見せるときに使える。
  const wantTask = params.get('task');
  if (wantTask && state.tasks.some((t) => t.id === wantTask)) selectTask(wantTask);

  const preset = params.get('sample');
  if (preset) {
    $('input-text').value = preset;
    handleInput(preset);
  }
  if (restoreFailures.length) {
    setStatus(
      `保存された設定を復元できなかったので初期値に戻しました（${restoreFailures.join(', ')}）`,
      'low',
    );
  }
  document.title = `EFT 測位クライアント — ${state.selectedKey}`;
}

/* ------------------------------------------------------------ フロア */

/** 矩形 [[x1,z1],[x2,z2], ラベル?] の中か。 */
function insideRect(rect, x, z) {
  const [[x1, z1], [x2, z2]] = rect;
  return x >= Math.min(x1, x2) && x <= Math.max(x1, x2) &&
         z >= Math.min(z1, z2) && z <= Math.max(z1, z2);
}

/**
 * 高さと平面位置から、いるべきフロアを選ぶ。
 *
 * 地下や寮 3 階にいるとき、別の階の図の上にマーカーが乗ると、
 * いちばん位置を知りたい状況でいちばん読めない図になる。
 *
 * 高さの範囲は重なっている（Customs の寮なら 2 階 [2.7, 6.5]、
 * 3 階 [5.7, ∞]）。重なった区間では「下限がより高い方」を採る。
 * 3 階の定義が 5.7 から始まっている以上、6.3 にいるなら 3 階と読むのが自然。
 */
function pickFloor(map, sample) {
  const layers = (map.tarkovDev && map.tarkovDev.layers) || [];
  let best = null;
  for (const L of layers) {
    for (const ex of L.extents || []) {
      const [lo, hi] = ex.height || [-Infinity, Infinity];
      if (!(sample.y >= lo && sample.y < hi)) continue;
      const rects = ex.bounds || [];
      if (rects.length && !rects.some((r) => insideRect(r, sample.x, sample.z))) continue;
      // 下限が高いものを優先。同じなら範囲の狭い（より具体的な）方
      if (!best || lo > best.lo || (lo === best.lo && hi - lo < best.span)) {
        best = { layer: L, lo, span: hi - lo };
      }
    }
  }
  return best ? best.layer : null;
}

/** tarkov-dev のレイヤ名を、SVG のグループ id に対応づける。 */
function resolveSvgLayer(layer, groupIds) {
  if (layer.svgLayer && groupIds.includes(layer.svgLayer)) return layer.svgLayer;
  const name = layer.name || '';
  const cands = [name, name.replace(/\s+/g, '_'), name.replace(/\s+/g, '_') + '_Level'];
  for (const c of cands) if (groupIds.includes(c)) return c;
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const n = norm(name);
  return n ? groupIds.find((g) => norm(g).startsWith(n)) || null : null;
}

/** サンプルに合わせてフロアを切り替える。固定中は何もしない。 */
function syncFloor(sample) {
  if (state.floorLocked || !sample) return;
  const m = state.db.byKey.get(state.selectedKey);
  if (!m || !m.affine) return;
  const layer = pickFloor(m, sample);
  const want = layer ? resolveSvgLayer(layer, state.floorIds) : (m.svgBaseLayer || '');
  const sel = $('floor-select');
  const value = want && state.floorIds.includes(want) ? want : (m.svgBaseLayer || '');
  if (sel.value !== value) {
    sel.value = value;
    state.view.setFloor(value || null);
  }
}

/* ------------------------------------------------ 名前の付いた地点のレイヤ */

function setupLayers() {
  const box = $('layer-filter');
  box.innerHTML = '';
  for (const def of LAYERS) {
    const label = document.createElement('label');
    label.className = 'chip';
    label.dataset.layer = def.id;
    label.style.setProperty('--lc', def.color);
    label.title = def.hint;
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = def.id;
    input.checked = state.layers.has(def.id);
    input.addEventListener('change', () => {
      if (input.checked) state.layers.add(def.id);
      else state.layers.delete(def.id);
      localStorage.setItem('eft-gps.layers', JSON.stringify([...state.layers]));
      renderLandmarks();
    });
    const span = document.createElement('span');
    span.textContent = def.name;
    label.append(input, span);
    box.appendChild(label);
  }
}

function landmarkLabel(item, kind) {
  if (kind === 'hazard') return hazardLabel(item);
  if (kind === 'boss') return bossLabel(item);
  if (kind === 'lock') return item.n || '施錠扉';
  if (kind === 'gun') return '固定武器';
  // 湧きは 1 マップ 400 点あるので、地図上に文字は出さない（吹き出しだけ）
  if (kind === 'spawnPmc' || kind === 'spawnScav') return '';
  return item.n || '';
}

function renderLandmarks() {
  const drawn = state.view.setLandmarks(state.landmarks, state.layers, LAYERS, landmarkLabel);

  // どの種類が何件あるか出す。0 件なら「このマップには無い」と分かる
  const counts = LAYERS.filter((d) => state.layers.has(d.id))
    .map((d) => `${d.name} ${layerCount(d, state.landmarks)}`)
    .join(' / ');
  $('layer-hint').textContent = state.landmarks.failed
    ? `地点データを読めませんでした（${state.landmarks.failed}）`
    : counts || 'チェックを入れると地名や危険地帯を出せます。';

  for (const label of $('layer-filter').querySelectorAll('.chip')) {
    const def = LAYERS.find((d) => d.id === label.dataset.layer);
    label.classList.toggle('empty', layerCount(def, state.landmarks) === 0);
  }
  return drawn;
}

/* -------------------------------------------------------------- タスク */

function setupTasks() {
  $('task-filter').addEventListener('input', (ev) => {
    state.taskFilter = ev.target.value;
    renderTaskOptions();
  });
  $('task-select').addEventListener('change', (ev) => selectTask(ev.target.value));
  $('btn-task-clear').addEventListener('click', () => selectTask(''));

  // 進行状況。ゲームからは読めないので手で印を付けてもらう。
  // 一覧は 243 件あり、終わったものが混ざったままだと探すのが辛い。
  const hide = $('task-hide-done');
  hide.checked = state.hideDone;
  hide.addEventListener('change', () => {
    state.hideDone = hide.checked;
    try {
      localStorage.setItem('eft-gps.hideDone', state.hideDone ? '1' : '0');
    } catch { /* 保存できなくても動作には影響しない */ }
    renderTaskOptions();
  });
  $('btn-task-done').addEventListener('click', () => {
    const t = state.activeTask;
    if (!t) return;
    if (state.doneTasks.has(t.id)) state.doneTasks.delete(t.id);
    else state.doneTasks.add(t.id);
    try {
      localStorage.setItem('eft-gps.doneTasks', JSON.stringify([...state.doneTasks]));
    } catch { /* 保存できなくても動作には影響しない */ }
    // 隠す設定なら、印を付けた時点で一覧から消えるので選択も外す
    if (state.hideDone && state.doneTasks.has(t.id)) selectTask('');
    else { renderTaskOptions(); syncTaskDoneButton(); }
  });
}

/** 「終わった」ボタンの見た目を、いま選んでいるタスクに合わせる。 */
function syncTaskDoneButton() {
  const btn = $('btn-task-done');
  const t = state.activeTask;
  btn.hidden = !t;
  if (!t) return;
  const done = state.doneTasks.has(t.id);
  btn.textContent = done ? '終わった印を外す' : '終わった';
  btn.setAttribute('aria-pressed', String(done));
}

/** そのマップのタスクを読み込んで一覧を作る。 */
async function loadMapTasks(mapData) {
  // マップが変わっても、同じタスクがそのマップにもあるなら選択を引き継ぐ。
  // トランジットで移動したときに、追いかけていた目標地点が
  // 理由の説明なく消えるのを防ぐ。
  const prev = state.activeTask;
  state.activeTask = null;
  state.tasks = await loadTasks(mapData.key, mapData.taskFile, state.db.anyTaskFile);
  $('task-filter').value = state.taskFilter = '';
  renderTaskOptions();
  renderObjectives();
  $('task-wiki').hidden = true;
  state.view.setTask(null, state.selectedKey);
  $('task-loadout').innerHTML = '';

  // 引き継ぎ: 直前に選んでいたもの、無ければ保存されていたもの
  const wantId = (prev && prev.id) || state.wantTaskId;
  if (wantId && state.tasks.some((t) => t.id === wantId)) {
    selectTask(wantId);
  } else if (prev) {
    setStatus(`「${prev.n}」は ${mapData.key} の目標ではないので選択を外しました`, 'low');
  }
}

function renderTaskOptions() {
  const sel = $('task-select');
  let shown = filterTasks(state.tasks, state.taskFilter);
  // 選択中のものは、隠す設定でも一覧に残す（消えると選択が外れて驚く）
  const activeId = state.activeTask ? state.activeTask.id : null;
  const hidden = state.hideDone
    ? shown.filter((t) => state.doneTasks.has(t.id) && t.id !== activeId).length
    : 0;
  if (state.hideDone) {
    shown = shown.filter((t) => !state.doneTasks.has(t.id) || t.id === activeId);
  }
  sel.innerHTML = '';
  const none = document.createElement('option');
  none.value = '';
  const m = state.db.byKey.get(state.selectedKey);
  const placed = state.tasks.filter((t) => taskPoints(t, state.selectedKey).length).length;
  const doneHere = state.tasks.filter((t) => state.doneTasks.has(t.id)).length;
  none.textContent = state.tasks.length
    ? `— 選択なし（${shown.length} / ${state.tasks.length} 件、◎ 地点あり ${placed} 件`
      + (doneHere ? `、終了 ${doneHere}${hidden ? ' を非表示' : ''}` : '')
      + `）—`
    : state.tasks.failed
      ? `— タスクデータを読めませんでした（${state.tasks.failed}）—`
      : m && m.taskFile === undefined
        ? '— データが古いようです。Ctrl+Shift+R で再読み込みしてください —'
        : '— このマップに目標地点のあるタスクはありません —';
  sel.appendChild(none);
  for (const t of shown) {
    const opt = document.createElement('option');
    opt.value = t.id;
    // 一覧 243 件のうち地点を持つのは Customs で 41 件しかない。
    // 選んでから「何も出ない」と気づくより、選ぶ前に分かるほうがよい
    const hasPlace = taskPoints(t, state.selectedKey).length > 0;
    opt.textContent =
      (state.doneTasks.has(t.id) ? '✓ ' : '') + (hasPlace ? '◎ ' : '　') + taskLabel(t);
    sel.appendChild(opt);
  }
  sel.disabled = !state.tasks.length;
  sel.value = state.activeTask ? state.activeTask.id : '';
}

function selectTask(id) {
  state.activeTask = id ? state.tasks.find((t) => t.id === id) || null : null;
  state.wantTaskId = state.activeTask ? state.activeTask.id : null;
  try {
    if (state.wantTaskId) localStorage.setItem('eft-gps.task', state.wantTaskId);
    else localStorage.removeItem('eft-gps.task');
  } catch { /* 保存できなくても動作には影響しない */ }
  // 隠す設定のときは、選択中だけ一覧に残している。選択が変わると
  // 「残す対象」も変わるので、そのつど作り直す
  if (state.hideDone) renderTaskOptions();
  $('task-select').value = id || '';
  syncTaskDoneButton();
  const wiki = $('task-wiki');
  wiki.hidden = !(state.activeTask && state.activeTask.w);
  if (!wiki.hidden) wiki.href = state.activeTask.w;
  const doors = state.activeTask ? taskKeyDoors(state.activeTask, state.landmarks) : [];
  state.view.setTask(state.activeTask, state.selectedKey, focusObjective, doors);
  renderLoadout(doors);
  renderObjectives();

  // 選んだ地点が入るように視点を寄せる。
  // 動かさないままだと、地図の別の場所を拡大しているときに
  // 「選んでも何も出ない」ようにしか見えなかった。
  if (!state.activeTask) return;
  const pts = taskPoints(state.activeTask, state.selectedKey);
  if (pts.length) {
    state.view.fitWorldPoints(pts);
    return;
  }
  // 地点が無いなら、その理由を出す。黙って何も起きないのがいちばん困る
  const doorPts = doors.flatMap(({ locks }) => locks.map((l) => ({ x: l.p[0], z: l.p[2] })));
  if (doorPts.length) {
    state.view.fitWorldPoints(doorPts);
    setStatus(`「${state.activeTask.n}」は地点データがありません（鍵の扉だけ表示）`, 'low');
    return;
  }
  setStatus(
    state.activeTask.any
      ? `「${state.activeTask.n}」はマップ指定のないタスクです（地点データなし）`
      : `「${state.activeTask.n}」は ${state.selectedKey} の地点データがありません`,
    'low',
  );
}

/** 目標 i の地点へ地図を寄せる。 */
function focusObjective(i) {
  if (!state.activeTask) return;
  const g = objectiveGeometry(state.activeTask.o[i], state.selectedKey);
  const p = g.zones[0] ? { x: g.zones[0].p[0], z: g.zones[0].p[2] }
    : g.spots[0] ? { x: g.spots[0][0], z: g.spots[0][2] } : null;
  if (p) state.view.focusWorld(p.x, p.z);
}

/** 持ち物（必要な鍵・持ち込むもの・装備指定）を出す。 */
function renderLoadout(doors) {
  const box = $('task-loadout');
  box.innerHTML = '';
  if (!state.activeTask) return;

  const { bring, find, weaponSpec } = taskLoadout(state.activeTask, state.selectedKey);
  if (!doors.length && !bring.length && !find.length && !weaponSpec) return;

  const head = document.createElement('div');
  head.className = 'lo-head';
  head.textContent = '持ち物';
  box.appendChild(head);

  const row = (cls, type, name, extra, onClick) => {
    const el = document.createElement(onClick ? 'button' : 'div');
    if (onClick) el.type = 'button';
    el.className = 'lo-row ' + cls;
    el.innerHTML =
      `<span class="t">${escapeHtml(type)}</span>` +
      `<span class="n" title="${escapeHtml(name)}">${escapeHtml(name)}</span>` +
      `<span class="x">${extra}</span>`;
    if (onClick) el.addEventListener('click', onClick);
    box.appendChild(el);
  };

  for (const { key, locks } of doors) {
    const extra = locks.length ? `扉 ${locks.length} 箇所` : '扉は別マップ';
    row('key', '鍵', key.n, extra, locks.length ? () => state.view.focusWorld(locks[0].p[0], locks[0].p[2]) : null);
  }
  for (const it of bring) {
    const label = it.kind === 'marker' ? 'マーカー' : it.kind === 'give' ? '納品' : '設置';
    const qty = it.c && it.c > 1 ? `×${it.c}` : '';
    const fir = it.f ? '<span class="fir">要FiR</span>' : '';
    row(it.kind, label, it.n, `${qty}${qty && fir ? ' ' : ''}${fir}`);
  }
  for (const it of find) {
    // 持ち込むのではなく、レイド内で見つける／トレーダーに渡すもの
    row('find', it.kind === 'hand' ? '引渡' : '探す', it.n, '');
  }
  if (weaponSpec) row('weapon', '装備', '使用武器の指定あり', `${weaponSpec} 種`);
  // 候補が多すぎて 8 件で打ち切ったぶん
  const more = (state.activeTask.o || []).reduce((n, o) => n + (o.itMore || 0), 0);
  if (more) row('weapon', 'ほか', `代わりに使えるアイテムが ${more} 種`, 'Wiki 参照');
}

function renderObjectives() {
  const box = $('task-objectives');
  box.innerHTML = '';
  if (!state.activeTask) return;

  const s = state.lastSample;
  const yaw = s ? headingOf(s) : null;

  state.activeTask.o.forEach((objective, i) => {
    const g = objectiveGeometry(objective, state.selectedKey);
    const here = g.zones.length > 0 || g.spots.length > 0;
    // 場所を持たない目標（「スカブを 10 体倒す」など）は「別マップ」ではない
    const placeless = !(objective.z || []).length && !(objective.l || []).length;

    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'obj-row' + (here || placeless ? '' : ' away');

    // 現在地からいちばん近い地点までの距離
    const spotCount = g.zones.length + g.spots.length;
    let meta = here || placeless
      ? (OBJECTIVE_TYPE[objective.t] || objective.t || '')
      : '別マップ';
    if (here && s) {
      const pts = [
        ...g.zones.map((z) => ({ x: z.p[0], z: z.p[2] })),
        ...g.spots.map((p) => ({ x: p[0], z: p[2] })),
      ];
      let best = null;
      for (const p of pts) {
        const b = pinBearing(s, { x: p.x, z: p.z }, yaw);
        if (!best || b.dist < best.dist) best = b;
      }
      if (best) {
        meta = `${best.dist.toFixed(0)}m ${best.bearing.toFixed(0)}°`;
        if (best.relative !== null) meta += `（${relativeText(best.relative)}）`;
      }
    }

    row.innerHTML =
      `<span class="n">${i + 1}</span>` +
      `<span class="d">${escapeHtml(objective.d || '')}${objective.opt ? '（任意）' : ''}` +
      `${spotCount > 1 ? `<em class="cnt">${spotCount} 箇所</em>` : ''}</span>` +
      `<span class="m">${escapeHtml(meta)}</span>`;
    if (here) row.addEventListener('click', () => focusObjective(i));
    else row.disabled = !placeless;
    box.appendChild(row);
  });
}

/* --------------------------------------------------------- レイドの記録の書き出し */

/**
 * 受け取ったサンプルと判定を JSON で保存する。
 *
 * 「Woods なのに Interchange に飛ぶ」のような報告は、ファイル名さえあれば
 * そのまま再現できる。手で貼ってもらうのは現実的でないので、まとめて出す。
 * 出るのはファイル名・座標・判定だけで、画像そのものは扱わない。
 */
function setupExport() {
  $('btn-export').addEventListener('click', () => {
    if (!state.log.length) {
      setStatus('まだ記録がありません。スクリーンショットを 1 枚受け取ってから押してください', 'low');
      return;
    }
    const payload = {
      tool: 'eft-gps',
      builtAt: state.db.builtAt,
      exportedAt: new Date().toISOString(),
      map: state.selectedKey,
      trackerCount: state.tracker.count,
      consensus: state.tracker.consensus(),
      samples: state.log,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.download = `eft-gps-${state.selectedKey}-${stamp}.json`;
    a.click();
    // revoke が早すぎるとダウンロードが始まらないブラウザがある
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    setStatus(`${state.log.length} 枚ぶんの記録を書き出しました`, 'ok');
  });
}

/* --------------------------------------------------------------- 方位の表示 */

const CARDINALS = ['北', '北東', '東', '南東', '南', '南西', '西', '北西'];

/**
 * ワールドの向きを、真北を基準にした方位に直して文字にする。
 *
 * ワールド座標の +Z は北とは限らず、Customs では 180° ずれている。
 * 図の上に方位ローズを出した以上、印字する数字も同じ基準でないと
 * 「北を指す針」と「方位 238°」が食い違って読めない。
 * mapdb の northDeg（= coordinateToCardinalRotation）で揃える。
 *
 * 相対表示（「左 63°」など）はワールド上の差なので、この変換の影響を受けない。
 */
function compassText(worldDeg, digits = 0) {
  const m = state.db && state.db.byKey.get(state.selectedKey);
  const north = m && typeof m.northDeg === 'number' ? m.northDeg : null;
  if (north === null) return `${worldDeg.toFixed(digits)}°`; // 基準が無ければ生の値
  const c = ((worldDeg - north) % 360 + 360) % 360;
  return `${c.toFixed(digits)}° ${CARDINALS[Math.round(c / 45) % 8]}`;
}

/* ------------------------------------------------- サイドバーの折りたたみ */

/**
 * 幅 340px を固定で取っていたので、ノート PC では地図が狭かった。
 * 畳んだ状態は覚えておく。Leaflet は自分でサイズ変化に気づけないので、
 * 切り替えのたびに invalidateSize を呼ぶ。
 */
function setupSidebar() {
  const btn = $('btn-side');
  const show = $('btn-side-show');
  const apply = (collapsed) => {
    document.body.classList.toggle('side-collapsed', collapsed);
    btn.setAttribute('aria-expanded', String(!collapsed));
    try {
      localStorage.setItem('eft-gps.sideCollapsed', collapsed ? '1' : '0');
    } catch { /* 保存できなくても動作には影響しない */ }
    // 折り返しのアニメーションは無いので、次のフレームで足りる
    requestAnimationFrame(() => state.view.map.invalidateSize());
  };
  btn.addEventListener('click', () => apply(true));
  show.addEventListener('click', () => apply(false));
  let saved = '0';
  try { saved = localStorage.getItem('eft-gps.sideCollapsed') || '0'; } catch { /* 既定は開いた状態 */ }
  if (saved === '1') apply(true);
}

/* ------------------------------------------------------------------ ピン */

function setupPins() {
  state.view.onMapClick = (world) => {
    // 名前は聞かない。連続で置けるようにするため、まず刺してから
    // 一覧で書き換えてもらう。名前を毎回聞くと 1 本ごとに手が止まる。
    const y = state.lastSample ? state.lastSample.y : 0;
    state.pins = addPin(state.pins, { name: `ピン ${state.pins.length + 1}`, x: world.x, y, z: world.z });
    savePins(state.selectedKey, state.pins);
    renderPins();
    // モードは切らない。オフにするまで置き続けられる。
  };

  state.view.onPinClick = (id) => {
    state.activePinId = state.activePinId === id ? null : id;
    localStorage.setItem('eft-gps.activePin', state.activePinId || '');
    renderPins();
  };

  $('btn-place').addEventListener('click', () => setPlacing(!state.placing));

  // 距離を測る。ピンと同時にはオンにしない（クリックの行き先が曖昧になる）
  const measureBtn = $('btn-measure');
  const measureOut = $('measure-out');
  state.view.onMeasure = (m) => {
    measureOut.textContent = m
      ? `${m.dist.toFixed(1)} m　方位 ${compassText(m.bearing)}`
      : state.measuring ? '始点をクリックしてください。' : '';
  };
  measureBtn.addEventListener('click', () => {
    const on = !state.measuring;
    if (on && state.placing) setPlacing(false);
    state.measuring = on;
    measureBtn.setAttribute('aria-pressed', String(state.measuring));
    state.view.setMeasuring(state.measuring);
    state.view.onMeasure(null);
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    if (state.placing) setPlacing(false);
    if (state.measuring) measureBtn.click();
  });
  $('btn-pins-clear').addEventListener('click', () => {
    if (!state.pins.length) return;
    if (!confirm(`${state.selectedKey} のピン ${state.pins.length} 個をすべて消します。よろしいですか？`)) return;
    state.pins = [];
    savePins(state.selectedKey, state.pins);
    renderPins();
  });
}

function setPlacing(on) {
  state.placing = on;
  // ピンを置く間は計測を止める。クリックの行き先が 2 つあると迷う
  if (on && state.measuring) {
    state.measuring = false;
    $('btn-measure').setAttribute('aria-pressed', 'false');
    state.view.setMeasuring(false);
  }
  state.view.setPlacing(on);
  const btn = $('btn-place');
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  btn.querySelector('.txt').textContent = on ? 'ピンを置く（オン）' : 'ピンを置く';
  const hint = $('pin-hint');
  hint.classList.toggle('on', on);
  hint.textContent = on
    ? 'オン。地図をクリックするたびに刺さります。ドラッグでの移動と拡大はそのまま使えます。もう一度押すか Esc で終了。'
    : 'ピンを置くを押してから地図をクリックします。';
}

function renderPins() {
  state.view.setPins(state.pins, state.activePinId);

  const box = $('pins');
  box.innerHTML = '';
  if (!state.pins.length) {
    $('btn-pins-clear').disabled = true;
    return;
  }
  $('btn-pins-clear').disabled = false;

  const s = state.lastSample;
  const yaw = s ? headingOf(s) : null;

  for (const pin of state.pins) {
    const row = document.createElement('div');
    row.className = 'pin-row' + (pin.id === state.activePinId ? ' active' : '');

    let dist = '—';
    if (s) {
      const b = pinBearing(s, pin, yaw);
      dist = `${b.dist.toFixed(0)}m ${b.bearing.toFixed(0)}°`;
      if (b.relative !== null) dist += `（${relativeText(b.relative)}）`;
    }

    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = pin.name;
    nm.title = 'クリックで名前を変更';
    nm.addEventListener('click', () => startRename(nm, pin));
    const ds = document.createElement('span');
    ds.className = 'dist';
    ds.textContent = dist;
    row.append(nm, ds);

    const ops = document.createElement('span');
    ops.className = 'ops';
    const goto = document.createElement('button');
    goto.type = 'button';
    goto.textContent = pin.id === state.activePinId ? '解除' : '目的地';
    goto.addEventListener('click', () => state.view.onPinClick(pin.id));
    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = '削除';
    del.addEventListener('click', () => {
      state.pins = removePin(state.pins, pin.id);
      if (state.activePinId === pin.id) state.activePinId = null;
      savePins(state.selectedKey, state.pins);
      renderPins();
    });
    ops.append(goto, del);
    row.appendChild(ops);
    box.appendChild(row);
  }

  // 目的地までの線
  const active = state.pins.find((p) => p.id === state.activePinId);
  state.view.drawRoute(s && active ? s : null, active || null);
}

/** 一覧の名前をその場で書き換える。 */
function startRename(span, pin) {
  const input = document.createElement('input');
  input.className = 'rename';
  input.value = pin.name;
  input.setAttribute('aria-label', 'ピンの名前');
  span.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const commit = (save) => {
    if (done) return;
    done = true;
    if (save) {
      state.pins = renamePin(state.pins, pin.id, input.value);
      savePins(state.selectedKey, state.pins);
    }
    renderPins();
  };
  input.addEventListener('blur', () => commit(true));
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') commit(true);
    if (ev.key === 'Escape') {
      ev.stopPropagation(); // ピン設置モードの解除まで巻き込まない
      commit(false);
    }
  });
}

/* -------------------------------------------------------- はじめての設定 */

function setupGuide() {
  const panel = $('setup');
  const open = () => { panel.hidden = false; };
  const close = () => {
    panel.hidden = true;
    localStorage.setItem('eft-gps.setupSeen', '1');
  };

  // 手順の中から直接フォルダを選べるようにする。初めての人が
  // サイドバーを下までスクロールしてボタンを探さずに済む。
  const pick = $('setup-pick');
  pick.addEventListener('click', async () => {
    if (!state.watcher) return;
    await state.watcher.pick();
    if (state.watcher.status === WATCH.WATCHING) close();
  });
  if (!isSupported()) {
    pick.disabled = true;
    pick.textContent = 'このブラウザでは使えません（Chrome / Edge が必要）';
  }

  $('setup-close').addEventListener('click', close);
  $('setup-done').addEventListener('click', close);
  $('btn-setup').addEventListener('click', open);
  panel.addEventListener('click', (ev) => { if (ev.target === panel) close(); });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !panel.hidden) close();
  });

  for (const btn of panel.querySelectorAll('.copy-btn')) {
    btn.addEventListener('click', async () => {
      const text = $(btn.dataset.copy).textContent;
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = 'コピーした';
      } catch {
        // クリップボードが使えない環境では選択状態にして手でコピーしてもらう
        const range = document.createRange();
        range.selectNodeContents($(btn.dataset.copy));
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        btn.textContent = '選択した';
      }
      setTimeout(() => { btn.textContent = 'コピー'; }, 1600);
    });
  }

  // 初めて来た人には自動で出す。一度閉じたら以後は出さない。
  // ?nohelp=1 は動作確認のスクリーンショット用。初回案内が地図を覆うのを避ける
  const skipHelp = new URLSearchParams(location.search).get('nohelp') === '1';
  if (!skipHelp && localStorage.getItem('eft-gps.setupSeen') !== '1') open();
}

/* ------------------------------------------------------------------ 監視 */

function setupWatcher() {
  const watcher = new ScreenshotWatcher({ intervalMs: 1000 });
  state.watcher = watcher;

  watcher.onStatus = (status, detail) => renderWatchStatus(status, detail);
  watcher.onNew = ({ name, lastModified }) => {
    state.received++;
    $('watch-count').textContent = `${state.received} 枚受信` + (state.skipped ? ` / ${state.skipped} 枚除外` : '');
    handleScreenshot(name, lastModified);
  };
  watcher.onError = (err) => console.warn('[watch]', err);

  $('btn-pick').addEventListener('click', () => watcher.pick());
  $('btn-grant').addEventListener('click', () => watcher.requestPermission());
  $('btn-forget').addEventListener('click', () => watcher.forget());
  $('btn-replay').addEventListener('click', async () => {
    const items = await watcher.listRecent(20);
    if (!items.length) return;
    state.view.clearTrail();
    state.tracker.reset();
    for (const it of items) handleScreenshot(it.name, it.lastModified);
    await applyQueue; // 全部描き終わってからボタンを戻す
  });

  if (!isSupported()) {
    renderWatchStatus(WATCH.UNSUPPORTED);
    return;
  }
  watcher.restore();
}

function renderWatchStatus(status, detail) {
  const [text, cls] = WATCH_TEXT[status] || ['?', 'idle'];
  const el = $('watch-status');
  el.textContent = detail && status !== WATCH.UNSUPPORTED ? `${text} — ${detail}` : text;
  el.className = 'status ' + cls;

  $('btn-pick').hidden = status === WATCH.UNSUPPORTED;
  $('btn-pick').textContent = status === WATCH.WATCHING ? 'フォルダを変える' : 'フォルダを選ぶ';
  $('btn-grant').hidden = status !== WATCH.NEED_PERMISSION;
  $('btn-forget').hidden = status === WATCH.IDLE || status === WATCH.UNSUPPORTED;
  $('btn-replay').hidden = status !== WATCH.WATCHING;
}

/**
 * applySample は中で await selectMap()（SVG 取得・レイヤ全消し・タスク再読込）を
 * 行うので、同時に走らせるとレイヤ掃除と描画が交錯してマーカーが消える。
 * 「直近 20 枚を読み込む」は 20 本を一度に投げるため、そこで確実に壊れる。
 * 1 本のプロミス連鎖に載せて順番を保つ。
 */
let applyQueue = Promise.resolve();
function enqueueSample(sample, lastModified, live) {
  applyQueue = applyQueue
    .then(() => applySample(sample, lastModified, live))
    .catch((err) => console.warn('[apply]', err));
  return applyQueue;
}

/** 新しいスクリーンショットが 1 枚できたとき。 */
function handleScreenshot(filename, lastModified) {
  const sample = parseScreenshotName(filename);
  if (!sample) return; // 座標の入っていないファイル
  const box = $('input-text');
  // 監視中に手入力している最中なら、書きかけを消さない
  if (!box.value.trim() || document.activeElement !== box) box.value = filename;
  state.lastSample = sample;
  state.lastModified = lastModified;
  enqueueSample(sample, lastModified, true);
}

/* ------------------------------------------------------------------ 入力 */

function handleInput(raw) {
  const text = String(raw || '').trim();
  if (!text) return;

  let sample = parseScreenshotName(text);
  if (!sample) {
    // "x, y, z" 形式も受ける
    const nums = text.split(/[,\s]+/).map(Number).filter((n) => Number.isFinite(n));
    if (nums.length >= 3) {
      sample = {
        filename: '(手入力)',
        x: nums[0], y: nums[1], z: nums[2],
        q: [0, 0, 0, 1], hasRotation: false,
        gameTime: null, extras: [], seq: null, takenAtMs: null,
      };
    }
  }
  if (!sample) {
    setStatus('読み取れませんでした。ファイル名か「x, y, z」を入力してください。', 'warn');
    return;
  }
  state.lastSample = sample;
  state.lastModified = null;
  enqueueSample(sample, null, false);
}

async function applySample(sample, fileModifiedMs, live) {
  // 累積判定に足す。1 枚だけでマップを決めると、開けた場所で別マップを
  // 1 位にすることがある (実測で 16 枚中 2 枚)。
  state.tracker.add(sample, state.db, fileModifiedMs ?? sample.takenAtMs ?? Date.now());

  let verdict = validateSample({
    sample,
    selectedKey: state.selectedKey,
    db: state.db,
    fileModifiedMs,
    tracker: state.tracker,
  });

  // 別マップと判定されたとき、設定されていれば自動で合わせる。
  //
  // ただし 1 枚だけを根拠にした提案では動かさない。マップ同士の座標系は
  // 大きく重なっていて（customs の点の 47% が streets の点から 20m 以内）、
  // 1 枚が偶然よそのマップに近いことがある。実測では 1 枚で切り替えると
  // レイド 1 本(12 枚)あたり 3.8%、Customs では 10% が誤って飛ばされた。
  // 2 枚続けて同じマップを指したときだけ動かすと、660 本の試行で 0 件になる。
  if (verdict.verdict === VERDICT.WRONG_MAP && state.autoSwitch) {
    const corroborated = verdict.via === 'consensus' || state.pendingSwitch === verdict.suggest;
    if (corroborated) {
      state.pendingSwitch = null;
      // 地図の読み込みを待ってから描く。待たずに進むと、切り替え途中の
      // レイヤ掃除でマーカーが消えることがある。
      await selectMap(verdict.suggest);
      verdict = validateSample({
        sample, selectedKey: verdict.suggest, db: state.db, fileModifiedMs, tracker: state.tracker,
      });
    } else {
      state.pendingSwitch = verdict.suggest;
      setStatus(
        `${verdict.suggest} の座標かもしれません。次の 1 枚で同じなら切り替えます`,
        'low',
      );
    }
  } else if (verdict.verdict !== VERDICT.NOT_IN_RAID) {
    state.pendingSwitch = null;
  }

  if (verdict.verdict === VERDICT.NOT_IN_RAID) {
    // レイド外の 1 枚を累積に残すと、原点付近の座標が bbox 足切りを狂わせ、
    // 正解のマップが候補から消える。判定が出た時点で取り消す。
    state.tracker.undoLast();
    // 続けてレイド外を見たら、レイドが終わったとみなして累積を捨てる。
    // 次のレイドに前のレイドの軌跡を持ち越さない。
    if (state.tracker.noteOutOfRaid()) {
      state.view.clearTrail();
      setStatus('レイド外の画面が続いたので、これまでの軌跡を消しました', 'low');
    }
    if (live) {
      state.skipped++;
      $('watch-count').textContent = `${state.received} 枚受信 / ${state.skipped} 枚除外`;
    }
  }

  // 書き出し用に残す。ファイル名そのものが一次情報なので、
  // 判定と並べて出せれば不具合の報告がそのまま再現データになる
  state.log.push({
    file: sample.filename || null,
    x: sample.x, y: sample.y, z: sample.z,
    q: sample.hasRotation ? sample.q : null,
    gameTime: sample.gameTime,
    takenAtMs: sample.takenAtMs,
    fileModifiedMs: fileModifiedMs ?? null,
    map: state.selectedKey,
    verdict: verdict.verdict,
    reason: verdict.reason || null,
    best: verdict.best ?? null,
    d1: verdict.d1 ?? null,
    ratio: verdict.ratio ?? null,
    suggest: verdict.suggest ?? null,
  });
  if (state.log.length > 600) state.log.shift();

  state.lastVerdict = verdict;
  renderSample(sample, verdict);

  const m = state.db.byKey.get(state.selectedKey);
  // マップ違いのときだけ、選択中のマップで最も近い既知の地点を 1 点描く。
  // 「そこに何も無い」ことが目で分かれば、比の数字だけより納得できる。
  // レイド外（ハイドアウト等）では出さない — 毎回出ると単なる雑音になる
  state.view.setNearestHint(
    m && m.affine && verdict.verdict === VERDICT.WRONG_MAP
      ? nearestPoiPoint(m, sample.x, sample.y, sample.z)
      : null,
  );
  // 判定を通っても、地図画像の外に出るなら描かない。
  // 外に点を打つと「ツールが壊れている」ようにしか見えないので、
  // 黙って描くより、描けない理由を出すほうが親切。
  const over = m && m.affine ? state.view.outsideImageMeters(sample.x, sample.z) : 0;
  if (m && m.affine && isDrawable(verdict.verdict) && over <= 1) {
    syncFloor(sample);
    state.shownAt = fileModifiedMs ?? sample.takenAtMs ?? Date.now();
    state.view.setPlayer(sample, headingOf(sample), verdict.verdict === VERDICT.ACCEPT);
    updateAge();
  } else if (over > 1) {
    state.view.setPlayer(null);
    setStatus(
      `この座標は ${state.selectedKey} の地図の外です（${over.toFixed(0)} m 外）。` +
      `マップの選択を確かめてください`,
      'warn',
    );
  }
  renderPins(); // 現在地が動いたので距離と方位を出し直す
  renderObjectives();
}

/**
 * 方位。真上・真下を向いていると定義できないので null を返す。
 * 実測でも「真下を見て撮った 1 枚」があり、そこでは向きを描いてはいけない。
 */
function headingOf(sample) {
  if (!sample.hasRotation) return null;
  if (headingStrength(sample.q) < 0.09) return null; // 見上げ角 |85°| 以上
  return quatToYawDeg(sample.q);
}

/* ------------------------------------------------------------------ 表示 */

async function selectMap(key) {
  state.selectedKey = key;
  localStorage.setItem('eft-gps.map', key);
  $('map-select').value = key;
  const m = state.db.byKey.get(key);
  const ok = await state.view.setMap(m);

  $('map-missing').hidden = ok;
  $('attrib').textContent =
    m.tarkovDev && m.tarkovDev.svgPath ? 'map: the-hideout/tarkov-dev-svg-maps (CC BY-NC-SA 4.0)' : '';
  $('build-stamp').textContent = state.db.builtAt
    ? `データ ${state.db.builtAt}`
    : 'データの版が不明（古い可能性があります）';

  const floors = $('floor-select');
  floors.innerHTML = '';
  if (ok) {
    const base = m.svgBaseLayer || '';
    const ids = state.view.setFloor(null);
    state.floorIds = ids;
    // 表示名は tarkov-dev の layers[].name を使う。
    // SVG のグループ id をそのまま出すと "Second Floor" が "Second_Floor" になる
    const named = new Map();
    for (const L of (m.tarkovDev && m.tarkovDev.layers) || []) {
      const id = resolveSvgLayer(L, ids);
      if (id && L.name) named.set(id, L.name);
    }
    for (const id of ids) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = named.get(id) || (id === base ? '地上' : id.replace(/_/g, ' '));
      if (id === base) opt.selected = true;
      floors.appendChild(opt);
    }
    floors.disabled = ids.length < 2;
    $('floor-lock').hidden = ids.length < 2;
    // 固定しているなら、保存されていたフロアを復元する
    if (state.floorLocked && state.wantFloor && ids.includes(state.wantFloor)) {
      floors.value = state.wantFloor;
      state.view.setFloor(state.wantFloor);
    }
  } else {
    floors.disabled = true;
    state.floorIds = [];
    $('floor-lock').hidden = true;
  }

  state.pins = loadPins(key);
  if (!state.pins.some((p) => p.id === state.activePinId)) state.activePinId = null;
  renderPins();
  state.landmarks = await loadLandmarks(key, m.landmarkFile);
  renderLandmarks();
  await loadMapTasks(m);

  $('map-info').textContent = ok
    ? `${m.poiCount.toLocaleString()} POI / 脱出口 ${(m.extracts || []).length} / ` +
      `タスク ${m.taskCount || 0} / ${m.scenes.map((s) => s.nameId).join(', ')}`
    : `${m.poiCount.toLocaleString()} POI / 地図画像なし（測位と検証は動く）`;
}

function renderSample(sample, verdict) {
  const box = $('sample');
  if (!sample) {
    box.innerHTML = '<div class="hint">スクリーンショットを撮るか、ファイル名を貼り付けてください。</div>';
    setStatus('待機中', 'idle');
    $('btn-switch').hidden = true;
    return;
  }

  const yaw = headingOf(sample);
  const pitch = sample.hasRotation ? quatToPitchDeg(sample.q) : null;
  const rows = [
    ['位置', `x ${sample.x.toFixed(2)}　y ${sample.y.toFixed(2)}　z ${sample.z.toFixed(2)}`],
    ['方位', yaw === null
      ? (pitch === null ? '—' : `真${pitch > 0 ? '下' : '上'}向き（方位が定義できない）`)
      : `${compassText(yaw, 1)}（見上げ ${pitch.toFixed(1)}°）`],
    ['ゲーム内時刻', sample.gameTime === null ? '—' : `${formatGameTime(sample.gameTime)}（${sample.gameTime}）`],
    ['撮影', sample.takenAtMs ? new Date(sample.takenAtMs).toLocaleString() : '—'],
  ];

  if (verdict) {
    rows.push([
      '最寄りマップ',
      `${verdict.best}　${verdict.d1.toFixed(2)} m（2位 ${verdict.second} ${verdict.d2.toFixed(1)} m, 比 ${verdict.ratio.toFixed(1)}）`,
    ]);
    if (verdict.consensus) {
      rows.push([
        '累積判定',
        `${verdict.consensus.best}　平均 ${verdict.consensus.mean.toFixed(1)} m` +
          `（${verdict.consensus.n} 枚, 比 ${verdict.consensus.ratio.toFixed(2)}）`,
      ]);
    }
    if (verdict.clock) {
      rows.push([
        '時計整合',
        verdict.clock.agrees
          ? `一致（差 ${(verdict.clock.diff * 60).toFixed(1)} 分）`
          : `不一致（差 ${verdict.clock.diff.toFixed(2)} h）`,
      ]);
    }
  }

  const activePin = state.pins.find((p) => p.id === state.activePinId);
  if (activePin && verdict && isDrawable(verdict.verdict)) {
    const b = pinBearing(sample, activePin, yaw);
    rows.push([
      '目的地',
      `${activePin.name}　${b.dist.toFixed(0)} m　方位 ${compassText(b.bearing)}` +
        (b.relative === null ? '' : `（${relativeText(b.relative)}）`),
    ]);
  }

  // 選択中のマップが違うなら、脱出口までの距離は別の座標系で計算した無意味な値になる。
  // 出さないこと自体が「この数字は信用できない」という情報になる。
  const m = state.db.byKey.get(state.selectedKey);
  const exit = verdict && !isDrawable(verdict.verdict) ? null : nearestExit(m, sample, yaw);
  if (exit) {
    rows.push([
      '最寄り脱出口',
      `${exit.name}${exit.needsSwitch ? '（要スイッチ）' : ''}　` +
        `${exit.dist.toFixed(0)} m　方位 ${compassText(exit.bearing)}` +
        (exit.relative === null ? '' : `（${relativeText(exit.relative)}）`),
    ]);
  }

  box.innerHTML = rows
    .map(([k, v]) => `<div class="row"><span class="k">${k}</span><span class="v">${escapeHtml(v)}</span></div>`)
    .join('');

  if (verdict) {
    const [text, cls] = VERDICT_TEXT[verdict.verdict] || ['?', 'off'];
    setStatus(`${text} — ${verdict.reason}`, cls);
    const sw = $('btn-switch');
    sw.hidden = verdict.verdict !== VERDICT.WRONG_MAP;
    sw.textContent = `${verdict.suggest} に切り替える`;
    sw.onclick = () => {
      selectMap(verdict.suggest).then(() => {
        if (state.lastSample) enqueueSample(state.lastSample, state.lastModified, false);
      });
    };
  }
}

function nearestExit(map, sample, yaw) {
  if (!map || !(map.extracts || []).length) return null;
  let best = null;
  for (const e of map.extracts) {
    if (!e.position) continue;
    // 地図の描画と同じ集合で絞る。ここだけ scav を決め打ちで捨てていたため、
    // スカブランでは案内される脱出口が丸ごと嘘になっていた
    if (!state.factions.has(e.faction || 'shared')) continue;
    const dx = e.position.x - sample.x;
    const dz = e.position.z - sample.z;
    const dist = Math.hypot(dx, dz);
    if (!best || dist < best.dist) {
      const bearing = bearingDeg(sample.x, sample.z, e.position.x, e.position.z);
      best = {
        name: String(e.name || '').replace(/^EXFIL[_ ]?/i, ''),
        dist,
        bearing,
        needsSwitch: !!e.sw,
        relative: yaw === null ? null : angleDiffDeg(bearing, yaw),
      };
    }
  }
  return best;
}

function relativeText(rel) {
  const a = Math.abs(rel);
  if (a < 15) return '正面';
  if (a > 165) return '真後ろ';
  return `${rel > 0 ? '右' : '左'} ${a.toFixed(0)}°`;
}

function setStatus(text, cls) {
  const el = $('status');
  el.textContent = text;
  el.className = 'status ' + cls;
}

/**
 * 現在地が「いつのものか」を出し、古くなるほどマーカーを薄くする。
 *
 * 撮り忘れたまま移動しているときに、古い点を現在地だと信じて動くのが
 * このツールで最も危ない誤り。時間を出さないと見分けがつかない。
 */
function updateAge() {
  const el = $('sample-age');
  if (!state.shownAt) {
    el.textContent = '';
    state.view.setPlayerAge(null);
    return;
  }
  const sec = Math.max(0, (Date.now() - state.shownAt) / 1000);
  el.textContent =
    sec < 60 ? `${Math.round(sec)} 秒前`
      : sec < 3600 ? `${Math.floor(sec / 60)} 分 ${Math.round(sec % 60)} 秒前`
        : `${Math.floor(sec / 3600)} 時間前`;
  el.className = 'age ' + (sec < 30 ? 'fresh' : sec < 120 ? 'aging' : 'stale');
  state.view.setPlayerAge(sec);
}

function tickClock() {
  const now = Date.now();
  $('world-clock').textContent =
    `${formatGameTime(tarkovTimeHours(now, false))} / ${formatGameTime(tarkovTimeHours(now, true))}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

// Service Worker。インストール可能にし、一度開いたあとはオフラインでも動くようにする。
// file:// では登録できないので、その場合は静かに諦める（アプリ自体は動く）。
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').then((reg) => {
      // sw.js は install で skipWaiting するので、新しい版は即座に受け持ちを
      // 引き継ぐ。ページ側は古い JS のまま動き続けるため、データと合わなく
      // なることがある。黙って直らないより、再読み込みを勧める。
      let first = !navigator.serviceWorker.controller;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (first) { first = false; return; } // 初回インストールは通知しない
        const bar = document.getElementById('update-bar');
        if (bar) bar.hidden = false;
      });
      // 開いたままのタブでも、たまに更新を見に行く（30 分ごと）
      setInterval(() => reg.update().catch(() => {}), 30 * 60 * 1000);
    }).catch(() => {});
  });
  const reload = document.getElementById('btn-reload');
  if (reload) reload.addEventListener('click', () => location.reload());
}

boot().catch((err) => {
  document.body.insertAdjacentHTML(
    'afterbegin',
    `<pre style="color:#c9776c;padding:1rem">起動に失敗しました\n${escapeHtml(err && err.stack ? err.stack : err)}</pre>`,
  );
});
