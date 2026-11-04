// Kopia's retention policy: how many of a location's snapshots of each kind it keeps, shown under its schedule and
// changed from there, as KopiaUI's policy editor does, with which of its snapshots that would delete.
import { api, redrawSoon } from './data.js';
import { el, formatFull, plural } from './format.js';
import { loadSchedule, scheduleOf, schedules } from './schedules.js';

// Each kind as KopiaUI names and explains it, in the order it lists them
export const RETENTION = [
  ['latest', 'Latest snapshots', 'The most recent snapshots to keep'],
  ['hourly', 'Hourly', 'The latest snapshot from each hour is kept'],
  ['daily', 'Daily', 'The latest snapshot from each day is kept'],
  ['weekly', 'Weekly', 'The latest snapshot from each week is kept'],
  ['monthly', 'Monthly', 'The latest snapshot from each calendar month is kept'],
  ['annual', 'Annual', 'The latest snapshot from each calendar year is kept'],
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

// The order kopia goes through them in
const ORDER = ['latest', 'annual', 'monthly', 'weekly', 'daily', 'hourly'];

// Why each of a location's finished snapshots would be kept, like ['latest-1', 'daily-1'], by its ID, none
// meaning it would be deleted; counted back from the newest
export function retentionReasons(snapshots, keep) {
  const complete = snapshots.filter(s => !s.incomplete).sort((a, b) => b.time.localeCompare(a.time));
  const reasons = new Map();
  if (!complete.length) return reasons;
  const newest = Date.parse(complete[0].time);
  const cutoff = {
    annual: addDate(newest, -keep.annual, 0, 0), monthly: addDate(newest, 0, -keep.monthly, 0),
    weekly: addDate(newest, 0, 0, -7 * keep.weekly), daily: addDate(newest, 0, 0, -keep.daily), hourly: newest - keep.hourly * HOUR,
  };
  const claimed = new Set();
  const count = Object.fromEntries(ORDER.map(kind => [kind, 0]));
  complete.forEach((snap, i) => {
    const time = Date.parse(snap.time);
    const keys = periodKeys(time);
    const why = [];
    for (const kind of ORDER) {
      const id = kind === 'latest' ? String(i) : keys[kind];
      if (kind !== 'latest' && time < cutoff[kind]) continue;
      if (claimed.has(id) || count[kind] >= keep[kind]) continue;
      claimed.add(id);
      why.push(`${kind}-${++count[kind]}`);
    }
    reasons.set(snap.id, why);
  });
  return reasons;
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
  const keep = scheduleOf(path)?.keep;
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
  // What it would delete, kept up to date as it's changed
  const update = () => {
    save.disabled = !valid();
    if (!valid()) {
      consequence.className = 'error';
      consequence.textContent = 'Each must be a whole number, or empty to inherit it.';
      return;
    }
    const going = wouldDelete(loc, effective());
    const total = loc.snapshots.filter(s => !s.incomplete).length;
    consequence.className = going.length ? 'warn' : '';
    consequence.textContent = going.length
      ? `After its next snapshot, kopia would delete ${going.length} of the ${plural(total, 'snapshot')} it has now, the oldest from ${formatFull(going[0].time)}. Pinned ones are always kept.`
      : `All ${plural(total, 'snapshot')} it has now would be kept.`;
  };
  for (const f of fields) f.input.addEventListener('input', update);
  const dialog = el('dialog', { class: 'confirm retention', 'aria-labelledby': 'retention-title' },
    el('h2', { id: 'retention-title' }, 'How many snapshots to keep?'),
    el('p', { class: 'what' }, el('b', {}, path)),
    el('div', { class: 'retention-fields' }, fields.map(f => f.element)),
    el('p', {}, 'Left empty, each is inherited. Snapshots kept by any of them stay; kopia deletes the rest after the next snapshot.'),
    consequence,
    el('p', {}, 'KopiaUI picks up the change when it next refreshes, within 4 hours.'),
    error,
    el('div', { class: 'actions' }, cancel, save));
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  update();
  dialog.showModal();
  fields[0].input.focus();
}
