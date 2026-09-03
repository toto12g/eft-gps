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
    /** 表示する脱出口の陣営 */
    this.factions = new Set(['pmc', 'scav', 'shared']);

    /** ピンを置くモード。次のクリックで onMapClick を呼ぶ */
    this.placing = false;
    /** @type {(world:{x:number,z:number}) => void} */
    this.onMapClick = () => {};
    /** @type {(id:string) => void} */
    this.onPinClick = () => {};

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
    for (const key of ['baseLayer', 'extractLayer', 'playerLayer', 'trailLayer', 'pinLayer', 'routeLayer']) {
      if (this[key]) {
        this[key].remove();
        this[key] = null;
      }
    }
    if (!mapData || !mapData.svg || !mapData.affine) return false;

    const L = this.L;
    const [vx, vy, vw, vh] = mapData.svgViewBox;
    const bounds = L.latLngBounds([vy, vx], [vy + vh, vx + vw]);

    const svgText = await fetch('./' + mapData.svg).then((r) => r.text());
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
    return true;
  }

  /** SVG のレイヤ (フロア) を出し分ける。null で既定レイヤ。 */
  setFloor(svgLayerId) {
    if (!this.svgElement) return [];
    const base = (this.mapData.tarkovDev && this.mapData.tarkovDev.svgLayer) || null;
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
            `<span class="dot" style="--c:${color}"></span>` +
            `<span class="label" style="--c:${color}">${escapeHtml(label)}</span>`,
          iconSize: [0, 0],
        }),
        interactive: true,
      }).addTo(this.extractLayer);
      marker.bindTooltip(
        `${escapeHtml(e.name || '')}<br>${FACTION_LABEL[faction] || faction}<br>` +
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
