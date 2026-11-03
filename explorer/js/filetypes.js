// What kinds of file a folder holds: each type's files and size at a snapshot, counting everything inside it,
// as another view of the Contents box. Double-clicking one adds it to the filter, or takes it out.
import { api, notLoaded } from './data.js';
import { hasPattern, matchingFiles, patterns, togglePattern } from './filter.js';
import { el, formatSize, plural } from './format.js';
import { state } from './state.js';
import { folderObj } from './storage.js';
import { SHOWN, showAllRow, sortRows, sortableHead, tableSorts, upTableRow } from './tables.js';

// A type's name: its extension, or for files without one, saying so
export const typeName = extension => extension || 'No extension';

// A type in the filter, which matches it exactly, with ext: by itself for files without an extension
const typePattern = extension => `ext:${extension}`;

// What double-clicking a type does to the filter
export function typeHint(extension, click) {
  const files = extension ? `${extension} files` : 'files without an extension';
  if (hasPattern(typePattern(extension))) return state.match.length > 1 ? `${click} to stop showing ${files}` : `${click} to show every file again`;
  return state.match.length ? `${click} to show ${files} too` : `${click} to show only ${files}`;
}

export const toggleTypeFilter = extension => togglePattern(typePattern(extension));

// The folder in scope's file types at the snapshot being viewed, as the Contents box's other view: each one's size,
// with its share of the whole, and files, counting everything in here, below the same row going up a folder.
// With a filter, only the files it lets through count. Double-clicking one adds its extension to the filter, or
// takes it out, like its band in the size chart, and ones in it are picked out. Only the first few are listed, as
// in the other view, with the rest a click away, kept while moving around the page.
let showAll = false;

export function typesTable(selected, up, rerender) {
  const obj = folderObj(selected, state.scope);
  const tally = obj && api.types(obj, patterns(), state.scope);
  if (!tally) return el('p', { class: 'note' }, notLoaded(obj ? 'file types' : 'folder listings'));
  const types = Object.entries(tally).map(([extension, [files, size]]) => ({ extension, name: typeName(extension), files, size }));
  const total = types.reduce((sum, t) => sum + t.size, 0);
  const share = t => (total ? 100 * t.size / total : 0);

  // In the same order as the other view's columns
  const columns = [
    { key: 'name', label: 'Type', value: t => t.name },
    { key: 'size', label: 'Size', value: t => t.size, desc: true },
    { key: 'files', label: 'Files', value: t => t.files, desc: true },
  ];
  const sorted = sortRows(types, tableSorts.types, columns, () => false, t => t.name);
  // Ones in the filter always show here
  const listed = showAll ? sorted : sorted.filter((t, i) => i < SHOWN || hasPattern(typePattern(t.extension)));
  return el('div', { class: 'table-wrap' },
    el('table', { class: 'file-types' },
      sortableHead(tableSorts.types, columns, rerender),
      el('tbody', {},
        up ? upTableRow(up.label, up.go, 2) : null,
        listed.map(t => el('tr', {
          class: `type-row${hasPattern(typePattern(t.extension)) ? ' picked' : ''}`,
          title: typeHint(t.extension, 'Double-click'),
          ondblclick: () => toggleTypeFilter(t.extension),
        },
        el('td', {}, el('span', { class: t.extension ? 'mono' : 'muted' }, t.name)),
        el('td', { class: 'num' },
          el('span', { class: 'share', title: `${share(t).toFixed(1)}% of the size in here` }, el('span', { class: 'fill', style: `width:${share(t)}%` })),
          formatSize(t.size)),
        el('td', { class: 'num' }, plural(t.files, 'file')))),
        sorted.length ? null : el('tr', {}, el('td', { class: 'muted', colspan: 3 }, patterns().length ? `No ${matchingFiles()} in here` : 'No files in here')),
        showAllRow(sorted.length, showAll, () => { showAll = !showAll; rerender(); }, 3))));
}
