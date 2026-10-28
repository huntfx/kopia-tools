// The snapshots panel on the right: the history of the folder or file being looked at
import { compareTarget, ignoredReason, isGone, kindCount } from './changes.js';
import { api, pending } from './data.js';
import { el, fillColour, formatFull, formatSize, gradientPositions, gradientRgb, plural, signedSize, timeAgo } from './format.js';
import { backupButton, beingDeleted, confirmDelete } from './jobs.js';
import { scheduleLine } from './schedules.js';
import { diskText, locationsBelow, sidebarSnapshot, treeNodes } from './sidebar.js';
import { navigate, state, ui } from './state.js';
import { asOfSnapshot, backingUpNow, currentPath, isCancelled, latest, locationOf, locationTotal, pathInScope, relativeTo, selectedSnapshot, snapshotListing, storage, tooOld, unfinished } from './storage.js';

// Viewing a snapshot sets "files as of" to its time, so every location follows; the newest goes back to now
export const asOfFor = (loc, snap) => (snap === latest(loc) ? null : snap.time);

// Clicking a snapshot views it; Shift-clicking compares the one being viewed with it instead
export function pickSnapshot(snap, selected, compare) {
  if (compare && !snap.incomplete && snap !== selected && !selected.incomplete) navigate({ compare: snap.id });
  else navigate({ asOf: asOfFor(storage.find(l => l.snapshots.includes(snap)), snap) });
}

// Picking a path inside the folder in scope shows its snapshots in the panel, without moving
export function openHistory(relativePath, isFolder = true) {
  ui.pickedIsFolder = isFolder;
  navigate({ history: pathInScope(storage.find(l => l.path === state.location), relativePath) });
}

// A folder path inside a location with each name in its real case, taken from the latest snapshot,
// as paths are typed in any case on Windows but kopia's names are case-sensitive
export function realCase(loc, rel) {
  const snap = sidebarSnapshot(loc);
  const parts = [];
  for (const part of rel ? rel.split('/') : []) {
    const entries = snap && snapshotListing(snap, parts.join('/'));
    const match = entries?.find(e => e.n.toLowerCase() === part.toLowerCase());
    parts.push(match ? match.n : part);
  }
  return parts.join('/');
}

// How a path changed from one snapshot to the next: { identical } when the snapshots are the same,
// otherwise { kind, size, oldSize, files } for a file or a folder added or removed whole, and, for a folder,
// counts of the files changed inside it. null if that diff wasn't captured.
// kopia's diff only reports changes to contents, so with none, touched says whether the path itself still
// differs, as a file's modified date changing without its contents (git does this) makes kopia store it, and
// every folder above it, again. Otherwise the snapshot differs only because of something elsewhere.
export function stepChange(older, newer, rel, isFolder) {
  if (older.root === newer.root) return { identical: true };
  const list = api.diff(older.id, newer.id);
  if (!list) return null;
  const result = { counts: { '+': 0, '-': 0, '~': 0, i: 0 } };
  for (const change of list) {
    if (!isFolder) {
      if (change.p === rel) Object.assign(result, { kind: change.k, size: change.s, oldSize: change.o, why: change.why });
    } else if (rel && change.p === `${rel}/`) {
      Object.assign(result, { kind: change.k, size: change.s, files: change.f, why: change.why });
    } else if ((!rel || change.p.startsWith(`${rel}/`)) && !change.p.endsWith('/')) {
      result.counts[change.k]++;
    }
  }
  if (!changedAtAll(result)) {
    // A folder by the object kopia stored for it, a file by its modified date, from the listing it's in
    const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    const name = rel.slice(rel.lastIndexOf('/') + 1);
    const entry = snap => snapshotListing(snap, parent)?.find(e => e.n === name && e.t === (isFolder ? 'd' : 'f'));
    const marker = snap => (!rel ? snap.root : isFolder ? entry(snap)?.o : entry(snap)?.m);
    const [before, after] = [marker(older), marker(newer)];
    if (before !== undefined && after !== undefined) result.touched = before !== after;
  }
  return result;
}

export const changedAtAll = change => !!change && !change.identical &&
  (!!change.kind || change.counts['+'] + change.counts['-'] + change.counts['~'] + change.counts.i > 0);

// What a step did to the path, as a line under the snapshot
export function describeStep(change, isFolder) {
  if (change === 'first') return el('span', { class: 'muted' }, 'Oldest snapshot');
  if (change === null) return el('span', { class: 'muted' }, pending.size ? 'Loading changes…' : 'Changes couldn\'t be loaded (see the bottom of the page)');
  // Nothing changed in it, whether or not anything did elsewhere in the location, which hovering says
  if (change.identical) return el('span', { class: 'muted', title: 'The whole snapshot is identical to the one before' }, 'No changes');
  const kinds = { '+': ['c-added', 'Added'], '-': ['c-removed', 'Removed'], '~': ['c-modified', 'Modified'], i: ['c-ignored', 'Ignored'] };
  if (change.kind && (change.kind !== '~' || !isFolder)) {
    const [cls, word] = kinds[change.kind];
    const delta = change.kind === '~' && change.oldSize != null && change.size !== change.oldSize ? ` (${signedSize(change.size - change.oldSize)})` : '';
    const what = isGone(change.kind) ? '' : ` · ${formatSize(change.size)}${delta}${isFolder && change.files != null ? ` in ${plural(change.files, 'file')}` : ''}`;
    return el('span', { title: change.why ? ignoredReason(change.why) : null }, el('span', { class: cls }, word), what);
  }
  if (!changedAtAll(change)) {
    // Until the listings to compare are in, it isn't known which; if they can't be, all that's known is the diff's
    if (change.touched === undefined) return el('span', { class: 'muted' }, pending.size ? 'Checking…' : 'No content changes');
    return change.touched
      ? el('span', { class: 'muted', title: 'kopia stored it again because a modified date changed, but no file\'s contents did' },
        isFolder ? 'Dates changed' : 'Date changed')
      : el('span', { class: 'muted', title: 'Nothing in it changed; something elsewhere in the location did' }, 'No changes');
  }
  // Only the kinds of change that happened, to keep the panel quiet
  return el('span', { class: 'counts', style: 'font-size:inherit;gap:8px' },
    ['+', '-', '~', 'i'].filter(k => change.counts[k]).map(k => kindCount(k, change.counts[k])));
}

// Whether the picked path is a folder: known if it was clicked, otherwise looked up in the snapshot
export function isFolderPath(loc, rel) {
  if (!rel) return true;
  if (state.history && !state.file) return ui.pickedIsFolder;
  if (state.file && !state.history) return false;
  const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
  const snap = sidebarSnapshot(loc);
  const entry = snap && snapshotListing(snap, parent)?.find(e => e.n === rel.slice(rel.lastIndexOf('/') + 1));
  return entry ? entry.t === 'd' : true;
}

// Why kopia's retention policy keeps a snapshot, from its reasons like latest-1, daily-3 or annual-1. The one
// that keeps it longest decides how long it stays, so that's shown, with all of them on hover.
export const KEEP_KINDS = [['annual', 'yearly'], ['monthly', 'monthly'], ['weekly', 'weekly'], ['daily', 'daily'], ['hourly', 'hourly'], ['latest', 'as recent']];

export function keptFor(snap) {
  if (!snap.keep?.length) return null;
  const reasons = snap.keep.map(r => r.split('-'));
  const [kind, word] = KEEP_KINDS.find(([k]) => reasons.some(([r]) => r === k)) || [];
  if (!kind) return null;
  const named = Object.fromEntries(KEEP_KINDS);
  const all = reasons.map(([r, n]) => `${r === 'latest' ? 'one of the latest' : named[r] || r} #${n}`).join(', ');
  return el('span', { class: 'keep', title: `Kept by kopia's retention policy as ${all}. ${kind === 'latest'
    ? 'Only as one of the latest, so it goes when newer snapshots replace it.' : `The ${word} one keeps it longest.`}` }, `kept ${word}`);
}

// For the PC or a folder above the backup locations, which have no snapshots of their own: the locations
// inside, each with its latest snapshot, so it's clear at a glance which are being backed up
export function renderFolderSide(aside) {
  const node = treeNodes.get(state.folder.toLowerCase());
  const locations = node ? locationsBelow(node).sort((a, b) => a.path.localeCompare(b.path, 'en', { sensitivity: 'base' })) : [];
  aside.replaceChildren(
    el('div', { class: 'history-head' },
      el('div', {}, el('h2', {}, `Backup locations (${locations.length})`), el('div', { class: 'target' }, state.folder))),
    el('ul', { class: 'snaps' }, locations.map(loc => {
      // The snapshot for the as-of date, or with none set, the latest; and what was on disk by then
      const newest = state.asOf ? (tooOld(loc) ? null : asOfSnapshot(loc)) : latest(loc);
      const onDisk = state.asOf ? newest?.total ?? 0 : locationTotal(loc);
      const cut = loc.path.lastIndexOf('\\') + 1;
      return el('li', { class: 'snaprow', title: `Open ${loc.path}`, onclick: () => navigate({ location: loc.path, snapshot: null }) },
        el('div', { class: 'top' },
          el('span', { class: 'marker', style: 'color:var(--accent)' }, '●'),
          // The path leading to the location gives way first, so its own name stays readable
          el('span', { class: 'when mono churn-name' },
            el('span', { class: 'lead' }, loc.path.slice(node.root ? 0 : state.folder.replace(/\\$/, '').length + 1, cut)),
            el('span', { class: 'own' }, `${loc.path.slice(cut)}\\`)),
          backingUpNow(loc) ? el('span', { class: 'badge' }, 'Live') : null,
          newest ? el('span', { class: 'disk', title: state.asOf ? 'On disk as of this snapshot' : 'On disk' }, diskText(onDisk)) : null),
        el('div', { class: 'what' },
          newest ? el('span', {}, `${state.asOf ? 'Snapshot' : 'Latest'} ${formatFull(newest.time)}`)
            : el('span', { class: 'muted' }, state.asOf ? 'No snapshot that old' : 'No snapshots'),
          newest ? el('span', { class: 'ago' }, timeAgo(newest.time)) : null));
    })));
}

export function renderSide() {
  const aside = document.getElementById('history');
  const app = document.getElementById('app');
  const target = state.history || currentPath();
  const loc = target && locationOf(target);
  // The panel stays open everywhere, so the page keeps its shape
  const shown = !!loc || !!state.folder;
  aside.hidden = !shown;
  app.classList.toggle('with-history', shown);
  if (!shown) return;
  if (!loc) return renderFolderSide(aside);

  const rel = relativeTo(loc, target);
  const isFolder = isFolderPath(loc, rel);
  // A location that hasn't been backed up yet: its schedule, and backing it up
  if (!loc.snapshots.length) {
    aside.replaceChildren(
      el('div', { class: 'history-head' },
        el('div', {}, el('h2', {}, 'Snapshots (0)'), el('div', { class: 'target' }, target), scheduleLine(loc, target, rel, isFolder)),
        backupButton(loc)),
      el('p', { class: 'note' }, 'No snapshots yet'));
    return;
  }
  // Snapshots can be viewed and compared for the location open in the middle; elsewhere a click goes there
  const viewing = loc.path === state.location;
  const selected = viewing ? selectedSnapshot(loc) : null;
  // The comparison is the changes panel's, for the folder being looked at, so it's only marked when
  // this list is for that folder, not for an item picked in it or a file's own page
  const other = viewing && !state.history && !state.file ? compareTarget(loc, selected) : null;
  const complete = loc.snapshots.filter(s => !s.incomplete);
  const inProgress = loc.snapshots.filter(s => s.incomplete);
  const [low, high] = other ? [complete.indexOf(other), complete.indexOf(selected)].sort((a, b) => a - b) : [-1, -1];
  const positions = gradientPositions(loc.snapshots.map(s => s.onDisk).filter(Boolean));
  const parentRel = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';

  // The size of what the panel is for at a snapshot: the snapshot's own for the location, otherwise from the
  // listing of the folder it's in, loaded if need be. Nothing if it isn't in that snapshot.
  const sizeAt = snap => {
    if (snap.incomplete) return null;
    const name = rel.slice(rel.lastIndexOf('/') + 1);
    const entries = rel ? snapshotListing(snap, parentRel) : undefined;
    const size = !rel ? snap.size : entries?.find(e => e.n === name)?.s;
    if (size == null) return rel && entries === undefined ? el('span', { class: 'disk muted' }, '…') : null;
    return el('span', { class: 'disk', title: `Size of ${rel ? name : 'the location'} in this snapshot` }, formatSize(size));
  };

  const row = (snap, change, extraClass = '') => {
    const at = complete.indexOf(snap);
    const deleting = beingDeleted(snap);
    const classes = ['snaprow', extraClass, deleting ? 'deleting' : '',
      snap === selected ? 'viewing' : '', snap === other ? 'compared' : '',
      // Taken after the as-of date
      state.asOf && new Date(snap.time) > new Date(state.asOf) ? 'after' : '',
      at > low && at < high ? 'between' : '', change !== 'first' && change && !change.kind && !changedAtAll(change) ? 'unchanged' : ''];
    // A file's snapshot opens the file itself at that time, and a folder's opens that folder; for the
    // folder already open it's viewed in place
    const here = isFolder && viewing && !state.file && rel === state.scope;
    const open = () => !isFolder
      ? navigate({ location: loc.path, scope: parentRel, file: rel.slice(rel.lastIndexOf('/') + 1), asOf: asOfFor(loc, snap) })
      : here
        ? pickSnapshot(snap, selected, false)
        : navigate({ location: loc.path, asOf: asOfFor(loc, snap), scope: rel, file: null, history: null });
    return el('li', {
      class: classes.filter(Boolean).join(' '),
      title: deleting ? 'This snapshot is being deleted' : snap.incomplete ? `This snapshot ${unfinished(snap)}`
        : here ? 'Click to view · Shift-click to compare with it' : 'Click to open at this snapshot',
      onclick: snap.incomplete || deleting ? null : event => (here && event.shiftKey ? pickSnapshot(snap, selected, true) : open()),
    },
      el('div', { class: 'top' },
        el('span', { class: 'marker' }, snap === selected ? '●' : snap === other ? '○' : ''),
        el('span', { class: 'when' }, formatFull(snap.time)),
        snap === latest(loc) ? el('span', { class: 'tag' }, 'latest') : null,
        snap === other ? el('span', { class: 'tag' }, 'compared') : null,
        snap.incomplete ? el('span', { class: 'badge' }, isCancelled(snap) ? 'Cancelled' : 'In progress') : null,
        deleting ? el('span', { class: 'badge' }, 'Deleting…') : null,
        sizeAt(snap),
        // Space the snapshot added on disk is for the whole location, so it's only shown for the location
        // itself; for anything inside, the row's own change says what happened to it
        // A snapshot just made doesn't have it yet, until the snapshots are read again
        rel ? null : snap.onDisk == null
          ? el('span', { class: 'disk muted', title: 'Working out how much this snapshot added on disk…' }, '…')
          : el('span', { class: 'disk', title: 'Added on disk by this snapshot, for the whole location' },
            snap.onDisk ? el('span', { class: 'swatch', style: `background:${fillColour(gradientRgb(positions.get(snap.onDisk)))}` }) : null,
            `+${formatSize(snap.onDisk)}`),
        // Not one still being made, which kopia replaces as it goes
        !deleting && (!snap.incomplete || isCancelled(snap)) ? el('button', {
          class: 'delete', 'aria-label': 'Delete this snapshot', title: 'Delete this snapshot…',
          onclick: event => { event.stopPropagation(); confirmDelete(loc, snap, rel, isFolder); },
        }, '×') : null),
      el('div', { class: 'what' },
        snap.incomplete ? el('span', { class: 'muted' }, 'Stored so far') : describeStep(change, isFolder),
        keptFor(snap),
        el('span', { class: 'ago' }, timeAgo(snap.time))));
  };

  // Newest first, each with what it changed in the path since the one before
  const rows = [];
  for (let i = complete.length - 1; i >= 0; i--) {
    rows.push(row(complete[i], i === 0 ? 'first' : stepChange(complete[i - 1], complete[i], rel, isFolder)));
  }

  // The same path may be backed up by other locations too
  const elsewhere = storage.filter(l => l !== loc && locationOf(target) !== l &&
    (target.toLowerCase() + '\\').startsWith(l.path.replace(/\\$/, '').toLowerCase() + '\\'));

  aside.replaceChildren(...[
    el('div', { class: 'history-head' },
      el('div', {}, el('h2', {}, `Snapshots (${complete.length})`), el('div', { class: 'target' }, target),
        scheduleLine(loc, target, rel, isFolder)),
      // Up one folder level within the location, for the panel only; the middle stays where it is
      rel ? el('button', {
        class: 'btn', style: 'font-size:0.8rem;flex:none', title: 'Show the snapshots of the folder above',
        onclick: () => {
          const above = target.slice(0, target.lastIndexOf('\\'));
          ui.pickedIsFolder = true;
          navigate({ history: above.toLowerCase() === currentPath().toLowerCase() ? null : above });
        },
      }, '↑ Up') : null,
      backupButton(loc)),
    el('ul', { class: 'snaps' }, inProgress.map(s => row(s, null, 'partial')), rows),
    elsewhere.length ? el('div', { class: 'elsewhere' }, 'Also backed up in ',
      elsewhere.map((l, i) => [i ? ', ' : '', el('button', {
        onclick: () => navigate({ location: l.path, snapshot: null, scope: isFolder ? relativeTo(l, target) : relativeTo(l, target).split('/').slice(0, -1).join('/') }),
      }, l.path)])) : null,
  ].filter(Boolean));
}
