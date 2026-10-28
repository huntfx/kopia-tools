// Charts of size over time, stacked or overlaid
import { notLoaded } from './data.js';
import { el, formatFull, formatSize, plural, svgEl } from './format.js';
import { render } from './render.js';
import { joinRel, locationsBelow, treeNodes } from './sidebar.js';
import { openHistory } from './snapshots.js';
import { navigate, state, ui } from './state.js';
import { pathInScope, snapshotListing } from './storage.js';

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
  }).sort((a, b) => b.values[b.values.length - 1] - a.values[a.values.length - 1]);

  return stackedChart({
    key: `folder:${node.path}`, heading: 'Space on disk over time', what: ['location', 'locations'], items, times, now,
    note: 'Each location\'s data on disk, as it grew with each snapshot it still has, with locations inside another counted as part of it. kopia counts each location\'s storage separately, so data shared between them is counted more than once and the total can be a little more than the repository uses.',
  });
}

// How big each folder and file in the folder in scope was at each of a location's snapshots, stacked, from
// the folder's listing at each one. kopia only counts space on disk for whole locations, so this is size.
// The biggest at their peak get their own bands, so something big that's since gone still stands out.
export function renderSizeChart(loc) {
  const complete = loc.snapshots.filter(s => !s.incomplete);
  if (complete.length < 2) return null;
  const listings = complete.map(snap => snapshotListing(snap, state.scope));
  const panel = (...body) => el('section', { class: 'panel' }, el('h2', {}, 'Size over time'), ...body);
  if (listings.includes(undefined)) return panel(el('p', { class: 'note' }, notLoaded('folder listings')));

  // Each thing in it at each snapshot, holding until the next, then the same now
  const now = Date.now();
  const times = [...complete.map(s => Date.parse(s.time)), now];
  const found = new Map();
  listings.forEach((entries, j) => {
    for (const entry of entries || []) {
      const key = `${entry.t}:${entry.n}`;
      if (!found.has(key)) found.set(key, { entry, values: times.map(() => 0) });
      found.get(key).values[j] = entry.s || 0;
    }
  });
  if (!found.size) return null;
  const lastAt = t => Math.max(0, ...times.slice(0, -1).filter(time => time <= t));
  const items = [...found.values()].map(({ entry, values }) => {
    values[values.length - 1] = values[values.length - 2];
    const isFolder = entry.t === 'd';
    const full = pathInScope(loc, entry.n);
    const nested = isFolder ? treeNodes.get(full.toLowerCase())?.location : null;
    return {
      name: entry.n + (isFolder ? '\\' : ''), title: full, values, lastAt, peak: Math.max(...values),
      // Like its row in Contents: its snapshots, then going into it, a location inside, or a file's own page
      pick: () => { ui.pickedRow = full; openHistory(entry.n, isFolder); },
      open: () => navigate(nested ? { location: nested.path, snapshot: null }
        : isFolder ? { scope: joinRel(state.scope, entry.n) } : { file: entry.n }),
    };
  }).sort((a, b) => b.peak - a.peak);

  return stackedChart({
    key: `size:${loc.path}:${state.scope}`, heading: 'Size over time', what: ['item', 'items'], items, times, now,
    note: 'How big each folder and file in here was at each snapshot. kopia only counts space on disk for a whole location, so this is their size rather than what they take up in the repository.',
  });
}

// Clicking a band hides it, and clicking Others hides all the ones shown, to see what's left in more detail.
// These are the ones hidden, by title, for the chart they're hidden from, so they stay hidden while moving
// around the page.
export let chartHidden = { key: null, titles: new Set() };

// Charts stack their bands on top of each other, or overlay them, each from zero, to compare them; remembered
export let chartOverlaid = false;

try { chartOverlaid = localStorage.getItem('chartMode') === 'overlaid'; } catch {}

// A stacked chart of things over time, biggest at the bottom: items are { name, title (unique), values (one per
// time), lastAt(t) (the snapshot a value at t is from), pick(), open() (what single and double clicks on its
// band do, like its row in Contents) }, biggest first. The first seven shown get
// their own colours; any more are added together as Others.
export function stackedChart(options) {
  const { key, heading, what, items, times, now, note } = options;
  const hidden = chartHidden.key === key ? chartHidden.titles : new Set();
  const shown = items.filter(item => !hidden.has(item.title));
  const setHidden = titles => {
    chartHidden = { key, titles };
    panel.replaceWith(stackedChart(options));
  };
  const named = shown.length > 8 ? shown.slice(0, 7) : shown;
  const others = shown.slice(named.length);
  // The last one shown stays, so there's always something to see
  const hideItem = item => { if (shown.length > 1) setHidden(new Set([...hidden, item.title])); };
  const openOthers = () => setHidden(new Set([...hidden, ...named.map(item => item.title)]));
  const series = [
    ...named.map((item, i) => ({ ...item, colour: `var(--series-${i + 1})` })),
    ...(others.length ? [{
      name: `${others.length} others`, title: `${others.length} smaller ${what[1]} added together`, colour: 'var(--series-other)', others: true,
      values: times.map((_, j) => others.reduce((sum, item) => sum + item.values[j], 0)),
      lastAt: t => Math.max(...others.map(item => item.lastAt(t))),
    }] : []),
  ];
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
    highlight = drawStackedChart(chart, drawnWidth, { heading, series, times, tops, max, now, openOthers, overlaid: chartOverlaid });
  };
  new ResizeObserver(drawIfResized).observe(chart);
  // Straight away once it's been put on the page, which happens just after this returns
  queueMicrotask(drawIfResized);

  // The legend names every band, with its size now; hovering one picks out its band, and clicking one hides it.
  // Hidden ones stay in it, greyed out, in their place by size, and clicking one shows it again, which may move
  // the smallest band shown back into Others.
  const showItem = item => setHidden(new Set([...hidden].filter(title => title !== item.title)));
  const entries = [
    ...series.map((s, i) => ({ s, i, at: s.others ? -1 : items.findIndex(item => item.title === s.title) })),
    ...items.filter(item => hidden.has(item.title)).map(item => ({ s: item, hidden: true, at: items.indexOf(item) })),
  ].sort((a, b) => (b.at === -1) - (a.at === -1) || b.at - a.at);
  const legend = el('div', { class: 'chart-legend' }, entries.map(({ s, i, hidden: isHidden }) => el('button', {
    class: isHidden ? 'hidden-item' : null,
    title: isHidden ? `${s.title}\nHidden · click to show it again`
      : s.others ? 'Click to hide the bigger ones and show these separately' : `${s.title}\nClick to hide it`,
    onmouseenter: isHidden ? null : () => highlight(i), onmouseleave: isHidden ? null : () => highlight(null),
    onclick: isHidden ? () => showItem(s) : s.others ? openOthers : () => hideItem(s),
  }, el('span', { class: 'swatch', style: isHidden ? null : `background:${s.colour}` }), el('span', { class: 'name' }, s.name),
    el('span', { class: 'muted' }, formatSize(s.values[times.length - 1])))));

  // Stacked or overlaid, for every chart on the page
  const setOverlaid = overlaid => {
    chartOverlaid = overlaid;
    try { localStorage.setItem('chartMode', overlaid ? 'overlaid' : 'stacked'); } catch {}
    render();
  };
  const modes = el('span', { class: 'chart-modes', role: 'group', 'aria-label': 'How the chart shows them' },
    [['Stacked', false, 'On top of each other, adding up to the total'], ['Overlaid', true, 'Each from zero, to compare them']].map(([label, overlaid, title]) =>
      el('button', { 'aria-pressed': String(chartOverlaid === overlaid), title, onclick: () => setOverlaid(overlaid) }, label)));

  const panel = el('section', { class: 'panel' },
    el('div', { class: 'chart-head' }, el('h2', {}, heading),
      hidden.size ? el('span', { class: 'legend', title: items.filter(item => hidden.has(item.title)).map(item => item.title).join('\n') },
        `${plural(hidden.size, what[0])} hidden · `,
        el('button', { class: 'linklike', onclick: () => setHidden(new Set()) }, 'Show all')) : null,
      el('span', { class: 'legend', style: 'margin-left:auto' }, `${formatSize(tops[tops.length - 1][times.length - 1])} now`),
      modes),
    chart,
    legend,
    el('p', { class: 'note', style: 'margin:8px 0 0' }, note));
  return panel;
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
  const x = t => pad.left + (t - times[0]) / (now - times[0] || 1) * (width - pad.left - pad.right);
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
    const t = times[0] + (px - pad.left) / (width - pad.left - pad.right) * (now - times[0]);
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
      el('div', { class: 'hint' }, series[band].others ? 'Click to hide the bigger ones and show these separately' : 'Click for its snapshots · double-click to open it'),
    ] : [
      when(t, isNow),
      ...[...series.keys()].reverse().map(i => row(i, j)),
      el('div', { class: 'row total' }, el('span', { class: 'key' }), el('b', {}, formatSize(tops[tops.length - 1][j])), el('span', {}, 'Total')),
      fromSnapshot(times[j]),
      el('div', { class: 'hint' }, 'Click to show files as of then'),
    ]));
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
    if (band >= 0) return series[band].others ? openOthers() : series[band].pick();
    navigate({ asOf: isNow ? null : new Date(t).toISOString() });
  });
  svg.addEventListener('dblclick', event => {
    const { band } = pointed(event);
    if (band >= 0 && !series[band].others) series[band].open();
  });
  chart.replaceChildren(svg, tip);
  return highlight;
}
