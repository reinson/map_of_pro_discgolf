import {
  SERIES_COLORS,
  behindLabel,
  dateRange,
  escapeHtml,
  placeClass,
  placeLabel,
  skippedEvents,
  toParLabel,
} from './data.js';
import { avatarHtml } from './maps.js';

const DIV_NAMES = { MPO: 'Mixed Pro Open', FPO: 'Women’s Pro Open' };

function seriesChip(series) {
  return `<span class="chip" style="--c:${SERIES_COLORS[series] || '#555'}">${escapeHtml(series)}</span>`;
}

export function playersListView(season, division, top) {
  const divs = division === 'ALL' ? ['MPO', 'FPO'] : [division];
  const sections = divs.map((div) => {
    const rows = season.players
      .filter((p) => p.division === div && p.rank <= top)
      .map(
        (p) => `
        <li class="row" data-player="${p.pdga}">
          ${avatarHtml(p, 32)}
          <span class="rank-num">${p.rank}</span>
          <span class="grow"><b>${escapeHtml(p.name)}</b><small>${escapeHtml(p.home)}</small></span>
          <span class="num">${p.points.toFixed(0)}</span>
        </li>`,
      )
      .join('');
    return `<h3>${div} · Top ${top} <small>DGPT World Standings, ${season.standings_as_of}</small></h3><ul class="list">${rows}</ul>`;
  });
  return `<div class="intro">Players are placed at the centre of their PDGA home town. Click a player or search to see their season.</div>${sections.join('')}`;
}

export function eventsListView(season, division) {
  const rows = season.events
    .filter((e) => e.upcoming || division === 'ALL' || e.divisions[division])
    .map((e) => {
      const winners = Object.entries(e.divisions)
        .filter(([d]) => division === 'ALL' || d === division)
        .map(([d, v]) => `<small>${d}: ${escapeHtml(v.winner)} (${toParLabel(v.winning_to_par)})</small>`)
        .join('');
      return `
        <li class="row" data-event="${e.slug}">
          <span class="dot" style="--c:${SERIES_COLORS[e.series]}"></span>
          <span class="date">${dateRange(e)}</span>
          <span class="grow"><b>${escapeHtml(e.name)}</b><small>${escapeHtml(e.location)}</small>${e.upcoming ? '<small><i>Upcoming</i></small>' : winners}</span>
        </li>`;
    })
    .join('');
  const legend = Object.entries(SERIES_COLORS)
    .map(([s, c]) => `<span class="legend-item"><span class="dot" style="--c:${c}"></span>${s}</span>`)
    .join('');
  return `<div class="legend">${legend}</div><h3>2026 DGPT schedule</h3><ul class="list">${rows}</ul>`;
}

export function playerDetailView(season, player, rows) {
  const finished = rows.filter((r) => !r.dnf);
  const wins = finished.filter((r) => r.place === 1).length;
  const podiums = finished.filter((r) => r.place <= 3).length;
  const avg = finished.length ? (finished.reduce((s, r) => s + r.place, 0) / finished.length).toFixed(1) : '–';
  const skipped = skippedEvents(season, player, rows);
  const entries = [
    ...rows.map((r) => ({ event: season.eventBySlug.get(r.event), row: r })),
    ...skipped.map((event) => ({ event, row: null })),
  ].sort((a, b) => (a.event.start || '').localeCompare(b.event.start || ''));
  const table = entries
    .map(({ event: e, row: r }) => {
      const dot = `<span class="dot" style="--c:${SERIES_COLORS[e.series]}"></span>`;
      if (!r) {
        return `
      <tr class="clickable skipped" data-event="${e.slug}">
        <td class="date">${dateRange(e)}</td>
        <td>${dot}${escapeHtml(e.name)}</td>
        <td colspan="3" class="muted">skipped</td>
      </tr>`;
      }
      return `
      <tr class="clickable" data-event="${e.slug}">
        <td class="date">${dateRange(e)}</td>
        <td>${dot}${escapeHtml(e.name)}${r.teammate ? `<small>with ${escapeHtml(r.teammate)}</small>` : ''}</td>
        <td><b class="place-badge inline ${placeClass(r)}">${placeLabel(r)}</b></td>
        <td class="num">${toParLabel(r.toPar)}</td>
        <td class="num behind">${behindLabel(r)}</td>
      </tr>`;
    })
    .join('');
  return `
    <button class="back" data-action="clear">← All players</button>
    <div class="profile">
      ${avatarHtml(player, 84)}
      <div>
        <h2>${escapeHtml(player.name)}</h2>
        <div class="muted">#${player.rank} ${player.division} · ${player.points.toFixed(2)} pts</div>
        <div class="muted">${escapeHtml(player.home)}</div>
        <a href="${player.profile}" target="_blank" rel="noopener">PDGA #${player.pdga} ↗</a>
      </div>
    </div>
    <div class="stats">
      <div><b>${rows.length}</b><small>events</small></div>
      <div><b>${wins}</b><small>wins</small></div>
      <div><b>${podiums}</b><small>podiums</small></div>
      <div><b>${avg}</b><small>avg place</small></div>
      <div><b>${skipped.length}</b><small>skipped</small></div>
    </div>
    <table class="results">
      <thead><tr><th>Date</th><th>Event</th><th>Place</th><th>Par</th><th>Behind</th></tr></thead>
      <tbody>${table || '<tr><td colspan="5" class="muted">No DGPT results</td></tr>'}</tbody>
    </table>
    <p class="footnote">“Behind” is strokes behind the winner. Players who missed a cut are compared to the leader after the same round.
    A dashed route means a tour event was skipped in between (EuroTour events not counted); hover its arrow to see them.</p>`;
}

export function eventDetailView(season, event, division, top) {
  const divs = Object.keys(event.divisions);
  const active = divs.includes(division) ? division : divs[0];
  const tabs = divs
    .map((d) => `<button data-tab="${d}" class="${d === active ? 'active' : ''}">${d} <small>${event.divisions[d].players}</small></button>`)
    .join('');
  const rows = (season.results[event.slug]?.[active] || [])
    .map((r) => {
      const p = r.pdga ? season.playerById.get(r.pdga) : null;
      const ranked = p && p.division === active ? p : null;
      return `
      <tr class="${ranked ? 'clickable ranked' : ''}" ${ranked ? `data-player="${p.pdga}"` : ''}>
        <td><b class="place-badge inline ${placeClass(r)}">${placeLabel(r)}</b></td>
        <td class="who">${ranked ? avatarHtml(ranked, 22) : '<span class="avatar-gap"></span>'}${escapeHtml(r.name)}${ranked ? ` <small>#${ranked.rank}</small>` : ''}</td>
        <td class="num">${toParLabel(r.toPar)}</td>
        <td class="num">${r.total ?? ''}</td>
        <td class="num behind">${behindLabel(r)}</td>
      </tr>`;
    })
    .join('');
  const links = event.pdga.map((id) => `<a href="https://www.pdga.com/tour/event/${id}" target="_blank" rel="noopener">PDGA ${id} ↗</a>`).join(' ');
  return `
    <button class="back" data-action="clear">← All competitions</button>
    <div class="event-head">
      ${seriesChip(event.series)}
      <h2>${escapeHtml(event.name)}</h2>
      <div class="muted">${dateRange(event)} · ${escapeHtml(event.location)}</div>
      ${event.note ? `<div class="note">${escapeHtml(event.note)}</div>` : ''}
      <div>${links}</div>
    </div>
    ${
      event.upcoming
        ? '<p class="muted">This event hasn’t been played yet.</p>'
        : `<div class="tabs">${tabs}</div>
    <p class="footnote">${DIV_NAMES[active]}. Avatars mark top-100 players; the map shows home towns of the top ${top} who played.</p>
    <table class="results">
      <thead><tr><th>Place</th><th>Player</th><th>Par</th><th>Total</th><th>Behind</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`
    }`;
}
