// Snapshot actions: kopia only runs the scripts policies say to run before and after snapshots once actions are
// enabled in its config, which KopiaUI has no setting for, so policies with actions while they're disabled are
// warned about above the panel at the bottom, with enabling them, which the Settings window does too. KopiaUI only
// reads the config when it starts, so after they're enabled, it's said until it's been restarted. The server's
// asked every half minute, while the page is showing, so the notice goes however they were enabled. What a
// location's own policy runs before and after its snapshots is shown under its schedule, and changed from there.
import { api, redrawSoon } from './data.js';
import { el, joined, listOf } from './format.js';
import { renderNotice } from './jobs.js';
import { renderSettings } from './settings.js';
import { navigate } from './state.js';
import { storage } from './storage.js';

const TICK = 30 * 1000;

// From the server: whether actions are enabled (null if it couldn't tell), the policies with any, each with what
// it's for, its folder if it's one, and what its actions run, where the Kopia config is, and whether KopiaUI was
// started before it last changed. Null until it's been asked.
export let actions = null;

// The notice put off, until it would say something else
let putOff = null;

// Being enabled or disabled from here, or why it couldn't be
export let changing = false;
export let changeError = null;

// Everything showing it drawn again, the page only if they've changed, as it's asked about every half minute
function changed(found = actions) {
  const redraw = JSON.stringify(found) !== JSON.stringify(actions);
  actions = found;
  renderNotice();
  renderSettings();
  if (redraw) redrawSoon();
}

export async function checkActions() {
  const found = await fetch('/api/actions').then(response => (response.ok ? response.json() : null)).catch(() => null);
  if (found) changed(found);
}

setInterval(() => {
  if (!document.hidden) checkActions();
}, TICK);

export async function setActions(enabled) {
  changing = true;
  changeError = null;
  changed();
  let found = actions;
  try {
    found = await api.post('/api/actions', { enabled });
  } catch (error) {
    changeError = `Couldn't ${enabled ? 'enable' : 'disable'} actions: ${error instanceof TypeError ? 'can\'t reach the server' : error.message}`;
  }
  changing = false;
  changed(found);
}

// Under the schedule of the location being looked at: what its own policy runs around its snapshots, with
// changing that, once what's set is known
export function actionsLine(loc) {
  if (!actions) return null;
  const own = actions.policies.find(p => p.path === loc.path);
  return el('div', { class: 'schedule' },
    own ? el('span', { title: own.actions.map(a => `${a.when}: ${a.script}`).join('\n') },
      `Actions ${listOf(own.actions.map(a => a.when.toLowerCase()))}`) : el('span', { class: 'muted' }, 'No actions'),
    own && actions.enabled === false ? el('span', { class: 'warn', title: 'Actions are globally disabled in the Kopia config - enable them in Settings' }, 'Disabled') : null,
    el('button', { class: 'linklike', onclick: () => actionsDialog(loc.path) }, 'Change…'));
}

// KopiaUI's names for what happens if an action fails, by kopia's. Must succeed is the default, as KopiaUI shows
// it for an action with none set, and kopia policy set sets it, so it's saved as that. Kopia itself only stops
// the snapshot if it's set, though, so saving one with none set makes it do as KopiaUI says.
const MODES = { essential: 'Must succeed', optional: 'Ignore failures', async: 'Run asynchronously, ignore failures' };

// Change what a location's own policy runs before and after its snapshots, as KopiaUI's policy editor does:
// each a script, with how long it can take and what happens if it fails. Emptied, it's taken out.
export function actionsDialog(path) {
  if (document.querySelector('dialog.location-actions')) return;
  const own = actions?.policies.find(p => p.path === path);
  const field = (kind, label) => {
    const action = own?.actions.find(a => a.kind === kind);
    const script = el('textarea', { rows: 3, spellcheck: false, 'aria-label': label });
    script.value = action?.script ?? '';
    const timeout = el('input', { type: 'number', min: 1, placeholder: 'Default', value: action?.timeout ?? '', 'aria-label': `${label} timeout in seconds` });
    const mode = el('select', { 'aria-label': `${label} mode` }, Object.entries(MODES).map(([value, name]) => el('option', { value }, name)));
    mode.value = action?.mode || 'essential';
    return {
      element: el('div', { class: 'action-field' },
        el('label', {}, el('b', {}, label), script),
        el('div', { class: 'action-options' },
          el('label', { title: 'How long it can take before it\'s stopped - left empty, none is saved, and kopia allows 3 minutes' }, 'Timeout', timeout, 'seconds'),
          el('label', {}, 'Mode', mode))),
      value: () => ({ script: script.value, timeout: timeout.value ? Number(timeout.value) : null, mode: mode.value }),
      script,
    };
  };
  const before = field('beforeSnapshotRoot', 'Before snapshot');
  const after = field('afterSnapshotRoot', 'After snapshot');
  const folderActions = own?.actions.some(a => !a.kind.endsWith('SnapshotRoot'));
  const error = el('p', { class: 'error', hidden: true });
  const cancel = el('button', { class: 'btn', onclick: () => dialog.close() }, 'Cancel');
  const save = el('button', {
    class: 'btn primary',
    onclick: async () => {
      save.disabled = cancel.disabled = true;
      try {
        const found = await api.post('/api/location-actions', { path, before: before.value(), after: after.value() });
        dialog.close();
        changed(found);
      } catch (e) {
        error.textContent = `Couldn't change them: ${e instanceof TypeError ? 'can\'t reach the server' : e.message}`;
        error.hidden = false;
        save.disabled = cancel.disabled = false;
      }
    },
  }, 'Save');
  const dialog = el('dialog', { class: 'confirm location-actions', 'aria-labelledby': 'location-actions-title' },
    el('h2', { id: 'location-actions-title' }, 'Snapshot actions'),
    el('p', { class: 'what' }, el('b', {}, path)),
    before.element,
    after.element,
    el('p', {}, 'Each runs as a batch file in a temporary folder, with the folder being backed up in %KOPIA_SOURCE_PATH%. Put paths with spaces in quotes.'),
    folderActions ? el('p', {}, 'Its folder actions are kept as they are.') : null,
    actions?.enabled === false ? el('p', { class: 'warn' }, 'Actions are globally disabled in the Kopia config, so these won\'t run until they\'re enabled in Settings.') : null,
    el('p', {}, 'KopiaUI picks up the change when it next refreshes, within 4 hours.'),
    error,
    el('div', { class: 'actions' }, cancel, save));
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  before.script.focus();
}

// A policy's name, linking to its location's page if it's for one, with the user's, the computer's or the global
// policy said in words, starting a sentence or not
export function policyName(policy, close = () => {}, first = false) {
  const loc = policy.path && storage.find(l => l.path === policy.path);
  if (loc) {
    return el('button', { class: 'linklike', 'data-key': `go:${loc.path}`, title: `Open ${loc.path}`, onclick: () => { close(); navigate({ location: loc.path, snapshot: null }); } }, loc.path);
  }
  return el('b', {}, first ? policy.name[0].toUpperCase() + policy.name.slice(1) : policy.name);
}

// Which notice there is: none, actions disabled, or KopiaUI not running them yet
function showing() {
  if (!actions?.policies.length) return null;
  if (actions.enabled === false) return 'off';
  return actions.enabled && actions.kopiaUIBehind ? 'behind' : null;
}

// The notice above the panel at the bottom, unless put off
export function actionsNotice() {
  const which = showing();
  if (!which || putOff === which) return null;
  // Putting it off, or just taking it away where there's nothing to do from here, as with restarting KopiaUI
  const close = label => el('button', { class: 'linklike', onclick: () => { putOff = which; changeError = null; renderNotice(); } }, label);
  if (which === 'behind') {
    return [
      el('h2', {}, 'KopiaUI not running actions'),
      el('p', {}, 'Actions are enabled, but KopiaUI won\'t run them in scheduled backups until it\'s restarted from its tray icon.'),
      el('div', { class: 'actions' }, close('OK')),
    ];
  }
  const named = actions.policies.map((policy, i) => policyName(policy, undefined, i === 0));
  return [
    el('h2', {}, 'Actions disabled'),
    el('p', {}, joined(named), named.length === 1 ? ' has' : ' have',
      ' actions that will not run, as they are globally disabled in the Kopia config.'),
    changeError ? el('p', { class: 'c-removed' }, changeError) : null,
    el('div', { class: 'actions' },
      el('button', { class: 'btn', disabled: changing, title: `Set enableActions in the Kopia config, ${actions.config}`, onclick: () => setActions(true) },
        changing ? 'Enabling actions…' : 'Enable actions'),
      close('Not now')),
  ];
}
