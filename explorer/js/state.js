// What the page shows, kept in the URL so back and bookmarks work, and going somewhere
import { changeFolders } from './changes.js';
import { render } from './render.js';
import { reveal } from './sidebar.js';
import { renderSide } from './snapshots.js';
import { currentFolder } from './storage.js';

// The middle shows either a backup location or a plain folder above locations, never both.
// scope is a folder inside the location (with / separators), which narrows everything shown to it,
// and file is a file in that folder whose own page is shown instead.
// The right-hand panel lists the location's snapshots for the folder or file being looked at, or for
// history, a path picked with a single click, until moving somewhere else. A path backed up in more than one
// location has its snapshots from the one open in the middle, or via, another picked for the panel.
export const state = {
  location: null, folder: null, scope: '', file: null, snapshot: null, compare: null, history: null, via: null,
  // * is for things that only existed between two snapshots compared, which are always shown, greyed out;
  // i (⊘) is for things that went from one snapshot to the next because kopia's ignore rules leave them out.
  // Files whose modified date changed but not their contents (d, •) go with modified ones (~).
  filters: { '+': true, '-': true, '~': true, '*': true, i: true }, filterText: '',
};

export function readHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  state.location = params.get('loc');
  state.folder = state.location ? null : params.get('dir');
  state.scope = state.location ? params.get('in') || '' : '';
  state.file = state.location ? params.get('file') : null;
  state.snapshot = params.get('snap');
  state.compare = params.get('cmp');
  state.history = params.get('hist');
  state.via = params.get('via');
  state.asOf = params.get('at');
}

export function writeHash(replace = false) {
  const params = new URLSearchParams();
  if (state.location) params.set('loc', state.location);
  if (state.scope) params.set('in', state.scope);
  if (state.file) params.set('file', state.file);
  if (state.folder) params.set('dir', state.folder);
  if (state.snapshot) params.set('snap', state.snapshot);
  if (state.compare) params.set('cmp', state.compare);
  if (state.history) params.set('hist', state.history);
  if (state.via) params.set('via', state.via);
  if (state.asOf) params.set('at', state.asOf);
  const hash = '#' + params.toString();
  if (hash !== location.hash) (replace ? history.replaceState(null, '', hash) : history.pushState(null, '', hash));
}

export function navigate(changes, replace = false) {
  // Picking something for the right-hand panel leaves the rest of the page alone, so expanded folders and scrolling stay put
  if (Object.keys(changes).every(key => key === 'history' || key === 'via')) {
    Object.assign(state, changes);
    writeHash(replace);
    renderSide();
    return;
  }
  // A new as-of date applies everywhere, replacing any snapshot picked by hand
  if ('asOf' in changes) {
    changes.snapshot = null;
    changes.compare = null;
  }
  // A file's own page is left when moving to another folder, but not when picking another snapshot of it
  if (!('file' in changes) && ['location', 'folder', 'scope'].some(key => key in changes)) changes.file = null;
  if (changes.location) changes.folder = null;
  // Going to a location without naming a folder in it goes to its top, even if it's the location already open
  if (changes.location && !('scope' in changes)) changes.scope = '';
  if (changes.folder) {
    changes.location = null;
    changes.snapshot = null;
  }
  if (changes.location && changes.location !== state.location) {
    // The folder in scope, filters and opened folders belong to the old location
    if (!('scope' in changes)) changes.scope = '';
    if (!('filterText' in changes)) changes.filterText = '';
    changeFolders.clear();
  }
  if (changes.folder) changes.scope = '';
  // Opened folders in the changes tree are relative to the scope, so they don't carry over
  if ('scope' in changes && changes.scope !== state.scope) changeFolders.clear();
  // Picking another snapshot or location goes back to comparing with the previous snapshot
  if (('snapshot' in changes || 'location' in changes) && !('compare' in changes)) changes.compare = null;
  const moved = !('history' in changes) && ['location', 'folder', 'scope', 'file'].some(key => key in changes);
  Object.assign(state, changes);
  // The sidebar opens down to wherever you go, and the snapshots panel goes back to following it
  if (moved) {
    reveal(currentFolder());
    state.history = null;
    state.via = null;
  }
  writeHash(replace);
  render();
}

window.addEventListener('popstate', () => {
  readHash();
  reveal(currentFolder());
  render();
});

// What isn't kept in the URL: the row last clicked, highlighted until something else is; whether the path
// picked for the snapshots panel is a folder, when it was picked by clicking something that knows; and whether
// locations with nothing as old as the as-of date are included, at their oldest snapshot, rather than hidden,
// which the as-of picker remembers in this browser
export const ui = { pickedRow: null, pickedIsFolder: true, includeOldest: false };
