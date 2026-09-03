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
import { loadMapDb } from '../mapdb/index.js';
import { validateSample, VERDICT, isDrawable, MapTracker } from '../verify/index.js';
import { ScreenshotWatcher, WATCH, isSupported } from '../watch/index.js';
import { MapView } from './map.js';
import { loadPins, savePins, addPin, removePin, renamePin, pinBearing } from './pins.js';
import { loadTasks, filterTasks, taskLabel, objectiveGeometry, OBJECTIVE_TYPE } from './tasks.js';
import { loadLandmarks, LAYERS, DEFAULT_ENABLED, hazardLabel, bossLabel } from './landmarks.js';

const $ = (id) => document.getElementById(id);

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
  tracker: new MapTracker({ windowSize: 12 }),
  factions: new Set(JSON.parse(localStorage.getItem('eft-gps.factions') || '["pmc","scav","shared"]')),
  selectedKey: localStorage.getItem('eft-gps.map') || 'customs',
  // 既定 ON。発火条件は d1 < 5m かつ 2位/1位 > 5 で、実測マージンは 30 倍ある。
  // 手動選択を置き換えるのではなく、明らかに間違っているときだけ直す。
  autoSwitch: (localStorage.getItem('eft-gps.autoSwitch') ?? '1') === '1',
  lastSample: null,
  lastModified: null,
  pins: [],
  landmarks: {},
  layers: new Set(JSON.parse(localStorage.getItem('eft-gps.layers') || 'null') || DEFAULT_ENABLED),
  tasks: [],
  taskFilter: '',
  activeTask: null,
  activePinId: localStorage.getItem('eft-gps.activePin') || null,
  placing: false,
  received: 0,
  skipped: 0,
};

/* ------------------------------------------------------------------ 起動 */

async function boot() {
  state.db = await loadMapDb('./data/');
  state.view = new MapView(window.L, $('map'));

  // ?map= と ?sample= で初期状態を指定できる (動作確認のスクリーンショット用)
  const params = new URLSearchParams(location.search);
  if (params.get('map')) state.selectedKey = params.get('map');

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
    renderSample(null, null);
  });
  $('floor-select').addEventListener('change', (ev) => {
    state.view.setFloor(ev.target.value || null);
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
    });
  }
  state.view.factions = new Set(state.factions);

  setupLayers();
  setupWatcher();
  setupGuide();
  setupPins();
  setupTasks();

  await selectMap(state.selectedKey);
  tickClock();
  setInterval(tickClock, 1000);

  // ?task=<id> でタスクを指定できる。特定の目標地点を人に見せるときに使える。
  const wantTask = params.get('task');
  if (wantTask && state.tasks.some((t) => t.id === wantTask)) selectTask(wantTask);

  const preset = params.get('sample');
  if (preset) {
    $('input-text').value = preset;
    handleInput(preset);
  }
  document.title = `EFT 測位クライアント — ${state.selectedKey}`;
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
  return item.n || '';
}

function renderLandmarks() {
  const drawn = state.view.setLandmarks(state.landmarks, state.layers, LAYERS, landmarkLabel);

  // どの種類が何件あるか出す。0 件なら「このマップには無い」と分かる
  const counts = LAYERS.filter((d) => state.layers.has(d.id))
    .map((d) => `${d.name} ${(state.landmarks[d.id] || []).length}`)
    .join(' / ');
  $('layer-hint').textContent = state.landmarks.failed
    ? `地点データを読めませんでした（${state.landmarks.failed}）`
    : counts || 'チェックを入れると地名や危険地帯を出せます。';

  for (const label of $('layer-filter').querySelectorAll('.chip')) {
    const n = (state.landmarks[label.dataset.layer] || []).length;
    label.classList.toggle('empty', n === 0);
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
}

/** そのマップのタスクを読み込んで一覧を作る。 */
async function loadMapTasks(mapData) {
  state.activeTask = null;
  state.tasks = await loadTasks(mapData.key, mapData.taskFile);
  $('task-filter').value = state.taskFilter = '';
  renderTaskOptions();
  renderObjectives();
  $('task-wiki').hidden = true;
  state.view.setTask(null, state.selectedKey);
}

function renderTaskOptions() {
  const sel = $('task-select');
  const shown = filterTasks(state.tasks, state.taskFilter);
  sel.innerHTML = '';
  const none = document.createElement('option');
  none.value = '';
  const m = state.db.byKey.get(state.selectedKey);
  none.textContent = state.tasks.length
    ? `— 選択なし（${shown.length} / ${state.tasks.length} 件）—`
    : state.tasks.failed
      ? `— タスクデータを読めませんでした（${state.tasks.failed}）—`
      : m && m.taskFile === undefined
        ? '— データが古いようです。Ctrl+Shift+R で再読み込みしてください —'
        : '— このマップに目標地点のあるタスクはありません —';
  sel.appendChild(none);
  for (const t of shown) {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = taskLabel(t);
    sel.appendChild(opt);
  }
  sel.disabled = !state.tasks.length;
  sel.value = state.activeTask ? state.activeTask.id : '';
}

function selectTask(id) {
  state.activeTask = id ? state.tasks.find((t) => t.id === id) || null : null;
  $('task-select').value = id || '';
  const wiki = $('task-wiki');
  wiki.hidden = !(state.activeTask && state.activeTask.w);
  if (!wiki.hidden) wiki.href = state.activeTask.w;
  state.view.setTask(state.activeTask, state.selectedKey, focusObjective);
  renderObjectives();
}

/** 目標 i の地点へ地図を寄せる。 */
function focusObjective(i) {
  if (!state.activeTask) return;
  const g = objectiveGeometry(state.activeTask.o[i], state.selectedKey);
  const p = g.zones[0] ? { x: g.zones[0].p[0], z: g.zones[0].p[2] }
    : g.spots[0] ? { x: g.spots[0][0], z: g.spots[0][2] } : null;
  if (p) state.view.focusWorld(p.x, p.z);
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

    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'obj-row' + (here ? '' : ' away');

    // 現在地からいちばん近い地点までの距離
    const spotCount = g.zones.length + g.spots.length;
    let meta = here ? (OBJECTIVE_TYPE[objective.t] || objective.t || '') : '別マップ';
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
    else row.disabled = true;
    box.appendChild(row);
  });
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
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && state.placing) setPlacing(false);
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
  if (localStorage.getItem('eft-gps.setupSeen') !== '1') open();
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

/** 新しいスクリーンショットが 1 枚できたとき。 */
function handleScreenshot(filename, lastModified) {
  const sample = parseScreenshotName(filename);
  if (!sample) return; // 座標の入っていないファイル
  $('input-text').value = filename;
  state.lastSample = sample;
  state.lastModified = lastModified;
  applySample(sample, lastModified, true);
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
  applySample(sample, null, false);
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

  // 累積で別マップと定まったとき、設定されていれば自動で合わせる。
  if (verdict.verdict === VERDICT.WRONG_MAP && state.autoSwitch) {
    // 地図の読み込みを待ってから描く。待たずに進むと、切り替え途中の
    // レイヤ掃除でマーカーが消えることがある。
    await selectMap(verdict.suggest);
    verdict = validateSample({
      sample, selectedKey: verdict.suggest, db: state.db, fileModifiedMs, tracker: state.tracker,
    });
  }

  if (live && verdict.verdict === VERDICT.NOT_IN_RAID) {
    state.skipped++;
    $('watch-count').textContent = `${state.received} 枚受信 / ${state.skipped} 枚除外`;
  }

  renderSample(sample, verdict);

  const m = state.db.byKey.get(state.selectedKey);
  if (m && m.affine && isDrawable(verdict.verdict)) {
    state.view.setPlayer(sample, headingOf(sample), verdict.verdict === VERDICT.ACCEPT);
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
    const base = (m.tarkovDev && m.tarkovDev.svgLayer) || '';
    const ids = state.view.setFloor(null);
    for (const id of ids) {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = id.replace(/_/g, ' ');
      if (id === base) opt.selected = true;
      floors.appendChild(opt);
    }
    floors.disabled = ids.length < 2;
  } else {
    floors.disabled = true;
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
      : `${yaw.toFixed(1)}°（見上げ ${pitch.toFixed(1)}°）`],
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
      `${activePin.name}　${b.dist.toFixed(0)} m　方位 ${b.bearing.toFixed(0)}°` +
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
      `${exit.name}　${exit.dist.toFixed(0)} m　方位 ${exit.bearing.toFixed(0)}°` +
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
        if (state.lastSample) applySample(state.lastSample, state.lastModified, false);
      });
    };
  }
}

function nearestExit(map, sample, yaw) {
  if (!map || !(map.extracts || []).length) return null;
  let best = null;
  for (const e of map.extracts) {
    if (!e.position) continue;
    if (e.faction === 'scav') continue; // PMC / 共用のみ
    const dx = e.position.x - sample.x;
    const dz = e.position.z - sample.z;
    const dist = Math.hypot(dx, dz);
    if (!best || dist < best.dist) {
      const bearing = bearingDeg(sample.x, sample.z, e.position.x, e.position.z);
      best = {
        name: String(e.name || '').replace(/^EXFIL[_ ]?/i, ''),
        dist,
        bearing,
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
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

boot().catch((err) => {
  document.body.insertAdjacentHTML(
    'afterbegin',
    `<pre style="color:#c9776c;padding:1rem">起動に失敗しました\n${escapeHtml(err && err.stack ? err.stack : err)}</pre>`,
  );
});
