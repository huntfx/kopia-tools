// What kinds of file a folder holds: each type's files and size at a snapshot, counting everything inside it.
// Clicking one narrows the page to files of that type.
import { api, notLoaded } from './data.js';
import { el, formatFull, formatSize, plural, shortId } from './format.js';
import { navigate, state } from './state.js';
import { folderObj } from './storage.js';
import { sortRows, sortableHead, tableSorts } from './tables.js';

// A type's name: its extension, or for files without one, saying so
export const typeName = extension => extension || 'No extension';

// A file's type, as the server counts them: its extension in lower case, or '' for none, including a name
// starting with a dot, like .gitignore
export function extensionOf(path) {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
}

// Whether a path, with / separators and folders ending in one, is a file of the type the page is narrowed to, if
// it's narrowed to one
export const ofType = path => state.type == null || (!path.endsWith('/') && extensionOf(path) === state.type);

// Files of a type in words, like ".zip files"
export const typeFiles = extension => (extension ? `${extension} files` : 'files with no extension');

// The page narrowed to a type, at the top: how much of it there is in here at the snapshot being viewed, and
// a way back to every type
export function typeFilter(selected) {
  if (state.type == null) return null;
  const obj = !selected.incomplete && folderObj(selected, state.scope);
  const counts = obj ? api.types(obj)?.[state.type] : null;
  return el('span', { class: 'type-filter' },
    'Only ', state.type ? [el('span', { class: 'mono' }, state.type), ' files'] : 'files with no extension',
    counts ? `: ${formatSize(counts[1])} in ${plural(counts[0], 'file')}` : '',
    el('button', { class: 'linklike', title: 'Show every type of file', onclick: () => navigate({ type: null }) }, '×'));
}

// The biggest types are shown, with the rest a click away, kept while moving around the page
const SHOWN = 12;
let showAll = false;

// The folder in scope's file types at the snapshot being viewed, biggest first, with each one's share of the size
export function renderFileTypes(loc, selected) {
  if (selected.incomplete) return null;
  const obj = folderObj(selected, state.scope);
  if (obj === null) return null;
  const tally = obj && api.types(obj);
  const head = legend => el('div', { class: 'chart-head' }, el('h2', {}, 'File types'), legend ? el('span', { class: 'legend' }, legend) : null);
  if (!tally) return el('section', { class: 'panel' }, head(), el('p', { class: 'note' }, notLoaded(obj ? 'file types' : 'folder listings')));
  const types = Object.entries(tally).map(([extension, [files, size]]) => ({ extension, name: typeName(extension), files, size }));
  if (!types.length) return null;
  const total = types.reduce((sum, t) => sum + t.size, 0);

  const columns = [
    { key: 'name', label: 'Type', value: t => t.name },
    { key: 'files', label: 'Files', value: t => t.files, desc: true },
    { key: 'size', label: 'Size', value: t => t.size, desc: true },
  ];
  const sorted = sortRows(types, tableSorts.types, columns, () => false, t => t.name);
  // The type the page is narrowed to always shows
  const shown = showAll ? sorted : sorted.filter((t, i) => i < SHOWN || t.extension === state.type);
  const share = t => (total ? 100 * t.size / total : 0);
  const panel = el('section', { class: 'panel' },
    head(`${plural(types.length, 'type')} at ${formatFull(selected.time)} (${shortId(selected.id)}), counting everything in here`),
    el('div', { class: 'table-wrap' },
      el('table', { class: 'file-types' },
        sortableHead(tableSorts.types, columns, () => panel.replaceWith(renderFileTypes(loc, selected))),
        el('tbody', {}, shown.map(t => {
          const picked = t.extension === state.type;
          return el('tr', {
            class: `type-row${picked ? ' picked' : ''}`,
            title: picked ? 'Click to show every type of file again' : `Click to show only ${typeFiles(t.extension)} on this page`,
            onclick: () => navigate({ type: picked ? null : t.extension }),
          },
          el('td', {}, el('span', { class: t.extension ? 'mono' : 'muted' }, t.name)),
          el('td', { class: 'num' }, plural(t.files, 'file')),
          el('td', { class: 'num' },
            el('span', { class: 'share', title: `${share(t).toFixed(1)}% of the size in here` },
              el('span', { class: 'fill', style: `width:${share(t)}%` })),
            formatSize(t.size)));
        }),
        // The rest a click away, as the table's last row, as it runs to the bottom of the panel
        sorted.length > SHOWN ? el('tr', {}, el('td', { colspan: 3 }, el('button', {
          class: 'linklike', onclick: () => { showAll = !showAll; panel.replaceWith(renderFileTypes(loc, selected)); },
        }, showAll ? 'Show fewer' : `Show all ${sorted.length}`))) : null))));
  return panel;
}
