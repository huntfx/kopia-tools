// How often folders are backed up, from kopia's policies, and changing that
import { api, redrawSoon } from './data.js';
import { el, listOf, plural } from './format.js';
import { backUp, changeSettings, offerSettings } from './jobs.js';
import { navigate } from './state.js';
import { enclosingLocation, refreshStorage, storage } from './storage.js';

// How often a folder is backed up on its own, from kopia's policies via the server, loaded once each, and
// again after one's changed: { interval, times, cron, manual, from, own, inherited }
export const schedules = new Map();

export function scheduleOf(path) {
  if (!schedules.has(path.toLowerCase())) loadSchedule(path).then(redrawSoon);
  return schedules.get(path.toLowerCase());
}

// The same, waiting for it if it isn't loaded yet; null if it can't be
export function loadSchedule(path) {
  const key = path.toLowerCase();
  if (schedules.has(key) && schedules.get(key) !== undefined) return Promise.resolve(schedules.get(key));
  schedules.set(key, undefined);
  return fetch(`/api/schedule?path=${encodeURIComponent(path)}`)
    .then(response => (response.ok ? response.json() : null)).catch(() => null)
    .then(schedule => { schedules.set(key, schedule); return schedule; });
}

// The intervals that can be picked, as in KopiaUI
export const INTERVALS = [600, 900, 1200, 1800, 3600, 10800, 21600, 43200];

// An interval in words, like "every 3 hours" or "every day"
export function every(seconds) {
  for (const [unit, size] of [['day', 86400], ['hour', 3600], ['minute', 60]]) {
    if (seconds % size === 0) return seconds === size ? `every ${unit}` : `every ${seconds / size} ${unit}s`;
  }
  return `every ${plural(seconds, 'second')}`;
}

export const capitalised = text => text[0].toUpperCase() + text.slice(1);

// A schedule in words, like "Every 12 hours" or "Every day and at 09:00", and where it's set, for its tooltip
export function scheduleText(schedule) {
  // As KopiaUI calls it
  if (schedule.manual) return 'Manual snapshots only';
  const parts = [schedule.interval ? every(schedule.interval) : null, schedule.times.length ? `at ${schedule.times.join(', ')}` : null,
    schedule.cron?.length ? 'on a custom schedule' : null].filter(Boolean);
  return capitalised(parts.join(' and ') || 'not on a schedule');
}

export const scheduleSource = (schedule, here) => (schedule.from ? `Set by ${schedule.from}` : here ? 'Set for this folder' : `Set for ${schedule.path}`);

// Under a location's heading in the snapshots panel: how often its snapshots are made, and changing that when
// it's the location being looked at. It can be changed once its schedule's loaded, so the dialog opens straight away.
export function scheduleLine(loc, changeable) {
  const schedule = scheduleOf(loc.path);
  return el('div', { class: 'schedule' },
    schedule ? el('span', { title: scheduleSource(schedule, changeable) }, scheduleText(schedule)) : el('span', { class: 'muted' }, '…'),
    changeable ? el('button', { class: 'linklike', disabled: !schedule, onclick: () => scheduleDialog(loc.path, 'change') }, 'Change…') : null);
}

// The parent settings fix: copying the settings a location inside another would inherit into its policy, as
// kopia doesn't use them in there while backing up the other location. Applying it or removing it is followed
// in the panel at the bottom, which shows it again once done.
function changeCopiedSettings(loc, undo, button) {
  button.disabled = true;
  changeSettings(undo, [loc.path]);
}

// Above a location's contents when it's inside another location and needs the parent settings fix
export function settingsWarning(loc) {
  const nested = scheduleOf(loc.path)?.nested;
  if (!nested?.missing.length || nested.copied.length) return null;
  const apply = el('button', { class: 'btn', onclick: () => changeCopiedSettings(loc, false, apply) }, 'Apply parent settings fix');
  return el('section', { class: 'panel warning' },
    el('div', { class: 'chart-head' }, el('h2', {}, 'Parent settings not used')),
    el('p', {}, `Backups of ${nested.container} don't use your ${listOf(nested.missing, 'or')} in here, as kopia doesn't pass them on to a location inside another. The parent settings fix copies them into this location's policy, and keeps them up to date.`),
    el('div', { class: 'actions' }, apply));
}

// At the top of a location's page, once the parent settings fix is applied, with removing it, and applying it
// again if the settings it copied have been changed by hand since, which keeps those changes
export function settingsStatus(loc) {
  const nested = scheduleOf(loc.path)?.nested;
  if (!nested?.copied.length) return null;
  const change = (label, undo) => {
    const button = el('button', { class: 'linklike', onclick: () => changeCopiedSettings(loc, undo, button) }, label);
    return button;
  };
  const changed = nested.edited || nested.missing.length;
  const title = capitalised(listOf(nested.copied)) + (nested.edited ? ' - changed since, so not kept up to date' : '');
  return el('span', { title },
    changed ? 'parent settings fix changed since (' : 'parent settings fix applied (',
    changed ? [change('reapply', false), ', '] : null, change('undo', true), ')');
}

// When the page opens: offer to copy settings into every location inside another that needs them, in the
// panel at the bottom, which finding them doesn't hold up
export async function offerToCopySettings() {
  const needing = await fetch('/api/copied-settings').then(response => (response.ok ? response.json() : [])).catch(() => []);
  offerSettings(needing);
}

// Under the snapshots panel's heading: backing up the folder being looked at on its own, unless it's a location
// already. It can be clicked once its schedule's loaded, so the dialog opens straight away.
export function separateLine(target, isFolder) {
  if (!isFolder || storage.some(l => l.path.toLowerCase() === target.toLowerCase())) return null;
  return el('div', { class: 'separate' },
    el('button', { class: 'linklike', disabled: !scheduleOf(target), onclick: () => scheduleDialog(target, 'separate') }, 'Back up on its own…'));
}

// Set how often a folder is backed up: a location's schedule (change), a folder inside one backed up on its
// own (separate), or any other folder on the PC backed up (new). A folder with a schedule of its own is a
// location, though it has nothing in it until it's backed up, so the last two do that straight away unless
// unticked, then show it.
export let scheduleDialogOpen = false;

export async function scheduleDialog(path, mode) {
  // One at a time, so clicking again while its schedule loads doesn't open a second
  if (scheduleDialogOpen) return;
  scheduleDialogOpen = true;
  const current = await loadSchedule(path);
  if (!current) {
    scheduleDialogOpen = false;
    return;
  }
  const separate = mode !== 'change';
  const inherited = current.inherited;
  // Its own interval stays a choice if it was set to something else elsewhere, so it isn't changed by accident
  const ownInterval = current.own && !current.ownManual;
  const intervals = ownInterval && !INTERVALS.includes(current.interval)
    ? [...INTERVALS, current.interval].sort((a, b) => a - b) : INTERVALS;
  // Or no schedule, as kopia's manual snapshots only: backed up only when asked, so when it's backed up now as
  // well, a single snapshot
  const select = el('select', { 'aria-label': 'How often' },
    inherited.interval ? el('option', { value: '' }, `Inherit from ${inherited.from} (${every(inherited.interval)})`) : null,
    el('option', { value: 'manual' }, separate ? 'Just this once' : 'Manual snapshots only'),
    intervals.map(seconds => el('option', { value: seconds }, capitalised(every(seconds)))));
  // Inheriting, unless it has its own, which is kept
  select.value = current.ownManual ? 'manual' : ownInterval ? String(current.interval) : '';
  const now = el('input', { type: 'checkbox', checked: true });
  // Just this once is backing it up now
  const once = () => {
    if (select.value === 'manual') now.checked = true;
    now.disabled = select.value === 'manual';
  };
  select.addEventListener('change', once);
  once();
  // A new policy inside another location doesn't pass on the settings above it to that location's backups,
  // unless they're copied in by the parent settings fix, as the page offers for existing ones
  const outer = separate && !current.own ? enclosingLocation({ path })?.loc : null;
  const copySettings = el('input', { type: 'checkbox', checked: true });
  const error = el('p', { class: 'error', hidden: true });
  const cancel = el('button', { class: 'btn', onclick: () => dialog.close() }, 'Cancel');
  const save = el('button', {
    class: 'btn primary',
    onclick: async () => {
      save.disabled = cancel.disabled = true;
      let saved;
      try {
        const manual = select.value === 'manual';
        saved = await api.post('/api/schedule', {
          path, interval: select.value && !manual ? Number(select.value) : null, manual, copySettings: !!outer && copySettings.checked,
        });
      } catch (e) {
        error.textContent = `Couldn't ${separate ? 'back it up' : 'change it'}: ${e instanceof TypeError ? 'can\'t reach the server' : e.message}`;
        error.hidden = false;
        save.disabled = cancel.disabled = false;
        return;
      }
      schedules.clear();
      dialog.close();
      if (!separate) return redrawSoon();
      // Now a location, as the server tidied its path
      if (now.checked) backUp(saved.path);
      await refreshStorage();
      if (mode === 'new') navigate({ location: saved.path, snapshot: null });
    },
  }, { change: 'Save', separate: 'Back up on its own', new: 'Back up' }[mode]);
  // Its own name with a backslash, like Code\, or a drive's, like D:\
  const name = `${(path.replace(/\\$/, '').split('\\').pop())}\\`;
  const dialog = el('dialog', { class: 'confirm', 'aria-labelledby': 'schedule-title' },
    el('h2', { id: 'schedule-title' }, { change: 'How often to back up?', separate: `Back up ${name} on its own?`, new: `Back up ${name}?` }[mode]),
    el('p', { class: 'what' }, el('b', {}, path)),
    el('label', { class: 'field' }, 'How often', select),
    separate ? el('label', { class: 'field' }, now, 'Back up now') : null,
    outer ? el('label', { class: 'field', title: `So backups of ${outer.path} use your settings in here` }, copySettings, 'Apply parent settings fix') : null,
    el('p', {}, 'KopiaUI picks up the change when it next refreshes, within 4 hours.'),
    error,
    el('div', { class: 'actions' }, cancel, save));
  dialog.addEventListener('close', () => {
    dialog.remove();
    scheduleDialogOpen = false;
  });
  document.body.append(dialog);
  dialog.showModal();
  select.focus();
}
