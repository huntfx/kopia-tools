// The sidebar's box, which filters or goes to a path, and adding a backup location
import { api } from './data.js';
import { el, formatSize } from './format.js';
import { scheduleDialog } from './schedules.js';
import { diskText, joinRel, renderLocations, treeNodes } from './sidebar.js';
import { realCase } from './snapshots.js';
import { navigate } from './state.js';
import { asOfSnapshot, hiddenAsOf, locationOf, relativeTo, snapshotListing, storage, totalAsOf } from './storage.js';

// Go to a typed path: into its folder in the location that contains it, or a folder page above locations
export function goToPath(typed) {
  // Paths can be typed with forward slashes or doubled ones, and a drive on its own, like A:
  let path = typed.trim().replaceAll('/', '\\').replace(/\\{2,}/g, '\\').replace(/\\$/, '');
  if (/^[a-z]:$/i.test(path)) path += '\\';
  const loc = locationOf(path);
  if (loc) {
    // A file opens its own page in the folder it's in; anything else is taken as a folder
    const rel = realCase(loc, relativeTo(loc, path));
    const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    const name = rel.slice(rel.lastIndexOf('/') + 1);
    const entry = rel && asOfSnapshot(loc) && snapshotListing(asOfSnapshot(loc), parent)?.find(e => e.n.toLowerCase() === name.toLowerCase());
    if (entry?.t === 'f') return navigate({ location: loc.path, snapshot: null, scope: parent, file: entry.n });
    return navigate({ location: loc.path, snapshot: null, scope: rel });
  }
  const node = treeNodes.get(path.toLowerCase()) || treeNodes.get(`${path}\\`.toLowerCase());
  if (node) return navigate(node.location ? { location: node.location.path, snapshot: null } : { folder: node.path });
  const input = document.getElementById('search-input');
  input.setCustomValidity(`${path} isn't in any backup location`);
  input.reportValidity();
  input.addEventListener('input', () => input.setCustomValidity(''), { once: true });
}

// A path starting with a drive is one to go to; anything else filters, including part of a path, such as
// Documents\Code copied from the top of a page
export const looksLikePath = text => /^[a-z]:/i.test(text);

export let sidebarFilter = '';

// What a filter is looked for in: with a slash, it's part of a path, matched against the full path up to
// and into its last folder or file, so it finds what it names rather than everything inside; otherwise names
export function filterQuery(query) {
  const q = query.toLowerCase().replaceAll('/', '\\').replace(/^\\+|\\+$/g, '');
  const byPath = q.includes('\\');
  return {
    q, byPath, last: byPath ? q.slice(q.lastIndexOf('\\') + 1) : q,
    matches: (name, path) => {
      if (!byPath) return name.toLowerCase().includes(q);
      const lower = path.toLowerCase().replace(/\\$/, '');
      const at = lower.lastIndexOf(q);
      return at >= 0 && at + q.length > lower.lastIndexOf('\\');
    },
  };
}

// Matches for a filter: backup locations by path, then folders and files by name (or path) from each
// location's snapshot for the as-of date, as far as their listings are known
export function findMatches(query) {
  const { q, matches, byPath } = filterQuery(query);
  const results = new Map();
  // Not locations hidden for being newer than the as-of date
  const shown = storage.filter(l => !hiddenAsOf(l));
  for (const loc of shown) {
    if (byPath ? matches(loc.path, loc.path) : loc.path.toLowerCase().includes(q)) {
      results.set(loc.path.toLowerCase(), { kind: 'location', loc, path: loc.path, name: loc.path });
    }
  }
  for (const loc of shown) {
    const snap = asOfSnapshot(loc);
    if (!snap || snap.incomplete) continue;
    const base = loc.path.replace(/\\$/, '');
    const walk = rel => {
      // Only what's loaded already, as loading everything to search it would crawl the whole repository
      for (const entry of snapshotListing(snap, rel, false) || []) {
        const inside = joinRel(rel, entry.n);
        const path = `${base}\\${inside.replaceAll('/', '\\')}`;
        if (matches(entry.n, path) && !results.has(path.toLowerCase())) {
          results.set(path.toLowerCase(), { kind: entry.t === 'd' ? 'folder' : 'file', loc, rel: inside, path, name: entry.n, size: entry.s });
        }
        if (entry.t === 'd') walk(inside);
      }
    };
    walk('');
  }
  // Locations, then folders, then files, each by path
  const order = { location: 0, folder: 1, file: 2 };
  return [...results.values()].sort((a, b) => order[a.kind] - order[b.kind] || a.path.localeCompare(b.path, 'en', { sensitivity: 'base' }));
}

export function openMatch(match) {
  if (match.kind === 'location') return navigate({ location: match.loc.path, snapshot: null });
  const parent = match.rel.includes('/') ? match.rel.slice(0, match.rel.lastIndexOf('/')) : '';
  if (match.kind === 'folder') return navigate({ location: match.loc.path, snapshot: null, scope: match.rel });
  return navigate({ location: match.loc.path, snapshot: null, scope: parent, file: match.name });
}

// The text with the part matching the filter marked
export function highlight(text, query) {
  const at = text.toLowerCase().lastIndexOf(query.toLowerCase());
  if (at < 0) return [text];
  return [text.slice(0, at), el('mark', {}, text.slice(at, at + query.length)), text.slice(at + query.length)];
}

// The sidebar while filtering: a flat list of matches instead of the tree
export function renderMatches() {
  const matches = findMatches(sidebarFilter);
  // Part of a path marks where it ends, in the name
  const { byPath, last } = filterQuery(sidebarFilter);
  const marked = byPath ? last : sidebarFilter;
  const limit = 100;
  document.getElementById('sum').replaceChildren(
    `${matches.length.toLocaleString('en-GB')} ${matches.length === 1 ? 'match' : 'matches'} for `, el('b', {}, `“${sidebarFilter}”`), ' · ',
    el('button', { class: 'linklike', onclick: () => clearFilter() }, 'Clear'));
  document.getElementById('locations').replaceChildren(...matches.slice(0, limit).map(match => {
    const cut = match.path.replace(/\\$/, '').lastIndexOf('\\') + 1;
    const own = match.kind === 'location' ? match.path.slice(cut) || match.path : match.name;
    return el('div', { class: `fsrow${match.kind === 'location' ? '' : ' group'}`, style: 'padding-left:6px' },
      el('span'),
      el('button', { class: 'label', title: match.path, onclick: () => { clearFilter(); openMatch(match); } },
        match.kind === 'location' ? el('span', { class: 'dot', 'aria-hidden': 'true' }) : null,
        cut ? el('span', { class: 'prefix' }, match.kind === 'location' && !byPath ? highlight(match.path.slice(0, cut), marked) : match.path.slice(0, cut)) : null,
        el('span', { class: 'text' }, highlight(own + (match.kind !== 'file' && !own.endsWith('\\') ? '\\' : ''), marked))),
      el('span', { class: 'total muted' }, match.kind === 'location' ? diskText(totalAsOf(match.loc)) : formatSize(match.size)));
  }), ...(matches.length > limit ? [el('div', { class: 'more', style: 'padding:4px 16px' }, `…and ${matches.length - limit} more`)] : []),
  ...(matches.length ? [] : [el('p', { class: 'note', style: 'padding:0 16px' }, 'Nothing matches. Paste a full path to go straight to it.')]));
}

export function clearFilter() {
  sidebarFilter = '';
  document.getElementById('search-input').value = '';
  renderLocations();
}

// Adding a backup location: a folder picked in a folder picker, which the server opens, then how often to
// back it up. One that's already a location is gone to instead.
export const addButton = document.getElementById('add-location');

addButton.addEventListener('click', async () => {
  addButton.disabled = true;
  addButton.textContent = 'Choosing…';
  let picked = null;
  try {
    ({ path: picked } = await api.post('/api/pick-folder', {}));
  } catch (error) {
    addButton.textContent = `Couldn't open the picker: ${error instanceof TypeError ? 'can\'t reach the server' : error.message}`;
    await new Promise(resolve => setTimeout(resolve, 4000));
  }
  addButton.disabled = false;
  addButton.textContent = 'Add location…';
  if (!picked) return;
  const loc = storage.find(l => l.path.toLowerCase() === picked.toLowerCase());
  if (loc) return navigate({ location: loc.path, snapshot: null });
  scheduleDialog(picked, 'new');
});

export const searchInput = document.getElementById('search-input');

searchInput.addEventListener('input', () => {
  const text = searchInput.value.trim();
  sidebarFilter = looksLikePath(text) ? '' : text;
  renderLocations();
});

searchInput.addEventListener('keydown', event => { if (event.key === 'Escape') clearFilter(); });

document.getElementById('search').addEventListener('submit', event => {
  event.preventDefault();
  const text = searchInput.value.trim().replace(/[\\/]+$/, '');
  if (!text) return;
  if (looksLikePath(text)) {
    goToPath(text);
    return;
  }
  // Words open the first match
  const [first] = findMatches(text);
  if (first) {
    clearFilter();
    openMatch(first);
  }
});
