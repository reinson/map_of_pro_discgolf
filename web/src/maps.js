import L from './leaflet-global.js';
import 'leaflet.markercluster';
import { SERIES_COLORS, dateRange, escapeHtml, initials, isSkippable, placeClass, placeLabel } from './data.js';

const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas';
const BASE_TILES = `${ESRI}/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}`;
const LABEL_TILES = `${ESRI}/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}`;
const ATTRIBUTION = 'Tiles &copy; Esri &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap contributors';

const FLY = 0.35;

const PANELS = {
  na: { el: 'map-na', bounds: [[25, -124], [49, -68]] },
  eu: { el: 'map-eu', bounds: [[48, 4], [65, 29]] },
};

/** Europe/Africa longitudes go to the Europe panel; everything else (Americas, Pacific) to North America. */
function panelFor(lat, lon) {
  if (lon >= -30 && lon < 60) return { key: 'eu', latlng: [lat, lon] };
  return { key: 'na', latlng: [lat, lon > 0 ? lon - 360 : lon] };
}

export function avatarHtml(player, size = 36) {
  const cls = `avatar ${player.division.toLowerCase()}`;
  const inner = player.avatar
    ? `<img src="${escapeHtml(player.avatar)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-initials="${initials(player.name)}">`
    : `<span>${initials(player.name)}</span>`;
  return `<div class="${cls}" style="--size:${size}px">${inner}</div>`;
}

function playerIcon(player, { size = 36, badge = null, focus = false } = {}) {
  const rank = `<b class="rank">${player.rank}</b>`;
  const extra = badge ? `<b class="place-badge ${badge.cls}">${badge.text}</b>` : rank;
  return L.divIcon({
    className: `player-marker${focus ? ' focus' : ''}`,
    html: avatarHtml(player, size) + extra,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

function eventIcon(event, { badge = null, active = false, shift = 0, ghost = false } = {}) {
  // Place badges are wider than the disc, so badged markers need more room side by side.
  const step = badge || ghost ? 26 : 20;
  const color = SERIES_COLORS[event.series] || '#555';
  const inner = badge ? `<b class="place-badge ${badge.cls}">${badge.text}</b>` : '';
  return L.divIcon({
    className: `event-marker${event.upcoming ? ' upcoming' : ''}${active ? ' active' : ''}${badge ? ' with-badge' : ''}${ghost ? ' ghost' : ''}`,
    html: `<div class="disc" style="--c:${color}"></div>${inner}`,
    iconSize: [22, 22],
    iconAnchor: [11 - shift * step, 11],
  });
}

/** Events sharing a town (e.g. USDGC and Throw Pink in Rock Hill) get side-by-side markers. */
function shiftCounter() {
  const seen = new Map();
  return (event) => {
    const k = `${event.lat.toFixed(3)},${event.lon.toFixed(3)}`;
    const n = seen.get(k) || 0;
    seen.set(k, n + 1);
    return n;
  };
}

/**
 * Leaflet stacks markers by screen y plus zIndexOffset; a large per-rank step makes the
 * marker (or group) holding the better-ranked player always sit above the others.
 */
function rankZ(rank) {
  return (201 - rank) * 100000;
}

function clusterIcon(cluster) {
  const players = cluster
    .getAllChildMarkers()
    .map((m) => m.options.player)
    .sort((a, b) => a.rank - b.rank);
  cluster.options.zIndexOffset = rankZ(players[0].rank);
  const shown = players.slice(0, 3);
  // Highest rank leftmost and on top; each later face tucks underneath the previous one.
  const faces = shown
    .map(
      (p, i) =>
        `<div class="face" data-pdga="${p.pdga}" style="z-index:${shown.length - i}">${avatarHtml(p, 30)}<b class="rank">${p.rank}</b></div>`,
    )
    .join('');
  const width = 30 + (shown.length - 1) * 18;
  return L.divIcon({
    className: 'player-cluster',
    html: `<b class="count" title="${players.length} players here">${players.length}</b><div class="stack">${faces}</div>`,
    iconSize: [width, 30],
    iconAnchor: [width / 2, 15],
  });
}

const ResetControl = L.Control.extend({
  options: { position: 'topleft' },
  initialize(onReset) {
    this.onReset = onReset;
  },
  onAdd() {
    const bar = L.DomUtil.create('div', 'leaflet-bar');
    const a = L.DomUtil.create('a', 'reset-view', bar);
    a.href = '#';
    a.title = 'Zoom out to the whole region';
    a.setAttribute('role', 'button');
    a.setAttribute('aria-label', 'Zoom out to the whole region');
    a.innerHTML = '⤢';
    L.DomEvent.disableClickPropagation(bar);
    L.DomEvent.on(a, 'click', (e) => {
      L.DomEvent.preventDefault(e);
      this.onReset();
    });
    return bar;
  },
});

export class DualMap {
  constructor({ onPlayerClick, onEventClick, onBackgroundClick }) {
    this.onPlayerClick = onPlayerClick;
    this.onEventClick = onEventClick;
    this.registry = { player: new Map(), event: new Map() };
    this.highlighted = null;
    this.panels = {};
    for (const [key, cfg] of Object.entries(PANELS)) {
      const map = L.map(cfg.el, {
        minZoom: 2,
        zoomSnap: 0.5,
        zoomDelta: 1,
        wheelPxPerZoomLevel: 40,
        wheelDebounceTime: 10,
        zoomAnimation: true,
      });
      L.tileLayer(BASE_TILES, { attribution: ATTRIBUTION, maxZoom: 16 }).addTo(map);
      L.tileLayer(LABEL_TILES, { maxZoom: 16, pane: 'shadowPane' }).addTo(map);
      map.fitBounds(cfg.bounds);
      new ResetControl(() => map.flyToBounds(cfg.bounds, { duration: FLY })).addTo(map);
      // Leaflet doesn't fire `click` after a drag, so panning won't clear the selection.
      map.on('click', () => onBackgroundClick?.());
      this.panels[key] = {
        map,
        cfg,
        players: L.markerClusterGroup({
          maxClusterRadius: 34,
          spiderfyDistanceMultiplier: 1.8,
          showCoverageOnHover: false,
          iconCreateFunction: clusterIcon,
        }).addTo(map),
        events: L.layerGroup().addTo(map),
        focus: L.layerGroup().addTo(map),
        ghosts: L.layerGroup().addTo(map),
        visible: true,
      };
    }
  }

  setVisible(visibility) {
    for (const [key, visible] of Object.entries(visibility)) this.panels[key].visible = visible;
    // The grid has already changed size; let Leaflet re-measure before refitting.
    requestAnimationFrame(() => {
      this.invalidate();
      this.refit();
    });
  }

  clear() {
    this.unhighlight();
    this.registry.player.clear();
    this.registry.event.clear();
    for (const p of Object.values(this.panels)) {
      p.players.clearLayers();
      p.events.clearLayers();
      p.focus.clearLayers();
      p.ghosts.clearLayers();
    }
    this.ghostable = null;
  }

  /** Grayed-out markers for events a player skipped; shown while hovering a dashed route leg. */
  showGhosts(events, shifts) {
    this.clearGhosts();
    for (const event of events) {
      const { key, latlng } = panelFor(event.lat, event.lon);
      const icon = eventIcon(event, { shift: shifts.get(event.slug) || 0, ghost: true });
      this.panels[key].ghosts.addLayer(L.marker(latlng, { icon, interactive: false, keyboard: false }));
    }
  }

  clearGhosts() {
    for (const p of Object.values(this.panels)) p.ghosts.clearLayers();
  }

  register(kind, id, marker, key) {
    const list = this.registry[kind].get(id) || [];
    list.push({ marker, key });
    this.registry[kind].set(id, list);
  }

  /** Emphasise the marker(s) for a player or event without hiding anything else. */
  highlight(kind, id) {
    this.unhighlight();
    const entries = this.registry[kind].get(id);
    if (!entries) {
      // A skipped event in the focused player's table has no marker; show it grayed out instead.
      const ghost = kind === 'event' && this.ghostable?.get(id);
      if (ghost) this.showGhosts([ghost], this.ghostShifts);
      return;
    }
    const lifted = [];
    for (const { marker, key } of entries) {
      // A clustered player is represented by its group's marker; light up their face in it.
      const shown = kind === 'player' ? this.panels[key].players.getVisibleParent(marker) || marker : marker;
      const el = shown.getElement?.();
      if (!el) continue;
      el.classList.add('hl');
      el.querySelector(`.face[data-pdga="${id}"]`)?.classList.add('hl');
      lifted.push({ shown, el, z: shown.options.zIndexOffset || 0 });
      shown.setZIndexOffset(2e9);
    }
    this.highlighted = lifted;
  }

  unhighlight() {
    for (const { shown, el, z } of this.highlighted || []) {
      el.classList.remove('hl');
      el.querySelector('.face.hl')?.classList.remove('hl');
      shown.setZIndexOffset(z);
    }
    this.highlighted = null;
    this.clearGhosts();
  }

  resetView() {
    this.lastFit = null;
    for (const p of Object.values(this.panels)) if (p.visible) p.map.flyToBounds(p.cfg.bounds, { duration: FLY });
  }

  invalidate() {
    for (const p of Object.values(this.panels)) p.map.invalidateSize();
  }

  showPlayers(players) {
    const buckets = { na: [], eu: [] };
    for (const player of players) {
      const { key, latlng } = panelFor(player.lat, player.lon);
      const m = L.marker(latlng, {
        icon: playerIcon(player),
        player,
        title: player.name,
        zIndexOffset: rankZ(player.rank),
        riseOnHover: true,
        riseOffset: 1e8,
      });
      m.bindTooltip(`<b>${escapeHtml(player.name)}</b><br>#${player.rank} ${player.division} · ${escapeHtml(player.home)}`, {
        direction: 'top',
        offset: [0, -18],
      });
      m.on('click', () => this.onPlayerClick(player.pdga));
      buckets[key].push(m);
      this.register('player', player.pdga, m, key);
    }
    for (const [key, ms] of Object.entries(buckets)) this.panels[key].players.addLayers(ms);
  }

  showEvents(events, { activeSlug = null, division = 'ALL' } = {}) {
    const shift = shiftCounter();
    const chains = new Map();
    for (const event of events) {
      const { key, latlng } = panelFor(event.lat, event.lon);
      const icon = eventIcon(event, { active: event.slug === activeSlug, shift: shift(event) });
      const m = L.marker(latlng, { icon, title: event.name, riseOnHover: true });
      m.bindTooltip(eventTooltip(event), { direction: 'top', offset: [0, -10] });
      m.on('click', () => this.onEventClick(event.slug));
      this.panels[key].events.addLayer(m);
      this.register('event', event.slug, m, key);
      // Heinola is Elite for MPO but EuroTour-only for FPO.
      const series = (division !== 'ALL' && event.division_series?.[division]) || event.series;
      const chain = `${key}:${series === 'EuroTour' ? 'EuroTour' : 'tour'}`;
      if (!chains.has(chain)) chains.set(chain, { key, euro: series === 'EuroTour', stops: [] });
      chains.get(chain).stops.push({ latlng, event });
    }
    for (const { key, euro, stops } of chains.values()) {
      stops.sort((a, b) => (a.event.start || '').localeCompare(b.event.start || ''));
      drawRoute(this.panels[key].focus, stops, { color: euro ? SERIES_COLORS.EuroTour : '#24292f' });
    }
  }

  /** A player's home plus every event they played, each labelled with the finishing place. */
  showPlayerFocus(player, rows, eventBySlug, schedule) {
    const points = { na: [], eu: [] };
    const home = panelFor(player.lat, player.lon);
    const homeMarker = L.marker(home.latlng, { icon: playerIcon(player, { size: 52, focus: true }), zIndexOffset: 1000 });
    homeMarker.bindTooltip(`<b>${escapeHtml(player.name)}</b><br>${escapeHtml(player.home)}`, { direction: 'top', offset: [0, -28] });
    this.panels[home.key].focus.addLayer(homeMarker);
    this.register('player', player.pdga, homeMarker, home.key);
    points[home.key].push(home.latlng);

    const shift = shiftCounter();
    const route = { na: [], eu: [] };
    for (const row of rows) {
      const event = eventBySlug.get(row.event);
      const { key, latlng } = panelFor(event.lat, event.lon);
      const badge = { text: placeLabel(row), cls: placeClass(row) };
      const m = L.marker(latlng, {
        icon: eventIcon(event, { badge, shift: shift(event) }),
        zIndexOffset: row.dnf ? 0 : 500 - row.place,
      });
      m.bindTooltip(eventTooltip(event, row), { direction: 'top', offset: [0, -12] });
      m.on('click', () => this.onEventClick(event.slug));
      this.panels[key].focus.addLayer(m);
      this.register('event', event.slug, m, key);
      route[key].push({ latlng, event });
      points[key].push(latlng);
    }
    // rows are chronological; each panel gets its own leg of the season (no NA↔EU jumps)
    const played = new Set(rows.map((r) => r.event));
    const unplayed = schedule.filter((e) => !played.has(e.slug));
    const ghostShifts = new Map(unplayed.map((e) => [e.slug, shift(e)]));
    this.ghostShifts = ghostShifts;
    this.ghostable = new Map(unplayed.map((e) => [e.slug, e]));
    const skipped = (a, b) => skippedBetween(schedule, played, player.division, a, b);
    const hover = {
      enter: (events) => this.showGhosts(events, ghostShifts),
      leave: () => this.clearGhosts(),
    };
    for (const [key, stops] of Object.entries(route)) drawRoute(this.panels[key].focus, stops, { skipped, hover });
    this.fitPoints(points);
  }

  /** An event plus the home towns of the ranked players who played it, labelled with their place there. */
  showEventFocus(event, entries) {
    const points = { na: [], eu: [] };
    const ev = panelFor(event.lat, event.lon);
    const evMarker = L.marker(ev.latlng, { icon: eventIcon(event, { active: true }), zIndexOffset: 1000 });
    evMarker.bindTooltip(eventTooltip(event), { direction: 'top', offset: [0, -10] });
    this.panels[ev.key].focus.addLayer(evMarker);
    this.register('event', event.slug, evMarker, ev.key);
    points[ev.key].push(ev.latlng);

    const buckets = { na: [], eu: [] };
    for (const { player, row } of entries) {
      const { key, latlng } = panelFor(player.lat, player.lon);
      const badge = { text: placeLabel(row), cls: placeClass(row) };
      const m = L.marker(latlng, { icon: playerIcon(player, { badge }), player, title: player.name, zIndexOffset: rankZ(player.rank) });
      m.bindTooltip(`<b>${escapeHtml(player.name)}</b> — ${placeLabel(row)}<br>${escapeHtml(player.home)}`, {
        direction: 'top',
        offset: [0, -18],
      });
      m.on('click', () => this.onPlayerClick(player.pdga));
      buckets[key].push(m);
      this.register('player', player.pdga, m, key);
      points[key].push(latlng);
    }
    for (const [key, ms] of Object.entries(buckets)) this.panels[key].players.addLayers(ms);
    this.fitPoints(points);
  }

  fitPoints(points) {
    this.lastFit = points;
    for (const [key, pts] of Object.entries(points)) {
      const { map, cfg, visible } = this.panels[key];
      if (!visible) continue;
      if (!pts.length) {
        map.flyToBounds(cfg.bounds, { duration: FLY });
      } else if (pts.length === 1) {
        map.flyTo(pts[0], Math.max(map.getZoom(), 5), { duration: FLY });
      } else {
        map.flyToBounds(L.latLngBounds(pts).pad(0.25), { maxZoom: 7, duration: FLY });
      }
    }
  }

  /** Re-apply the last fit, e.g. after a panel was resized by closing the other one. */
  refit() {
    if (this.lastFit) this.fitPoints(this.lastFit);
    else this.resetView();
  }
}

/**
 * Schedule events the player could have played between two of their stops but didn't.
 * EuroTour events don't count, nor do events without the player's division.
 */
function skippedBetween(schedule, played, division, from, to) {
  return schedule.filter(
    (e) => e.start > from.start && e.start < to.start && !played.has(e.slug) && isSkippable(e, division),
  );
}

function drawRoute(layer, stops, { skipped = () => [], hover = null, color = '#24292f' } = {}) {
  for (let i = 1; i < stops.length; i++) {
    const [a, b] = [stops[i - 1].latlng, stops[i].latlng];
    if (a[0] === b[0] && a[1] === b[1]) continue;
    const missed = skipped(stops[i - 1].event, stops[i].event);
    L.polyline([a, b], {
      color,
      weight: 2,
      opacity: missed.length ? 0.45 : 0.55,
      dashArray: missed.length ? '5 6' : null,
      interactive: false,
    }).addTo(layer);
    // Web Mercator is conformal, so the on-screen bearing is the same at every zoom.
    const pa = L.CRS.EPSG3857.latLngToPoint(L.latLng(a), 0);
    const pb = L.CRS.EPSG3857.latLngToPoint(L.latLng(b), 0);
    const angle = (Math.atan2(pb.y - pa.y, pb.x - pa.x) * 180) / Math.PI;
    // The line is straight in projected space, so its midpoint must be taken there too.
    const mid = L.CRS.EPSG3857.pointToLatLng(pa.add(pb).divideBy(2), 0);
    // Legs with skipped events get a larger hover target around the arrow.
    const size = missed.length ? 30 : 14;
    const arrow = L.marker(mid, {
      icon: L.divIcon({
        className: `route-arrow${missed.length ? ' skipped' : ''}`,
        html: `<svg viewBox="-5 -5 10 10" style="transform:rotate(${angle}deg);color:${color}"><path d="M4 0 -3.5 -3.5 -2 0 -3.5 3.5Z" fill="currentColor"/></svg>`,
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2],
      }),
      interactive: missed.length > 0,
      bubblingMouseEvents: false,
      keyboard: false,
    }).addTo(layer);
    if (!missed.length) continue;
    arrow.bindTooltip(skippedTooltip(missed), { direction: 'top', offset: [0, -10] });
    arrow.on('mouseover', () => hover.enter(missed));
    arrow.on('mouseout', () => hover.leave());
  }
}

function skippedTooltip(events) {
  const items = events
    .map((e) => `<span class="muted">${dateRange(e)}</span> ${escapeHtml(e.name)}`)
    .join('<br>');
  return `<b>Skipped ${events.length} event${events.length > 1 ? 's' : ''}</b><br>${items}`;
}

function eventTooltip(event, row = null) {
  const dates = dateRange(event);
  const head = `<b>${escapeHtml(event.name)}</b><br>${dates ? `<span class="muted">${dates}</span> · ` : ''}${escapeHtml(event.location)}`;
  if (row) return `${head}<br>${row.division}: <b>${placeLabel(row)}</b>`;
  const winners = Object.entries(event.divisions)
    .map(([d, v]) => `${d}: ${escapeHtml(v.winner)}`)
    .join('<br>');
  return `${head}${event.upcoming ? '<br><i>upcoming</i>' : winners ? `<br>${winners}` : ''}`;
}
