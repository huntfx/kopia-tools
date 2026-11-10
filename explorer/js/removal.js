// Removing the files ignore rules leave out from the snapshots already taken, so the space they use can be freed: a
// folder's .kopiaignore rules, from the snapshots of the locations it's in, and for a location's own folder, the
// rules in the policy it goes by, from its own snapshots, unless they're the global policy's; or the global policy's,
// from the locations going by them. Rules come in groups by where they're from, each rule known by its group's kind
// and its line, as file:line or policy:line. The server works out what each rule would remove, reading every snapshot in the
// repository, which can take a few minutes the first time, then for the rules ticked, how many files go from how many
// snapshots, how much space they take, and how much of that maintenance would free, as files staying elsewhere may
// use the same data. Kopia removes them, which can't be undone, followed in the panel at the bottom. After new rules
// are saved that leave out files the snapshots have, it's offered above the panel.
import { api } from './data.js';
import { el, formatSize, listOf, plural } from './format.js';
import { removeIgnored, renderNotice } from './jobs.js';
import { checkMaintenance, maintenanceInfo } from './maintenance.js';
import { storage } from './storage.js';

// What the dialog and the offer are called, as the link that opens it says
const NAME = 'Remove from older snapshots';

// The lines that ignore something, as ! lines only bring things back
const ignoring = rules => [...new Set(rules.map(line => line.trim()).filter(line => line && !line.startsWith('#') && !line.startsWith('!')))];

// A rule's line, without the kind of group it's from
export const ruleLine = key => key.slice(key.indexOf(':') + 1);

const inside = (path, loc) => `${path.replace(/\\$/, '').toLowerCase()}\\`.startsWith(`${loc.path.replace(/\\$/, '').toLowerCase()}\\`);

// The locations with snapshots the rules could be removed from, and the ones ticked to start with: for a folder's
// .kopiaignore, the locations it's in, with the nearest ticked, as that's the one it's for, or with only its policy's
// rules, only its own; for the global rules, the locations without a list of their own, none ticked, so each is
// picked on purpose
function locationsFor(path, groups, replaced) {
  if (path) {
    const found = storage.filter(l => inside(path, l) && (groups.some(g => g.kind === 'file') || l.path.toLowerCase() === path.toLowerCase()))
      .sort((a, b) => b.path.length - a.path.length);
    return { locations: found.filter(l => l.snapshots.length).map(l => l.path), ticked: found[0]?.snapshots.length ? [found[0].path] : [] };
  }
  return { locations: storage.filter(l => l.snapshots.length && !replaced.includes(l.path)).map(l => l.path), ticked: [] };
}

// Whether there's anywhere to remove some rules from, for showing the link
export function canRemove(path, groups, replaced = []) {
  return groups.some(g => ignoring(g.rules).length) && locationsFor(path, groups, replaced).locations.length > 0;
}

// The link beside an ignore file's Change…, for a folder's rules (path) or the global ones (path null, with the
// locations that have a list of their own), each group as { kind, label, rules }
export function removeLink(path, groups, replaced = []) {
  return el('button', {
    class: 'linklike', title: 'Remove the files these rules ignore from the snapshots already taken',
    onclick: () => removalDialog({ path, groups, replaced }),
  }, `${NAME}…`);
}

// ---- The offer above the panel at the bottom, after saving new rules ----

let offer = null;

// New rules saved, of all the rules there now, that leave out files the latest snapshots have
export function offerRemoval(path, groups, added, replaced = []) {
  offer = { path, groups, added, replaced };
  renderNotice();
}

export function removalNotice() {
  if (!offer) return null;
  const { path, groups, added, replaced } = offer;
  const where = path ? `${path.replace(/\\$/, '')}\\.kopiaignore` : 'the global ignore rules';
  return [
    el('h2', {}, 'Ignored files still in snapshots'),
    el('p', {}, 'Snapshots taken before you changed ', el('b', {}, where), ' still have the files ',
      el('span', { title: added.map(ruleLine).join('\n') }, added.length === 1 ? 'the new rule' : `the ${added.length} new rules`), added.length === 1 ? ' ignores.' : ' ignore.'),
    el('div', { class: 'actions' },
      el('button', { class: 'btn', onclick: () => removalDialog({ path, groups, picked: added, replaced }) }, `${NAME}…`),
      el('button', { class: 'linklike', onclick: () => { offer = null; renderNotice(); } }, 'Not now')),
  ];
}

// ---- The dialog ----

// What removing the files the ticked rules ignore from the ticked locations' snapshots would do, worked out while it's
// open: ticking other locations works it out again, which the server does in the background, said as it goes;
// ticking other rules only asks for the numbers again. Removing starts it in the panel at the bottom.
export function removalDialog({ path, groups, picked = null, replaced = [] }) {
  if (document.querySelector('dialog.removal')) return;
  if (!maintenanceInfo()) checkMaintenance().then(() => draw());
  // Each group's rules that ignore something, by key, keeping only the groups with any
  const shown = groups.map(g => ({ ...g, keys: ignoring(g.rules).map(line => `${g.kind}:${line}`) })).filter(g => g.keys.length);
  const keys = shown.flatMap(g => g.keys);
  const bringsBack = groups.some(g => g.rules.some(line => line.trim().startsWith('!')));
  const { locations, ticked } = locationsFor(path, groups, replaced);
  let plan = null;      // From the server: how working it out is getting on, then what each rule would remove alone
  let result = null;    // What the ticked rules would remove
  let failed = null;    // Why it couldn't be worked out
  let polling = null;
  let asking = 0;       // Answers to older questions are ignored
  const ruleBoxes = new Map(keys.map(key => [key, el('input', { type: 'checkbox', checked: (picked || keys).includes(key), onchange: () => evaluate() })]));
  const locationBoxes = new Map(locations.map(loc => [loc, el('input', { type: 'checkbox', checked: ticked.includes(loc), onchange: () => start() })]));
  const tickedRules = () => keys.filter(key => ruleBoxes.get(key).checked);
  const tickedLocations = () => locations.filter(loc => locationBoxes.get(loc).checked);
  const notes = new Map(keys.map(key => [key, el('span', { class: 'note' })]));
  const ruleItem = key => el('li', {}, el('label', {}, ruleBoxes.get(key), el('span', { class: 'rule' }, ruleLine(key)), notes.get(key)));
  // Each group's rules in the order they're in until it's worked out, then the ones that found something, biggest
  // first, with the rest folded away under them, as a long list can have only a few. With more than one group, each
  // is headed by where its rules are from; a policy's only apply to its own location's snapshots, which is said when
  // others can be ticked.
  const ruleList = el('div', {});
  let rulesShown = null;
  const groupRules = g => {
    if (plan?.state !== 'done') return [el('ul', { class: 'removal-list' }, g.keys.map(ruleItem))];
    const found = g.keys.filter(key => plan.rules[key]?.files).sort((a, b) => plan.rules[b].bytes - plan.rules[a].bytes);
    const none = g.keys.filter(key => !plan.rules[key]?.files);
    return [
      found.length ? el('ul', { class: 'removal-list' }, found.map(ruleItem)) : null,
      none.length ? el('details', { class: 'other-rules' }, el('summary', {}, `Nothing in the snapshots (${plural(none.length, 'rule')})`),
        el('ul', { class: 'removal-list' }, none.map(ruleItem))) : null,
    ];
  };
  const drawRules = () => {
    const done = plan?.state === 'done' ? plan.id : null;
    if (rulesShown === done && ruleList.firstChild) return;
    rulesShown = done;
    ruleList.replaceChildren(...shown.flatMap(g => [
      // The folder's path is above, so the file's name is enough
      shown.length > 1 ? el('h3', {}, `In ${g.kind === 'file' ? '.kopiaignore' : `${g.label[0].toLowerCase()}${g.label.slice(1)}`}`) : null,
      shown.length > 1 && g.kind === 'policy' && path && locations.length > 1 ? el('p', { class: 'muted' }, `These are only removed from the snapshots of ${path}.`) : null,
      ...groupRules(g),
    ]).filter(Boolean));
  };
  const summary = el('div', { class: 'removal-summary', role: 'status' });
  const cancel = el('button', { class: 'btn', onclick: () => dialog.close() }, 'Cancel');
  const remove = el('button', {
    class: 'btn danger', disabled: true,
    onclick: () => {
      const where = result.locations.filter(l => l.snapshots).map(l => l.path);
      // Where they're from, as the server says it
      const from = shown.filter(g => g.keys.some(key => ruleBoxes.get(key).checked))
        .map(g => (g.kind === 'file' ? g.label : path ? `the policy ${path} goes by` : 'the global ignore rules'));
      dialog.close();
      offer = null;
      renderNotice();
      removeIgnored(plan.id, tickedRules(), { name: listOf(from), locations: where });
    },
  }, 'Remove');

  const stopPolling = () => {
    clearInterval(polling);
    polling = null;
  };
  const reason = error => (error instanceof TypeError ? 'can\'t reach the server' : error.message);

  // Worked out again for the locations ticked, the one before cancelled, unless it's the same one
  async function start() {
    stopPolling();
    const old = plan;
    plan = result = failed = null;
    const asked = ++asking;
    if (old && old.state === 'working') api.post('/api/removal/cancel', { id: old.id }).catch(() => {});
    if (!tickedLocations().length) return draw();
    draw();
    try {
      const found = await api.post('/api/removal/plan', { path, locations: tickedLocations() });
      if (asked !== asking || !dialog.isConnected) return;
      plan = found;
    } catch (error) {
      if (asked === asking) failed = `Couldn't work it out: ${reason(error)}`;
      return draw();
    }
    follow(asked);
  }

  function follow(asked) {
    const check = async () => {
      if (asked !== asking || !dialog.isConnected) return stopPolling();
      let found;
      try {
        found = await fetch(`/api/removal/plan?id=${plan.id}`).then(r => (r.ok ? r.json() : Promise.reject(new Error(r.statusText || `Error ${r.status}`))));
      } catch (error) {
        if (asked !== asking) return;
        stopPolling();
        // Snapshots made or changed meanwhile mean it's worked out again
        if (/expired/.test(error.message)) return start();
        failed = `Couldn't work it out: ${reason(error)}`;
        return draw();
      }
      if (asked !== asking) return;
      plan = found;
      if (plan.state === 'working') return draw();
      stopPolling();
      if (plan.state === 'failed') failed = `Couldn't work it out: ${plan.error}`;
      if (plan.state === 'done') return evaluate();
      draw();
    };
    check();
    polling = setInterval(check, 500);
  }

  // The numbers for the rules ticked, once it's worked out
  async function evaluate() {
    result = null;
    if (plan?.state !== 'done' || !tickedRules().length) return draw();
    const asked = asking;
    const rulesAsked = tickedRules().join('\n');
    draw();
    try {
      const found = await api.post('/api/removal/evaluate', { id: plan.id, rules: tickedRules() });
      if (asked !== asking || rulesAsked !== tickedRules().join('\n')) return;
      result = found;
    } catch (error) {
      if (asked !== asking) return;
      if (/expired/.test(error.message)) return start();
      failed = `Couldn't work it out: ${reason(error)}`;
    }
    draw();
  }

  // Where the files are removed from, in words
  const whereText = found => {
    const where = found.locations.filter(l => l.snapshots);
    return where.length === 1 ? el('b', {}, where[0].path)
      : el('b', { title: where.map(l => `${l.path} (${plural(l.snapshots, 'snapshot')})`).join('\n') }, plural(where.length, 'location'));
  };

  // Whether maintenance will free it, and where it runs, as it only runs on the PC that owns it
  function maintenanceLine() {
    const info = maintenanceInfo();
    if (!info) return null;
    if (!info.owner) return el('p', { class: 'warn' }, 'No PC owns Kopia\'s maintenance, so no space will be freed until one does.');
    if (!info.full.enabled) return el('p', { class: 'warn' }, 'Full maintenance is disabled, so no space will be freed until it\'s turned on.');
    return info.owner === info.me ? null : el('p', {}, `Maintenance only runs on ${info.owner}.`);
  }

  function draw() {
    if (!dialog.isConnected) return;
    drawRules();
    for (const key of keys) {
      const alone = plan?.state === 'done' && plan.rules[key];
      notes.get(key).textContent = alone?.files ? `${plural(alone.files, 'file')} (${formatSize(alone.bytes)})` : '';
    }
    const working = plan?.state === 'working' || (tickedLocations().length && !plan && !failed);
    let parts;
    if (failed) parts = [el('p', { class: 'error' }, failed)];
    else if (!tickedLocations().length) parts = [el('p', {}, 'Tick the locations to remove the files from.')];
    else if (working) {
      const total = plan?.total;
      parts = [el('p', {}, `${plan?.step || 'Starting'}…`),
        total ? el('div', { class: 'loading-bar' },
          el('span', { class: 'bar' }, el('span', { class: 'fill', style: `display:block;width:${100 * plan.done / total}%` })),
          `${plan.done.toLocaleString('en-GB')} of ${total.toLocaleString('en-GB')}`) : null,
        el('p', { class: 'muted' }, 'This reads every snapshot in the repository, so the first time can take a few minutes.')];
    } else if (!tickedRules().length) parts = [el('p', {}, 'Tick the rules to remove what they ignore.')];
    else if (!result) parts = [el('p', { class: 'muted' }, 'Adding it up…')];
    else if (!result.files) parts = [el('p', {}, 'Nothing to remove: the snapshots don\'t have any files these rules ignore.')];
    else {
      parts = [
        el('p', {}, `This will remove ${plural(result.files, 'file')} (${formatSize(result.bytes)}) from ${plural(result.snapshots, 'snapshot')} of `, whereText(result), '.'),
        result.freed
          ? [el('p', {}, `Roughly ${formatSize(result.freed)} of space will be freed by maintenance.`), maintenanceLine()]
          : el('p', {}, 'No space will be freed, as these files are all in other snapshots too.'),
      ];
    }
    if (result?.skipped) parts.push(el('p', { class: 'muted' }, `${plural(result.skipped, 'file')} can't be removed, as identical copies are kept elsewhere in the same snapshots.`));
    if (result?.files) parts.push(el('p', {}, 'It can\'t be undone.'));
    summary.replaceChildren(...parts.flat().filter(Boolean));
    remove.disabled = !result?.files;
    remove.textContent = result?.files ? `Remove from ${plural(result.snapshots, 'snapshot')}` : 'Remove';
  }

  const dialog = el('dialog', { class: 'confirm removal', 'aria-labelledby': 'removal-title' },
    el('h2', { id: 'removal-title' }, `${NAME}?`),
    el('p', { class: 'what' }, el('b', {}, shown.length === 1 ? shown[0].label : path)),
    el('p', {}, 'Removes the files these rules ignore from the snapshots already taken, so the space they use can be freed.',
      bringsBack ? ' Anything a ! rule brings back stays.' : ''),
    ruleList,
    locations.length > 1 || !path ? [
      el('p', {}, path ? `${path.replace(/\\$/, '')} is in ${plural(locations.length, 'location')}, which each read its .kopiaignore. Remove the files from the snapshots of:`
        : 'Remove the files from the snapshots of these locations, which go by the global ignore rules:'),
      el('ul', { class: 'removal-list locations' }, locations.map(loc => el('li', {}, el('label', { title: loc }, locationBoxes.get(loc), el('span', {}, loc))))),
    ] : null,
    locations.length ? summary : el('p', {}, 'None of the locations these rules apply in have any snapshots yet.'),
    el('div', { class: 'actions' }, cancel, remove));
  dialog.addEventListener('close', () => {
    stopPolling();
    asking++;
    if (plan?.state === 'working') api.post('/api/removal/cancel', { id: plan.id }).catch(() => {});
    dialog.remove();
  });
  document.body.append(dialog);
  dialog.showModal();
  cancel.focus();
  start();
}

// What a removal in the panel at the bottom is of, in words, for its tooltip: the rules, and where they're from
export const removalRules = j => `${listOf(j.rules.map(ruleLine))}, from ${j.name}`;
