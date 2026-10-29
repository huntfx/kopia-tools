// Charts of size over time, stacked or overlaid
import { api, notLoaded } from './data.js';
import { el, formatFull, formatSize, plural, svgEl } from './format.js';
import { ofType, typeFiles, typeName } from './filetypes.js';
import { render } from './render.js';
import { joinRel, locationsBelow, treeNodes } from './sidebar.js';
import { openHistory } from './snapshots.js';
import { navigate, state, ui } from './state.js';
import { folderObj, pathInScope, selectedSnapshot, snapshotListing } from './storage.js';

// How the space the locations inside a folder take on disk grew over time, stacked: each location's running
// total as of its latest snapshot at each moment. kopia counts storage per location, so data shared between
// locations is counted in each.
export function renderStorageChart(node) {
  // Like the totals elsewhere, a location inside another counts as part of that one
  const below = locationsBelow(node);
  const within = (inner, outer) => inner.path.toLowerCase().startsWith(`${outer.path.replace(/\\$/, '').toLowerCase()}\\`);
  const locations = below.filter(l => l.snapshots.some(s => !s.incomplete) && !below.some(o => o !== l && within(l, o)));
  if (locations.length < 2) return null;

  // Every moment a snapshot was taken, then now; each location's total is its latest snapshot's by then
  const now = Date.now();
  const times = [...new Set(locations.flatMap(l => l.snapshots.filter(s => !s.incomplete).map(s => Date.parse(s.time)))), now]
    .sort((a, b) => a - b);
  const items = locations.map(loc => {
    const snaps = loc.snapshots.filter(s => !s.incomplete);
    let at = -1;
    const values = times.map(t => {
      while (at + 1 < snaps.length && Date.parse(snaps[at + 1].time) <= t) at++;
      return at < 0 ? 0 : snaps[at].total;
    });
    return {
      name: loc.path.slice(loc.path.replace(/\\$/, '').lastIndexOf('\\') + 1) || loc.path, title: loc.path, values,
      lastAt: t => Math.max(0, ...snaps.filter(s => Date.parse(s.time) <= t).map(s => Date.parse(s.time))),
      // Like its row in Contents
      pick: () => { ui.pickedRow = loc.path; ui.pickedIsFolder = true; navigate({ history: loc.path }); },
      open: () => navigate({ location: loc.path, snapshot: null }),
    };
  });

  return stackedChart({
    key: `folder:${node.path}`, heading: 'Space on disk over time', pieHeading: 'Space on disk', what: ['location', 'locations'], items, times, now,
    note: 'Each location\'s data on disk, as it grew with each snapshot it still has, with locations inside another counted as part of it. kopia counts each location\'s storage separately, so data shared between them is counted more than once and the total can be a little more than the repository uses.',
  });
}

// How big each folder and file in the folder in scope was at each of a location's snapshots, stacked, from
// the folder's listing at each one. kopia only counts space on disk for whole locations, so this is size.
export function renderSizeChart(loc) {
  const complete = loc.snapshots.filter(s => !s.incomplete);
  if (complete.length < 2) return null;
  // While loading, it can still be switched between folders and files, and file types
  const panel = (...body) => el('section', { class: 'panel' },
    el('div', { class: 'chart-head' }, el('h2', {}, 'Size over time'), sizeViews()), ...body);
  if (sizeByType) return renderTypesChart(loc, complete, panel);
  const listings = complete.map(snap => snapshotListing(snap, state.scope));
  if (listings.includes(undefined)) return panel(el('p', { class: 'note' }, notLoaded('folder listings')));
  // Narrowed to a type, only files of it, and how much of it each folder had inside
  const inside = state.type == null ? null
    : complete.map((snap, j) => (listings[j] === null ? {} : api.typesInside(folderObj(snap, state.scope))));
  if (inside?.includes(undefined)) return panel(el('p', { class: 'note' }, notLoaded('file types')));

  // Each thing in it at each snapshot, holding until the next, then the same now
  const now = Date.now();
  const times = [...complete.map(s => Date.parse(s.time)), now];
  const found = new Map();
  listings.forEach((entries, j) => {
    for (const entry of entries || []) {
      const size = !inside ? entry.s || 0
        : entry.t === 'd' ? inside[j][entry.n]?.[state.type]?.[1] || 0 : ofType(entry.n) ? entry.s || 0 : 0;
      if (inside && !size) continue;
      const key = `${entry.t}:${entry.n}`;
      if (!found.has(key)) found.set(key, { entry, values: times.map(() => 0) });
      found.get(key).values[j] = size;
    }
  });
  if (!found.size) return inside ? panel(el('p', { class: 'note' }, `No ${typeFiles(state.type)} in here at any snapshot.`)) : null;
  const lastAt = t => Math.max(0, ...times.slice(0, -1).filter(time => time <= t));
  const items = [...found.values()].map(({ entry, values }) => {
    values[values.length - 1] = values[values.length - 2];
    const isFolder = entry.t === 'd';
    const full = pathInScope(loc, entry.n);
    const nested = isFolder ? treeNodes.get(full.toLowerCase())?.location : null;
    return {
      name: entry.n + (isFolder ? '\\' : ''), title: full, values, lastAt,
      // Like its row in Contents: its snapshots, then going into it, a location inside, or a file's own page
      pick: () => { ui.pickedRow = full; openHistory(entry.n, isFolder); },
      open: () => navigate(nested ? { location: nested.path, snapshot: null }
        : isFolder ? { scope: joinRel(state.scope, entry.n) } : { file: entry.n }),
    };
  });

  return stackedChart({
    key: `size:${loc.path}:${state.scope}:${state.type}`, heading: 'Size over time', pieHeading: 'Size', at: viewedAt(complete, loc),
    what: ['item', 'items'], items, times, now, views: sizeViews(),
    note: 'How big each folder and file in here was at each snapshot. kopia only counts space on disk for a whole location, so this is their size rather than what they take up in the repository.',
  });
}

// The size chart by file type instead: how much of each type was in the folder in scope at each snapshot,
// counting everything inside it. Narrowed to a type, it's just that one.
function renderTypesChart(loc, complete, panel) {
  const objs = complete.map(snap => folderObj(snap, state.scope));
  if (objs.includes(undefined)) return panel(el('p', { class: 'note' }, notLoaded('folder listings')));
  // Not in a snapshot, it had nothing then
  const tallies = objs.map(obj => (obj === null ? {} : api.types(obj)));
  if (tallies.includes(undefined)) return panel(el('p', { class: 'note' }, notLoaded('file types')));

  const now = Date.now();
  const times = [...complete.map(s => Date.parse(s.time)), now];
  const lastAt = t => Math.max(0, ...times.slice(0, -1).filter(time => time <= t));
  const extensions = [...new Set(tallies.flatMap(Object.keys))].filter(extension => state.type == null || extension === state.type);
  if (!extensions.length) return state.type == null ? null : panel(el('p', { class: 'note' }, `No ${typeFiles(state.type)} in here at any snapshot.`));
  const items = extensions.map(extension => {
    const values = [...tallies.map(tally => tally[extension]?.[1] || 0)];
    values.push(values[values.length - 1]);
    const name = typeName(extension);
    return { name, title: extension ? `${extension} files` : 'Files with no extension', values, lastAt, hint: null };
  });

  return stackedChart({
    key: `types:${loc.path}:${state.scope}:${state.type}`, heading: 'Size over time', pieHeading: 'Size', at: viewedAt(complete, loc),
    what: ['type', 'types'], items, times, now, views: sizeViews(),
    note: 'How much of each file type was in here at each snapshot, counting everything inside it. This is their size rather than what they take up in the repository.',
  });
}

// Where the snapshot being viewed is among a location's complete ones, for the pie, which shows it like Contents
// does: the latest, if one still being made or cancelled is being viewed
const viewedAt = (complete, loc) => {
  const at = complete.indexOf(selectedSnapshot(loc));
  return at < 0 ? complete.length - 1 : at;
};

// The size chart's bands are the folders and files in the folder in scope, or file types; remembered
export let sizeByType = false;

try { sizeByType = localStorage.getItem('sizeChart') === 'types'; } catch {}

function sizeViews() {
  const setByType = byType => {
    sizeByType = byType;
    try { localStorage.setItem('sizeChart', byType ? 'types' : 'contents'); } catch {}
    render();
  };
  return el('span', { class: 'chart-modes', role: 'group', 'aria-label': 'What the bands are' },
    [['Folders & files', false, 'A band for each folder and file in here'], ['File types', true, 'A band for each file type, counting everything in here']]
      .map(([label, byType, title]) => el('button', { 'aria-pressed': String(sizeByType === byType), title, onclick: () => setByType(byType) }, label)));
}

// Clicking a band hides it, and clicking Others hides all the ones shown, to see what's left in more detail.
// These are the ones hidden, by title, for the chart they're hidden from, so they stay hidden while moving
// around the page.
export let chartHidden = { key: null, titles: new Set() };

// Charts stack their bands on top of each other, or overlay them, each from zero, to compare them, or show
// each one's share at one moment as a pie; remembered
export let chartMode = 'stacked';

try { chartMode = ['overlaid', 'pie'].includes(localStorage.getItem('chartMode')) ? localStorage.getItem('chartMode') : 'stacked'; } catch {}

// A stacked chart of things over time, smallest at the bottom: items are { name, title (unique), values (one per
// time), lastAt(t) (the snapshot a value at t is from), pick(), open() (what single and double clicks on its
// band do, like its row in Contents), hint (saying so, or null where they do nothing) }. They go biggest first
// overall, by the area under each one, so something big that's since gone still counts. The first seven shown get
// their own colours, or up to 14 if Others would be big; any more are added together as Others. views, if given,
// switches what the bands are, beside switching between stacked, overlaid and pie. The pie, the legend and the total are at the
// time at (an index into times, the last by default); the pie's headed pieHeading. Whichever way it's shown, the
// legend's the same, and hiding one hides it in all of them.
export function stackedChart(options) {
  const { key, heading, pieHeading, what, items, times, now, note, views } = options;
  const at = options.at ?? times.length - 1;
  const pie = chartMode === 'pie';
  const chartOverlaid = chartMode === 'overlaid';
  const hidden = chartHidden.key === key ? chartHidden.titles : new Set();
  // Each value holds until the next time
  const area = new Map(items.map(item => [item, item.values.reduce((sum, v, j) => sum + v * ((times[j + 1] ?? times[j]) - times[j]), 0)]));
  const byArea = (a, b) => area.get(b) - area.get(a);
  const sorted = [...items].sort(byArea);
  const shown = sorted.filter(item => !hidden.has(item.title));
  const setHidden = titles => {
    chartHidden = { key, titles };
    panel.replaceWith(stackedChart(options));
  };
  // The biggest overall get colours of their own. While what's left would still be more than a fifth of the total
  // at the time shown, the biggest of the rest then get one too, in lighter shades of the same colours, up to 14.
  // Others of just one would be no better than naming it.
  const named = shown.length > 8 ? shown.slice(0, 7) : [...shown];
  const sizeAt = list => list.reduce((sum, item) => sum + item.values[at], 0);
  const whole = sizeAt(shown);
  const rest = shown.filter(item => !named.includes(item)).sort((a, b) => b.values[at] - a.values[at]);
  while (rest.length && named.length < 14 && sizeAt(rest) > whole / 5) named.push(rest.shift());
  if (rest.length === 1) named.push(rest.shift());
  const others = rest;
  // The last one shown stays, so there's always something to see
  const hideItem = item => { if (shown.length > 1) setHidden(new Set([...hidden, item.title])); };
  const openOthers = () => setHidden(new Set([...hidden, ...named.map(item => item.title)]));
  // Biggest overall first, coloured in that order, past seven in lighter shades, so each keeps its colour
  // whichever time's shown
  const bySize = [
    ...named.sort(byArea).map((item, i) => ({ ...item, colour: i < 7 ? `var(--series-${i + 1})` : `color-mix(in srgb, var(--series-${i - 6}) 55%, var(--surface))` })),
    ...(others.length ? [{
      name: `${others.length} others`, title: `${others.length} smaller ${what[1]} added together`, colour: 'var(--series-other)', others: true,
      values: times.map((_, j) => others.reduce((sum, item) => sum + item.values[j], 0)),
      lastAt: t => Math.max(...others.map(item => item.lastAt(t))),
    }] : []),
  ];
  // The total and each one's share then, as the legend and the pie say them
  const total = bySize.reduce((sum, s) => sum + s.values[at], 0);
  const share = value => `${(total ? 100 * value / total : 0).toFixed(1)}%`;
  // From the bottom up: stacked, the ones that barely change at this scale at the bottom, biggest first, as a solid
  // base, then the rest, steadiest first, so one changing only moves those above it, which change more anyway. The
  // pie goes round biggest first, like the legend.
  const changed = s => s.values.reduce((sum, v, j) => sum + (j ? Math.abs(v - s.values[j - 1]) : 0), 0);
  const height = Math.max(...times.map((_, j) => bySize.reduce((sum, s) => sum + s.values[j], 0)));
  const steady = s => changed(s) < height / 50;
  const series = chartOverlaid || pie ? bySize
    : [...bySize].sort((a, b) => steady(b) - steady(a) || (steady(a) ? 0 : changed(a) - changed(b)));
  // Each band's top at each moment, stacked in order from the bottom; overlaid, the scale goes up to the biggest one
  const tops = [];
  series.forEach((s, i) => tops.push(s.values.map((v, j) => v + (i ? tops[i - 1][j] : 0))));
  const max = chartOverlaid ? Math.max(...series.flatMap(s => s.values)) : Math.max(...tops[tops.length - 1]);

  // Drawn at the width it's shown at, once it's on the page, and again if that changes
  const chart = el('div', { class: 'storage-chart' });
  let highlight = () => {};
  let drawnWidth = 0;
  const drawIfResized = () => {
    if (!chart.isConnected || !chart.clientWidth || Math.abs(chart.clientWidth - drawnWidth) <= 1) return;
    drawnWidth = chart.clientWidth;
    highlight = pie
      ? drawPieChart(chart, drawnWidth, { heading: pieHeading || heading, slices: series, at, total, share, openOthers })
      : drawStackedChart(chart, drawnWidth, { heading, series, times, tops, max, now, openOthers, overlaid: chartOverlaid });
  };
  new ResizeObserver(drawIfResized).observe(chart);
  // Straight away once it's been put on the page, which happens just after this returns
  queueMicrotask(drawIfResized);

  // The legend names every band, biggest first, then Others, with each one's size and share; hovering one picks
  // out its band, and clicking one hides it. Hidden ones stay in it, greyed out, at the end, and clicking one
  // shows it again, which may move the smallest band shown back into Others.
  const showItem = item => setHidden(new Set([...hidden].filter(title => title !== item.title)));
  // In the order they're coloured, then Others, then any hidden
  const entries = [
    ...series.map((s, i) => ({ s, i, order: bySize.indexOf(s) })),
    ...items.filter(item => hidden.has(item.title)).map(item => ({ s: item, hidden: true, order: bySize.length + sorted.indexOf(item) })),
  ].sort((a, b) => a.order - b.order);
  const legend = el('div', { class: 'chart-legend' }, entries.map(({ s, i, hidden: isHidden }) => el('button', {
    class: isHidden ? 'hidden-item' : null,
    title: isHidden ? `${s.title}\nHidden - click to show it again`
      : s.others ? 'Click to hide the bigger ones and show these separately' : `${s.title}\nClick to hide it`,
    onmouseenter: isHidden ? null : () => highlight(i), onmouseleave: isHidden ? null : () => highlight(null),
    onclick: isHidden ? () => showItem(s) : s.others ? openOthers : () => hideItem(s),
  }, el('span', { class: 'swatch', style: isHidden ? null : `background:${s.colour}` }), el('span', { class: 'name' }, s.name),
    el('span', { class: 'muted' }, isHidden ? formatSize(s.values[at]) : `${formatSize(s.values[at])} (${share(s.values[at])})`))));

  const when = at === times.length - 1 ? 'now' : `at ${formatFull(new Date(times[at]).toISOString())}`;
  const panel = el('section', { class: 'panel' },
    el('div', { class: 'chart-head' }, el('h2', {}, pie ? pieHeading || heading : heading),
      hidden.size ? el('span', { class: 'legend', title: items.filter(item => hidden.has(item.title)).map(item => item.title).join('\n') },
        `${plural(hidden.size, what[0])} hidden · `,
        el('button', { class: 'linklike', onclick: () => setHidden(new Set()) }, 'Show all')) : null,
      el('span', { class: 'legend', style: 'margin-left:auto' }, `${formatSize(total)} ${when}`),
      views, chartModes()),
    pie && !total ? el('p', { class: 'note' }, `Nothing in here ${when}`) : chart,
    legend,
    el('p', { class: 'note', style: 'margin:8px 0 0' }, note));
  return panel;
}

// Stacked, overlaid or a pie, for every chart on the page
function chartModes() {
  const setMode = mode => {
    chartMode = mode;
    try { localStorage.setItem('chartMode', mode); } catch {}
    render();
  };
  return el('span', { class: 'chart-modes', role: 'group', 'aria-label': 'How the chart shows them' },
    [['Stacked', 'stacked', 'On top of each other, adding up to the total'], ['Overlaid', 'overlaid', 'Each from zero, to compare them'],
      ['Pie', 'pie', 'Each one\'s share of the total']].map(([label, mode, title]) =>
      el('button', { 'aria-pressed': String(chartMode === mode), title, onclick: () => setMode(mode) }, label)));
}

// Draw a stacked chart's bands as a pie at one time, as a ring with the total in the middle, into its box at a
// width, returning how to pick out a slice, for the legend. Each slice is its band's size then, in its colour,
// going round from the top, biggest first. Hovering a slice says what it is; clicking does what clicking its band
// does.
function drawPieChart(chart, width, { heading, slices, at, total, share, openOthers }) {
  const height = 240;
  const outer = 108, inner = 50, cx = width / 2, cy = height / 2;
  const point = (angle, radius) => `${(cx + radius * Math.cos(angle)).toFixed(1)},${(cy + radius * Math.sin(angle)).toFixed(1)}`;
  // A whole ring is drawn just short of a circle, which an arc can't be; one with nothing then has no slice
  let angle = -Math.PI / 2;
  const paths = slices.map(s => {
    if (!s.values[at]) return svgEl('path', { class: 'band', d: '' });
    const sweep = Math.min(s.values[at] / total * 2 * Math.PI, 2 * Math.PI - 0.0001);
    const from = angle;
    angle += sweep;
    const large = sweep > Math.PI ? 1 : 0;
    return svgEl('path', {
      class: 'band', style: `--band:${s.colour}`,
      d: `M${point(from, outer)}A${outer},${outer} 0 ${large} 1 ${point(angle, outer)}L${point(angle, inner)}A${inner},${inner} 0 ${large} 0 ${point(from, inner)}Z`,
    });
  });
  const highlight = i => paths.forEach((path, k) => path.classList.toggle('faded', i != null && k !== i));
  const svg = svgEl('svg', { class: 'pie', viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': heading },
    paths,
    svgEl('text', { class: 'pie-total', x: cx, y: cy + 2, 'text-anchor': 'middle' }, formatSize(total)),
    svgEl('text', { class: 'pie-label', x: cx, y: cy + 18, 'text-anchor': 'middle' }, 'Total'));

  const tip = el('div', { class: 'chart-tip', hidden: true });
  paths.forEach((path, i) => {
    const s = slices[i];
    path.addEventListener('pointermove', event => {
      highlight(i);
      tip.replaceChildren(...[
        el('div', { class: 'row' }, el('span', { class: 'key', style: `background:${s.colour}` }), el('b', {}, formatSize(s.values[at])), el('span', {}, s.name)),
        el('div', { class: 'path' }, s.title),
        el('div', { class: 'hint' }, `${share(s.values[at])} of the total`),
        s.hint === null ? null : el('div', { class: 'hint' }, s.others ? 'Click to hide the bigger ones and show these separately'
          : s.hint ?? 'Click for its snapshots - double-click to open it'),
      ].filter(Boolean));
      tip.hidden = false;
      const box = svg.getBoundingClientRect();
      const left = event.clientX - box.left;
      tip.style.left = `${left + (left > box.width / 2 ? -tip.offsetWidth - 12 : 12)}px`;
    });
    path.addEventListener('click', event => {
      // The second click of a double click is the double click's
      if (event.detail > 1) return;
      if (s.others) openOthers();
      else s.pick?.();
    });
    path.addEventListener('dblclick', () => { if (!s.others) s.open?.(); });
  });
  svg.addEventListener('pointerleave', () => {
    tip.hidden = true;
    highlight(null);
  });
  chart.replaceChildren(svg, tip);
  return highlight;
}

// Draw a stacked chart into its box at a width, returning how to pick out a band, for the legend
export function drawStackedChart(chart, width, { heading, series, times, tops, max, now, openOthers, overlaid }) {
  // Scales, with a round number of bytes for each gridline
  const height = 240;
  const pad = { left: 64, right: 12, top: 10, bottom: 26 };
  const raw = max / 4;
  const magnitude = 10 ** Math.floor(Math.log10(raw || 1));
  const step = [1, 2, 2.5, 5, 10].map(m => m * magnitude).find(s => s >= raw);
  const top = Math.ceil(max / step) * step || 1;
  // Time runs left to right, but the last snapshot holding until now gets a few pixels at least, as one taken
  // moments ago would otherwise show nothing of what it changed; the rest is squeezed up to make room
  const plot = width - pad.left - pad.right;
  const last = times[times.length - 2];
  const tail = Math.max((now - last) / (now - times[0] || 1) * plot, 6);
  const split = width - pad.right - tail;
  const x = t => (t <= last
    ? pad.left + (t - times[0]) / (last - times[0] || 1) * (split - pad.left)
    : split + (t - last) / (now - last || 1) * tail);
  const timeAt = px => (px <= split
    ? times[0] + (px - pad.left) / (split - pad.left) * (last - times[0])
    : last + (px - split) / tail * (now - last));
  const y = v => height - pad.bottom - v / top * (height - pad.top - pad.bottom);

  // Steps, as a value only changes when a snapshot is taken
  const stepLine = row => row.flatMap((v, j) => (j ? [[x(times[j]), y(row[j - 1])], [x(times[j]), y(v)]] : [[x(times[j]), y(v)]]));
  const bandPath = i => {
    const upper = stepLine(tops[i]);
    const lower = i ? stepLine(tops[i - 1]).reverse() : [[x(now), y(0)], [x(times[0]), y(0)]];
    return `M${[...upper, ...lower].map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join('L')}Z`;
  };

  const spanDays = (now - times[0]) / 86400000;
  const dateLabel = t => new Date(t).toLocaleDateString('en-GB', spanDays > 300 ? { month: 'short', year: 'numeric' } : { day: 'numeric', month: 'short' });
  const xTicks = Array.from({ length: 5 }, (_, i) => times[0] + (now - times[0]) * i / 4);
  const yTicks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);

  // Stacked, a band each on top of the one below; overlaid, an area each from zero, the biggest drawn first so
  // the smaller ones are in front
  const area = values => `M${[...stepLine(values), [x(now), y(0)], [x(times[0]), y(0)]]
    .map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join('L')}Z`;
  const bands = series.map((s, i) => svgEl('path', { class: 'band', d: overlaid ? area(s.values) : bandPath(i), style: `--band:${s.colour}` }));
  const order = overlaid
    ? [...series.keys()].sort((a, b) => Math.max(...series[b].values) - Math.max(...series[a].values))
    : [...series.keys()];
  const bandGroup = svgEl('g', {}, order.map(i => bands[i]));
  // Pick out one, fading the rest; overlaid, it comes to the front so the smaller ones don't hide it
  const highlight = i => {
    bands.forEach((band, k) => band.classList.toggle('faded', i != null && k !== i));
    if (!overlaid) return;
    bandGroup.append(...order.map(k => bands[k]));
    if (i != null) bandGroup.append(bands[i]);
  };
  const crosshair = svgEl('line', { class: 'crosshair', y1: pad.top, y2: height - pad.bottom, visibility: 'hidden' });
  const asOfLine = state.asOf && Date.parse(state.asOf) >= times[0]
    ? svgEl('g', { class: 'as-of-mark' },
      svgEl('line', { x1: x(Date.parse(state.asOf)), x2: x(Date.parse(state.asOf)), y1: pad.top, y2: height - pad.bottom }),
      svgEl('text', { x: x(Date.parse(state.asOf)) + 4, y: pad.top + 10 }, 'Files as of'))
    : null;
  // A tick along the bottom for each snapshot, as that's where the steps come from
  const rug = times.slice(0, -1).map(t => svgEl('line', { class: 'rug', x1: x(t), x2: x(t), y1: height - pad.bottom, y2: height - pad.bottom + 4 }));
  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': heading },
    yTicks.map(v => svgEl('g', { class: 'axis' },
      svgEl('line', { class: 'grid', x1: pad.left, x2: width - pad.right, y1: y(v), y2: y(v) }),
      svgEl('text', { x: pad.left - 8, y: y(v) + 4, 'text-anchor': 'end' }, v ? formatSize(v) : '0'))),
    xTicks.map((t, i) => svgEl('text', { class: 'axis', x: x(t), y: height - 8, 'text-anchor': i === 0 ? 'start' : i === 4 ? 'end' : 'middle' }, i === 4 ? 'Now' : dateLabel(t))),
    bandGroup, rug, asOfLine, crosshair);

  // The line follows the pointer, and shows every band's value as of that moment: each holds until the next
  // snapshot. Over a band, it's picked out and the tooltip is just for that one; a click shows its snapshots and
  // a double click opens it, like Contents, and for Others, a click hides the ones shown to show what's in it.
  // Elsewhere, clicking shows files as of then. Within a couple of minutes of now is now.
  const tip = el('div', { class: 'chart-tip', hidden: true });
  const pointed = event => {
    const box = svg.getBoundingClientRect();
    const px = Math.min(Math.max((event.clientX - box.left) / box.width * width, x(times[0])), x(now));
    const py = (event.clientY - box.top) / box.height * height;
    const t = timeAt(px);
    // The last snapshot by then, and the band under the pointer then, if any
    let j = 0;
    while (j + 1 < times.length - 1 && times[j + 1] <= t) j++;
    const v = (height - pad.bottom - py) / (height - pad.top - pad.bottom) * top;
    // Stacked, the band the pointer's in; overlaid, the front-most area it's in, the one that's seen there
    const band = v < 0 ? -1 : overlaid
      ? [...order].reverse().find(i => v < series[i].values[j]) ?? -1
      : tops.findIndex(row => v < row[j]);
    return { px, t, j, band, isNow: now - t < 120000 };
  };
  const when = (t, isNow) => el('div', { class: 'when' }, isNow ? 'Now' : formatFull(new Date(t).toISOString()));
  const fromSnapshot = time => el('div', { class: 'hint' },
    time ? `From the snapshot of ${formatFull(new Date(time).toISOString())}` : 'No snapshots yet then');
  const row = (i, j) => el('div', { class: 'row' },
    el('span', { class: 'key', style: `background:${series[i].colour}` }), el('b', {}, formatSize(series[i].values[j])), el('span', {}, series[i].name));
  svg.addEventListener('pointermove', event => {
    const { px, t, j, band, isNow } = pointed(event);
    crosshair.setAttribute('x1', px);
    crosshair.setAttribute('x2', px);
    crosshair.setAttribute('visibility', 'visible');
    highlight(band >= 0 ? band : null);
    tip.replaceChildren(...(band >= 0 ? [
      when(t, isNow), row(band, j),
      el('div', { class: 'path' }, series[band].title),
      fromSnapshot(series[band].lastAt(t)),
      series[band].hint === null ? null : el('div', { class: 'hint' }, series[band].others ? 'Click to hide the bigger ones and show these separately'
        : series[band].hint ?? 'Click for its snapshots - double-click to open it'),
    ] : [
      when(t, isNow),
      ...[...series.keys()].reverse().map(i => row(i, j)),
      el('div', { class: 'row total' }, el('span', { class: 'key' }), el('b', {}, formatSize(tops[tops.length - 1][j])), el('span', {}, 'Total')),
      fromSnapshot(times[j]),
      el('div', { class: 'hint' }, 'Click to show files as of then'),
    ]).filter(Boolean));
    tip.hidden = false;
    const box = svg.getBoundingClientRect();
    const left = px / width * box.width;
    tip.style.left = `${left + (left > box.width / 2 ? -tip.offsetWidth - 12 : 12)}px`;
  });
  svg.addEventListener('pointerleave', () => {
    crosshair.setAttribute('visibility', 'hidden');
    tip.hidden = true;
    highlight(null);
  });
  svg.addEventListener('click', event => {
    // The second click of a double click is the double click's
    if (event.detail > 1) return;
    const { t, band, isNow } = pointed(event);
    if (band >= 0) return series[band].others ? openOthers() : series[band].pick?.();
    navigate({ asOf: isNow ? null : new Date(t).toISOString() });
  });
  svg.addEventListener('dblclick', event => {
    const { band } = pointed(event);
    if (band >= 0 && !series[band].others) series[band].open?.();
  });
  chart.replaceChildren(svg, tip);
  return highlight;
}
