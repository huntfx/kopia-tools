// Loading from kopia_explorer.py: snapshots, diffs, folder listings, date-only changes and file types, with the
// progress bar
import { el, listOf, plural } from './format.js';
import { render } from './render.js';
import { storage } from './storage.js';

// What's been loaded: the repository, and diffs, folder listings and date-only changes by what they're between,
// and file types by folder
export const DATA = { diffs: {}, listings: {}, dates: {}, types: {} };

export const requested = new Set();  // Each request is only made once, so a failure isn't retried in a loop

export const pending = new Set();    // Requests in flight, for saying something's loading

export const failures = new Map();   // Requests that failed, with why, until retried

// How many of each kind of request have been made and finished, for the progress bar; reset once all are in
export const progress = { changes: { done: 0, total: 0 }, folders: { done: 0, total: 0 }, types: { done: 0, total: 0 } };

// Each kind in words, for the progress bar: what it is, and what it's counted in
const KINDS = { changes: ['changes for ', 'snapshot'], folders: ['', 'folder'], types: ['file types for ', 'snapshot'] };

// Fetch something not loaded yet, and redraw once it arrives. Until then the page says it's loading.
export function load(url, kind, store) {
  if (requested.has(url)) return;
  requested.add(url);
  pending.add(url);
  progress[kind].total++;
  showProgress();
  fetch(url)
    // The server puts the reason, such as kopia's error, in the status text
    .then(response => (response.ok ? response.json() : Promise.reject(new Error(response.statusText || `Error ${response.status}`))))
    .then(store)
    .catch(error => failures.set(url, { kind, reason: error instanceof TypeError ? 'Can\'t reach the server. Is kopia_explorer.py still running?' : error.message }))
    .finally(() => {
      pending.delete(url);
      progress[kind].done++;
      if (!pending.size) for (const counts of Object.values(progress)) counts.done = counts.total = 0;
      showProgress();
      redrawSoon();
    });
}

// Ask again for everything that failed
export function retryFailed() {
  for (const url of failures.keys()) requested.delete(url);
  failures.clear();
  showProgress();
  redrawSoon();
}

// Why the last thing that failed did, for saying so where it's missing
export const failureReason = () => [...failures.values()].pop()?.reason;

// At the bottom of the page: what's loading, counted in requests as each diff is one kopia command with no
// progress of its own, so it's one per snapshot; or what couldn't be loaded, with a retry
export function showProgress() {
  const box = document.getElementById('progress');
  box.hidden = !pending.size && !failures.size;
  const count = (kind, done, total) => {
    const [what, unit] = KINDS[kind];
    return what + (done == null ? plural(total, unit) : `${done.toLocaleString('en-GB')} of ${plural(total, unit)}`);
  };
  if (pending.size) {
    const kinds = Object.keys(KINDS).filter(kind => progress[kind].total);
    const done = kinds.reduce((sum, kind) => sum + progress[kind].done, 0);
    const total = kinds.reduce((sum, kind) => sum + progress[kind].total, 0);
    const parts = kinds.map(kind => count(kind, progress[kind].done, progress[kind].total));
    box.replaceChildren(
      el('span', {}, `Loading ${listOf(parts)}…`),
      el('span', { class: 'bar' }, el('span', { class: 'fill', style: `display:block;width:${100 * done / total}%` })));
  } else if (failures.size) {
    const failed = kind => [...failures.values()].filter(f => f.kind === kind).length;
    const parts = Object.keys(KINDS).filter(failed).map(kind => count(kind, null, failed(kind)));
    box.replaceChildren(
      el('span', { class: 'c-removed' }, `Couldn't load ${listOf(parts, 'or')}: ${failureReason()}`),
      el('button', { class: 'btn', onclick: retryFailed }, 'Retry'));
  }
}

export let redrawQueued = false;

// Redraw once whatever's arrived has, but not while a mouse button's down: a click only counts if what was pressed
// is still there when it's let go, so redrawing in between, as happens a lot while things load, would lose it.
// It's redrawn once the click's done.
let pointerDown = false;
let redrawAfterPointer = false;

export function redrawSoon() {
  if (redrawQueued) return;
  redrawQueued = true;
  requestAnimationFrame(() => {
    if (pointerDown) {
      redrawAfterPointer = true;
      return;
    }
    redrawQueued = false;
    render();
  });
}

function pointerReleased() {
  pointerDown = false;
  if (!redrawAfterPointer) return;
  redrawAfterPointer = false;
  // After the click the release makes has been handled
  setTimeout(() => {
    redrawQueued = false;
    render();
  });
}
document.addEventListener('pointerdown', () => { pointerDown = true; }, true);
document.addEventListener('pointerup', pointerReleased, true);
// A press that ends elsewhere, such as outside the window, doesn't hold redrawing up
document.addEventListener('pointercancel', pointerReleased, true);
window.addEventListener('blur', pointerReleased);

export const api = {
  // Everything else is built from this, so the page waits for it, showing how the server's getting on, as
  // working out storage for locations with new snapshots can take a while
  async storage() {
    const main = document.getElementById('main');
    const show = (step, done, total) => main.replaceChildren(el('div', { class: 'panel loading', role: 'status' },
      el('p', {}, `${step}…`),
      total ? el('div', { class: 'loading-bar' },
        el('span', { class: 'bar' }, el('span', { class: 'fill', style: `display:block;width:${100 * done / total}%` })),
        `${done} of ${plural(total, 'location')}`) : null));
    show('Reading the repository');
    let waiting = true;
    (async () => {
      while (waiting) {
        await new Promise(resolve => setTimeout(resolve, 400));
        const progress = await fetch('/api/progress').then(r => r.json()).catch(() => ({}));
        if (waiting && progress.step) show(progress.step, progress.done, progress.total);
      }
    })();
    try {
      const response = await fetch('/api/storage');
      if (!response.ok) throw new Error(response.statusText || `Error ${response.status}`);
      return await response.json();
    } catch (error) {
      main.replaceChildren(el('div', { class: 'panel empty' }, `Couldn't read the repository: ${
        error instanceof TypeError ? 'can\'t reach the server. Is kopia_explorer.py running?' : error.message}`));
      throw error;
    } finally {
      waiting = false;
    }
  },
  // A diff between consecutive snapshots. A missing one loads all of its location's missing diffs, one
  // request each so they fill in as they come, newest first as those are seen first.
  diff(fromId, toId) {
    let changes = DATA.diffs[`${fromId}..${toId}`];
    const loc = !changes && storage.find(l => l.snapshots.some(s => s.id === fromId));
    if (loc) {
      const complete = loc.snapshots.filter(s => !s.incomplete);
      for (let i = complete.length - 1; i > 0; i--) {
        const key = `${complete[i - 1].id}..${complete[i].id}`;
        // Identical snapshots have nothing to ask kopia about
        if (complete[i - 1].root === complete[i].root) DATA.diffs[key] = [];
        if (!DATA.diffs[key]) load(`/api/diff?from=${complete[i - 1].id}&to=${complete[i].id}`, 'changes', list => { DATA.diffs[key] = list; });
      }
      changes = DATA.diffs[`${fromId}..${toId}`];
    }
    return changes;
  },
  // A folder's entries by object ID, loaded if missing unless only peeking, as search does
  listing(obj, fetchIfMissing = true) {
    const entries = DATA.listings[obj];
    if (!entries && fetchIfMissing) load(`/api/listing?obj=${obj}`, 'folders', result => { DATA.listings[obj] = result; });
    return entries;
  },
  // How many files of each type a folder has and how big they are, counting everything inside it, by its object
  // ID: { extension: [files, bytes] }, with '' for files without one
  types(obj) {
    if (!DATA.types[obj]) load(`/api/types?obj=${obj}`, 'types', result => { DATA.types[obj] = result; });
    return DATA.types[obj];
  },
  // Files whose modified date changed but not their contents, between any two snapshots of a location
  dates(fromId, toId) {
    const key = `${fromId}..${toId}`;
    if (!DATA.dates[key]) load(`/api/dates?from=${fromId}&to=${toId}`, 'changes', list => { DATA.dates[key] = list; });
    return DATA.dates[key];
  },
  // Asks the server, which picks where in a folder picker; the header shows it's this page asking
  post: (url, body) => fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Kopia-Explorer': '1' }, body: JSON.stringify(body),
  }).then(response => (response.ok ? response.json() : Promise.reject(new Error(response.statusText || `Error ${response.status}`)))),
};

// What to say where something isn't there: still loading, or failed
export function notLoaded(what) {
  return pending.size ? `Loading the ${what}…` : `The ${what} couldn't be loaded: ${failureReason() || 'no reason given'}`;
}

// The repository, for tooltips: its description, where it is, and who's connected to it
export function repositoryTitle() {
  const repo = DATA.repository;
  return [repo.description, repo.path, repo.user && `Connected as ${repo.user}@${repo.host}`].filter(Boolean).join('\n');
}

export const notKnown = () => el('span', { class: 'muted' }, pending.size ? 'Loading…' : 'Not known');
