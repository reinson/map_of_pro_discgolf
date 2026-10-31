export const SERIES_COLORS = {
  Major: '#b8860b',
  Elite: '#1f6feb',
  Playoffs: '#8250df',
  Championship: '#cf222e',
  JomezPro: '#1a7f37',
  EuroTour: '#0e7490',
};

const RESULT_FIELDS = ['place', 'tied', 'name', 'pdga', 'total', 'toPar', 'behind', 'rounds', 'behindAfter', 'dnf', 'teammate'];

export async function loadSeason() {
  const res = await fetch(`${import.meta.env.BASE_URL}season.json`);
  const raw = await res.json();

  const events = raw.events.sort((a, b) => (a.start < b.start ? -1 : 1));
  const eventBySlug = new Map(events.map((e) => [e.slug, e]));

  const results = {};
  const resultsByPlayer = new Map();
  for (const [slug, divs] of Object.entries(raw.results)) {
    results[slug] = {};
    for (const [div, rows] of Object.entries(divs)) {
      results[slug][div] = rows.map((arr) => {
        const row = Object.fromEntries(RESULT_FIELDS.map((k, i) => [k, arr[i]]));
        row.event = slug;
        row.division = div;
        if (row.pdga) {
          if (!resultsByPlayer.has(row.pdga)) resultsByPlayer.set(row.pdga, []);
          resultsByPlayer.get(row.pdga).push(row);
        }
        return row;
      });
    }
  }
  for (const rows of resultsByPlayer.values()) {
    rows.sort((a, b) => (eventBySlug.get(a.event).start < eventBySlug.get(b.event).start ? -1 : 1));
  }

  const players = raw.players;
  const playerById = new Map(players.map((p) => [p.pdga, p]));

  return { ...raw, events, eventBySlug, results, resultsByPlayer, players, playerById };
}

export function placeLabel(row) {
  if (row.dnf) return 'DNF';
  return `${row.tied ? 'T' : ''}${row.place}`;
}

export function toParLabel(v) {
  if (v === null || v === undefined) return '';
  if (v === 0) return 'E';
  return v > 0 ? `+${v}` : `${v}`;
}

export function behindLabel(row) {
  if (row.behind === null || row.behind === undefined) return '';
  if (row.place === 1 && !row.dnf && row.behindAfter === null) return 'won';
  const s = `+${row.behind}`;
  return row.behindAfter ? `${s} after R${row.behindAfter}` : s;
}

export function placeClass(row) {
  if (row.dnf) return 'p-dnf';
  if (row.place === 1) return 'p-1';
  if (row.place === 2) return 'p-2';
  if (row.place === 3) return 'p-3';
  if (row.place <= 10) return 'p-top10';
  return 'p-rest';
}

export function initials(name) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

export function fold(s) {
  return s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

export function dateRange(e) {
  const fmt = (d, opts) => new Date(`${d}T12:00:00`).toLocaleDateString('en-US', opts);
  if (!e.start) return '';
  if (e.start === e.end || !e.end) return fmt(e.start, { month: 'short', day: 'numeric' });
  const sameMonth = e.start.slice(5, 7) === e.end.slice(5, 7);
  return `${fmt(e.start, { month: 'short', day: 'numeric' })}–${fmt(e.end, sameMonth ? { day: 'numeric' } : { month: 'short', day: 'numeric' })}`;
}

/**
 * Whether not playing this event counts as skipping it: it has been played, has the
 * player's division, and isn't EuroTour (Heinola is EuroTour-only for FPO).
 */
export function isSkippable(event, division) {
  return (
    !event.upcoming &&
    Boolean(event.divisions[division]) &&
    (event.division_series?.[division] || event.series) !== 'EuroTour'
  );
}

/** Schedule events a player could have played but didn't, in date order. */
export function skippedEvents(season, player, rows) {
  const played = new Set(rows.map((r) => r.event));
  return season.events.filter((e) => !played.has(e.slug) && isSkippable(e, player.division));
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
