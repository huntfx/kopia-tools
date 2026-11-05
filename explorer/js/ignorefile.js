// A folder's .kopiaignore, for any folder in a backup location, or at its top: how many rules it has, shown under
// the snapshots panel's heading for the nearest location, and editing it, which writes the file, or deletes it when
// it's emptied. Rules from the .kopiaignore files of the folders above it in the location carry down into it, and
// the ignore rules in its policy apply as well, from the nearest policy that has any, as a list there replaces the
// one above, so both are shown with it.
import { DATA, api, redrawSoon } from './data.js';
import { el, formatSize, plural } from './format.js';
import { storage } from './storage.js';

// From the server, by lower-cased folder path: what's in the file, whether it's there and whether the folder's
// on disk, whether kopia reads it, the policy's rules and where they're set, and the rules carried down from
// above; null if it couldn't be read. Loaded when the folder's first shown, and again once it's saved.
const files = new Map();
const loading = new Map();

function loadIgnoreFile(path) {
  const key = path.toLowerCase();
  if (files.has(key)) return Promise.resolve(files.get(key));
  if (!loading.has(key)) {
    loading.set(key, fetch(`/api/ignore-file?path=${encodeURIComponent(path)}`)
      .then(response => (response.ok ? response.json() : null)).catch(() => null)
      .then(found => {
        loading.delete(key);
        files.set(key, found);
        redrawSoon();
        return found;
      }));
  }
  return loading.get(key);
}

// The lines kopia uses, leaving out blank ones and comments
const rulesIn = content => content.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));

// Where the policy's rules are set, in words
const policyName = (file, path) => (file.policyFrom === path ? 'its own policy' : file.policyFrom);

// The file's name, with its folder's when it isn't a location's, like Python\.kopiaignore
const fileName = (path, loc) => (path.toLowerCase() === loc.path.toLowerCase() ? '.kopiaignore'
  : `${path.replace(/\\$/, '').split('\\').pop()}\\.kopiaignore`);

// Under the heading of the nearest location: how many rules the folder being looked at has in its .kopiaignore,
// with what else applies in the tooltip, and changing it, which can start before it's loaded. Not for a folder
// that's only in snapshots, as there's nowhere to put one.
export function ignoreLine(path, loc) {
  const key = path.toLowerCase();
  if (!files.has(key)) loadIgnoreFile(path);
  const file = files.get(key);
  if (file && !file.onDisk) return null;
  const name = fileName(path, loc);
  const change = el('button', { class: 'linklike', onclick: () => ignoreDialog(path, loc) }, 'Change…');
  if (file === undefined) return el('div', { class: 'schedule' }, el('span', { class: 'muted' }, '…'), change);
  if (file === null) return el('div', { class: 'schedule' }, el('span', { class: 'muted', title: `Couldn't read ${name}` }, `${name} ?`), change);
  const rules = rulesIn(file.content);
  const title = [file.exists ? `${name}:\n${rules.join('\n') || '(no rules)'}` : `No ${name}`,
    ...file.above.map(a => `\nCarried down from ${a.path}:\n${a.rules.join('\n')}`),
    file.policyRules.length ? `\nAlso ignored by ${policyName(file, file.location)}:\n${file.policyRules.join('\n')}` : null].filter(Boolean).join('\n');
  return el('div', { class: 'schedule' },
    file.exists ? el('span', { title }, `${plural(rules.length, 'ignore rule')} in ${name}`) : el('span', { class: 'muted', title }, `No ${name}`),
    file.exists && !file.read ? el('span', { class: 'warn', title: `The policy here doesn't read ${file.name} files, so kopia won't use it` }, 'Not read') : null,
    change);
}

// Kopia's page about .kopiaignore, shown in the explorer, over the editor, so what's typed stays as it is
const DOCS = 'https://kopia.io/docs/advanced/kopiaignore/';

function docsDialog() {
  const dialog = el('dialog', { class: 'confirm docs', 'aria-label': 'Kopia\'s documentation on .kopiaignore' },
    el('iframe', { src: DOCS, title: 'Kopia\'s documentation on .kopiaignore' }),
    el('div', { class: 'actions' }, el('button', { class: 'btn', onclick: () => dialog.close() }, 'Close')));
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

// Rules shown under the box, folded away: carried down from a folder above, or from the policy, or the locations
// with their own
const ruleList = (summary, lines, word = 'rule') => el('details', { class: 'other-rules' },
  el('summary', {}, `${summary} (${plural(lines.length, word)})`), el('pre', {}, lines.join('\n')));

// Edit a folder's .kopiaignore. It opens straight away, filling in once the file's loaded, and can't be saved
// until then. Saved empty, the file's deleted. Every location it's in has its snapshots' changes worked out
// again, as which removed files count as ignored goes by the rules there are now, and the folders inside it are
// read again, as what carries down into them has changed.
// ---- Notes on the lines being edited ----

// What new rules would leave out of the latest snapshots, by folder (or the global policy, as null) and rule, as
// the server works it out, kept while the page is open: the first check of a location after it's backed up can
// take a minute or two, as kopia lists its whole snapshot
const drops = new Map();

const dropKey = (path, line) => `${path ?? ''}\n${line}`;

// What a rule would leave out, in words
function dropText(found, global) {
  if (!found.files && !found.folders) return { text: 'Matches nothing in the latest snapshot', kind: 'muted' };
  const what = found.folders ? plural(found.folders, 'folder') : plural(found.files, 'file');
  const where = global && found.locations > 1 ? ` across ${plural(found.locations, 'location')}` : '';
  return { text: `Would leave out ${what}${where} (${formatSize(found.bytes)})`, kind: '' };
}

// A list under an editor's box, of the lines with something to say: a mistake, a line that changes nothing, or for
// a new line, what it would leave out of the latest snapshots, which is asked for once typing pauses. Others are
// other lists of rules that apply too, by name, so a line already in one says so. The global policy can't have
// comments, as kopia keeps its list sorted, which also stops ! lines bringing anything back. Blocked says whether
// it can't be saved as it is.
function ruleChecks({ text, path, global = false }) {
  const list = el('ul', { class: 'rule-checks', hidden: true });
  let saved = new Set();
  let others = [];
  let soon = null;
  const lines = () => text.value.split('\n').map(line => line.trim());
  const ask = rules => {
    for (const line of rules) drops.set(dropKey(path, line), 'checking');
    draw();
    api.post('/api/check-ignore', { path: global ? null : path, rules })
      .then(found => { for (const [line, result] of Object.entries(found)) drops.set(dropKey(path, line), result); })
      .catch(() => { for (const line of rules) drops.delete(dropKey(path, line)); })
      .finally(() => { if (list.isConnected) draw(); });
  };
  const noteFor = (line, i, all) => {
    if (global && line.startsWith('#')) return { text: 'Comments can\'t be kept in the global policy', kind: 'error' };
    if (!line || line.startsWith('#')) return null;
    if (global && line.startsWith('!')) return { text: 'Kopia keeps this list sorted, so this can\'t bring anything back', kind: 'warn' };
    if (/\\[A-Za-z0-9_.-]/.test(line)) return { text: 'Use / between folders, not \\', kind: 'warn' };
    const first = all.indexOf(line);
    if (first < i) return { text: `Same as line ${first + 1}`, kind: 'muted' };
    const elsewhere = others.find(o => o.rules.includes(line));
    if (elsewhere) return { text: `Already in ${elsewhere.name}`, kind: 'muted' };
    if (saved.has(line) || line.startsWith('!')) return null;
    const found = drops.get(dropKey(path, line));
    if (found === 'checking') return { text: 'Checking…', kind: 'muted' };
    return found ? dropText(found, global) : null;
  };
  const draw = () => {
    const all = lines();
    const notes = all.map((line, i) => [i, line, noteFor(line, i, all)]).filter(([, , note]) => note);
    list.hidden = !notes.length;
    list.replaceChildren(...notes.map(([i, line, note]) => el('li', {},
      el('span', { class: 'n' }, `Line ${i + 1}`), el('span', { class: 'rule' }, line), el('span', { class: `note ${note.kind}` }, note.text))));
  };
  const refresh = () => {
    draw();
    clearTimeout(soon);
    soon = setTimeout(() => {
      const wanted = [...new Set(lines())].filter(line => line && !line.startsWith('#') && !line.startsWith('!') && !saved.has(line)
        && !drops.has(dropKey(path, line)) && !/\\[A-Za-z0-9_.-]/.test(line));
      if (wanted.length) ask(wanted);
    }, 600);
  };
  text.addEventListener('input', refresh);
  return {
    element: list,
    // Once what's saved is loaded: its lines, which aren't new, and the other lists that apply
    start: (savedLines, otherLists = []) => {
      saved = new Set(savedLines.map(line => line.trim()));
      others = otherLists;
      refresh();
    },
    blocked: () => global && lines().some(line => line.startsWith('#')),
    stop: () => clearTimeout(soon),
  };
}

function ignoreDialog(path, loc) {
  if (document.querySelector('dialog.ignore-file')) return;
  const name = fileName(path, loc);
  const text = el('textarea', { rows: 12, spellcheck: false, 'aria-label': `${name} rules`, disabled: true, placeholder: 'Loading…' });
  const checks = ruleChecks({ text, path });
  const details = el('div', {});
  const error = el('p', { class: 'error', hidden: true });
  const cancel = el('button', { class: 'btn', onclick: () => dialog.close() }, 'Cancel');
  let file = null;
  const save = el('button', {
    class: 'btn primary', disabled: true,
    onclick: async () => {
      save.disabled = cancel.disabled = true;
      let saved;
      try {
        saved = await api.post('/api/ignore-file', { path, content: text.value });
      } catch (e) {
        error.textContent = `Couldn't save it: ${e instanceof TypeError ? 'can\'t reach the server' : e.message}`;
        error.hidden = false;
        save.disabled = cancel.disabled = false;
        return;
      }
      const key = path.toLowerCase();
      for (const other of [...files.keys()].filter(k => k.startsWith(`${key.replace(/\\$/, '')}\\`))) files.delete(other);
      files.set(key, saved);
      const inside = l => (`${key}\\`).startsWith(`${l.path.replace(/\\$/, '').toLowerCase()}\\`);
      const ids = new Set(storage.filter(inside).flatMap(l => l.snapshots.map(s => s.id)));
      for (const diff of Object.keys(DATA.diffs).filter(k => k.split('..').some(id => ids.has(id)))) delete DATA.diffs[diff];
      dialog.close();
      redrawSoon();
    },
  }, 'Save');
  // Saving empty deletes it, which the button says
  const label = () => { save.textContent = !text.value.trim() && file?.exists ? 'Delete file' : 'Save'; };
  text.addEventListener('input', label);
  const dialog = el('dialog', { class: 'confirm ignore-file', 'aria-labelledby': 'ignore-file-title' },
    el('h2', { id: 'ignore-file-title' }, 'Ignore rules'),
    el('p', { class: 'what' }, el('b', {}, `${path.replace(/\\$/, '')}\\.kopiaignore`)),
    text,
    el('p', {}, el('button', { class: 'linklike', onclick: docsDialog }, 'Documentation')),
    checks.element,
    details,
    error,
    el('div', { class: 'actions' }, cancel, save));
  dialog.addEventListener('close', () => {
    checks.stop();
    dialog.remove();
  });
  document.body.append(dialog);
  dialog.showModal();
  loadIgnoreFile(path).then(found => {
    if (!dialog.isConnected) return;
    if (!found || !found.onDisk) {
      text.placeholder = '';
      error.textContent = found ? `There's no folder ${path} on this PC to put it in.` : `Couldn't read ${name}.`;
      error.hidden = false;
      return;
    }
    file = found;
    text.value = file.content;
    text.placeholder = '';
    text.disabled = false;
    save.disabled = false;
    label();
    checks.start(file.content.split('\n'), [
      ...file.above.map(a => ({ name: a.path, rules: a.rules })),
      ...(file.policyRules.length ? [{ name: policyName(file, file.location), rules: file.policyRules }] : []),
    ]);
    details.replaceChildren(...[
      !file.read ? el('p', { class: 'warn' }, `The policy here doesn't read ${file.name} files, so kopia won't use it.`) : null,
      ...file.above.map(a => ruleList(`Carried down from ${a.path}`, a.rules)),
      file.policyRules.length ? ruleList(`Also ignored by ${policyName(file, file.location)}`, file.policyRules) : null,
    ].filter(Boolean));
    text.focus();
  });
}

// ---- The global policy's ignore rules ----

// From the server: the global policy's rules, and the locations with a list of their own, which replaces them;
// null if it couldn't be read. Loaded when the PC's page is first shown, and again once they're saved.
let global;
let globalLoading = null;

function loadGlobalIgnore() {
  if (global !== undefined) return Promise.resolve(global);
  globalLoading ||= fetch('/api/global-ignore')
    .then(response => (response.ok ? response.json() : null)).catch(() => null)
    .then(found => {
      globalLoading = null;
      global = found;
      redrawSoon();
      return found;
    });
  return globalLoading;
}

// The locations that don't go by them, in words, for tooltips and the editor
const replacedText = found => `${plural(found.replaced.length, 'location')} ${found.replaced.length === 1 ? 'has' : 'have'} a list of ${found.replaced.length === 1 ? 'its' : 'their'} own, which replaces these:\n${found.replaced.join('\n')}`;

// Under the global policy's schedule on the PC's page: how many ignore rules it has, and changing them, which
// can start before they're loaded
export function globalIgnoreLine() {
  if (global === undefined) loadGlobalIgnore();
  const change = el('button', { class: 'linklike', onclick: globalIgnoreDialog }, 'Change…');
  if (global === undefined) return el('div', { class: 'schedule' }, el('span', { class: 'muted' }, '…'), change);
  if (global === null) return el('div', { class: 'schedule' }, el('span', { class: 'muted', title: 'Couldn\'t read the global policy\'s ignore rules' }, 'Ignore rules ?'), change);
  const title = [global.rules.join('\n') || 'None', global.replaced.length ? `\n${replacedText(global)}` : null].filter(Boolean).join('\n');
  return el('div', { class: 'schedule' },
    el('span', { title }, global.rules.length ? `${plural(global.rules.length, 'ignore rule')} in the global policy` : 'No ignore rules in the global policy'),
    change);
}

// Edit the global policy's ignore rules. Kopia keeps them sorted, so there can't be comments, which it would keep
// as rules and move, and a ! rule ends up before what it's meant to bring back, so can't, which it warns about.
// Every location's ignore rules and changes are read again after, as any may have changed.
function globalIgnoreDialog() {
  if (document.querySelector('dialog.ignore-file')) return;
  const text = el('textarea', { rows: 14, spellcheck: false, 'aria-label': 'Global ignore rules', disabled: true, placeholder: 'Loading…' });
  const checks = ruleChecks({ text, global: true });
  const details = el('div', {});
  const error = el('p', { class: 'error', hidden: true });
  const cancel = el('button', { class: 'btn', onclick: () => dialog.close() }, 'Cancel');
  const rules = () => text.value.split('\n').map(line => line.trim()).filter(Boolean);
  const save = el('button', {
    class: 'btn primary', disabled: true,
    onclick: async () => {
      save.disabled = cancel.disabled = true;
      let saved;
      try {
        saved = await api.post('/api/global-ignore', { rules: rules() });
      } catch (e) {
        error.textContent = `Couldn't save them: ${e instanceof TypeError ? 'can\'t reach the server' : e.message}`;
        error.hidden = false;
        save.disabled = cancel.disabled = false;
        return;
      }
      global = saved;
      files.clear();
      for (const diff of Object.keys(DATA.diffs)) delete DATA.diffs[diff];
      dialog.close();
      redrawSoon();
    },
  }, 'Save');
  // A comment can't be saved in the global policy, which the line's note says
  const checkRules = () => { save.disabled = checks.blocked() || text.disabled; };
  text.addEventListener('input', checkRules);
  const dialog = el('dialog', { class: 'confirm ignore-file', 'aria-labelledby': 'ignore-file-title' },
    el('h2', { id: 'ignore-file-title' }, 'Ignore rules'),
    el('p', { class: 'what' }, el('b', {}, 'Global policy')),
    text,
    el('p', {}, el('button', { class: 'linklike', onclick: docsDialog }, 'Documentation')),
    checks.element,
    details,
    error,
    el('div', { class: 'actions' }, cancel, save));
  dialog.addEventListener('close', () => {
    checks.stop();
    dialog.remove();
  });
  document.body.append(dialog);
  dialog.showModal();
  loadGlobalIgnore().then(found => {
    if (!dialog.isConnected) return;
    if (!found) {
      text.placeholder = '';
      error.textContent = 'Couldn\'t read the global policy\'s ignore rules.';
      error.hidden = false;
      return;
    }
    text.value = found.rules.join('\n');
    text.placeholder = '';
    text.disabled = false;
    checks.start(found.rules);
    checkRules();
    details.replaceChildren(...[found.replaced.length ? ruleList('Not used by locations with a list of their own', found.replaced, 'location') : null].filter(Boolean));
    text.focus();
  });
}
