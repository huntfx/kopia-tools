// What kinds of file a folder holds: each type's files and size at a snapshot, counting everything inside it
import { api, notLoaded } from './data.js';
import { el, formatFull, formatSize, plural, shortId } from './format.js';
import { state } from './state.js';
import { folderObj } from './storage.js';
import { sortRows, sortableHead, tableSorts } from './tables.js';

// A type's name: its extension, or for files without one, saying so
export const typeName = extension => extension || 'No extension';

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
  const shown = showAll ? sorted : sorted.slice(0, SHOWN);
  const share = t => (total ? 100 * t.size / total : 0);
  const panel = el('section', { class: 'panel' },
    head(`${plural(types.length, 'type')} at ${formatFull(selected.time)} (${shortId(selected.id)}), counting everything in here`),
    el('div', { class: 'table-wrap' },
      el('table', { class: 'file-types' },
        sortableHead(tableSorts.types, columns, () => panel.replaceWith(renderFileTypes(loc, selected))),
        el('tbody', {}, shown.map(t => el('tr', {},
          el('td', {}, el('span', { class: t.extension ? 'mono' : 'muted' }, t.name)),
          el('td', { class: 'num' }, plural(t.files, 'file')),
          el('td', { class: 'num' },
            el('span', { class: 'share', title: `${share(t).toFixed(1)}% of the size in here` },
              el('span', { class: 'fill', style: `width:${share(t)}%` })),
            formatSize(t.size)))),
        // The rest a click away, as the table's last row, as it runs to the bottom of the panel
        sorted.length > SHOWN ? el('tr', {}, el('td', { colspan: 3 }, el('button', {
          class: 'linklike', onclick: () => { showAll = !showAll; panel.replaceWith(renderFileTypes(loc, selected)); },
        }, showAll ? 'Show fewer' : `Show all ${sorted.length}`))) : null))));
  return panel;
}
