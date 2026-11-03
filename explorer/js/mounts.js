// The Mounts window, from the header's drive button: every folder from a snapshot mounted as a drive, by Kopia
// Explorer or at the command line, with opening and unmounting each, and drives mounted through KopiaUI, which
// can only be opened, as which folder each is can't be found out. Those are read from the server when the window
// opens; the rest are the mounts the panel at the bottom follows. The button says how many of those there are.
import { el, formatFull } from './format.js';
import { driveName, jobActive, jobList, showInExplorer, unmount } from './jobs.js';
import { navigate } from './state.js';
import { storage } from './storage.js';

let dialog = null;

// Drives mounted through KopiaUI or another kopia server: undefined while being read, null if they couldn't be
let others;

let reads = 0;  // So only the latest read is shown, if it's read again before the last one's back

export function openMounts() {
  if (dialog) return;
  dialog = el('dialog', { class: 'confirm listing mounts', 'aria-labelledby': 'mounts-title' });
  dialog.addEventListener('close', () => {
    dialog.remove();
    dialog = null;
  });
  document.body.append(dialog);
  dialog.showModal();
  loadMounts();
  dialog.querySelector('[data-key="close"]').focus({ preventScroll: true });
}

async function loadMounts() {
  const read = ++reads;
  others = undefined;
  renderMounts();
  const found = await fetch('/api/other-mounts').then(response => (response.ok ? response.json() : null)).catch(() => null);
  if (read !== reads) return;
  others = found;
  renderMounts();
}

const mounts = () => jobList.filter(j => j.kind === 'mount' && jobActive(j));

// The count on the header's button, and the window while it's open, drawn again whenever what's going on the
// server changes, but only if it says something else, keeping the focus on the same button where it's still there
export function renderMounts() {
  document.getElementById('mounts-count').textContent = mounts().length || '';
  if (!dialog) return;
  const fresh = el('div', {},
    el('h2', { id: 'mounts-title' }, 'Mounts'),
    el('p', {}, 'Folders from snapshots mounted as read-only drives.'),
    el('ul', {}, rows()),
    el('div', { class: 'actions' }, el('button', { class: 'btn', 'data-key': 'close', onclick: () => dialog.close() }, 'Close')));
  if (fresh.innerHTML === dialog.innerHTML) return;
  const key = dialog.contains(document.activeElement) ? document.activeElement.dataset.key : null;
  dialog.replaceChildren(...fresh.childNodes);
  if (key) (dialog.querySelector(`[data-key="${CSS.escape(key)}"]`) || dialog.querySelector('[data-key="close"]')).focus();
}

function rows() {
  const items = [...mounts().map(mountRow), ...(others || []).map(otherRow)];
  if (others === undefined) items.push(el('li', { class: 'muted' }, 'Looking for drives mounted in KopiaUI…'));
  if (others === null) items.push(el('li', { class: 'c-removed' }, 'Couldn\'t look for drives mounted in KopiaUI'));
  return items.length ? items : el('li', { class: 'muted' }, 'Nothing\'s mounted');
}

const openButton = (drive, key) => el('button', {
  class: 'linklike', 'data-key': key, title: `Open ${driveName(drive)} in Windows Explorer`,
  onclick: event => showInExplorer(drive, event.currentTarget),
}, 'Open');

// A folder mounted by Kopia Explorer or at the command line: going to it, in the snapshot it's from, if that's
// known, opening it, and unmounting it, unless it's being mounted or unmounted
function mountRow(j) {
  const loc = j.snapshot && storage.find(l => l.snapshots.some(s => s.id === j.snapshot));
  const go = () => {
    dialog.close();
    navigate({ location: loc.path, snapshot: j.snapshot, scope: j.path, file: null, asOf: null });
  };
  const busy = { mounting: 'Mounting…', unmounting: 'Unmounting…' }[j.state];
  return el('li', {},
    el('div', { class: 'what' },
      loc ? el('button', { class: 'linklike', 'data-key': `go:${j.id}`, title: 'Go to it, in the snapshot it\'s from', onclick: go }, j.from)
        : el('b', {}, j.from),
      el('div', { class: 'detail' }, j.snapshotTime ? `As of ${formatFull(j.snapshotTime)}` : 'Not from a snapshot found here',
        j.found ? ' - found mounted, not mounted here' : '')),
    el('div', { class: 'status' }, busy ? el('span', { class: 'muted' }, busy) : [
      el('b', {}, driveName(j.drive)),
      openButton(j.drive, `open:${j.id}`),
      el('button', { class: 'linklike', 'data-key': `unmount:${j.id}`, title: 'Take the drive away again', onclick: () => unmount(j) }, 'Unmount'),
    ]));
}

// A drive mounted through KopiaUI, which can only be opened, as it's unmounted there
function otherRow(m) {
  return el('li', {},
    el('div', { class: 'what' }, el('b', {}, `Mounted in ${m.by}`),
      el('div', { class: 'detail' }, `Which folder it is can't be found out - unmount it in ${m.by}`)),
    el('div', { class: 'status' }, el('b', {}, driveName(m.drive)), openButton(m.drive, `open:${m.drive}`)));
}
