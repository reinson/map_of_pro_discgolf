import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import './style.css';
import { escapeHtml, fold, loadSeason } from './data.js';
import { DualMap, avatarHtml } from './maps.js';
import { eventDetailView, eventsListView, playerDetailView, playersListView } from './sidebar.js';

const DEFAULTS = { mode: 'players', division: 'ALL', top: 20, panels: 'both', player: null, event: null, eventTab: null };
const TOP_OPTIONS = [10, 20, 30, 50, 100];
const state = { ...DEFAULTS };
const sidebar = document.getElementById('sidebar');
let season;
let maps;

function inFilter(p) {
  return (state.division === 'ALL' || p.division === state.division) && p.rank <= state.top;
}

function visiblePlayers() {
  return season.players.filter(inFilter);
}

function applyPanels() {
  const el = document.querySelector('.maps');
  el.classList.toggle('only-na', state.panels === 'na');
  el.classList.toggle('only-eu', state.panels === 'eu');
  maps.setVisible({ na: state.panels !== 'eu', eu: state.panels !== 'na' });
}

function visibleEvents() {
  return season.events.filter((e) => e.upcoming || state.division === 'ALL' || e.divisions[state.division]);
}

function render({ fit = false } = {}) {
  maps.clear();
  if (state.player) {
    const player = season.playerById.get(state.player);
    const rows = season.resultsByPlayer.get(player.pdga) || [];
    sidebar.innerHTML = playerDetailView(season, player, rows);
    maps.showPlayerFocus(player, rows, season.eventBySlug, season.events);
  } else if (state.event) {
    const event = season.eventBySlug.get(state.event);
    const tab = state.eventTab || (state.division !== 'ALL' ? state.division : Object.keys(event.divisions)[0]);
    sidebar.innerHTML = eventDetailView(season, event, tab, state.top);
    const entries = [];
    for (const [div, rows] of Object.entries(season.results[event.slug] || {})) {
      for (const row of rows) {
        const player = row.pdga && season.playerById.get(row.pdga);
        if (player && player.division === div && inFilter(player)) entries.push({ player, row });
      }
    }
    maps.showEventFocus(event, entries);
  } else if (state.mode === 'players') {
    sidebar.innerHTML = playersListView(season, state.division, state.top);
    maps.showPlayers(visiblePlayers());
    if (fit) maps.resetView();
  } else {
    sidebar.innerHTML = eventsListView(season, state.division);
    maps.showEvents(visibleEvents(), { division: state.division });
    if (fit) maps.resetView();
  }
  sidebar.scrollTop = 0;
  renderSelectionChip();
  syncControls();
  writeHash();
}

function renderSelectionChip() {
  const chip = document.getElementById('selection');
  let label = null;
  if (state.player) {
    const p = season.playerById.get(state.player);
    label = `${avatarHtml(p, 22)}<span>${escapeHtml(p.name)}</span>`;
  } else if (state.event) {
    label = `<span>${escapeHtml(season.eventBySlug.get(state.event).name)}</span>`;
  }
  chip.hidden = !label;
  chip.innerHTML = label
    ? `${label}<button data-action="clear" title="Clear selection (Esc)" aria-label="Clear selection">×</button>`
    : '';
}

function selectPlayer(pdga) {
  Object.assign(state, { player: pdga, event: null, eventTab: null });
  render();
}

function selectEvent(slug) {
  Object.assign(state, { event: slug, player: null, eventTab: null });
  render();
}

function clearSelection() {
  Object.assign(state, { player: null, event: null, eventTab: null });
  render({ fit: true });
}

function syncControls() {
  const groups = [['mode', state.mode], ['division', state.division], ['top', String(state.top)], ['panels', state.panels]];
  for (const [id, value] of groups) {
    for (const b of document.querySelectorAll(`#${id} button`)) b.classList.toggle('active', b.dataset.value === value);
  }
}

function writeHash() {
  const params = new URLSearchParams();
  if (state.player) params.set('player', state.player);
  else if (state.event) params.set('event', state.event);
  else if (state.mode !== 'players') params.set('mode', state.mode);
  if (state.division !== 'ALL') params.set('div', state.division);
  if (state.top !== DEFAULTS.top) params.set('top', state.top);
  if (state.panels !== DEFAULTS.panels) params.set('maps', state.panels);
  const hash = params.toString();
  history.replaceState(null, '', hash ? `#${hash}` : location.pathname);
}

function readHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  const player = Number(params.get('player'));
  if (player && season.playerById.has(player)) state.player = player;
  const event = params.get('event');
  if (event && season.eventBySlug.has(event)) state.event = event;
  if (params.get('mode') === 'events') state.mode = 'events';
  if (['MPO', 'FPO'].includes(params.get('div'))) state.division = params.get('div');
  const top = Number(params.get('top'));
  if (TOP_OPTIONS.includes(top)) state.top = top;
  if (['na', 'eu'].includes(params.get('maps'))) state.panels = params.get('maps');
}

function setupControls() {
  document.getElementById('mode').addEventListener('click', (e) => {
    const value = e.target.closest('button')?.dataset.value;
    if (!value) return;
    Object.assign(state, { mode: value, player: null, event: null, eventTab: null });
    render({ fit: true });
  });
  document.getElementById('division').addEventListener('click', (e) => {
    const value = e.target.closest('button')?.dataset.value;
    if (!value) return;
    state.division = value;
    if (state.player && value !== 'ALL' && season.playerById.get(state.player).division !== value) state.player = null;
    state.eventTab = null;
    render();
  });
  document.getElementById('top').addEventListener('click', (e) => {
    const value = Number(e.target.closest('button')?.dataset.value);
    if (!value) return;
    state.top = value;
    render();
  });
  const setPanels = (value) => {
    state.panels = value;
    applyPanels();
    syncControls();
    writeHash();
  };
  document.getElementById('panels').addEventListener('click', (e) => {
    const value = e.target.closest('button')?.dataset.value;
    if (value) setPanels(value);
  });
  document.querySelector('.maps').addEventListener('click', (e) => {
    const closing = e.target.closest('[data-close]')?.dataset.close;
    if (!closing) return;
    // closing the only open map brings both back rather than leaving nothing
    setPanels(state.panels === 'both' ? (closing === 'na' ? 'eu' : 'na') : 'both');
  });

  sidebar.addEventListener('click', (e) => {
    const el = e.target.closest('[data-player],[data-event],[data-action],[data-tab]');
    if (!el || e.target.closest('a')) return;
    if (el.dataset.action === 'clear') clearSelection();
    else if (el.dataset.tab) {
      state.eventTab = el.dataset.tab;
      render();
    } else if (el.dataset.player) selectPlayer(Number(el.dataset.player));
    else if (el.dataset.event) selectEvent(el.dataset.event);
  });

  let hovered = null;
  sidebar.addEventListener('mouseover', (e) => {
    const el = e.target.closest('[data-player],[data-event]');
    if (el === hovered) return;
    hovered = el;
    if (!el) return maps.unhighlight();
    if (el.dataset.player) maps.highlight('player', Number(el.dataset.player));
    else maps.highlight('event', el.dataset.event);
  });
  sidebar.addEventListener('mouseleave', () => {
    hovered = null;
    maps.unhighlight();
  });

  document.getElementById('selection').addEventListener('click', (e) => {
    if (e.target.closest('[data-action="clear"]')) clearSelection();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.activeElement !== searchInput && (state.player || state.event)) clearSelection();
  });
}

const searchInput = document.getElementById('search');
const suggestions = document.getElementById('suggestions');
let activeIndex = -1;

function setupSearch() {
  const index = season.players.map((p) => ({ p, key: fold(p.name) }));

  const close = () => {
    suggestions.hidden = true;
    activeIndex = -1;
  };
  const choose = (pdga) => {
    close();
    searchInput.value = '';
    searchInput.blur();
    selectPlayer(pdga);
  };
  const highlight = () => {
    [...suggestions.children].forEach((li, i) => li.classList.toggle('active', i === activeIndex));
  };

  searchInput.addEventListener('input', () => {
    const q = fold(searchInput.value.trim());
    if (!q) return close();
    const hits = index
      .filter(({ p, key }) => key.includes(q) && (state.division === 'ALL' || p.division === state.division))
      .sort((a, b) => (a.key.startsWith(q) ? 0 : 1) - (b.key.startsWith(q) ? 0 : 1) || a.p.rank - b.p.rank)
      .slice(0, 8);
    suggestions.innerHTML = hits.length
      ? hits
          .map(
            ({ p }) => `<li data-player="${p.pdga}">${avatarHtml(p, 26)}<span><b>${escapeHtml(p.name)}</b><small>#${p.rank} ${p.division} · ${escapeHtml(p.home)}</small></span></li>`,
          )
          .join('')
      : '<li class="empty">No top-100 player matches</li>';
    suggestions.hidden = false;
    activeIndex = hits.length ? 0 : -1;
    highlight();
  });
  searchInput.addEventListener('keydown', (e) => {
    const items = [...suggestions.querySelectorAll('li[data-player]')];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!items.length) return;
      activeIndex = (activeIndex + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      highlight();
    } else if (e.key === 'Enter' && items[activeIndex]) {
      choose(Number(items[activeIndex].dataset.player));
    } else if (e.key === 'Escape') {
      close();
      searchInput.blur();
    }
  });
  suggestions.addEventListener('mousedown', (e) => {
    const li = e.target.closest('li[data-player]');
    if (li) {
      e.preventDefault();
      choose(Number(li.dataset.player));
    }
  });
  searchInput.addEventListener('blur', () => setTimeout(close, 100));
}

// Players without a reachable PDGA photo fall back to initials.
document.addEventListener(
  'error',
  (e) => {
    const img = e.target;
    if (img.tagName === 'IMG' && img.dataset.initials) {
      const span = document.createElement('span');
      span.textContent = img.dataset.initials;
      img.replaceWith(span);
    }
  },
  true,
);

async function main() {
  season = await loadSeason();
  maps = new DualMap({
    onPlayerClick: selectPlayer,
    onEventClick: selectEvent,
    onBackgroundClick: () => {
      if (state.player || state.event) clearSelection();
    },
  });
  readHash();
  setupControls();
  setupSearch();
  applyPanels();
  render();
  window.addEventListener('resize', () => maps.invalidate());
  window.addEventListener('hashchange', () => {
    Object.assign(state, DEFAULTS);
    readHash();
    applyPanels();
    render({ fit: !state.player && !state.event });
  });
}

main();
