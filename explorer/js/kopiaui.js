// KopiaUI: its server makes the scheduled snapshots, so none are made while it isn't running, which is warned
// about above the panel at the bottom, with starting it. The server's asked every half minute, while the page
// is showing, so the notice goes once it's running again, however it was started.
import { api } from './data.js';
import { el } from './format.js';
import { renderNotice } from './jobs.js';
import { pageHidden, whenShown } from './shown.js';

const TICK = 30 * 1000;

// From the server: whether it's running (null if it couldn't tell), when its server started, and whether it can
// be started from here
let kopiaUI = null;

// When KopiaUI's server started, in milliseconds, or null if it isn't running or that isn't known
export const kopiaUIStarted = () => (kopiaUI?.running && kopiaUI.since ? kopiaUI.since * 1000 : null);

// Put off until it's next running, so it's only said again once it's closed again
let putOff = false;

// Started from here, and not seen running yet, or why it couldn't be
let starting = false;
let startError = null;

export async function checkKopiaUI() {
  const found = await fetch('/api/kopiaui').then(response => (response.ok ? response.json() : null)).catch(() => null);
  if (!found) return;
  kopiaUI = found;
  if (kopiaUI.running) putOff = starting = false;
  renderNotice();
}

setInterval(() => {
  if (!pageHidden()) checkKopiaUI();
}, TICK);
whenShown(checkKopiaUI);

// Asked again every couple of seconds until it's running, which takes a few, or giving up after a minute
async function startKopiaUI() {
  starting = true;
  startError = null;
  renderNotice();
  try {
    await api.post('/api/kopiaui/start', {});
  } catch (error) {
    starting = false;
    startError = error instanceof TypeError ? 'can\'t reach the server' : error.message;
    renderNotice();
    return;
  }
  for (let tries = 0; tries < 30 && starting; tries++) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    await checkKopiaUI();
  }
  if (starting) {
    starting = false;
    startError = 'it hasn\'t started yet';
    renderNotice();
  }
}

// The notice above the panel at the bottom while KopiaUI isn't running, unless put off
export function kopiaUINotice() {
  if (kopiaUI?.running !== false || putOff) return null;
  return [
    el('h2', {}, 'KopiaUI not running'),
    el('p', {}, 'KopiaUI is not currently running. Scheduled backups will resume once it\'s started.'),
    startError ? el('p', { class: 'c-removed' }, `Couldn't start KopiaUI: ${startError}`) : null,
    el('div', { class: 'actions' },
      kopiaUI.startable ? el('button', { class: 'btn', disabled: starting, onclick: startKopiaUI }, starting ? 'Starting KopiaUI…' : 'Start KopiaUI') : null,
      el('button', { class: 'linklike', onclick: () => { putOff = true; startError = null; renderNotice(); } }, 'Not now')),
  ];
}
