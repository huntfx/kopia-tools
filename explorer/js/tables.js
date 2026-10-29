// Sortable tables with rows that are picked with a click and opened with a double click
import { el, formatFull, formatSize, gradientPositions, gradientRgb, plural, textColour } from './format.js';
import { navigate, ui } from './state.js';
import { LOCATION_DOT, currentPath } from './storage.js';

// items: { key, label, prefix?, folder, location?, live?, size, files, modified, pick?, open }
// up: { label, go } or null. rerender returns a fresh copy of the panel, for re-sorting. empty is what to say with
// no items.
export function contentsTable(legend, up, items, rerender, empty = 'Empty folder') {
  const columns = [
    { key: 'name', label: 'Name', value: i => (i.prefix || '') + i.label },
    { key: 'size', label: 'Size', value: i => i.size, desc: true },
    // A file counts as -1 files, so it sorts just below a folder with none, without folders being kept first
    { key: 'files', label: 'Files', value: i => i.folder ? i.files : -1, desc: true, mixed: true },
    { key: 'modified', label: 'Modified', value: i => i.modified, desc: true },
  ];
  const sorted = sortRows(items, tableSorts.contents, columns, i => i.folder, i => (i.prefix || '') + i.label);
  const positions = gradientPositions(sorted.map(i => i.size).filter(Boolean));
  const row = item => pickableRow(item.key, item.pick, item.open,
    `${item.pick ? 'Click for its history - ' : ''}Double-click to open${item.location ? ` (${item.location.path} is a backup location)` : ''}`,
    el('td', {},
      el('span', { class: 'mono' },
        item.location ? el('span', { class: 'swatch', style: 'background:var(--accent);border-radius:50%', title: LOCATION_DOT }) : null,
        item.prefix ? el('span', { class: 'muted' }, item.prefix) : null,
        item.label + (item.folder ? '\\' : '')),
      item.live ? el('span', { class: 'badge', style: 'margin-left:8px' }, 'Live') : null),
    el('td', { class: 'num', style: item.size ? `color:${textColour(gradientRgb(positions.get(item.size)))}` : null }, formatSize(item.size)),
    el('td', { class: 'num' }, item.folder && item.files != null ? plural(item.files, 'file') : ''),
    el('td', { class: 'num' }, item.modified ? formatFull(item.modified) : ''));
  const panel = el('section', { class: 'panel' },
    el('div', { class: 'chart-head' }, el('h2', {}, 'Contents'), legend ? el('span', { class: 'legend' }, legend) : null),
    el('div', { class: 'table-wrap' },
      el('table', {},
        sortableHead(tableSorts.contents, columns, () => panel.replaceWith(rerender())),
        el('tbody', {},
          up ? upTableRow(up.label, up.go, 3) : null,
          sorted.map(row),
          sorted.length ? null : el('tr', {}, el('td', { class: 'muted', colspan: 4 }, empty))))));
  return panel;
}

// How each table is sorted, kept while moving between folders
export const tableSorts = { contents: { key: 'name', desc: false }, changes: { key: 'name', desc: false }, types: { key: 'size', desc: true } };

// A header row whose headings sort the table; clicking the current one reverses it
export function sortableHead(sort, columns, rerender) {
  return el('thead', {}, el('tr', {}, columns.map(col => {
    const active = sort.key === col.key;
    return el('th', { 'aria-sort': active ? (sort.desc ? 'descending' : 'ascending') : null },
      el('button', {
        class: 'sort-head', title: active ? 'Click again to reverse' : `Sort by ${col.label.toLowerCase()}`,
        onclick: () => {
          if (active) sort.desc = !sort.desc;
          else { sort.key = col.key; sort.desc = !!col.desc; }
          rerender();
        },
      }, col.label, active ? (sort.desc ? ' ▼' : ' ▲') : ''));
  })));
}

// Sort like Windows: folders above files, then by the chosen column, then by name. Reversing a column
// reverses the whole list, so folders go below files, as Windows does.
// A column marked mixed sorts folders and files together by its value alone.
// Empty values always go last, whichever way it's sorted.
export function sortRows(items, sort, columns, isFolder, name) {
  const column = columns.find(c => c.key === sort.key);
  const value = column.value;
  const direction = sort.desc ? -1 : 1;
  const foldersFirst = !!sort.desc === !!column.desc;
  const byName = (a, b) => name(a).localeCompare(name(b), 'en', { sensitivity: 'base' });
  return [...items].sort((a, b) => {
    if (!column.mixed && isFolder(a) !== isFolder(b)) return (foldersFirst ? 1 : -1) * (isFolder(b) - isFolder(a));
    const x = value(a), y = value(b);
    if ((x == null) !== (y == null)) return (x == null) - (y == null);
    const order = x == null ? 0 : typeof x === 'string' ? x.localeCompare(y, 'en', { sensitivity: 'base' }) : x - y;
    return direction * order || byName(a, b);
  });
}

// Make a row picked (and show its history) on a single click, and opened on a double click.
// The second click of a double click is ignored, so it doesn't land on whatever replaced the row.
export function makePickable(row, key, pick, open) {
  if (key === ui.pickedRow) row.classList.add('picked');
  row.addEventListener('click', event => {
    if (event.detail > 1) return;
    ui.pickedRow = key;
    row.parentElement.querySelectorAll(':scope > .picked').forEach(r => r.classList.remove('picked'));
    row.classList.add('picked');
    pick?.();
  });
  if (open) row.addEventListener('dblclick', open);
  return row;
}

export const pickableRow = (key, pick, open, title, ...cells) => makePickable(el('tr', { title }, ...cells), key, pick, open);

// A ".." row: a single click picks the folder you're in and shows its history, a double click goes up
export function upTableRow(label, go, span) {
  const here = currentPath();
  return pickableRow(`..${here}`, here ? () => navigate({ history: null }) : null, go,
    `Click for this folder's snapshots - double-click to go up to ${label}`,
    el('td', {}, el('span', { class: 'mono' }, '..')), el('td', { class: 'muted', colspan: span }, `Up to ${label}`));
}
