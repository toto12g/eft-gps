/**
 * Leaflet の設定とマップ描画。
 *
 * CRS を「SVG のユーザ座標そのもの」にしている。
 *   latLng = [py, px]   (lat = 画像 y, lng = 画像 x)
 *   transformation = 恒等 (1, 0, 1, 0) なので y は下向きのまま
 * これでマップ固有の知識がすべて 1 本のアフィンに集約され、CRS は全マップ共通になる。
 * SVG は常に軸並行の矩形 [[0,0],[H,W]] に貼るので、回転を考えなくてよい。
 *
 * Leaflet は vendor/leaflet からグローバル L として読み込まれている前提。
 */

import { applyAffine, worldToLatLng, latLngToWorld, headingToScreenDeg } from '../geo/index.js';

/** 陣営ごとの色。地図の配色 (青緑・灰・カーキ) から浮くものを選んでいる。 */
export const FACTION_COLOR = {
  pmc: '#6fd66f',
  scav: '#ff7a5c',
  shared: '#ffc848',
};
export const FACTION_LABEL = { pmc: 'PMC', scav: 'スカブ', shared: '共通' };
/** 色だけだと、暗い地図の上の小さな点は色覚特性によっては判別できない。形も変える。 */
export const FACTION_SHAPE = { pmc: 'circle', scav: 'triangle', shared: 'square' };

/** SVG のピクセル座標をそのまま CRS 単位として使う。 */
export function makeCRS(L) {
  return L.extend({}, L.CRS.Simple, {
    transformation: new L.Transformation(1, 0, 1, 0),
  });
}

export class MapView {
  /**
   * @param {any} L Leaflet のグローバル
   * @param {HTMLElement} container
   */
  constructor(L, container) {
    this.L = L;
    this.map = L.map(container, {
      crs: makeCRS(L),
      minZoom: -4,
      maxZoom: 4,
      zoomSnap: 0.25,
      zoomDelta: 0.5,
      wheelPxPerZoomLevel: 90,
      attributionControl: true,
      zoomControl: true,
    });
    this.map.attributionControl.setPrefix('');

    this.baseLayer = null;
    this.extractLayer = null;
    this.playerLayer = null;
    this.trailLayer = null;
    this.mapData = null;
    this.svgElement = null;
    this.trail = [];
    this.pinLayer = null;
    this.routeLayer = null;
    this.taskLayer = null;
    this.landmarkLayer = null;
    this.northCtl = null;
    this.hintLayer = null;
    /** 表示する脱出口の陣営 */
    this.factions = new Set(['pmc', 'scav', 'shared']);

    /** ピンを置くモード。次のクリックで onMapClick を呼ぶ */
    this.placing = false;
    /** @type {(world:{x:number,z:number}) => void} */
    this.onMapClick = () => {};
    /** @type {(id:string) => void} */
    this.onPinClick = () => {};

    // 拡大したときだけ、数の多い地点のラベルを出す（CSS 側で制御）
    const syncZoomClass = () => {
      this.map.getContainer().classList.toggle('zoomed-in', this.map.getZoom() >= 1);
    };
    this.map.on('zoomend', syncZoomClass);
    syncZoomClass();

    this.map.on('click', (ev) => {
      if (!this.placing || !this.mapData || !this.mapData.affine) return;
      const w = latLngToWorld(this.mapData.affine, ev.latlng.lat, ev.latlng.lng);
      if (w) this.onMapClick(w);
    });
  }

  /** ピン設置モードの切り替え。カーソルも変える。 */
  setPlacing(on) {
    this.placing = !!on;
    const el = this.map.getContainer();
    el.classList.toggle('placing-pin', this.placing);
  }

  /** マップを切り替える。SVG が無いマップでは false を返す。 */
  async setMap(mapData) {
    this.mapData = mapData;
    this.trail = [];
    for (const key of ['baseLayer', 'extractLayer', 'playerLayer', 'trailLayer', 'pinLayer', 'routeLayer', 'taskLayer', 'landmarkLayer', 'hintLayer']) {
      if (this[key]) {
        this[key].remove();
        this[key] = null;
      }
    }
    if (!mapData || !mapData.svg || !mapData.affine) return false;

    const L = this.L;
    const [vx, vy, vw, vh] = mapData.svgViewBox;
    const bounds = L.latLngBounds([vy, vx], [vy + vh, vx + vw]);

    // cache: 'no-cache' の理由は src/mapdb/index.js のコメントを参照。
    // 付けないと、デプロイ直後の 10 分間だけ古い SVG と新しい affine が
    // 組み合わさり、「更新したのにズレている」という報告になる。
    const svgText = await fetch('./' + mapData.svg, { cache: 'no-cache' }).then((r) => r.text());
    const holder = document.createElement('div');
    holder.innerHTML = svgText;
    const svg = holder.querySelector('svg');
    svg.setAttribute('viewBox', `${vx} ${vy} ${vw} ${vh}`);
    svg.setAttribute('preserveAspectRatio', 'none'); // 貼る矩形と viewBox が一致しているので不要
    this.svgElement = svg;
    this.setFloor(null); // 既定のフロアだけ表示する

    this.baseLayer = L.svgOverlay(svg, bounds, { interactive: false }).addTo(this.map);
    this.map.setMaxBounds(bounds.pad(0.4));
    this.map.invalidateSize(false);
    this.map.fitBounds(bounds, { padding: [12, 12], animate: false });

    this.drawExtracts();
    this.setNorth(mapData.northDeg);
    return true;
  }

  /** SVG のレイヤ (フロア) を出し分ける。null で既定レイヤ。 */
  setFloor(svgLayerId) {
    if (!this.svgElement) return [];
    const base = this.mapData.svgBaseLayer || null;
    const want = svgLayerId || base;
    const groups = [...this.svgElement.children].filter((c) => c.nodeName === 'g' && c.id);
    for (const g of groups) {
      const keep = !want || g.id === want || g.dataset.keepWithGroup === want;
      g.style.display = keep ? '' : 'none';
    }
    return groups.map((g) => g.id);
  }

  /** 表示する陣営を変える。 */
  setFactions(factions) {
    this.factions = new Set(factions);
    if (this.mapData && this.mapData.affine) {
      if (this.extractLayer) this.extractLayer.remove();
      this.drawExtracts();
    }
  }

  drawExtracts() {
    const L = this.L;
    const aff = this.mapData.affine;
    this.extractLayer = L.layerGroup().addTo(this.map);

    for (const e of this.mapData.extracts || []) {
      const faction = e.faction || 'shared';
      if (!this.factions.has(faction)) continue;
      const color = FACTION_COLOR[faction] || '#c8d0ce';

      if ((e.outline || []).length >= 3) {
        L.polygon(
          e.outline.map((v) => worldToLatLng(aff, v.x, v.z)),
          { color, weight: 2, fillOpacity: 0.35, interactive: false },
        ).addTo(this.extractLayer);
      }
      if (!e.position) continue;

      const label = String(e.name || '').replace(/^EXFIL[_ ]?/i, '');
      const marker = L.marker(worldToLatLng(aff, e.position.x, e.position.z), {
        icon: L.divIcon({
          className: 'extract-icon',
          html:
            `<span class="dot ex-${FACTION_SHAPE[faction] || 'circle'}" style="--c:${color}"></span>` +
            (e.sw ? `<span class="sw" title="スイッチが要る">⚡</span>` : '') +
            `<span class="label" style="--c:${color}">${escapeHtml(label)}</span>`,
          iconSize: [0, 0],
        }),
        interactive: true,
      }).addTo(this.extractLayer);
      marker.bindTooltip(
        `${escapeHtml(e.name || '')}<br>${FACTION_LABEL[faction] || faction}` +
          (e.sw ? '<br><b>スイッチを入れないと使えない</b>' : '') + '<br>' +
          `x ${e.position.x.toFixed(1)} / y ${e.position.y.toFixed(1)} / z ${e.position.z.toFixed(1)}`,
      );
    }
  }

  /**
   * 現在地を置く。
   * @param {{x:number,y:number,z:number}} pos
   * @param {number|null} yawDeg
   * @param {boolean} confident false なら破線で描く
   */
  setPlayer(pos, yawDeg, confident = true) {
    const L = this.L;
    if (this.playerLayer) this.playerLayer.remove();
    if (!this.mapData || !this.mapData.affine || !pos) return;

    const aff = this.mapData.affine;
    const latlng = worldToLatLng(aff, pos.x, pos.z);
    const screenDeg = yawDeg === null || yawDeg === undefined ? null : headingToScreenDeg(aff, yawDeg);

    // 真上・真下を向いていると方位が定義できない (yawDeg が null で来る)。
    // その場合は矢印ではなく丸を出す。嘘の向きを描かないため。
    const cls = confident ? '' : ' unsure';
    const html =
      `<span class="player-ring${cls}"></span>` +
      (screenDeg === null
        ? `<span class="player-dot${cls}"></span>`
        : `<span class="player-arrow${cls}" style="transform:rotate(${screenDeg}deg)"></span>`);

    this.playerLayer = L.marker(latlng, {
      icon: L.divIcon({ className: 'player-icon', html, iconSize: [0, 0] }),
      zIndexOffset: 1000,
      interactive: false,
    }).addTo(this.map);

    this.trail.push(latlng);
    if (this.trail.length > 60) this.trail.shift();
    if (this.trailLayer) this.trailLayer.remove();
    if (this.trail.length > 1) {
      this.trailLayer = L.polyline(this.trail, {
        color: '#22e0ff',
        weight: 2,
        opacity: 0.5,
        dashArray: '4 5',
        interactive: false,
      }).addTo(this.map);
    }
    // 画面外に出たときだけ追従する。毎回中央に寄せると、全体が見えている
    // 状態からいきなり地図が画面外へ押し出されて位置関係が分からなくなる。
    if (!this.map.getBounds().pad(-0.15).contains(latlng)) {
      this.map.panTo(latlng, { animate: true });
    }
  }

  /**
   * ピンを描き直す。
   * @param {import('./pins.js').Pin[]} pins
   * @param {string|null} activeId 目的地に設定されているピン
   */
  setPins(pins, activeId = null) {
    const L = this.L;
    if (this.pinLayer) this.pinLayer.remove();
    this.pinLayer = null;
    if (!this.mapData || !this.mapData.affine || !pins || !pins.length) return;

    const aff = this.mapData.affine;
    this.pinLayer = L.layerGroup().addTo(this.map);

    for (const pin of pins) {
      const active = pin.id === activeId;
      const marker = L.marker(worldToLatLng(aff, pin.x, pin.z), {
        icon: L.divIcon({
          className: 'pin-icon' + (active ? ' active' : ''),
          html: `<span class="head"></span><span class="label">${escapeHtml(pin.name)}</span>`,
          iconSize: [0, 0],
        }),
        zIndexOffset: active ? 900 : 500,
        interactive: true,
      }).addTo(this.pinLayer);
      marker.on('click', (ev) => {
        // ピンをクリックしたときに地図のクリック（ピン設置）を起こさない
        if (ev.originalEvent) L.DomEvent.stopPropagation(ev.originalEvent);
        this.onPinClick(pin.id);
      });
    }
  }

  /**
   * 選択中のタスクの目標地点を描く。
   * @param {Object|null} task
   * @param {string} mapKey
   * @param {(index:number) => void} [onPick] 目標をクリックしたとき
   */
  setTask(task, mapKey, onPick = () => {}, keyDoors = []) {
    const L = this.L;
    if (this.taskLayer) this.taskLayer.remove();
    this.taskLayer = null;
    if (!task || !this.mapData || !this.mapData.affine) return;

    const aff = this.mapData.affine;
    this.taskLayer = L.layerGroup().addTo(this.map);
    const COLOR = '#b48cff'; // 脱出口（緑/橙/黄）ともピン（琥珀）とも被らない色

    // そのタスクの鍵で開く扉。レイヤのオンオフに関係なく出す。
    // 「鍵はこれ、扉はここ」が 1 回の選択で揃うようにするため。
    for (const { key, locks } of keyDoors) {
      for (const lock of locks) {
        const marker = L.marker(worldToLatLng(aff, lock.p[0], lock.p[2]), {
          icon: L.divIcon({
            className: 'task-door',
            html: `<span class="mark"></span><span class="label">${escapeHtml(key.n)}</span>`,
            iconSize: [0, 0],
          }),
          zIndexOffset: 650,
        }).addTo(this.taskLayer);
        marker.bindTooltip(`この鍵で開く扉: ${escapeHtml(key.n)}`);
      }
    }

    (task.o || []).forEach((objective, i) => {
      const zones = (objective.z || []).filter((z) => z.m === mapKey);
      const spots = [];
      for (const loc of objective.l || []) if (loc.m === mapKey) spots.push(...loc.p);
      const label = `${i + 1}. ${objective.d || ''}`;

      // 同じ目標が何十箇所もあることがある（BTR の停車地点など）。
      // そこに毎回説明文を描くと地図が文字で埋まって読めなくなるので、
      // 地点が少ないときだけ文字を出し、多いときは番号だけにする。
      // 説明はホバーのツールチップと左の一覧で読める。
      const showText = zones.length <= 2;

      for (const z of zones) {
        if ((z.o || []).length >= 3) {
          L.polygon(z.o.map((v) => worldToLatLng(aff, v[0], v[1])), {
            color: COLOR, weight: 2, fillOpacity: 0.28, interactive: false,
          }).addTo(this.taskLayer);
        }
        const marker = L.marker(worldToLatLng(aff, z.p[0], z.p[2]), {
          icon: L.divIcon({
            className: 'task-icon',
            html:
              `<span class="num">${i + 1}</span>` +
              (showText ? `<span class="label">${escapeHtml(objective.d || '')}</span>` : ''),
            iconSize: [0, 0],
          }),
          zIndexOffset: 700,
        }).addTo(this.taskLayer);
        marker.bindTooltip(escapeHtml(label));
        marker.on('click', (ev) => {
          if (ev.originalEvent) L.DomEvent.stopPropagation(ev.originalEvent);
          onPick(i);
        });
      }

      for (const s of spots) {
        L.circleMarker(worldToLatLng(aff, s[0], s[2]), {
          radius: 4, color: COLOR, weight: 2, fillOpacity: 0.5, interactive: false,
        }).addTo(this.taskLayer);
      }
    });
  }

  /**
   * 名前の付いた地点を描く。
   * @param {Object} data 種類 → 配列
   * @param {Set<string>} enabled 表示する種類
   * @param {Object[]} layers LAYERS の定義
   * @param {(item:Object, kind:string) => string} labelOf 表示名
   */
  setLandmarks(data, enabled, layers, labelOf) {
    const L = this.L;
    if (this.landmarkLayer) this.landmarkLayer.remove();
    this.landmarkLayer = null;
    if (!this.mapData || !this.mapData.affine || !data) return;

    const aff = this.mapData.affine;
    const group = L.layerGroup();
    let drawn = 0;

    for (const def of layers) {
      if (!enabled.has(def.id)) continue;
      for (const item of data[def.id] || []) {
        const text = labelOf(item, def.id);
        const latlng = worldToLatLng(aff, item.p[0], item.p[2]);

        // 範囲を持つもの（危険地帯）は面でも描く
        if ((item.o || []).length >= 3) {
          L.polygon(item.o.map((v) => worldToLatLng(aff, v[0], v[1])), {
            color: def.color, weight: 1.5, fillOpacity: 0.18, interactive: false,
          }).addTo(group);
        }

        const html =
          def.shape === 'text'
            ? `<span class="lm-text" style="--c:${def.color}">${escapeHtml(text)}</span>`
            : `<span class="lm-mark lm-${def.shape}" style="--c:${def.color}"></span>` +
              `<span class="lm-label" style="--c:${def.color}">${escapeHtml(text)}</span>`;

        const marker = L.marker(latlng, {
          icon: L.divIcon({
            // 湧きは陣営(item.s)で見た目を変える。数が多いので色分けが要る
            className: `lm-icon lm-kind-${def.id}${item.s ? ' lm-side-' + item.s : ''}`,
            html,
            iconSize: [0, 0],
          }),
          zIndexOffset: def.id === 'label' ? 100 : 300,
          interactive: def.shape !== 'text',
        }).addTo(group);
        // 湧きのように地図上に文字を出さないものは、item.n を吹き出しに回す
        if (def.shape !== 'text') {
          marker.bindTooltip(text ? `${def.name}: ${escapeHtml(text)}` : escapeHtml(item.n || def.name));
        }
        drawn++;
      }
    }

    if (drawn) {
      this.landmarkLayer = group.addTo(this.map);
    }
    return drawn;
  }

  /**
   * 方位ローズ。北がどちらかを図の右下に出す。
   * 「方位 77°」と言われても、基準が図に無いと地図と結び付かない。
   * アフィンに写した「北」の向きを描くので、回転・反転した図でも正しく向く。
   */
  setNorth(northDeg) {
    if (this.northCtl) {
      this.northCtl.remove();
      this.northCtl = null;
    }
    if (northDeg === null || northDeg === undefined || !this.mapData || !this.mapData.affine) return;
    const deg = headingToScreenDeg(this.mapData.affine, northDeg);
    const L = this.L;
    const Ctl = L.Control.extend({
      onAdd() {
        const el = L.DomUtil.create('div', 'north-rose');
        el.innerHTML = `<span class="needle" style="transform:rotate(${deg}deg)"></span><span class="n">N</span>`;
        el.title = `北（ワールドの方位 ${northDeg}°）`;
        return el;
      },
    });
    this.northCtl = new Ctl({ position: 'bottomright' });
    this.northCtl.addTo(this.map);
  }

  /**
   * 「このマップで最も近い POI」を 1 点描く。
   * マップ違いを疑われたときに、そこに何も無いことを目で確かめられるようにする。
   */
  setNearestHint(point) {
    if (this.hintLayer) {
      this.hintLayer.remove();
      this.hintLayer = null;
    }
    if (!point || !this.mapData || !this.mapData.affine) return;
    const L = this.L;
    this.hintLayer = L.circleMarker(worldToLatLng(this.mapData.affine, point.x, point.z), {
      radius: 6, color: '#c9776c', weight: 2, dashArray: '3 3', fillOpacity: 0,
      interactive: true,
    }).addTo(this.map);
    this.hintLayer.bindTooltip(`このマップで最も近い既知の地点（${point.d.toFixed(0)} m）`);
  }

  /** 指定のワールド座標へ寄る。 */
  focusWorld(x, z) {
    if (!this.mapData || !this.mapData.affine) return;
    this.map.setView(worldToLatLng(this.mapData.affine, x, z), Math.max(this.map.getZoom(), 1), {
      animate: true,
    });
  }

  /** 目的地までの線を現在地から引く。 */
  drawRoute(from, to) {
    const L = this.L;
    if (this.routeLayer) this.routeLayer.remove();
    this.routeLayer = null;
    if (!from || !to || !this.mapData || !this.mapData.affine) return;
    const aff = this.mapData.affine;
    this.routeLayer = L.polyline(
      [worldToLatLng(aff, from.x, from.z), worldToLatLng(aff, to.x, to.z)],
      { color: '#ffc848', weight: 2, opacity: 0.75, dashArray: '6 6', interactive: false },
    ).addTo(this.map);
  }

  /**
   * 現在地マーカーの「古さ」を反映する。30 秒で 0.7、2 分で 0.45、5 分で 0.25。
   * 撮り忘れたまま動いているときに、古い点だと気づけるようにするため。
   */
  setPlayerAge(seconds) {
    if (!this.playerLayer) return;
    const el = this.playerLayer.getElement();
    if (!el) return;
    let op = 1;
    if (seconds !== null && seconds !== undefined) {
      if (seconds > 300) op = 0.25;
      else if (seconds > 120) op = 0.45;
      else if (seconds > 30) op = 0.7;
    }
    el.style.opacity = String(op);
  }

  /** SVG 上の座標を返す (デバッグ・診断用)。 */
  project(x, z) {
    return applyAffine(this.mapData.affine, x, z);
  }

  clearTrail() {
    this.trail = [];
    if (this.trailLayer) {
      this.trailLayer.remove();
      this.trailLayer = null;
    }
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}
