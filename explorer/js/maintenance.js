// Kopia's maintenance, which frees the space deleted snapshots used and keeps the repository tidy: shown in the
// Settings window, and warned about above the panel at the bottom when it's failing, overdue, or no PC owns it,
// as kopia only runs it on the PC that does. Overdue isn't said while KopiaUI isn't running here, if this PC owns
// it, as that's said already and is why. It's asked about every ten minutes, while the page is showing, as it
// only changes when it runs, and whenever the Settings window opens.
import { api } from './data.js';
import { el, formatFull, timeAgo } from './format.js';
import { renderNotice } from './jobs.js';
import { kopiaUIStopped } from './kopiaui.js';
import { OVERDUE, capitalised, every } from './schedules.js';
import { renderSettings } from './settings.js';
import { pageHidden, whenShown } from './shown.js';

const TICK = 10 * 60 * 1000;

// From the server: who owns it and who this is, as user@host, each cycle, with whether it's enabled, how often it
// runs in seconds, and when it last ran and is next due as Unix times, and each task whose latest run failed.
// Null until it's been asked.
let maintenance = null;

// The notice put off, until it would say something else
let putOff = null;

// Being taken on by this PC, or why it couldn't be
let owning = false;
let ownError = null;

function changed(found = maintenance) {
  maintenance = found;
  renderNotice();
  renderSettings();
}

export async function checkMaintenance() {
  const found = await fetch('/api/maintenance').then(response => (response.ok ? response.json() : null)).catch(() => null);
  if (found) changed(found);
}

setInterval(() => {
  if (!pageHidden()) checkMaintenance();
}, TICK);
whenShown(checkMaintenance);

async function ownMaintenance() {
  owning = true;
  ownError = null;
  changed();
  let found = maintenance;
  try {
    found = await api.post('/api/maintenance/own', {});
  } catch (error) {
    ownError = `Couldn't run it from this PC: ${error instanceof TypeError ? 'can\'t reach the server' : error.message}`;
  }
  owning = false;
  changed(found);
}

const ms = seconds => seconds * 1000;
const CYCLES = [['quick', 'Quick maintenance'], ['full', 'Full maintenance']];
const ownedHere = () => maintenance.owner === maintenance.me;
const overdue = cycle => cycle.enabled && cycle.next && Date.now() - ms(cycle.next) >= OVERDUE;

// What's wrong, if anything, worst first: nothing owns it, so it never runs, its latest run of something failed,
// or a cycle's overdue
function problem() {
  if (!maintenance) return null;
  if (!maintenance.owner) return 'unowned';
  if (maintenance.failed.length) return 'failed';
  if (CYCLES.some(([key]) => overdue(maintenance[key]))) return 'overdue';
  return null;
}

// Who runs it, in words
const ownerText = () => (!maintenance.owner ? 'and no PC does' : ownedHere() ? 'which is this one' : `which is ${maintenance.owner}`);

// Taking it on, where this PC doesn't own it
function ownButton(className) {
  if (ownedHere()) return null;
  return el('button', {
    class: className, 'data-key': 'own', disabled: owning, title: `Make ${maintenance.me} its owner`, onclick: ownMaintenance,
  }, owning ? 'Changing…' : 'Run it from this PC');
}

// The notice above the panel at the bottom, unless put off
export function maintenanceNotice() {
  const which = problem();
  const key = which && JSON.stringify([which, maintenance.owner, maintenance.failed]);
  if (!which || putOff === key || (which === 'overdue' && ownedHere() && kopiaUIStopped())) return null;
  const close = el('button', { class: 'linklike', onclick: () => { putOff = key; ownError = null; renderNotice(); } }, 'Not now');
  const error = ownError ? el('p', { class: 'c-removed' }, ownError) : null;
  if (which === 'unowned') {
    return [
      el('h2', {}, 'Maintenance not running'),
      el('p', {}, 'No PC owns Kopia\'s maintenance, so it never runs, and space used by deleted snapshots is never freed.'),
      error, el('div', { class: 'actions' }, ownButton('btn'), close),
    ];
  }
  if (which === 'failed') {
    return [
      el('h2', {}, 'Maintenance failing'),
      maintenance.failed.map(f => el('p', { title: formatFull(ms(f.when)) }, `Kopia's ${f.task} maintenance task failed ${timeAgo(ms(f.when))}: ${f.error}`)),
      el('div', { class: 'actions' }, close),
    ];
  }
  const due = Math.min(...CYCLES.filter(([key]) => overdue(maintenance[key])).map(([key]) => maintenance[key].next));
  return [
    el('h2', {}, 'Maintenance overdue'),
    el('p', {}, `Kopia's maintenance was due ${timeAgo(ms(due))}, but hasn't run. `,
      ownedHere() ? 'It runs while KopiaUI is running.' : `It only runs on ${maintenance.owner}.`),
    error, el('div', { class: 'actions' }, ownButton('btn'), close),
  ];
}

// The Settings window's section
export function maintenanceSection() {
  const which = problem();
  return [
    el('div', { class: 'section-head' }, el('h3', {}, 'Maintenance'),
      maintenance ? el('div', { class: 'actions' },
        which ? el('span', { class: 'warn' }, { unowned: 'Not running', failed: 'Failing', overdue: 'Overdue' }[which])
          // Turned off on purpose, so not warned about at the bottom, but it's what frees the space
          : !maintenance.full.enabled ? el('span', { class: 'warn', title: 'Space used by deleted snapshots is never freed' }, 'Full maintenance disabled')
            : el('span', { class: 'c-added' }, '✓ Up to date'),
        ownButton('linklike')) : null),
    el('p', {}, 'Frees the space deleted snapshots used, and keeps the repository tidy. KopiaUI runs it in the background, but only on the PC that owns it, ',
      maintenance ? `${ownerText()}.` : '…'),
    ownError ? el('p', { class: 'c-removed' }, ownError) : null,
    el('ul', {}, maintenanceRows()),
  ];
}

// Each cycle, how often it runs, when it last did and when it's next due, then each task that failed
function maintenanceRows() {
  if (!maintenance) return el('li', { class: 'muted' }, 'Reading the maintenance schedule…');
  return [
    CYCLES.map(([key, name]) => {
      const cycle = maintenance[key];
      return el('li', {},
        el('div', { class: 'what' }, name, el('div', { class: 'detail' }, capitalised(every(cycle.interval)))),
        el('div', { class: 'status' }, cycleStatus(cycle)));
    }),
    maintenance.failed.map(f => el('li', {},
      el('div', { class: 'what' }, `${f.task} failed`, el('div', { class: 'detail' }, f.error)),
      el('div', { class: 'status' }, el('span', { class: 'c-removed', title: formatFull(ms(f.when)) }, timeAgo(ms(f.when)))))),
  ];
}

function cycleStatus(cycle) {
  if (!cycle.enabled) return el('span', { class: 'warn' }, 'Disabled');
  const last = cycle.last ? el('span', { class: 'muted', title: formatFull(ms(cycle.last)) }, `Ran ${timeAgo(ms(cycle.last))}`) : null;
  if (!cycle.next) return last || el('span', { class: 'muted' }, 'Never run');
  const next = ms(cycle.next);
  if (overdue(cycle)) return [last, el('span', { class: 'warn', title: formatFull(next) }, `Due ${timeAgo(next)}`)];
  return [last, el('span', { class: 'muted', title: formatFull(next) }, next > Date.now() ? `Next ${timeAgo(next)}` : 'Due now')];
}
