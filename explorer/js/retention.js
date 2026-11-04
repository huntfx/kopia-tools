// Kopia's retention policy: how many of a location's snapshots of each kind it keeps, shown under its schedule and
// changed from there, as KopiaUI's policy editor does, with a preview of what that keeps: in the long run, on the
// location's schedule, as retention-preview.html does, or of the snapshots it has now, with which would be deleted.
import { api, redrawSoon } from './data.js';
import { el, formatFull, listOf, plural, svgEl, timeAgo } from './format.js';
import { GO_EPOCH, loadSchedule, scheduleOf, scheduleText, schedules } from './schedules.js';

// Each kind as KopiaUI names and explains it, in the order it lists them, with its name in the preview
export const RETENTION = [
  ['latest', 'Latest snapshots', 'The most recent snapshots to keep', 'Latest'],
  ['hourly', 'Hourly', 'The latest snapshot from each hour is kept', 'Hourly'],
  ['daily', 'Daily', 'The latest snapshot from each day is kept', 'Daily'],
  ['weekly', 'Weekly', 'The latest snapshot from each week is kept', 'Weekly'],
  ['monthly', 'Monthly', 'The latest snapshot from each calendar month is kept', 'Monthly'],
  ['annual', 'Annual', 'The latest snapshot from each calendar year is kept', 'Annual'],
];

// How many of each kind are kept: its own setting, or what it inherits, with none set anywhere being none
const counts = keep => Object.fromEntries(RETENTION.map(([kind]) => [kind, keep[kind].own ?? keep[kind].inherited ?? 0]));

// ---- A port of kopia's snapshot/policy/retention_policy.go, as in retention-preview.html ----
// Like kopia, hour, day, month and year are taken in UTC, but the ISO week in local time. The periods share one
// set of keys, as in kopia, so a weekly "2027-01" (week 1) and a monthly "2027-01" (January) count as the same.
const HOUR = 3600e3;
const pad = (n, width = 2) => String(n).padStart(width, '0');

function isoWeek(d) {
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  t.setDate(t.getDate() + 3 - ((t.getDay() + 6) % 7));  // Thursday of its ISO week
  const jan4 = new Date(t.getFullYear(), 0, 4);
  return [t.getFullYear(), 1 + Math.round(((t - jan4) / 864e5 - 3 + ((jan4.getDay() + 6) % 7)) / 7)];
}

function periodKeys(ms) {
  const d = new Date(ms);
  const Y = d.getUTCFullYear(), M = pad(d.getUTCMonth() + 1), D = pad(d.getUTCDate()), H = pad(d.getUTCHours());
  const [weekYear, week] = isoWeek(d);
  return { annual: `${Y}`, monthly: `${Y}-${M}`, weekly: `${pad(weekYear, 4)}-${pad(week)}`, daily: `${Y}-${M}-${D}`, hourly: `${Y}-${M}-${D} ${H}` };
}

// Go's time.AddDate, in local time
function addDate(ms, years, months, days) {
  const d = new Date(ms);
  d.setFullYear(d.getFullYear() + years, d.getMonth() + months, d.getDate() + days);
  return d.getTime();
}

// How far back from the newest snapshot each kind looks: one older than that isn't kept as that kind
const cutoffs = (newest, keep) => ({
  annual: addDate(newest, -keep.annual, 0, 0), monthly: addDate(newest, 0, -keep.monthly, 0),
  weekly: addDate(newest, 0, 0, -7 * keep.weekly), daily: addDate(newest, 0, 0, -keep.daily), hourly: newest - keep.hourly * HOUR,
});

// The order kopia goes through them in
const ORDER = ['latest', 'annual', 'monthly', 'weekly', 'daily', 'hourly'];

// Why each of a set of snapshot times, newest first, would be kept, like [['latest', 1], ['daily', 1]], none
// meaning it would be deleted, and the periods a kind lost to another that already had its key
function rank(times, keep) {
  if (!times.length) return { reasons: [], collisions: [] };
  const cut = cutoffs(times[0], keep);
  const claimed = new Map();
  const count = Object.fromEntries(ORDER.map(kind => [kind, 0]));
  const collisions = [];
  const reasons = times.map((time, i) => {
    const keys = periodKeys(time);
    const why = [];
    for (const kind of ORDER) {
      const id = kind === 'latest' ? String(i) : keys[kind];
      if (kind !== 'latest' && time < cut[kind]) continue;
      if (claimed.has(id)) {
        if (claimed.get(id) !== kind && count[kind] < keep[kind]) collisions.push({ kind, id, owner: claimed.get(id) });
        continue;
      }
      if (count[kind] >= keep[kind]) continue;
      claimed.set(id, kind);
      why.push([kind, ++count[kind]]);
    }
    return why;
  });
  return { reasons, collisions };
}

// Why each of a location's finished snapshots would be kept, like ['latest-1', 'daily-1'], by its ID, none
// meaning it would be deleted; counted back from the newest
export function retentionReasons(snapshots, keep) {
  const complete = snapshots.filter(s => !s.incomplete).sort((a, b) => b.time.localeCompare(a.time));
  const { reasons } = rank(complete.map(s => Date.parse(s.time)), keep);
  return new Map(complete.map((s, i) => [s.id, reasons[i].map(([kind, n]) => `${kind}-${n}`)]));
}

// ---- In the long run ----

// Whether a schedule backs up at times that can be worked out: on an interval, or at times of day
const simulable = schedule => !!schedule && !schedule.manual && (!!schedule.interval || schedule.times.length > 0);

// The last time at or before a time that a schedule backs up at, as kopia's scheduler works it out: on its
// interval, counted from 1 Jan 0001, or at one of its times of day, whichever's later
function scheduledBefore(schedule, t) {
  let at = -Infinity;
  if (schedule.interval) {
    const every = schedule.interval;
    at = (Math.floor((t / 1000 + GO_EPOCH) / every) * every - GO_EPOCH) * 1000;
  }
  for (const time of schedule.times) {
    const [hour, minute] = time.split(':').map(Number);
    const day = new Date(t);
    day.setHours(hour, minute, 0, 0);
    if (day.getTime() > t) day.setDate(day.getDate() - 1);
    at = Math.max(at, day.getTime());
  }
  return at;
}

// The snapshots kopia would have now, after backing up on a schedule for as long as it takes, newest first: only
// the ones that can be kept, which are the latest few, then the newest in each quarter of an hour (UTC), as every
// period starts on one, in any time zone, back as far as any kind looks
const QUARTER = 15 * 60e3;

function longRunTimes(schedule, keep, now) {
  const newest = scheduledBefore(schedule, now);
  const oldest = Math.min(...Object.values(cutoffs(newest, keep)));
  const times = [];
  for (let t = newest; times.length < 500000 && (times.length < keep.latest || t >= oldest);) {
    times.push(t);
    t = scheduledBefore(schedule, times.length < keep.latest ? t - 1 : Math.floor(t / QUARTER) * QUARTER - 1);
  }
  return times;
}

// ---- Under the schedule ----

// In words, like "10 latest, 48 hourly, 7 daily", leaving out kinds none are kept of
function retentionText(keep) {
  const kept = RETENTION.map(([kind]) => [kind, counts(keep)[kind]]).filter(([, n]) => n);
  return kept.length ? `Keeps ${kept.map(([kind, n]) => `${n} ${kind}`).join(', ')}` : 'Keeps every snapshot';
}

// Where each setting comes from, for its tooltip
function retentionSources(keep) {
  return RETENTION.map(([kind, name]) => `${name}: ${keep[kind].own != null ? 'set for this folder' : keep[kind].from ? `set by ${keep[kind].from}` : 'not set'}`).join('\n');
}

// Under the actions of the location being looked at: how many of its snapshots are kept, with changing that
export function retentionLine(loc) {
  const keep = scheduleOf(loc.path)?.keep;
  return el('div', { class: 'schedule' },
    keep ? el('span', { title: retentionSources(keep) }, retentionText(keep)) : el('span', { class: 'muted' }, '…'),
    el('button', { class: 'linklike', disabled: !keep, onclick: () => retentionDialog(loc) }, 'Change…'));
}

// ---- The preview ----

// Kopia's name clash, in words: weeks the weekly kind lost to January to December, as kopia gives week 1 the same
// key as January (kopia issues #2964 and #5096), and anything else lost the same way
function clashText(collisions) {
  const weeks = new Map();
  const other = [];
  for (const c of collisions) {
    if (c.kind !== 'weekly') {
      other.push(`the ${c.kind} rule skipped ${c.id}, which the ${c.owner} rule had already kept`);
      continue;
    }
    const [year, week] = c.id.split('-');
    if (!weeks.has(year)) weeks.set(year, new Set());
    weeks.get(year).add(Number(week));
  }
  const lost = [...weeks].map(([year, found]) => {
    const list = [...found].sort((a, b) => a - b);
    return `${list.length > 1 ? 'weeks' : 'week'} ${listOf(list.map(String))} of ${year}`;
  });
  const parts = [lost.length ? `the weekly rule keeps nothing for ${listOf(lost)}, as kopia names week 1 of a year the same as January, and so on, and the monthly rule has already kept those (kopia issues #2964 and #5096)` : null, ...other].filter(Boolean);
  return parts.length ? `A kopia bug is in effect: ${listOf(parts)}.` : null;
}

// What a kept snapshot's reasons are, as keep tags, as on a snapshot's page
const keepTags = (reasons, pinned, deleted) => el('div', { class: 'snap-tags' },
  deleted ? el('span', { class: 'badge error' }, 'Deleted') : null,
  pinned ? el('span', { class: 'keep-tag pinned' }, 'pinned') : null,
  reasons.map(([kind, n]) => el('span', { class: `keep-tag ${kind}` }, `${kind}-${n}`)));

// A timeline of snapshots by age, on a log scale so recent hours and old years both fit: a lane for all those kept,
// one for each kind that keeps any, and one for those deleted, if any are. Hovering one says why it's kept. Ages
// are from the newest, as kopia counts back from it.
const AGE_TICKS = [[HOUR, '1h'], [6 * HOUR, '6h'], [24 * HOUR, '1d'], [7 * 864e5, '1w'], [30.44 * 864e5, '1mo'],
  [182.6 * 864e5, '6mo'], [365.25 * 864e5, '1y'], [2 * 365.25 * 864e5, '2y'], [3 * 365.25 * 864e5, '3y'],
  [5 * 365.25 * 864e5, '5y'], [10 * 365.25 * 864e5, '10y']];

function drawTimeline(box, points) {
  box.replaceChildren();
  if (!points.length) return;
  const now = Math.max(...points.map(p => p.time));
  const width = 560, left = 96, right = 12, top = 6, laneHeight = 24, axisHeight = 22;
  const lanes = [{ kind: 'all', name: 'All kept', has: p => !p.deleted }];
  for (const [kind, , , name] of RETENTION) {
    const has = p => p.reasons.some(([k]) => k === kind);
    if (points.some(has)) lanes.push({ kind, name, has });
  }
  if (points.some(p => p.deleted)) lanes.push({ kind: 'deleted', name: 'Deleted', has: p => p.deleted });
  const height = top + lanes.length * laneHeight + axisHeight;
  const offset = 30 * 60e3;  // So the newest, just made, isn't at minus infinity
  const maxAge = Math.max(...points.map(p => now - p.time), 864e5);
  // A little in from the lane names, so the newest's dots aren't taken as part of them
  const inset = 10;
  const x = age => left + inset + (Math.log(Math.max(age, 0) + offset) - Math.log(offset)) / (Math.log(maxAge + offset) - Math.log(offset)) * (width - left - inset - right);
  const laneY = i => top + i * laneHeight + laneHeight / 2;
  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': 'Snapshots kept, by age and by what keeps them' });
  for (const [age, label] of AGE_TICKS.filter(([age]) => age <= maxAge + offset)) {
    svg.append(svgEl('line', { class: 'grid', x1: x(age), x2: x(age), y1: top, y2: height - axisHeight }),
      svgEl('text', { x: x(age), y: height - axisHeight + 15, 'text-anchor': 'middle' }, label));
  }
  svg.append(svgEl('line', { class: 'axis', x1: left, x2: width - right, y1: height - axisHeight, y2: height - axisHeight }));
  lanes.forEach((lane, i) => {
    const count = points.filter(lane.has).length;
    svg.append(svgEl('text', { class: 'lane', x: left - 8, y: laneY(i) + 4, 'text-anchor': 'end' }, `${lane.name} ${count}`),
      svgEl('line', { class: 'lane-line', x1: left, x2: width - right, y1: laneY(i), y2: laneY(i) }));
  });
  const crosshair = svgEl('line', { class: 'crosshair', y1: top, y2: height - axisHeight, visibility: 'hidden' });
  svg.append(crosshair);
  for (const p of points) {
    lanes.forEach((lane, i) => {
      if (lane.has(p)) svg.append(svgEl('circle', { class: `dot ${lane.kind}`, cx: x(now - p.time), cy: laneY(i), r: 3.5 }));
    });
  }
  const tip = el('div', { class: 'chart-tip', hidden: true });
  const xs = points.map(p => x(now - p.time));
  const hide = () => {
    crosshair.setAttribute('visibility', 'hidden');
    tip.hidden = true;
  };
  const show = event => {
    const bounds = svg.getBoundingClientRect();
    const at = (event.clientX - bounds.left) * (width / bounds.width);
    let best = 0;
    xs.forEach((px, i) => { if (Math.abs(px - at) < Math.abs(xs[best] - at)) best = i; });
    if (Math.abs(xs[best] - at) > 24) return hide();
    const p = points[best];
    crosshair.setAttribute('x1', xs[best]);
    crosshair.setAttribute('x2', xs[best]);
    crosshair.setAttribute('visibility', 'visible');
    tip.replaceChildren(el('div', { class: 'when' }, formatFull(p.time), ` (${timeAgo(new Date(p.time).toISOString())})`),
      keepTags(p.reasons, p.pinned, p.deleted));
    tip.hidden = false;
    const px = xs[best] * bounds.width / width;
    tip.style.left = `${px + 12 + tip.offsetWidth > bounds.width ? Math.max(0, px - tip.offsetWidth - 12) : px + 12}px`;
  };
  const hit = svgEl('rect', { x: left, y: 0, width: width - left - right, height: height - axisHeight, fill: 'transparent' });
  hit.addEventListener('pointermove', show);
  hit.addEventListener('pointerdown', show);
  hit.addEventListener('pointerleave', hide);
  svg.append(hit);
  box.append(svg, tip);
}

// In the long run on its schedule, if that can be worked out, or the snapshots it has now. Drawn again as the
// numbers change.
function retentionPreview(loc, schedule) {
  let mode = simulable(schedule) ? 'long' : 'now';
  let shown = null;
  const summary = el('p', {});
  const chart = el('div', { class: 'retention-chart' });
  const clash = el('p', { class: 'warn', hidden: true });
  const buttons = [['In the long run', 'long', simulable(schedule)
    ? `What kopia would be keeping once it's been backing up ${scheduleText(schedule).toLowerCase()} for long enough`
    : 'Its schedule is manual or custom, so can\'t be worked out'],
  ['Its snapshots now', 'now', 'Which of the snapshots it has now would be kept, and which deleted']].map(([label, value, title]) =>
    el('button', { 'aria-pressed': String(mode === value), title, disabled: value === 'long' && !simulable(schedule),
      onclick: () => { mode = value; buttons.forEach(b => b.setAttribute('aria-pressed', String(b === buttons[value === 'long' ? 0 : 1]))); draw(shown); } }, label));
  const draw = keep => {
    shown = keep;
    if (!keep) {
      summary.textContent = '';
      chart.replaceChildren();
      clash.hidden = true;
      return;
    }
    const now = Date.now();
    let points, collisions;
    if (mode === 'long') {
      const times = longRunTimes(schedule, keep, now);
      const ranked = rank(times, keep);
      collisions = ranked.collisions;
      points = times.map((time, i) => ({ time, reasons: ranked.reasons[i] })).filter(p => p.reasons.length);
      const oldest = points.at(-1);
      summary.textContent = points.length
        ? `Backing up ${scheduleText(schedule).toLowerCase()}, kopia keeps ${plural(points.length, 'snapshot')} once it's been going long enough, the oldest from ${timeAgo(new Date(oldest.time).toISOString())}.`
        : 'Kopia would keep none of its snapshots.';
    } else {
      const complete = loc.snapshots.filter(s => !s.incomplete).sort((a, b) => b.time.localeCompare(a.time));
      const ranked = rank(complete.map(s => Date.parse(s.time)), keep);
      collisions = ranked.collisions;
      points = complete.map((s, i) => {
        const pinned = !!s.pins?.length;
        return { time: Date.parse(s.time), reasons: ranked.reasons[i], pinned, deleted: !pinned && !ranked.reasons[i].length };
      });
      const going = points.filter(p => p.deleted).length;
      summary.textContent = complete.length
        ? `Of the ${plural(complete.length, 'snapshot')} it has now, ${points.length - going} would be kept and ${going} deleted.`
        : 'It has no snapshots yet.';
    }
    drawTimeline(chart, points);
    const text = clashText(collisions);
    clash.textContent = text || '';
    clash.hidden = !text;
  };
  return {
    element: el('section', { class: 'retention-preview' },
      el('div', { class: 'chart-head' }, el('h3', {}, 'Preview'), el('span', { class: 'chart-modes', role: 'group', 'aria-label': 'What to preview' }, buttons)),
      summary, chart,
      el('p', { class: 'note' }, 'How much older each is than the newest, on a log scale. Hover over one to see what keeps it.'),
      clash),
    draw,
  };
}

// ---- Changing it ----

// What saving would delete, as far as can be told from the snapshots there are now: ones no rule keeps, unless
// they're pinned, which kopia never deletes. Kopia tidies up after the next snapshot, so the oldest that's now
// only kept as one of the latest may go then too.
function wouldDelete(loc, keep) {
  const reasons = retentionReasons(loc.snapshots, keep);
  return loc.snapshots.filter(s => !s.incomplete && !s.pins?.length && reasons.get(s.id)?.length === 0);
}

export function retentionDialog(loc) {
  if (document.querySelector('dialog.retention')) return;
  const path = loc.path;
  const schedule = scheduleOf(path);
  const keep = schedule?.keep;
  if (!keep) return;
  const fields = RETENTION.map(([kind, name, about]) => {
    const { own, inherited, from } = keep[kind];
    // Left empty, it's inherited, which the placeholder says, as KopiaUI shows it
    const input = el('input', {
      type: 'number', min: 0, step: 1, value: own ?? '', 'aria-label': name,
      placeholder: inherited != null ? `${inherited} inherited` : 'None', title: from ? `Left empty, it's inherited from ${from}` : 'Left empty, none are kept',
    });
    return { kind, input, element: el('label', { class: 'retention-field' }, el('span', {}, el('b', {}, name), el('small', {}, about)), input) };
  });
  const values = () => Object.fromEntries(fields.map(f => [f.kind, f.input.value === '' ? null : Number(f.input.value)]));
  const valid = () => fields.every(f => f.input.value === '' || (Number.isInteger(Number(f.input.value)) && Number(f.input.value) >= 0));
  const effective = () => Object.fromEntries(Object.entries(values()).map(([kind, n]) => [kind, n ?? keep[kind].inherited ?? 0]));
  const preview = retentionPreview(loc, schedule);
  const consequence = el('p', {});
  const error = el('p', { class: 'error', hidden: true });
  const cancel = el('button', { class: 'btn', onclick: () => dialog.close() }, 'Cancel');
  const save = el('button', {
    class: 'btn primary',
    onclick: async () => {
      save.disabled = cancel.disabled = true;
      try {
        await api.post('/api/retention', { path, keep: values() });
      } catch (e) {
        error.textContent = `Couldn't change it: ${e instanceof TypeError ? 'can\'t reach the server' : e.message}`;
        error.hidden = false;
        save.disabled = cancel.disabled = false;
        return;
      }
      schedules.clear();
      dialog.close();
      await loadSchedule(path);
      redrawSoon();
    },
  }, 'Save');
  // What it would delete, and the preview, kept up to date as it's changed, the preview once typing pauses
  let previewSoon;
  const update = () => {
    save.disabled = !valid();
    clearTimeout(previewSoon);
    if (!valid()) {
      consequence.className = 'error';
      consequence.textContent = 'Each must be a whole number, or empty to inherit it.';
      preview.draw(null);
      return;
    }
    const going = wouldDelete(loc, effective());
    const total = loc.snapshots.filter(s => !s.incomplete).length;
    consequence.className = going.length ? 'warn' : '';
    consequence.textContent = going.length
      ? `After its next snapshot, kopia would delete ${going.length} of the ${plural(total, 'snapshot')} it has now, the oldest from ${formatFull(going[0].time)}. Pinned ones are always kept.`
      : `All ${plural(total, 'snapshot')} it has now would be kept.`;
    previewSoon = setTimeout(() => preview.draw(effective()), 120);
  };
  for (const f of fields) f.input.addEventListener('input', update);
  const dialog = el('dialog', { class: 'confirm retention', 'aria-labelledby': 'retention-title' },
    el('h2', { id: 'retention-title' }, 'How many snapshots to keep?'),
    el('p', { class: 'what' }, el('b', {}, path)),
    el('div', { class: 'retention-body' },
      el('div', {},
        el('div', { class: 'retention-fields' }, fields.map(f => f.element)),
        el('p', {}, 'Left empty, each is inherited. Snapshots kept by any of them stay; kopia deletes the rest after the next snapshot.'),
        consequence),
      preview.element),
    el('p', {}, 'KopiaUI picks up the change when it next refreshes, within 4 hours.'),
    error,
    el('div', { class: 'actions' }, cancel, save));
  dialog.addEventListener('close', () => {
    clearTimeout(previewSoon);
    dialog.remove();
  });
  document.body.append(dialog);
  update();
  dialog.showModal();
  fields[0].input.focus();
}
