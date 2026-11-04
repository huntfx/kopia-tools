// Snapshot actions: kopia only runs the scripts policies say to run before and after snapshots once actions are
// enabled in its config, which KopiaUI has no setting for, so policies with actions while they're disabled are
// warned about above the panel at the bottom, with enabling them, which the Settings window does too. KopiaUI only
// reads the config when it starts, so after they're enabled, it's said until it's been restarted. The server's
// asked every half minute, while the page is showing, so the notice goes however they were enabled.
import { api } from './data.js';
import { el, joined } from './format.js';
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

function changed() {
  renderNotice();
  renderSettings();
}

export async function checkActions() {
  const found = await fetch('/api/actions').then(response => (response.ok ? response.json() : null)).catch(() => null);
  if (!found) return;
  actions = found;
  changed();
}

setInterval(() => {
  if (!document.hidden) checkActions();
}, TICK);

export async function setActions(enabled) {
  changing = true;
  changeError = null;
  changed();
  try {
    actions = await api.post('/api/actions', { enabled });
  } catch (error) {
    changeError = `Couldn't ${enabled ? 'enable' : 'disable'} actions: ${error instanceof TypeError ? 'can\'t reach the server' : error.message}`;
  }
  changing = false;
  changed();
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
