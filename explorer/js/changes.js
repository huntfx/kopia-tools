// What changed between two snapshots, as a tree
import { api, notLoaded } from './data.js';
import { appendAll, changeRgb, el, formatFull, formatSize, gradientPositions, plural, shortId, signedSize, textColour, timeAgo } from './format.js';
import { openHistory } from './snapshots.js';
import { navigate, state } from './state.js';
import { unfinished } from './storage.js';
import { sortRows, tableSorts } from './tables.js';

// Gone from the backup: removed, or ignored (i), which the server marks where kopia's current ignore rules
// explain a removal, as then it was most likely left out from then on rather than deleted
export const isGone = k => k === '-' || k === 'i';

// How much bigger a change made things: a file's size added or removed, or how much a modified one grew.
// Something that only existed in between (*) is gone again, so made no difference.
export const changeDelta = c => (c.k === '+' ? c.s || 0 : isGone(c.k) ? -(c.s || 0) : c.k === '~' && c.o != null ? c.s - c.o : 0);

export const KIND_CLASS = { '+': 'c-added', '-': 'c-removed', '~': 'c-modified', d: 'c-modified', i: 'c-ignored' };

export const KIND_SYMBOL = { '+': '+', '-': '−', '~': '~', d: '•', i: '⊘', '*': '' };

// How many of a kind of change in a folder's counts, where modified includes only the modified date changing
export const kindTotal = (counts, k) => counts[k] + (k === '~' ? counts.d : 0);

// A count of one kind of change, like "+3", saying what it counts on hover: files, or with times, how many
// times things were, where a file changed in several snapshots counts each time
export const KIND_WORDS = { '+': 'added', '-': 'removed', '~': 'modified', d: 'with only a date change', i: 'ignored' };

export const kindCount = (k, n, times = false) => el('span', {
  class: KIND_CLASS[k],
  title: times ? `${KIND_WORDS[k][0].toUpperCase()}${KIND_WORDS[k].slice(1)} ${plural(n, 'time')}` : `${plural(n, 'file')} ${KIND_WORDS[k]}`,
}, `${KIND_SYMBOL[k]}${n.toLocaleString('en-GB')}`);

// The rules things were ignored by, from what the server found, as "X, Y in .kopiaignore": grouped by where
// they're from, an ignore file (named inside the location) or the policy, the first few of each. The server
// goes by the rules as they are now.
export function ignoringRules(whys) {
  const base = state.location?.replace(/\\$/, '').toLowerCase();
  const where = file => (!file ? 'the policy'
    : base && file.toLowerCase().startsWith(`${base}\\`) ? file.slice(base.length + 1) : file);
  const groups = new Map();
  for (const why of whys) {
    const rules = groups.get(where(why.file)) || groups.set(where(why.file), new Set()).get(where(why.file));
    rules.add(why.rule);
  }
  return [...groups].map(([file, rules]) => {
    const listed = [...rules].slice(0, 3).join(', ');
    return `${listed}${rules.size > 3 ? ' and more' : ''} in ${file}`;
  }).join(', and ');
}

export const ignoredReason = why => `Ignored by ${ignoringRules([why])}`;

// kopia lists the files inside folders added or removed whole too, so a folder's counts and net change
// come from the files below it, whatever happened to the folder itself
export function buildTree(changes) {
  const newNode = (name, path) => ({ name, path, children: new Map(), counts: { '+': 0, '-': 0, '~': 0, '*': 0, d: 0, i: 0 }, delta: 0 });
  const root = newNode('', '');
  for (const change of changes) {
    const isDir = change.p.endsWith('/');
    const parts = change.p.replace(/\/$/, '').split('/');
    const delta = isDir ? 0 : changeDelta(change);
    let node = root;
    parts.forEach((part, i) => {
      if (!node.children.has(part)) node.children.set(part, newNode(part, parts.slice(0, i + 1).join('/')));
      node = node.children.get(part);
      // Files count towards every folder above them
      if (!isDir && i < parts.length - 1) {
        node.counts[change.k]++;
        node.delta += delta;
      }
    });
    if (!isDir) {
      root.counts[change.k]++;
      root.delta += delta;
    }
    node.change = change;
  }
  return root;
}

// Every row's net change in a tree, for colouring them on one scale
export function treeDeltas(node, found = []) {
  if (node.change && !node.change.d) found.push(Math.abs(changeDelta(node.change)));
  else found.push(Math.abs(node.delta));
  for (const child of node.children.values()) treeDeltas(child, found);
  return found;
}

// Fold the changes of consecutive steps into one net change per path, like snapshot_diff.py --group:
// whether a path exists at the start and end decides the result, so something deleted and re-added
// in between is modified, and something that only existed in between is transient (*), shown greyed out
export function foldDiffs(lists) {
  const history = new Map();
  for (const list of lists) {
    for (const change of list) {
      const item = history.get(change.p);
      if (item) item.last = change;
      else history.set(change.p, { first: change, last: change });
    }
  }
  const result = [];
  for (const { first, last } of history.values()) {
    const existedFirst = first.k !== '+';
    const existsLast = !isGone(last.k);
    if (!existedFirst && !existsLast) {
      // Only existed in between: kept as * at its last size, for showing on request
      result.push({ ...last, k: '*' });
    } else if (existedFirst && existsLast) {
      // Folders that existed at both ends are left to their contents to describe
      if (first.d || last.d) continue;
      result.push({ k: '~', p: last.p, s: last.s, o: first.k === '~' ? first.o : first.s });
    } else {
      // Gone by the end the way it went last: removed, or ignored
      result.push(existsLast ? { ...last, k: '+' } : { ...first, k: last.k, why: last.why });
    }
  }
  return result;
}

// Files whose modified date changed between two snapshots but not their contents, which kopia's diff only counts:
// the server finds them, comparing just the folders kopia names. Paths are inside the folder in scope;
// contentPaths are the changes the diff found, which aren't repeated. complete is false while they load.
export function dateOnlyChanges(older, newer, scope, contentPaths) {
  const list = api.dates(older.id, newer.id);
  if (!list) return { found: [], complete: false };
  const prefix = scope ? `${scope}/` : '';
  const found = list.filter(c => c.p.startsWith(prefix)).map(c => ({ ...c, p: c.p.slice(prefix.length) }))
    .filter(c => !contentPaths.has(c.p));
  return { found, complete: true };
}

// Changes between two complete snapshots of a location, oldest first, or null if not captured
export function diffBetween(loc, older, newer) {
  const complete = loc.snapshots.filter(s => !s.incomplete);
  const from = complete.indexOf(older), to = complete.indexOf(newer);
  const lists = [];
  for (let i = from; i < to; i++) {
    const list = api.diff(complete[i].id, complete[i + 1].id);
    if (!list) return null;
    lists.push(list);
  }
  return lists.length === 1 ? lists[0] : foldDiffs(lists);
}

// Every snapshot newest first, like the table, with the selected one shown in place but disabled
export function compareSelect(complete, selected, other) {
  const newest = complete[complete.length - 1];
  const option = snap => {
    const label = `${formatFull(snap.time)} · ${timeAgo(snap.time)} (${shortId(snap.id)})${snap === newest ? ' · latest' : ''}`;
    return snap === selected
      ? el('option', { value: snap.id, disabled: true }, `${label} · this snapshot`)
      : el('option', { value: snap.id, selected: other && snap.id === other.id }, label);
  };
  return el('label', { class: 'compare' }, 'Compare with',
    el('select', { onchange: event => navigate({ compare: event.target.value || null }) },
      other ? null : el('option', { value: '', selected: true }, 'Pick a snapshot'),
      [...complete].reverse().map(option)));
}

// The snapshot the selected one is compared with: the chosen one, or by default the nearest earlier one
// with changes in the folder in scope since, so there's something to see. Steps whose changes aren't
// loaded yet count if the snapshots differ at all. With no changes since the oldest, it's the oldest.
export function compareTarget(loc, selected) {
  if (selected.incomplete) return undefined;
  const complete = loc.snapshots.filter(s => !s.incomplete);
  const chosen = complete.find(s => s.id === state.compare && s !== selected);
  if (chosen) return chosen;
  // Anything at or below the folder in scope, including folders added or removed whole
  const prefix = state.scope ? `${state.scope}/` : '';
  for (let i = complete.indexOf(selected); i > 0; i--) {
    const [older, newer] = [complete[i - 1], complete[i]];
    if (older.root === newer.root) continue;
    const list = api.diff(older.id, newer.id);
    if (!list || list.some(c => c.p.startsWith(prefix))) return older;
  }
  return complete.indexOf(selected) > 0 ? complete[0] : undefined;
}

export function renderChanges(loc, selected) {
  const panel = el('section', { class: 'panel' });
  if (selected.incomplete) {
    panel.append(el('h2', {}, 'Changes'), el('p', { class: 'note' }, `This snapshot ${unfinished(selected)}, so its changes aren't shown.`));
    return panel;
  }
  const complete = loc.snapshots.filter(s => !s.incomplete);
  const index = complete.indexOf(selected);
  const other = compareTarget(loc, selected);
  const select = compareSelect(complete, selected, other);
  const title = legend => el('div', { class: 'chart-head' }, el('h2', {}, 'Changes'), legend ? el('span', { class: 'legend' }, legend) : null);
  if (!other) {
    appendAll(panel, title(), el('div', { class: 'changes-head' }, el('div', { class: 'line' }, select)),
      el('p', { class: 'note' }, 'This is the oldest snapshot, so pick a later one to compare it with.'));
    return panel;
  }
  const [older, newer] = complete.indexOf(other) < index ? [other, selected] : [selected, other];
  // Only steps where something changed count as combined; identical snapshots add nothing
  const range = complete.slice(complete.indexOf(older), complete.indexOf(newer) + 1);
  const steps = range.slice(1).filter((s, i) => s.root !== range[i].root).length;
  const identical = range.length - 1 - steps;
  const changes = diffBetween(loc, older, newer);
  if (!changes) {
    appendAll(panel, title(), el('div', { class: 'changes-head' }, el('div', { class: 'line' }, select)),
      el('p', { class: 'note' }, notLoaded('changes')));
    return panel;
  }

  // Only what's inside the folder in scope, with paths starting inside it
  const prefix = state.scope ? `${state.scope}/` : '';
  const inScope = prefix
    ? changes.filter(c => c.p.startsWith(prefix) && c.p.length > prefix.length).map(c => ({ ...c, p: c.p.slice(prefix.length) }))
    : changes;
  // Files whose modified date changed but not their contents, which the server finds, as kopia's diff only
  // counts them; like the other kinds, they're counted whether or not they're shown
  const dates = dateOnlyChanges(older, newer, state.scope, new Set(inScope.map(c => c.p)));
  const scoped = [...inScope, ...dates.found];
  const tree = buildTree(scoped);
  // Files that only existed between the snapshots compared, which are shown greyed out
  const transient = tree.counts['*'];
  // Files no longer backed up because of the ignore rules, which are otherwise an unexplained drop in size
  const ignored = tree.counts.i;
  // Modified includes files with only their modified date changed, which their own symbol marks in the tree
  const modified = kindCount('~', kindTotal(tree.counts, '~'));
  if (tree.counts.d) modified.title += `, including ${tree.counts.d.toLocaleString('en-GB')} ${KIND_WORDS.d}`;
  if (!dates.complete) {
    modified.append('…');
    modified.title += `, still finding ones ${KIND_WORDS.d}`;
  }
  const counts = el('span', { class: 'counts' }, kindCount('+', tree.counts['+']), kindCount('-', tree.counts['-']), modified, kindCount('i', ignored));
  const toggle = k => { state.filters[k] = !state.filters[k]; panel.replaceWith(renderChanges(loc, selected)); };
  const filters = el('span', { class: 'filters' }, ['+', '-', '~'].map(k => el('button', {
    class: KIND_CLASS[k], 'aria-pressed': String(state.filters[k]),
    title: `Show ${KIND_WORDS[k]}`,
    onclick: () => toggle(k),
  }, KIND_SYMBOL[k])),
  el('button', {
    class: 'c-ignored', 'aria-pressed': String(state.filters.i), onclick: () => toggle('i'), title: 'Show ignored',
  }, '⊘'));
  const text = el('input', {
    class: 'filter-text', placeholder: 'Filter paths…', value: state.filterText, 'aria-label': 'Filter paths',
    oninput: event => { state.filterText = event.target.value; treeBox.replaceChildren(...topFolder(filtered())); },
  });
  const treeBox = el('div', { class: 'tree' });
  const filtered = () => {
    const needle = state.filterText.toLowerCase();
    return buildTree(scoped.filter(c => state.filters[c.k === 'd' ? '~' : c.k] && (!needle || c.p.toLowerCase().includes(needle))));
  };
  const visible = filtered();
  // Everything sits under the folder being looked at, so collapsing that collapses it all
  const folderName = state.scope ? state.scope.split('/').pop() : loc.path.replace(/\\$/, '').split('\\').pop() || loc.path;
  function topFolder(root) {
    if (!root.children.size) return [];
    // Coloured on the scale of what's shown, so it's recalculated as the filters change
    const sizePositions = gradientPositions(treeDeltas(root).filter(Boolean));
    // Headings sort the tree like the contents table's; clicking the current one reverses it
    const sort = tableSorts.changes;
    const head = el('div', { class: 'node head' }, el('span'), el('span'), changeColumns.map(col => {
      const active = sort.key === col.key;
      return el('span', { class: col.cls || null, 'aria-sort': active ? (sort.desc ? 'descending' : 'ascending') : null },
        el('button', {
          class: 'sort-head', title: `${col.title ? `${col.title} - ` : ''}${active ? 'Click again to reverse' : 'Click to sort'}`,
          onclick: () => {
            if (active) sort.desc = !sort.desc;
            else { sort.key = col.key; sort.desc = !!col.desc; }
            treeBox.replaceChildren(...topFolder(filtered()));
          },
        }, col.label, active ? (sort.desc ? ' ▼' : ' ▲') : ''));
    }));
    return [head, renderNode({ ...root, name: folderName, path: '' }, sizePositions, true)];
  }
  treeBox.append(...topFolder(visible));
  if (!visible.children.size) {
    treeBox.append(el('p', { class: 'note' }, scoped.length ? 'Nothing matches the filters.'
      : state.scope ? 'Nothing in this folder changed in this snapshot.' : 'No changes in this snapshot.'));
  }

  // How several snapshots' changes were combined, in as few words as what applies needs
  const skipped = identical ? ` (${plural(identical, 'identical one')} skipped)` : '';
  const combined = steps > 1
    ? `Changes from ${steps} snapshots combined${skipped}. Anything deleted and re-added in between shows as modified${
      transient ? `; the ${transient === 1 ? 'file' : plural(transient, 'file')} greyed out only existed in between.` : '.'}`
    : identical ? `${plural(identical, 'identical snapshot')} in between skipped.` : null;
  appendAll(panel,
    title(`${formatFull(older.time)} (${timeAgo(older.time)}) → ${formatFull(newer.time)} (${timeAgo(newer.time)})`),
    el('div', { class: 'changes-head' }, el('div', { class: 'line' }, select, counts, filters, text)),
    combined ? el('p', { class: 'note', style: 'margin:-4px 0 10px' }, combined) : null,
    treeBox);
  return panel;
}

// The ignore rules behind what's ignored in a folder of the changes tree, for its tooltip
export function ignoredRules(node) {
  const whys = [];
  (function walk(n) {
    if (n.change?.why) whys.push(n.change.why);
    for (const child of n.children.values()) walk(child);
  })(node);
  return ignoringRules(whys);
}

// Render the whole changes tree from its root; every folder starts open
export const renderTree = (root, sizePositions) => renderNodes(root, sizePositions);

// The changes tree's columns, for sorting. A row merged with the folders leading to it (see compact)
// sorts by what it shows, which is the last of them.
export const isChangeFolder = n => n.children.size > 0 || !!n.change?.d;

export const rowNode = n => compact(n).node;

export const changeCount = k => n => (isChangeFolder(rowNode(n)) ? kindTotal(rowNode(n).counts, k) : null);

export const changeColumns = [
  { key: 'name', label: 'Name', value: n => n.name },
  { key: '+', label: '+', title: 'Files added', cls: 'c-added', desc: true, value: changeCount('+') },
  { key: '-', label: '−', title: 'Files removed', cls: 'c-removed', desc: true, value: changeCount('-') },
  { key: '~', label: '~', title: 'Files modified', cls: 'c-modified', desc: true, value: changeCount('~') },
  { key: 'size', label: 'Size', desc: true, value: n => rowNode(n).change?.s ?? null },
  { key: 'change', label: 'Change', title: 'How much bigger or smaller', desc: true,
    value: n => (isChangeFolder(rowNode(n)) ? rowNode(n).delta : changeDelta(rowNode(n).change)) },
];

// Render a folder's children, sorted by the chosen column like the contents: folders first, unless reversed
export function renderNodes(node, sizePositions) {
  const entries = sortRows([...node.children.values()], tableSorts.changes, changeColumns, isChangeFolder, n => n.name);
  const limit = 300;
  const rows = entries.slice(0, limit).map(child => renderNode(child, sizePositions));
  if (entries.length > limit) rows.push(el('div', { class: 'more' }, `…and ${entries.length - limit} more`));
  return rows;
}

// Merge chains of folders that only contain one thing, like VS Code's compact folders, including
// when that one thing is the change itself: a single changed file, or a folder added or removed whole
export function compact(node) {
  let label = node.name;
  while (!node.change && node.children.size === 1) {
    const [only] = node.children.values();
    node = only;
    label += '/' + node.name;
  }
  return { node, label };
}

// Folders in the changes tree that were opened or closed by hand, so re-rendering keeps them that way
export const changeFolders = new Map();

export function renderNode(original, sizePositions, whole = false) {
  // The top folder stays as itself, rather than merging into a folder it only contains
  const { node, label } = whole ? { node: original, label: original.name } : compact(original);
  const change = node.change;
  const isFolder = node.children.size > 0 || change?.d;
  const kind = change?.k;
  // A folder where only dates changed, like settings a game rewrote unchanged, is grouped like one added or
  // removed whole: a dot, collapsed (except the top folder), with how many on hover
  const only = k => !change && node.counts[k] > 0 && ['+', '-', '~', '*', 'd', 'i'].every(other => other === k || !node.counts[other]);
  const datesOnly = only('d');
  // Likewise a folder where everything that went was ignored, like a game's data a rule now leaves out
  const ignoredOnly = only('i');
  const shownKind = datesOnly ? 'd' : ignoredOnly ? 'i' : kind;
  const symClass = KIND_CLASS[shownKind];
  const wrapper = el('div');
  let open = node.children.size > 0 &&
    // Folders start open, except ones added or removed whole, or with only dates changed or only ignored
    // files, whose row says enough
    (changeFolders.has(node.path) ? changeFolders.get(node.path) : !change && !((datesOnly || ignoredOnly) && !whole));
  const childBox = el('div', { class: 'children' });

  const fill = () => childBox.replaceChildren(...renderTree(node, sizePositions));
  const twisty = node.children.size
    ? el('button', { class: 'twisty', 'aria-expanded': String(open), 'aria-label': `${open ? 'Collapse' : 'Expand'} ${node.name}`,
        onclick: () => {
          open = !open;
          changeFolders.set(node.path, open);
          twisty.textContent = open ? '▾' : '▸';
          twisty.setAttribute('aria-expanded', String(open));
          childBox.hidden = !open;
          if (open && !childBox.childElementCount) fill();
        } },
      open ? '▾' : '▸')
    : el('span');

  // The same columns for every row: files added, removed and modified (for folders; a file's symbol says
  // which it is), its size, and how much bigger or smaller it got
  const count = k => el('span', { class: KIND_CLASS[k] },
    isFolder && kindTotal(node.counts, k) ? kindTotal(node.counts, k).toLocaleString('en-GB') : '');
  const delta = isFolder ? node.delta : changeDelta(change);
  const deltaCell = delta && shownKind === 'i'
    // Smaller, but nothing on disk was lost, so not on the red scale
    ? el('span', { class: 'delta c-ignored' }, signedSize(delta))
    : delta
    ? el('span', { class: 'delta', style: `color:${textColour(changeRgb(delta, sizePositions))}` }, signedSize(delta))
    // Files that changed without changing size, including just their dates, changed by nothing
    : el('span', { class: 'delta muted' }, change && !isFolder && (kind === '~' || kind === 'd') ? '0 B' : '');

  // In a merged row, the folders leading to what's named are dimmed
  const cut = label.lastIndexOf('/') + 1;
  // Like Contents: a single click shows its snapshots, a double click opens the folder or the file's page
  const inside = [state.scope, node.path].filter(Boolean).join('/');
  const goInto = () => isFolder
    ? navigate({ scope: inside })
    : navigate({ scope: inside.includes('/') ? inside.slice(0, inside.lastIndexOf('/')) : '', file: inside.slice(inside.lastIndexOf('/') + 1) });
  const name = el('button', {
    class: 'name', title: 'Click for its snapshots - double-click to open',
    onclick: event => { if (event.detail === 1) openHistory(node.path, !!isFolder); },
    ondblclick: node.path ? goInto : null,
  }, cut ? el('span', { class: 'muted' }, label.slice(0, cut)) : null, label.slice(cut) + (isFolder ? '/' : ''));
  // Things that only existed in between, and folders with nothing else in them, are greyed out with no symbol;
  // files whose modified date changed but not their contents get a small dot
  const transient = kind === '*' || only('*');
  const rowTitle = kind === 'd' ? `Date changed: ${formatFull(change.from)} → ${formatFull(change.to)}`
    : datesOnly ? `${plural(node.counts.d, 'file')} ${KIND_WORDS.d}`
    : kind === 'i' ? ignoredReason(change.why)
    : ignoredOnly ? `${plural(node.counts.i, 'file')} ignored by ${ignoredRules(node)}`
    : transient ? 'Only existed in between' : null;
  // Folders that only contain changes have no symbol or size of their own
  const rowClass = `${isFolder ? ' folder' : ''}${transient ? ' transient' : ''}${shownKind === 'd' ? ' date-only' : ''}${shownKind === 'i' ? ' ignored' : ''}`;
  wrapper.append(el('div', { class: `node${rowClass}`, title: rowTitle },
    twisty, el('span', { class: `sym ${symClass || ''}` }, KIND_SYMBOL[shownKind] ?? ''), name,
    count('+'), count('-'), count('~'),
    el('span', { class: 'size' }, change ? formatSize(change.s) : ''), deltaCell));
  if (node.children.size) {
    childBox.hidden = !open;
    if (open) fill();
    wrapper.append(childBox);
  }
  return wrapper;
}
