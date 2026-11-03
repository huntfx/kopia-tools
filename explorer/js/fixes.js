// The Fixes window, from the header's hammer button: every location with one of Kopia Explorer's fixes, or needing one, so
// they're easy to keep track of. The parent settings fix is read from the server, which asks kopia about each
// location inside another, so it's read when the window opens and again once a change to it is done; the last
// good pin is worked out from the snapshots. Each location goes to its page, and each fix can be applied or
// undone here, followed in the panel at the bottom.
import { el, formatFull, listOf, plural, timeAgo } from './format.js';
import { changeSettings, confirmPin, jobActive, jobList } from './jobs.js';
import { LAST_GOOD, failingRun, lastGood, lastGoodPinned, pinLastGood, warned } from './lastgood.js';
import { capitalised } from './schedules.js';
import { navigate } from './state.js';
import { storage } from './storage.js';

let dialog = null;

// Locations inside others with the parent settings fix or needing it, from the server: undefined while being
// read, null if they couldn't be
let nested;

let reads = 0;  // So only the latest read is shown, if it's read again before the last one's back

export function openFixes() {
  if (dialog) return;
  dialog = el('dialog', { class: 'confirm fixes', 'aria-labelledby': 'fixes-title' });
  dialog.addEventListener('close', () => {
    dialog.remove();
    dialog = null;
  });
  document.body.append(dialog);
  dialog.showModal();
  loadFixes();
  // Without scrolling down to it, as the window can be taller than the page
  dialog.querySelector('[data-key="close"]').focus({ preventScroll: true });
}

// Read the parent settings fix again, while the window's open
export async function loadFixes() {
  if (!dialog) return;
  const read = ++reads;
  nested = undefined;
  renderFixes();
  const found = await fetch('/api/nested-settings').then(response => (response.ok ? response.json() : null)).catch(() => null);
  if (read !== reads) return;
  nested = found;
  renderFixes();
}

// Drawn again whenever the snapshots or what's going on the server change, but only if it says something else,
// keeping the focus on the same button where it's still there
export function renderFixes() {
  if (!dialog) return;
  const fresh = el('div', {},
    el('h2', { id: 'fixes-title' }, 'Fixes'),
    el('p', {}, 'Kopia Explorer\'s fixes for kopia\'s policies and snapshots, on each location that has one or needs one.'),
    el('div', { class: 'section-head' }, el('h3', {}, 'Parent settings fix'), settingsForAll()),
    el('p', {}, 'Copies the settings a location inside another would inherit into its own policy, as kopia doesn\'t use them in there when backing up the other location.'),
    el('ul', {}, settingsRows()),
    el('h3', {}, 'Last good pin'),
    el('p', {}, 'Pins the latest snapshot without missing files, and moves the pin on to each new one, so Kopia\'s retention settings never delete them.'),
    el('ul', {}, lastGoodRows()),
    el('div', { class: 'actions' }, el('button', { class: 'btn', 'data-key': 'close', onclick: () => dialog.close() }, 'Close')));
  if (fresh.innerHTML === dialog.innerHTML) return;
  const key = dialog.contains(document.activeElement) ? document.activeElement.dataset.key : null;
  dialog.replaceChildren(...fresh.childNodes);
  if (key) (dialog.querySelector(`[data-key="${CSS.escape(key)}"]`) || dialog.querySelector('[data-key="close"]')).focus();
}

// A location's row: going to it, what it has, and what can be done, unless something's being done already, which
// the panel at the bottom follows. Each button is [label, action, how]: 'leave' closes the window, as it goes
// somewhere, 'asks' opens a dialog over it first, and otherwise it's done straight away, so it can't be clicked
// twice.
function row(path, state, detail, buttons, busy = null, title = null) {
  const loc = storage.find(l => l.path.toLowerCase() === path.toLowerCase());
  const go = () => {
    dialog.close();
    navigate({ location: loc.path, snapshot: null });
  };
  const button = ([label, action, how]) => el('button', {
    class: 'linklike', 'data-key': `${path}:${label}`, disabled: !!busy,
    onclick: event => {
      if (how === 'leave') dialog.close();
      else if (how !== 'asks') event.currentTarget.disabled = true;
      action();
    },
  }, label);
  return el('li', {},
    el('div', { class: 'what' },
      loc ? el('button', { class: 'linklike', title: `Open ${loc.path}`, 'data-key': path, onclick: go }, loc.path) : el('b', {}, path),
      el('div', { class: 'detail', title }, detail)),
    el('div', { class: 'status' }, busy ? el('span', { class: 'muted' }, busy) : state, buttons.map(button)));
}

const applied = () => el('span', { class: 'c-added' }, '✓ Applied');
const warning = text => el('span', { class: 'warn' }, text);

// Beside the parent settings fix's heading: applying it to every location inside another that doesn't have it yet,
// or removing it from every one that has, apart from settings changed by hand since, as the server finds them,
// unless there are none or a change to it is going
function settingsForAll() {
  const going = jobList.some(j => j.kind === 'settings' && jobActive(j));
  const all = (label, undo, none, title) => el('button', {
    class: 'linklike', 'data-key': `all:${label}`, title, disabled: going || nested === undefined || none,
    onclick: event => {
      event.currentTarget.disabled = true;
      changeSettings(undo);
    },
  }, label);
  return el('div', { class: 'actions' },
    all('Apply to all', false, nested?.every(n => n.copied.length),
      'To every nested location that doesn\'t have it yet, so backups of the locations they\'re in use your settings inside them'),
    all('Remove from all', true, nested?.every(n => !n.copied.length),
      'From every nested location that has it, apart from settings changed by hand since'));
}

// Locations inside others, with applying, reapplying or undoing the parent settings fix, followed in the panel at
// the bottom while it's going
function settingsRows() {
  if (nested === undefined) return el('li', { class: 'muted' }, 'Reading the policies…');
  if (nested === null) return el('li', { class: 'c-removed' }, 'Couldn\'t read the policies');
  if (!nested.length) return el('li', { class: 'muted' }, 'No nested locations have it or need it');
  return nested.map(n => {
    const job = jobList.find(j => j.kind === 'settings' && jobActive(j) && (!j.items.length || j.items.some(i => i.path === n.path)));
    const change = undo => () => changeSettings(undo, [n.path]);
    const busy = job && (job.undo ? 'Removing…' : 'Applying…');
    if (!n.copied.length) {
      return row(n.path, warning('Not applied'), `Backups of ${n.container} don't use your ${listOf(n.missing, 'or')} in here`,
        [['Apply', change(false)]], busy);
    }
    // Which settings are copied in, as it's usually the same few for each
    const copied = `${plural(n.copied.length, 'setting')} copied in, for backups of ${n.container}`;
    const which = capitalised(listOf(n.copied));
    if (n.edited || n.missing.length) {
      return row(n.path, warning('Changed since'),
        n.edited ? `${copied} - changed since, so not kept up to date` : `${copied}, but not your ${listOf(n.missing, 'or')}, set since`,
        [['Reapply', change(false)], ['Undo', change(true)]], busy, which);
    }
    return row(n.path, applied(), copied, [['Undo', change(true)]], busy, which);
  });
}

// Locations with the last good pin, or warned about needing it, with pinning or unpinning, and viewing the
// snapshot, which goes to it
function lastGoodRows() {
  const having = storage.filter(loc => lastGoodPinned(loc) || warned(loc)).sort((a, b) => a.path.localeCompare(b.path));
  if (!having.length) return el('li', { class: 'muted' }, 'No locations have it or need it');
  return having.map(loc => {
    const pinned = lastGoodPinned(loc);
    const good = pinned || lastGood(loc);
    const job = jobList.find(j => j.kind === 'pin' && jobActive(j) && j.snapshot === good.id);
    const busy = job && (job.add.length ? 'Pinning…' : 'Unpinning…');
    const run = failingRun(loc);
    const missing = run === 1 ? 'the last backup had missing files' : `the last ${run} backups had missing files`;
    const when = `${formatFull(good.time)} (${timeAgo(good.time)})`;
    const view = ['View', () => navigate({ location: loc.path, snapshot: good.id }), 'leave'];
    if (!pinned) {
      return row(loc.path, warning('Not applied'), `${capitalised(missing)} - latest good snapshot from ${when}`,
        [['Apply', () => pinLastGood(loc)], view], busy);
    }
    return row(loc.path, applied(), `Pinned snapshot from ${when}${run ? ` - ${missing}` : ''}`,
      [view, ['Undo', () => confirmPin(loc, pinned, [LAST_GOOD]), 'asks']], busy);
  });
}
