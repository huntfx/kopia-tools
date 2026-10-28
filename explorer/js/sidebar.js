// The sidebar: the tree of backup locations, or them listed by size or name
import { DATA, repositoryTitle } from './data.js';
import { el, formatSize, gradientPositions, gradientRgb, textColour } from './format.js';
import { renderMatches, sidebarFilter } from './search.js';
import { navigate, state } from './state.js';
import { asOfSnapshot, backingUpNow, currentFolder, hiddenAsOf, locationOf, selectedSnapshot, snapshotListing, storage, totalAsOf } from './storage.js';

// Build a folder tree from the backup locations: the PC at the top, named after the computer the
// snapshots were taken on, then its drives, with locations nested inside each other
export const treeNodes = new Map();  // Every folder in the tree by lower-cased path, for looking up a folder page

export function buildLocationTree() {
  const hosts = [...new Set(storage.map(loc => loc.host).filter(Boolean))];
  const name = hosts.length === 1 ? hosts[0] : DATA.repository?.description || 'This PC';
  const root = { name, path: name, children: new Map(), root: true };
  treeNodes.set(name.toLowerCase(), root);
  for (const loc of storage) {
    const parts = loc.path.split('\\').filter(Boolean);
    let node = root;
    parts.forEach((part, i) => {
      if (!node.children.has(part)) {
        const path = i === 0 ? `${part}\\` : parts.slice(0, i + 1).join('\\');
        const child = { name: i === 0 ? `${part}\\` : part, path, children: new Map(), drive: i === 0 };
        node.children.set(part, child);
        treeNodes.set(path.toLowerCase(), child);
      }
      node = node.children.get(part);
    });
    node.location = loc;
  }
  return root;
}

// Every location at or below a folder, for counts and the latest snapshot
export function locationsBelow(node) {
  const found = node.location ? [node.location] : [];
  for (const child of node.children.values()) found.push(...locationsBelow(child));
  return found;
}

// Whether a folder in the tree has any location in it that isn't hidden for being newer than the as-of date
export const shownBelow = node => locationsBelow(node).some(l => !hiddenAsOf(l));

// On-disk total of a folder: its own if it's a location, otherwise the locations below it,
// skipping locations nested inside another so they aren't counted twice
export function treeTotal(node) {
  if (node.location) return totalAsOf(node.location);
  let total = 0;
  for (const child of node.children.values()) {
    const inside = treeTotal(child);
    // Not known until a location's storage stats are
    if (inside == null) return null;
    total += inside;
  }
  return total;
}

// A size on disk, or … while it's being worked out
export const diskText = size => (size == null ? '…' : formatSize(size));

// Folders that aren't locations and lead to a single folder are merged into one row
export function compactFolder(node) {
  const names = [node.name];
  while (!node.location && !node.drive && !node.root && node.children.size === 1) {
    const [only] = node.children.values();
    node = only;
    names.push(node.name);
  }
  // The last folder is what matters, so the path leading to it is shown dimmed before it
  const prefix = names.slice(0, -1).map(n => n + '\\').join('');
  return { node, prefix, label: names[names.length - 1] };
}

// Built again when a location's added, such as a folder backed up on its own
export let locationTree;

// Folders above the locations start open, so the tree shows every location; closed ones are kept here.
// Locations and the folders inside them start closed, so it isn't swamped; opened ones are kept here.
export const collapsedFolders = new Set();

export const openFolders = new Set();

// Open the folders above a path, so it shows and is highlighted in the sidebar, without listing its own
// contents. In the lists by size or name, each location is a row of its own, so only folders inside the
// path's own location are opened, not the locations it's nested in; switching to the tree opens those.
export function reveal(path) {
  if (!path) return;
  collapsedFolders.delete(locationTree.path);
  const owner = sidebarSort === 'tree' ? null : locationOf(path)?.path.replace(/\\$/, '').toLowerCase();
  const parts = path.replace(/\\$/, '').split('\\');
  for (let i = 1; i < parts.length; i++) {
    const sub = i === 1 ? `${parts[0]}\\` : parts.slice(0, i).join('\\');
    const key = sub.toLowerCase();
    collapsedFolders.delete(sub);
    if (!owner || key === owner || key.startsWith(`${owner}\\`)) openFolders.add(key);
  }
}

// Colour every folder's total on one scale, so colours don't shift as folders are expanded. It's worked
// out again whenever the sidebar's drawn, as the totals change with the as-of date and new snapshots.
export function treeScale() {
  const totals = [];
  (function collectTotals(node) {
    for (const child of node.children.values()) {
      totals.push(treeTotal(child));
      collectTotals(child);
    }
  })(locationTree);
  return gradientPositions(totals.filter(Boolean));
}

export let treePositions;

// The tree and its colour scale, built when the page starts, and again when the snapshots change
export function buildSidebarTree() {
  treeNodes.clear();
  locationTree = buildLocationTree();
  rescaleTree();
}
export function rescaleTree() {
  treePositions = treeScale();
}

// How the sidebar is sorted, remembered in this browser. Clicking the current sort again reverses it.
export const SORTS = { tree: 'Folders', size: 'Size', name: 'Name' };

// Size starts largest first, the others A–Z
export const DESCENDING_BY_DEFAULT = { tree: false, size: true, name: false };

export let sidebarSort = 'tree';

export let sidebarReversed = false;

try {
  if (SORTS[localStorage.getItem('sidebarSort')]) sidebarSort = localStorage.getItem('sidebarSort');
  sidebarReversed = localStorage.getItem('sidebarReversed') === '1';
} catch {}

export function renderSort() {
  document.getElementById('sort').replaceChildren(...Object.entries(SORTS).map(([key, label]) => {
    const active = key === sidebarSort;
    const descending = DESCENDING_BY_DEFAULT[key] !== (active && sidebarReversed);
    return el('button', {
      'aria-pressed': String(active),
      title: active ? 'Click again to reverse' : `Sort by ${label.toLowerCase()}`,
      onclick: () => {
        if (active) sidebarReversed = !sidebarReversed;
        else { sidebarSort = key; sidebarReversed = false; }
        // The tree shows what's open through the locations above it, which the lists leave closed
        if (sidebarSort === 'tree') reveal(currentFolder());
        try {
          localStorage.setItem('sidebarSort', sidebarSort);
          localStorage.setItem('sidebarReversed', sidebarReversed ? '1' : '0');
        } catch {}
        renderSort();
        renderLocations();
      },
    }, active ? `${label} ${descending ? '▼' : '▲'}` : label);
  }));
}

/* Sidebar items. Above the locations, folders come from the tree of locations. Inside a location,
   its folders come from the snapshot being looked at (or its latest), with locations nested inside it
   slotted in among them. Each item knows the location it's in (owner) and its path there (rel). */

export const joinRel = (rel, name) => (rel ? `${rel}/${name}` : name);

// The snapshot a location's folders are read from: the one selected if it's open, otherwise its latest
export function sidebarSnapshot(loc) {
  const snap = loc.path === state.location ? selectedSnapshot(loc) : asOfSnapshot(loc);
  // None for a location that hasn't been backed up yet
  return snap?.incomplete ? [...loc.snapshots].reverse().find(s => !s.incomplete) : snap;
}

export const treeItem = node => node.location
  ? { name: node.name, path: node.path, tree: node, owner: node.location, rel: '' }
  : { name: node.name, path: node.path, tree: node, owner: null, rel: '' };

// The folders shown inside an item. Listings only load once it's opened, so until then it's marked
// as maybe having some, to show it can be expanded.
export function sidebarChildren(item) {
  const children = new Map();
  let unknown = false;
  if (item.owner) {
    const snap = sidebarSnapshot(item.owner);
    const entries = snap && snapshotListing(snap, item.rel, isOpen(item));
    unknown = !!snap && entries === undefined;
    for (const entry of entries || []) {
      if (entry.t !== 'd') continue;
      children.set(entry.n.toLowerCase(), {
        name: entry.n, path: `${item.path.replace(/\\$/, '')}\\${entry.n}`, tree: null,
        owner: item.owner, rel: joinRel(item.rel, entry.n), size: entry.s,
      });
    }
  }
  for (const child of item.tree?.children.values() || []) {
    if (!shownBelow(child)) continue;
    const key = child.name.toLowerCase();
    // A nested location is its own owner; other folders on the way to one belong to the location they're in
    children.set(key, child.location ? treeItem(child) : {
      name: child.name, path: child.path, tree: child, owner: item.owner,
      rel: item.owner ? joinRel(item.rel, child.name) : '', size: children.get(key)?.size,
    });
  }
  return Object.assign([...children.values()], { unknown });
}

// Whether an item is open: folders above the locations unless closed, locations and folders inside them if opened
export const isOpen = item => item.owner ? openFolders.has(item.path.toLowerCase()) : !collapsedFolders.has(item.path);

export function toggleOpen(item) {
  if (item.owner) {
    const key = item.path.toLowerCase();
    openFolders.has(key) ? openFolders.delete(key) : openFolders.add(key);
  } else {
    collapsedFolders.has(item.path) ? collapsedFolders.delete(item.path) : collapsedFolders.add(item.path);
  }
  renderLocations();
}

// Close an item and everything inside it: locations and their folders by forgetting they were opened,
// and the folders above locations, which start open, by marking them closed
export function collapseAll(item) {
  const path = item.path.replace(/\\$/, '').toLowerCase();
  // Everything is inside the PC
  const inside = key => item.tree?.root || key.replace(/\\$/, '') === path || key.startsWith(`${path}\\`);
  for (const key of [...openFolders]) if (inside(key)) openFolders.delete(key);
  for (const node of treeNodes.values()) {
    if (!node.location && node.children.size && inside(node.path.toLowerCase())) collapsedFolders.add(node.path);
  }
  renderLocations();
}

// Highlighted when it's what's shown in the middle
export function isCurrent(item) {
  if (item.tree?.location) return state.location === item.tree.location.path && !state.scope;
  if (item.owner) return state.location === item.owner.path && state.scope === item.rel;
  return state.folder === item.path;
}

// Where clicking an item goes; within the location already open, the selected snapshot is kept
export function itemTarget(item) {
  if (item.tree?.location) {
    const path = item.tree.location.path;
    return state.location === path ? { location: path } : { location: path, snapshot: null };
  }
  if (item.owner) return state.location === item.owner.path ? { scope: item.rel } : { location: item.owner.path, snapshot: null, scope: item.rel };
  return { folder: item.path };
}

export function renderLocations() {
  if (sidebarFilter) return renderMatches();
  // The sizes, and so their colours, are as of the as-of date
  rescaleTree();
  document.getElementById('sum').textContent = `${storage.filter(l => !hiddenAsOf(l)).length} locations · ${diskText(treeTotal(locationTree))} on disk`;
  const direction = sidebarReversed ? -1 : 1;
  const rows = [];
  // In the flat lists the direction is for size or path, so what's inside a location is always A–Z
  const nameDirection = sidebarSort === 'tree' ? direction : 1;
  const sorted = items => items.sort((a, b) => nameDirection * a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));

  // A row for an item, with label parts given: the path leading to it dimmed, then its own name
  const row = (item, depth, prefix, label, children) => {
    const loc = item.tree?.location;
    const expandable = children.length > 0 || children.unknown;
    const open = expandable && isOpen(item);
    // Sizes on disk for locations and the folders above them; plain sizes, greyed, for folders inside
    const onDisk = item.tree && (loc || !item.owner);
    const total = onDisk ? treeTotal(item.tree) : null;
    rows.push(el('div', {
      class: `fsrow${loc ? '' : ' group'}`, 'aria-current': isCurrent(item) ? 'true' : 'false',
      style: `padding-left:${6 + depth * 12}px`,
    },
      expandable
        ? el('button', { class: 'twisty', 'aria-expanded': String(open), 'aria-label': `${open ? 'Collapse' : 'Expand'} ${label}`, onclick: () => toggleOpen(item) }, open ? '▾' : '▸')
        : el('span'),
      // A click opens it in the middle; a double click expands or collapses it. The first click redraws
      // the sidebar, so the second is recognised by its click count rather than a dblclick event.
      el('button', {
        class: 'label', title: `${loc ? `${loc.path} (backup location)` : item.tree?.root ? repositoryTitle() : item.path}${expandable ? ' · double-click to expand or collapse' : ''}`,
        onclick: event => {
          if (event.detail < 2) navigate(itemTarget(item));
          // Collapsing this way closes everything inside it too, so it opens again one level at a time
          else if (open) collapseAll(item);
          else if (expandable) toggleOpen(item);
        },
      },
        loc ? el('span', { class: 'dot', 'aria-hidden': 'true' }) : null,
        prefix ? el('span', { class: 'prefix' }, prefix) : null,
        // Folders end in a backslash, like drives and the contents tables; the PC isn't a folder
        el('span', { class: 'text' }, item.tree?.root || label.endsWith('\\') ? label : `${label}\\`),
        loc && backingUpNow(loc) ? el('span', { class: 'badge', title: 'A snapshot is in progress' }, 'Live') : null),
      // The PC's total is everything, so it's left off the colour scale
      onDisk && total == null ? el('span', { class: 'total muted', title: 'Working out space on disk…' }, '…')
        : total != null
          ? el('span', { class: 'total', style: total && !item.tree.root ? `color:${textColour(gradientRgb(treePositions.get(total)))}` : null }, formatSize(total))
          : el('span', { class: 'total muted' }, item.size != null ? formatSize(item.size) : '')));
    if (open) for (const child of sorted(children)) walk(child, depth + 1);
  };

  const walk = (item, depth) => {
    // Folders above the locations that only lead to one folder are merged into one row
    if (!item.owner && item.tree && !item.tree.drive && !item.tree.root && !item.tree.location) {
      const { node, prefix, label } = compactFolder(item.tree);
      const merged = treeItem(node);
      return row(merged, depth, prefix, label, sidebarChildren(merged));
    }
    row(item, depth, '', item.name, sidebarChildren(item));
  };

  if (sidebarSort === 'tree') {
    walk(treeItem(locationTree), 0);
  } else {
    // Every location as a top-level row with its full path, each expandable like in the tree
    const locations = storage.filter(l => !hiddenAsOf(l)).sort(sidebarSort === 'size'
      ? (a, b) => direction * (totalAsOf(b) - totalAsOf(a))
      : (a, b) => direction * a.path.localeCompare(b.path, 'en', { sensitivity: 'base' }));
    for (const loc of locations) {
      const item = treeItem(treeNodes.get(loc.path.toLowerCase()));
      const cut = loc.path.replace(/\\$/, '').lastIndexOf('\\') + 1;
      row(item, 0, cut ? loc.path.slice(0, cut) : '', loc.path.slice(cut) || loc.path, sidebarChildren(item));
    }
  }
  document.getElementById('locations').replaceChildren(...rows);
}
