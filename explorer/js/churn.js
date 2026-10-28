// Where the changes happen: activity across every snapshot, by folder and file
import { KIND_SYMBOL, kindCount } from './changes.js';
import { api, notLoaded } from './data.js';
import { appendAll, el, fillColour, formatFull, formatSize, formatTime, gradientPositions, gradientRgb, plural, timeAgo } from './format.js';
import { asOfFor } from './snapshots.js';
import { navigate, state, ui } from './state.js';
import { selectedSnapshot } from './storage.js';
import { makePickable } from './tables.js';

// Activity across every step from one snapshot to the next, added up into a folder tree, plus per file.
// Each step counts separately, as this measures churn: a file rewritten ten times counts ten times.
// For each folder and file: counts of each kind, data written (added and modified files) and removed,
// and per step what happened, for the activity strips.
export const churnCache = new Map();

export const newActivity = () => ({ counts: { '+': 0, '-': 0, '~': 0 }, written: 0, removed: 0, steps: new Map() });

export function addActivity(activity, change, step) {
  activity.counts[change.k]++;
  if (change.k === '-') activity.removed += change.s || 0;
  else activity.written += change.s || 0;
  if (!activity.steps.has(step)) activity.steps.set(step, { '+': 0, '-': 0, '~': 0, bytes: 0 });
  const tick = activity.steps.get(step);
  tick[change.k]++;
  tick.bytes += change.s || 0;
}

export function locationChurn(loc) {
  if (churnCache.has(loc.path)) return churnCache.get(loc.path);
  // own is what happened to files directly in the folder, as opposed to in its subfolders
  const newNode = () => ({ ...newActivity(), own: newActivity(), children: new Map() });
  const root = newNode();
  const files = new Map();
  const complete = loc.snapshots.filter(s => !s.incomplete);
  // Each step ends at a snapshot; captured says whether its changes are known
  const steps = complete.slice(1).map((snap, i) => ({ snap, captured: !!api.diff(complete[i].id, snap.id) }));
  steps.forEach(({ snap }, step) => {
    for (const change of api.diff(complete[step].id, snap.id) || []) {
      // Things ignored from then on weren't changed by anyone, so they aren't activity
      if (change.p.endsWith('/') || change.k === 'i') continue;
      const parts = change.p.split('/');
      let node = root;
      addActivity(node, change, step);
      for (const part of parts.slice(0, -1)) {
        if (!node.children.has(part)) node.children.set(part, newNode());
        node = node.children.get(part);
        addActivity(node, change, step);
      }
      addActivity(node.own, change, step);
      if (!files.has(change.p)) files.set(change.p, newActivity());
      addActivity(files.get(change.p), change, step);
    }
  });
  const result = steps.some(s => s.captured) ? { root, files, steps, first: complete[0], last: complete[complete.length - 1] } : null;
  // Diffs may still be loading, so it's only kept once they're all in
  if (steps.every(s => s.captured)) churnCache.set(loc.path, result);
  return result;
}

// Looking inside a folder scopes the whole page to it, including the changes panel
export const drillChurn = path => navigate({ scope: path });

export function renderChurn(loc) {
  const panel = el('section', { class: 'panel' });
  const churn = locationChurn(loc);
  if (!churn) {
    panel.append(el('h2', {}, 'Where the changes happen'), el('p', { class: 'note' }, notLoaded('changes')));
    return panel;
  }

  // Walk down to the folder in scope; nothing below it changed if it isn't there
  const parts = state.scope ? state.scope.split('/') : [];
  let node = churn.root;
  for (const part of parts) node = node?.children.get(part);
  const legend = el('span', { class: 'legend' },
    `Data added, modified and removed across ${plural(churn.steps.length, 'snapshot')}, ${formatTime(churn.first.time)} – ${formatTime(churn.last.time)}`);
  if (!node) {
    panel.append(el('div', { class: 'chart-head' }, el('h2', {}, 'Where the changes happen'), legend),
      el('p', { class: 'note' }, 'Nothing in this folder changed across these snapshots.'));
    return panel;
  }

  const fullPath = rel => `${loc.path.replace(/\\$/, '')}\\${rel.replaceAll('/', '\\')}`;
  const total = activity => activity.written + activity.removed;
  const changes = activity => activity.counts['+'] + activity.counts['-'] + activity.counts['~'];

  const byTotal = (a, b) => total(b.activity) - total(a.activity) || changes(b.activity) - changes(a.activity);
  // Folders first, like Contents
  const folders = [...node.children].map(([name, child]) => {
    const rel = [...parts, name].join('/');
    return {
      key: `churn:${rel}`, label: `${name}/`, activity: child,
      // Rows click like Contents: a single click shows a folder's history, a double click goes into it
      pick: () => { ui.pickedIsFolder = true; navigate({ history: fullPath(rel) }); },
      open: () => drillChurn(rel),
    };
  }).filter(row => changes(row.activity)).sort(byTotal);
  const limit = 12;
  const rest = folders.slice(limit);

  // Then the files directly in this folder, those changed in the most snapshots first, as files
  // rewritten again and again are the ones worth noticing
  const prefix = parts.length ? `${parts.join('/')}/` : '';
  const rewrites = activity => [...activity.steps.values()].filter(t => t['+'] || t['~']).length;
  const files = [...churn.files]
    .filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
    .map(([path, activity]) => ({
      key: `churn-file:${path}`, label: path.slice(prefix.length), activity,
      pick: () => { ui.pickedIsFolder = false; navigate({ history: fullPath(path) }); },
      open: () => navigate({ scope: state.scope, file: path.slice(prefix.length) }),
    }))
    .sort((a, b) => rewrites(b.activity) - rewrites(a.activity) || byTotal(a, b));
  const moreFiles = files.slice(limit);

  const shown = [...folders.slice(0, limit), ...files.slice(0, limit)];
  // One scale for every row's bar and colour, so they compare
  const max = Math.max(1, ...shown.map(r => total(r.activity)));
  const positions = gradientPositions(shown.map(r => total(r.activity)).filter(Boolean));

  // A tick per step, lit where something changed, coloured by what kind of change it was.
  // The ticks for the snapshot being viewed are ringed, down every row.
  const viewed = selectedSnapshot(loc);
  const strip = (activity, rowKey) => el('span', { class: 'strip' }, churn.steps.map(({ snap, captured }, step) => {
    const tick = activity.steps.get(step);
    const kind = !tick ? '' : tick['~'] || (tick['+'] && tick['-']) ? 'modified' : tick['+'] ? 'added' : 'removed';
    const what = tick ? ['+', '-', '~'].filter(k => tick[k]).map(k => `${KIND_SYMBOL[k]}${tick[k]}`).join(' ') : captured ? 'no changes' : 'not loaded';
    return el('span', {
      class: `tick ${kind || (captured ? '' : 'unknown')}${snap === viewed ? ' viewed' : ''}`,
      title: `${formatFull(snap.time)} (${timeAgo(snap.time)}): ${what}${tick ? `, ${formatSize(tick.bytes)}` : ''}`,
      // A tick is a moment for the folder being looked at, so it views that snapshot here, with the
      // snapshots panel back on this folder rather than on the row's item, and the row highlighted
      onclick: event => {
        event.stopPropagation();
        ui.pickedRow = rowKey;
        navigate({ asOf: asOfFor(loc, snap), history: null });
      },
    });
  }));

  const churnRow = row => {
    const a = row.activity;
    const sum = total(a);
    const fill = sum ? fillColour(gradientRgb(positions.get(sum))) : null;
    return makePickable(
      el('div', { class: 'churn-row', title: 'Click for its history - double-click to open' },
        el('span', { class: 'churn-name', title: row.label }, el('span', { class: 'own' }, row.label)),
        // Written and removed side by side, so deletions count as activity too
        el('div', { class: 'churn-track', title: `${formatSize(a.written)} added or modified - ${formatSize(a.removed)} removed` },
          a.written ? el('div', { class: 'churn-fill', style: `width:${100 * a.written / max}%;background:${fill}` }) : null,
          a.removed ? el('div', { class: 'churn-fill removed', style: `width:${100 * a.removed / max}%` }) : null),
        el('span', { class: 'num' }, formatSize(sum)),
        strip(a, row.key),
        el('span', { class: 'agg' }, ['+', '-', '~'].filter(k => a.counts[k]).map(k => kindCount(k, a.counts[k], true)))),
      row.key, row.pick || null, row.open || null);
  };

  const columns = `--ticks:${churn.steps.length}`;
  appendAll(panel,
    el('div', { class: 'chart-head' }, el('h2', {}, 'Where the changes happen'), legend),
    shown.length ? el('div', { class: 'churn', style: columns }, shown.map(churnRow)) : el('p', { class: 'note' }, 'No changes here.'),
    rest.length || moreFiles.length ? el('p', { class: 'note', style: 'margin:6px 0 0' }, '…and ', [
      rest.length ? plural(rest.length, 'more folder') : null,
      moreFiles.length ? plural(moreFiles.length, 'more file') : null,
    ].filter(Boolean).join(' and '),
    ` with ${formatSize([...rest, ...moreFiles].reduce((n, r) => n + total(r.activity), 0))} between them`) : null);
  return panel;
}
