// The middle of the page: a location or folder inside one, a folder page above them, or a file
import { isGone, renderChanges } from './changes.js';
import { renderSizeChart, renderStorageChart } from './charts.js';
import { renderChurn } from './churn.js';
import { renderFileTypes } from './filetypes.js';
import { settingsStatus, settingsWarning } from './schedules.js';
import { notKnown, notLoaded, pending } from './data.js';
import { appendAll, el, formatFull, formatSize, plural, shortId, timeAgo } from './format.js';
import { beingDeleted, restoreItem, showInExplorer } from './jobs.js';
import { compactFolder, diskText, locationTree, locationsBelow, repositoryDiskText, shownBelow, treeNodes, treeTotal } from './sidebar.js';
import { describeStep, openHistory, stepChange } from './snapshots.js';
import { navigate, state, ui } from './state.js';
import { asOfSnapshot, backingUpNow, enclosingLocation, hiddenAsOf, isCancelled, pathInScope, relativeTo, selectedSnapshot, snapshotListing, storage, unfinished } from './storage.js';
import { contentsTable } from './tables.js';

// What's directly inside a folder: merged folder chains and backup locations, like the sidebar
// The folder above, skipping folders that only lead to one other folder, or null at a drive
export function parentNode(node) {
  let path = node.path.replace(/\\$/, '');
  while (path.includes('\\')) {
    path = path.slice(0, path.lastIndexOf('\\'));
    const parent = treeNodes.get((path.includes('\\') ? path : `${path}\\`).toLowerCase());
    if (parent && (parent.location || parent.drive || parent.children.size > 1)) return parent;
  }
  // Drives are in the PC
  return node.root ? null : locationTree;
}

// Size, files and modified time of a folder from each location's snapshot as of the date (the latest
// by default), counting a location nested inside another only once, as part of the outer one, and not
// counting ones hidden for being newer than the date
export function latestSummary(node) {
  if (node.location) {
    const snap = !hiddenAsOf(node.location) && asOfSnapshot(node.location);
    return snap && !snap.incomplete ? { size: snap.size, files: snap.files, modified: snap.mtime } : { size: 0, files: 0, modified: null };
  }
  const summary = { size: 0, files: 0, modified: null };
  for (const child of node.children.values()) {
    const inner = latestSummary(child);
    summary.size += inner.size;
    summary.files += inner.files;
    if (inner.modified && (!summary.modified || inner.modified > summary.modified)) summary.modified = inner.modified;
  }
  return summary;
}

// A folder page's contents: the folders and backup locations directly inside it, from their latest snapshots
export function renderContents(node) {
  const items = [...node.children.values()].filter(shownBelow).map(child => {
    const { node: inner, prefix, label } = compactFolder(child);
    const loc = inner.location;
    return {
      // Folders get a backslash added, which drives have already
      key: inner.path, prefix, label: label.replace(/\\$/, ''), folder: true, location: loc,
      live: locationsBelow(inner).some(backingUpNow),
      ...latestSummary(inner),
      // A location shows its history on a single click; plain folders aren't backed up themselves
      pick: loc ? () => { ui.pickedIsFolder = true; navigate({ history: loc.path }); } : null,
      open: () => navigate(loc ? { location: loc.path, snapshot: null } : { folder: inner.path }),
    };
  });
  const parent = parentNode(node);
  const up = parent ? {
    label: parent.path,
    go: () => navigate(parent.location ? { location: parent.location.path, snapshot: null } : { folder: parent.path }),
  } : null;
  return contentsTable(state.asOf
    ? `From each backup location's snapshot as of ${formatFull(state.asOf)}`
    : 'From the latest snapshot of each backup location', up, items, () => renderContents(node));
}

// Breadcrumbs for a path, each folder above it clickable
export function pathCrumbs(path) {
  if (path === locationTree.path) return el('div', { class: 'crumbs', style: 'font-size:1.15rem;margin:0;gap:0' }, el('span', { class: 'current' }, path));
  const parts = path.split('\\').filter(Boolean);
  // No gap between parts, so the path reads as one, like B:\Projects\Photos
  return el('div', { class: 'crumbs', style: 'font-size:1.15rem;margin:0;gap:0' }, parts.map((part, i) => {
    const sub = i === 0 ? `${part}\\` : parts.slice(0, i + 1).join('\\');
    const node = treeNodes.get(sub.toLowerCase());
    const label = i === 0 ? `${part}\\` : part;
    const last = i === parts.length - 1;
    return [
      i > 1 ? el('span', {}, '\\') : null,
      last || !node ? el('span', { class: 'current' }, label)
        : el('button', { onclick: () => navigate(node.location ? { location: node.location.path, snapshot: null } : { folder: node.path }) }, label),
    ];
  }));
}

// Breadcrumbs for a location, continuing into the folder in scope
export function locationCrumbs(loc) {
  const crumbs = pathCrumbs(loc.path);
  if (!state.scope) return crumbs;
  // The location's own name becomes a link back to the whole location
  const last = crumbs.lastElementChild;
  last.replaceWith(el('button', { onclick: () => navigate({ scope: '' }) }, last.textContent));
  const parts = state.scope.split('/');
  parts.forEach((part, i) => {
    crumbs.append(el('span', {}, '\\'), i === parts.length - 1
      ? el('span', { class: 'current' }, part)
      : el('button', { onclick: () => navigate({ scope: parts.slice(0, i + 1).join('/') }) }, part));
  });
  return crumbs;
}

export function renderFolder(main) {
  const node = treeNodes.get(state.folder.toLowerCase());
  if (!node) {
    main.replaceChildren(el('div', { class: 'panel empty' }, `${state.folder} isn't a folder with backup locations in it.`));
    return;
  }
  // Like a location's page: the size and files of what's in it, then the space it takes on disk, all as of the
  // as-of date. The PC is the whole repository, whose exact size can be worked out.
  const { size, files } = latestSummary(node);
  // The storage chart isn't there with fewer than two locations to compare
  main.replaceChildren(...[
    el('section', { class: 'loc-head' },
      pathCrumbs(node.path),
      el('div', { class: 'meta' },
        el('span', {}, el('b', {}, formatSize(size))),
        el('span', {}, plural(files, 'file')),
        el('span', {}, node.root ? repositoryDiskText(treeTotal(node), true) : diskText(treeTotal(node)), ' on disk'))),
    renderContents(node),
    renderStorageChart(node),
  ].filter(Boolean));
}

export function renderMain() {
  const main = document.getElementById('main');
  if (state.folder) return renderFolder(main);
  const loc = storage.find(l => l.path === state.location);
  if (!loc) {
    main.replaceChildren(el('div', { class: 'panel empty' }, 'Pick a backup location on the left, or search for a path to see its history.'));
    return;
  }
  // A folder given a schedule of its own isn't backed up until its first snapshot
  if (!loc.snapshots.length) {
    main.replaceChildren(el('section', { class: 'loc-head' }, locationCrumbs(loc)), el('div', { class: 'panel empty' }, 'No snapshots yet'));
    return;
  }
  if (state.file) return renderFilePage(main, loc);
  const selected = selectedSnapshot(loc);

  // What's being looked at, at the snapshot being viewed: the folder's size and files, then for the
  // whole location its space on disk by then. The snapshot itself is named in the contents heading. With
  // nothing as old as the as-of date, that's the oldest, which this is all as of too.
  const here = folderSummary(loc, selected);
  const head = el('section', { class: 'loc-head' },
    locationCrumbs(loc),
    el('div', { class: 'meta' },
      here ? el('span', {}, el('b', {}, formatSize(here.size))) : null,
      here ? el('span', {}, plural(here.files, 'file')) : null,
      state.scope ? null : el('span', {}, `${diskText(selected.total)} on disk`),
      settingsStatus(loc)));

  // The folder as it was in the snapshot, to restore: its own modified time is in the listing of the
  // folder above it, or for the location, the snapshot's
  const complete = loc.snapshots.filter(s => !s.incomplete);
  const at = complete.indexOf(selected);
  const parts = state.scope ? state.scope.split('/') : [];
  const modified = !state.scope ? selected.mtime
    : snapshotListing(selected, parts.slice(0, -1).join('/'))?.find(e => e.n === parts[parts.length - 1] && e.t === 'd')?.m;
  const restore = restorePanel({
    selected, rel: state.scope, present: !!here, size: here?.size, what: 'folder', wide: true,
    facts: selected.incomplete ? [['Status', isCancelled(selected) ? 'Cancelled before it finished' : 'Still in progress']] : [
      ['Size', here ? formatSize(here.size) : notKnown()],
      ['Files', here ? plural(here.files, 'file') : notKnown()],
      ['Modified', modified ? `${formatFull(modified)}, ${timeAgo(modified)}` : notKnown()],
      ['In this snapshot', describeStep(at > 0 ? stepChange(complete[at - 1], selected, state.scope, true) : 'first', true)],
    ],
  });

  // What's in the folder at the snapshot picked in the right-hand panel, restoring it, its size across every
  // snapshot, then what changed in it, which can be long, and where the changes happen. The snapshots
  // themselves are on the right.
  // The size chart isn't there with too little to chart, such as a single snapshot
  main.replaceChildren(...[head, settingsWarning(loc), renderSnapshotContents(loc, selected), restore, renderSizeChart(loc),
    renderFileTypes(loc, selected), renderChanges(loc, selected), renderChurn(loc)].filter(Boolean));
}

// Size and file count of the folder in scope at a snapshot: the snapshot's own for the location's top,
// otherwise from the listing of the folder above it, or null if that wasn't captured
export function folderSummary(loc, snap) {
  if (snap.incomplete) return null;
  if (!state.scope) return { size: snap.size, files: snap.files };
  const parts = state.scope.split('/');
  const entry = snapshotListing(snap, parts.slice(0, -1).join('/'))?.find(e => e.n === parts[parts.length - 1] && e.t === 'd');
  return entry ? { size: entry.s, files: entry.f } : null;
}

// What's known about a file at a snapshot, from the folder listing where captured and from the diffs:
// whether it's there, its size and modified time, what changed since the snapshot before, and its history
export function fileInfo(loc, rel, selected) {
  const complete = loc.snapshots.filter(s => !s.incomplete);
  const at = complete.indexOf(selected);
  const name = rel.slice(rel.lastIndexOf('/') + 1);
  const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';

  // Each snapshot where it was added, modified or removed, oldest first
  const steps = [];
  let captured = true;
  for (let i = 1; i < complete.length; i++) {
    const change = stepChange(complete[i - 1], complete[i], rel, false);
    if (change === null) captured = false;
    else if (change.kind) steps.push({ snap: complete[i], ...change });
  }
  const upTo = steps.filter(s => complete.indexOf(s.snap) <= at);
  const lastStep = upTo[upTo.length - 1];
  const listing = snapshotListing(selected, parent);
  const entry = listing?.find(e => e.n === name && e.t === 'f');
  // There if it's listed, otherwise going by its last change; if it never changed, it was there all along
  const present = listing ? !!entry : lastStep ? !isGone(lastStep.kind) : !(steps[0]?.kind === '+');
  return {
    present, captured, steps,
    size: entry?.s ?? (lastStep && !isGone(lastStep.kind) ? lastStep.size : null),
    modified: entry?.m ?? null,
    here: at > 0 ? stepChange(complete[at - 1], selected, rel, false) : 'first',
    firstSeen: steps[0]?.kind === '+' ? steps[0].snap : null,
    lastChanged: [...steps].reverse().find(s => !isGone(s.kind))?.snap ?? null,
    snapshots: complete.length,
  };
}

// A file's own page: what it is at the snapshot being viewed, with its history in the snapshots panel
export function renderFilePage(main, loc) {
  const full = pathInScope(loc, state.file);
  const rel = relativeTo(loc, full);
  const selected = selectedSnapshot(loc);
  const crumbs = locationCrumbs(loc);
  // The folder it's in becomes a link back to that folder
  const last = crumbs.lastElementChild;
  last.replaceWith(el('button', { onclick: () => navigate({ file: null }) }, last.textContent));
  crumbs.append(el('span', {}, '\\'), el('span', { class: 'current' }, state.file));

  const info = fileInfo(loc, rel, selected);
  const when = snap => `${formatFull(snap.time)}, ${timeAgo(snap.time)}`;
  const changedIn = info.steps.filter(s => !isGone(s.kind)).length;
  // Back to the folder, with the file picked there so its row is highlighted
  const showInFolder = () => { ui.pickedRow = full; ui.pickedIsFolder = false; navigate({ file: null, history: full }); };

  main.replaceChildren(
    el('section', { class: 'loc-head' }, crumbs,
      el('div', { class: 'meta' },
        info.present && info.size != null ? el('span', {}, el('b', {}, formatSize(info.size))) : null,
        info.modified ? el('span', {}, `modified ${formatFull(info.modified)}`) : null,
        info.present ? null : el('span', { class: 'c-removed' }, 'Not in this snapshot'))),
    restorePanel({
      selected, rel, present: info.present, size: info.size, what: 'version',
      facts: [
        ...(info.present ? [
          ['Size', info.size != null ? formatSize(info.size) : notKnown()],
          ['Modified', info.modified ? `${formatFull(info.modified)}, ${timeAgo(info.modified)}` : notKnown()],
        ] : [['Status', el('span', { class: 'c-removed' }, 'Not in this snapshot')]]),
        ['In this snapshot', describeStep(info.here, false)],
        ['Changed in', info.captured ? `${changedIn} of ${plural(info.snapshots, 'snapshot')}` : notKnown()],
        ['First backed up', info.firstSeen ? when(info.firstSeen) : 'In the oldest snapshot still kept'],
        ['Last changed', info.lastChanged ? when(info.lastChanged) : info.captured ? 'Not since the oldest snapshot' : notKnown()],
      ],
      buttons: [el('button', { class: 'btn', onclick: showInFolder, title: 'Go to the folder it\'s in, here in the explorer' }, 'Go to folder')],
      note: 'Every snapshot where it changed, and how, is in the snapshots panel on the right.',
    }));
}

// The Restore panel on file and folder pages: what it was like in the snapshot being viewed, and a button
// to restore it as it was then. Folders' fewer facts go two to a row, to keep it short above the contents.
export function restorePanel({ selected, rel, present, size, what, facts, buttons = [], note = null, wide = false }) {
  const detail = ([label, value]) => [el('dt', {}, label), el('dd', {}, value)];
  const loc = storage.find(l => l.snapshots.includes(selected));
  const onDisk = rel ? `${loc.path.replace(/\\$/, '')}\\${rel.replaceAll('/', '\\')}` : loc.path;
  const explorerButton = el('button', {
    class: 'btn', title: `Open ${onDisk} in Windows Explorer, as it is now (or the nearest folder above it, if it's gone)`,
    onclick: () => showInExplorer(onDisk, explorerButton),
  }, 'Show in Explorer');
  return el('section', { class: 'panel' },
    el('div', { class: 'chart-head' },
      el('h2', {}, 'Restore'),
      el('span', { class: 'legend' }, `At ${formatFull(selected.time)}, ${timeAgo(selected.time)} (${shortId(selected.id)})`)),
    el('dl', { class: `facts${wide ? ' wide' : ''}` }, facts.map(detail)),
    el('div', { class: 'facts-actions' },
      el('button', {
        class: 'btn primary', disabled: !present || beingDeleted(selected),
        title: !present ? 'It isn\'t in this snapshot'
          : beingDeleted(selected) ? 'This snapshot is being deleted'
          : `${what === 'folder' ? 'Pick a folder to put it in' : 'Pick where to save it'}, keeping modified dates, as it was on ${formatFull(selected.time)}`,
        onclick: () => restoreItem(selected, rel, what === 'folder'),
      }, `Restore this ${what}${size != null ? ` (${formatSize(size)})` : ''}…`),
      explorerButton, buttons),
    note ? el('p', { class: 'note', style: 'margin:10px 0 0' }, note) : null);
}

// Contents of the folder in scope at the selected snapshot, like an Explorer window
export function renderSnapshotContents(loc, selected) {
  const node = treeNodes.get(loc.path.toLowerCase());
  const panel = el('section', { class: 'panel' });
  const head = el('div', { class: 'chart-head' },
    el('h2', {}, 'Contents'),
    el('span', { class: 'legend' }, `At ${formatFull(selected.time)}, ${timeAgo(selected.time)} (${shortId(selected.id)})`));
  if (selected.incomplete) {
    appendAll(panel, head, el('p', { class: 'note' }, `This snapshot ${unfinished(selected)}, so its contents aren't shown.`));
    return panel;
  }
  const entries = snapshotListing(selected, state.scope);
  if (entries === undefined) {
    // Not known: fall back to the locations nested inside, if there are any
    if (node && node.children.size && !state.scope && !pending.size) return renderContents(node);
    appendAll(panel, head, el('p', { class: 'note' }, notLoaded('folder listings')));
    return panel;
  }
  if (entries === null) {
    appendAll(panel, head, el('p', { class: 'note' }, 'This folder isn\'t in this snapshot.'));
    return panel;
  }

  // Up a folder: within the location while in a subfolder; from the top of a location that's inside
  // another, into the outer location at the folder containing it; otherwise to the folder page above
  const scopeParts = state.scope ? state.scope.split('/') : [];
  const above = node && parentNode(node);
  const outer = enclosingLocation(loc);
  const up = scopeParts.length
    ? { label: [loc.path.replace(/\\$/, ''), ...scopeParts.slice(0, -1)].join('\\'), go: () => navigate({ scope: scopeParts.slice(0, -1).join('/') }) }
    : outer ? { label: outer.parentPath, go: () => navigate({ location: outer.loc.path, snapshot: null, scope: outer.scope }) }
    : above ? { label: above.path, go: () => navigate(above.location ? { location: above.location.path, snapshot: null } : { folder: above.path }) } : null;

  const base = [loc.path.replace(/\\$/, ''), ...scopeParts].join('\\');
  const items = entries.map(entry => {
    const full = `${base}\\${entry.n}`;
    const nested = entry.t === 'd' ? treeNodes.get(full.toLowerCase())?.location : null;
    return {
      key: full, label: entry.n, folder: entry.t === 'd', location: nested,
      size: entry.s, files: entry.t === 'd' ? entry.f : null, modified: entry.m,
      pick: () => openHistory(entry.n, entry.t === 'd'),
      // Double click goes into it: a nested location, a folder, or a file's own page
      open: nested ? () => navigate({ location: nested.path, snapshot: null })
        : entry.t === 'd' ? () => navigate({ scope: [...scopeParts, entry.n].join('/') })
        : () => navigate({ file: entry.n }),
    };
  });
  return contentsTable(`At ${formatFull(selected.time)}, ${timeAgo(selected.time)} (${shortId(selected.id)})`, up, items,
    () => renderSnapshotContents(loc, selected));
}

// Copying a path from the breadcrumbs gives it on one line, as it's shown: its parts are separate elements,
// which would otherwise copy as a line each
document.addEventListener('copy', event => {
  const selection = document.getSelection();
  const crumbsOf = node => (node?.nodeType === Node.TEXT_NODE ? node.parentElement : node)?.closest('.crumbs');
  if (!selection.rangeCount || !crumbsOf(selection.anchorNode)) return;
  event.clipboardData.setData('text/plain', selection.toString().replace(/\s*\n\s*/g, ''));
  event.preventDefault();
});
