// The backup locations and their snapshots: reading them, keeping them up to date, and finding things in them
import { DATA, api, failures, showProgress } from './data.js';
import { el, formatFull, plural } from './format.js';
import { jobList } from './jobs.js';
import { render } from './render.js';
import { buildSidebarTree, forgetExactSize, rescaleTree } from './sidebar.js';
import { navigate, state, ui } from './state.js';

// Backups and deletes that finished after the snapshots were last read, by the server's clock, applied on
// top of them: a deleted snapshot taken out, and a new one put in from what kopia said when it made it
export let storageRead = 0;

export function applyJobs() {
  for (const j of jobList) {
    const loc = j.finished > storageRead && storage.find(l => l.path === j.source);
    if (!loc) continue;
    if (j.kind === 'delete' && j.state === 'done') loc.snapshots = loc.snapshots.filter(s => s.id !== j.snapshot);
    if (j.kind === 'backup' && j.info && !loc.snapshots.some(s => s.id === j.info.id)) {
      loc.snapshots = [...loc.snapshots, { ...j.info }].sort((a, b) => a.time.localeCompare(b.time));
    }
  }
}

// Storage stats come after the snapshots, as kopia takes a while over them, so a new snapshot may not have
// them yet: what it added on disk stays unknown, and the total on disk is taken as unchanged since the one
// before, until they come. With none known for a location, such as the first time, its total is unknown too.
export let storageWorking = false;

export function fillTotals() {
  for (const loc of storage) {
    let total = null;
    for (const snap of loc.snapshots) {
      if (snap.onDisk == null) snap.total = total;
      else total = snap.total;
    }
  }
}

// While the server works out storage stats, the header says how it's getting on; once it's done, the
// snapshots are read again for them
export let storagePolling = null;

export function followStorage() {
  if (storagePolling || !storageWorking) return renderRepoStatus();
  renderRepoStatus();
  storagePolling = setInterval(async () => {
    const progress = await fetch('/api/progress').then(r => r.json()).catch(() => null);
    if (!progress) return;
    if (progress.step) return renderRepoStatus(progress);
    clearInterval(storagePolling);
    storagePolling = null;
    refreshStorage();
  }, 1500);
}

// The header's line about the repository: which it is, when it was read, and how storage stats are getting on
export function renderRepoStatus(progress = {}) {
  const status = document.getElementById('repo-status');
  status.replaceChildren(`${DATA.repository.description || DATA.repository.path} · live from kopia, read ${formatFull(new Date(storageRead * 1000))}`);
  if (storageWorking) {
    status.append(el('span', { title: 'Space on disk for new snapshots, which kopia takes a while over' },
      ` · working out storage${progress.total ? ` for ${progress.done} of ${plural(progress.total, 'location')}` : ''}…`));
  }
}

// After the snapshots have changed: everything redrawn, with viewing or comparing with a snapshot that's
// been deleted going back to the default, and anything that failed to load for a deleted one forgotten
export function snapshotsChanged() {
  fillTotals();
  forgetExactSize();
  rescaleTree();
  const known = new Set(storage.flatMap(l => l.snapshots.map(s => s.id)));
  for (const url of [...failures.keys()]) {
    if ([...url.matchAll(/[?&](?:from|to)=([0-9a-f]+)/g)].some(m => !known.has(m[1]))) failures.delete(url);
  }
  showProgress();
  const gone = id => id && !known.has(id);
  if (gone(state.snapshot) || gone(state.compare)) {
    return navigate({ snapshot: gone(state.snapshot) ? null : state.snapshot, compare: gone(state.compare) ? null : state.compare }, true);
  }
  render();
}

// Read the snapshots again, quietly, as a backup has made one or one's been deleted. Each location's list is
// replaced in place, with the snapshots already known kept as the same objects, so everything holding on to
// them still finds them. One read at a time: asked for again meanwhile, it reads once more after, to catch
// what changed since it started.
export let refreshing = null;

export let refreshAgain = false;

export function refreshStorage() {
  if (refreshing) {
    refreshAgain = true;
    return refreshing;
  }
  refreshing = (async () => {
    do {
      refreshAgain = false;
      try {
        const response = await fetch('/api/storage');
        if (!response.ok) return;
        const { locations, read, working } = await response.json();
        let added = false;
        for (const fresh of locations) {
          const loc = storage.find(l => l.path === fresh.path);
          if (!loc) {
            // A new location, such as a folder backed up on its own, goes into the tree in order
            storage.push(fresh);
            added = true;
            continue;
          }
          const known = new Map(loc.snapshots.map(s => [s.id, s]));
          loc.snapshots = fresh.snapshots.map(s => Object.assign(known.get(s.id) || {}, s));
        }
        if (added) {
          storage.sort((a, b) => (a.path.toLowerCase() < b.path.toLowerCase() ? -1 : 1));
          buildSidebarTree();
        }
        storageRead = read;
        storageWorking = working;
        applyJobs();
        snapshotsChanged();
        followStorage();
      } catch {
        // It's read again after the next backup or delete, or when the page is reloaded
        return;
      }
    } while (refreshAgain);
  })().finally(() => { refreshing = null; });
  return refreshing;
}

// kopia keeps a backup stopped part way as an incomplete snapshot, saying why: cancelled, or a checkpoint
// of one still going
export const isCancelled = snap => snap.incomplete === 'canceled';

export const unfinished = snap => (isCancelled(snap) ? 'was cancelled before it finished' : 'is still in progress');

export const backingUpNow = loc => loc.snapshots.some(s => s.incomplete && !isCancelled(s));

// What the blue dot beside a backup location means, wherever one's listed
export const LOCATION_DOT = 'Backup location, with its own policy';

// Every backup location with its snapshots, oldest first, which everything else is built from: read when the
// page starts, then kept up to date
export let storage;
export async function loadStorage() {
  const { repository, locations, read, working } = await api.storage();
  DATA.repository = repository;
  storageRead = read;
  storageWorking = working;
  storage = locations;
  fillTotals();
}

export const latest = loc => [...loc.snapshots].reverse().find(s => !s.incomplete) || loc.snapshots[loc.snapshots.length - 1];

export const locationTotal = loc => loc.snapshots.length ? loc.snapshots[loc.snapshots.length - 1].total : 0;

// The snapshot a location is shown at: the last complete one at or before the as-of date (the latest if
// none is set), or the oldest if it has none that old
export function asOfSnapshot(loc) {
  const complete = loc.snapshots.filter(s => !s.incomplete);
  if (!state.asOf) return latest(loc);
  const cutoff = new Date(state.asOf);
  return [...complete].reverse().find(s => new Date(s.time) <= cutoff) || complete[0] || latest(loc);
}

// Whether a location has no snapshot as old as the as-of date
export const tooOld = loc => !!state.asOf && loc.snapshots.every(s => s.incomplete || new Date(s.time) > new Date(state.asOf));
// Left out of the sidebar and folder pages for being newer than the as-of date, unless asked to include them
export const hiddenAsOf = loc => !ui.includeOldest && tooOld(loc);

// A location's space on disk as of the as-of date: the running total at its last snapshot by then, or with none
// that old, its oldest if it's included, or none if it's hidden; with no date, as it is now. Like the storage
// chart, data shared between locations counts in each.
export function totalAsOf(loc) {
  if (!state.asOf) return locationTotal(loc);
  const snap = !hiddenAsOf(loc) && asOfSnapshot(loc);
  return snap ? snap.total : 0;
}

// A snapshot picked by hand wins; otherwise it's the one for the as-of date
export const selectedSnapshot = loc => loc.snapshots.find(s => s.id === state.snapshot) || asOfSnapshot(loc);

// The path being looked at in the middle: a file, the folder in scope, or a folder page
export function currentPath() {
  const loc = storage.find(l => l.path === state.location);
  if (loc) return pathInScope(loc, state.file);
  return state.folder;
}

// The folder being looked at, which on a file's page is the folder it's in
export function currentFolder() {
  const loc = storage.find(l => l.path === state.location);
  if (loc) return pathInScope(loc, null);
  return state.folder;
}

// The full Windows path of something in the folder in scope
export function pathInScope(loc, name) {
  const inside = [state.scope, name].filter(Boolean).join('/');
  return inside ? `${loc.path.replace(/\\$/, '')}\\${inside.replaceAll('/', '\\')}` : loc.path;
}

// The listing of the folder in scope at a snapshot: an array of entries, null if the folder
// isn't in that snapshot, or undefined if it isn't loaded (yet) or wasn't captured. Listings missing on
// the way are loaded unless only peeking.
export function snapshotListing(snap, scope, fetchIfMissing = true) {
  const obj = folderObj(snap, scope, fetchIfMissing);
  return obj ? api.listing(obj, fetchIfMissing) : obj;
}

// The object ID of the folder in scope at a snapshot, from the listings on the way to it: null if the folder
// isn't in that snapshot, or undefined if they aren't loaded (yet)
export function folderObj(snap, scope, fetchIfMissing = true) {
  let obj = snap.root;
  for (const part of scope ? scope.split('/') : []) {
    const entries = api.listing(obj, fetchIfMissing);
    if (!entries) return undefined;
    const entry = entries.find(e => e.n === part && e.t === 'd');
    if (!entry) return null;
    obj = entry.o;
  }
  return obj;
}

// The nearest location a location sits inside, with the scope of the folder containing it there
export function enclosingLocation(loc) {
  const path = loc.path.replace(/\\$/, '');
  const parentPath = path.slice(0, path.lastIndexOf('\\'));
  const outer = storage
    .filter(l => l !== loc && path.toLowerCase().startsWith(l.path.replace(/\\$/, '').toLowerCase() + '\\'))
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (!outer) return null;
  const scope = parentPath.slice(outer.path.replace(/\\$/, '').length + 1).replaceAll('\\', '/');
  return { loc: outer, scope, parentPath };
}

// The deepest backup location containing a path
export function locationOf(path) {
  const lower = path.replace(/\\$/, '').toLowerCase();
  return storage
    .filter(l => lower === l.path.replace(/\\$/, '').toLowerCase() || lower.startsWith(l.path.replace(/\\$/, '').toLowerCase() + '\\'))
    .sort((a, b) => b.path.length - a.path.length)[0];
}

// The path's place in a location, with / separators: '' for the location itself
export function relativeTo(loc, path) {
  const base = loc.path.replace(/\\$/, '');
  return path.length > base.length ? path.slice(base.length + 1).replaceAll('\\', '/') : '';
}
