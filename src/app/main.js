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
    opt.textContent = m.affine ? m.key : `${m.key}（地図なし）`;
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

  setupGuide();
  setupWatcher();

  await selectMap(state.selectedKey);
  tickClock();
  setInterval(tickClock, 1000);

  const preset = params.get('sample');
  if (preset) {
    $('input-text').value = preset;
    handleInput(preset);
  }
  document.title = `EFT 測位クライアント — ${state.selectedKey}`;
}

/* -------------------------------------------------------- はじめての設定 */

function setupGuide() {
  const panel = $('setup');
  const open = () => { panel.hidden = false; };
  const close = () => {
    panel.hidden = true;
    localStorage.setItem('eft-gps.setupSeen', '1');
  };

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

  $('map-info').textContent = ok
    ? `${m.poiCount.toLocaleString()} POI / 脱出口 ${(m.extracts || []).length} / ` +
      `${m.scenes.map((s) => s.nameId).join(', ')}`
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
