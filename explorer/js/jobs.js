// Restores, backups, deletes and settings changes, which run on the server, and the panel at the bottom that
// follows them
import { actionsNotice } from './actions.js';
import { api, redrawSoon } from './data.js';
import { loadFixes, renderFixes } from './fixes.js';
import { el, formatFull, formatSize, formatTime, listOf, plural, shortId } from './format.js';
import { kopiaUINotice } from './kopiaui.js';
import { renderMounts } from './mounts.js';
import { LAST_GOOD, failingNotice } from './lastgood.js';
import { render } from './render.js';
import { schedules } from './schedules.js';
import { KEEP_KINDS } from './snapshots.js';
import { navigate, writeHash } from './state.js';
import { applyJobs, followRenamed, latest, refreshStorage, snapshotsChanged, storage, unfinished } from './storage.js';

// Restores and backups run on the server, and the panel at the bottom follows them. A restore asks where in
// a folder picker, then has kopia write it there, so it keeps its modified times; a backup takes a snapshot
// of a location now, as a scheduled one would.
export let jobList = [];

export let jobsShown = false;

export let jobPolling = null;

export let jobsUnreachable = false;  // The server stopped answering while following them

// Still going: choosing where, restoring, moving the finished restore into place, backing up or changing
// settings, cancelling, deleting a snapshot, finding the locations whose settings to change, waiting for
// another settings change to finish, or a folder mounted as a drive, or being mounted or unmounted
export const jobActive = j => ['picking', 'restoring', 'finishing', 'running', 'cancelling', 'deleting', 'checking', 'waiting',
  'mounting', 'mounted', 'unmounting'].includes(j.state);

// Going, and changing, so followed: not a folder that's just mounted, which stays that way until it's unmounted
const jobMoving = j => jobActive(j) && j.state !== 'mounted';

// Locations inside others whose settings aren't used in the backups of the locations they're in, warned about
// when the page opens, above the panel at the bottom, until copied in or put off
export let settingsOffer = null;

export function offerSettings(needing) {
  settingsOffer = needing.length ? needing : null;
  renderNotice();
}

// Copy settings into locations inside others, or take them out again: the given ones, or without any, every one
// that needs them, or every one that has them
export function changeSettings(undo, paths = null) {
  if (!undo) {
    settingsOffer = paths ? settingsOffer?.filter(n => !paths.includes(n.path)) || null : null;
    if (!settingsOffer?.length) settingsOffer = null;
    renderNotice();
  }
  jobsShown = true;
  startJob('/api/copied-settings', { undo, paths },
    { kind: 'settings', name: 'settings', undo, items: (paths || []).map(path => ({ path, state: 'failed' })) });
}

// Whether a snapshot is being deleted, so it can't be opened or restored from meanwhile; once deleted, it's
// still listed until the snapshots have been read again
export const beingDeleted = snap => jobList.some(j => j.kind === 'delete' && j.snapshot === snap.id && j.state !== 'failed');

// A location's backup still going, if there is one
export const backupOf = loc => jobList.find(j => j.kind === 'backup' && j.source === loc.path && jobActive(j));

// Restore a file or folder (rel inside the location, '' for all of it) as it was in a snapshot
export function restoreItem(snap, rel, folder) {
  jobsShown = true;
  // One at a time while choosing where: the panel shows the one waiting instead of queueing another
  if (jobList.some(j => j.state === 'picking')) return renderJobs();
  startJob('/api/restore', { snapshot: snap.id, path: rel, folder },
    { kind: 'restore', name: rel.split('/').pop() || 'this location', snapshotTime: snap.time });
}

// The drive last mounted on, offered again while it's free
let lastDrive = null;

// Mount a folder (rel inside the location, '' for all of it) as it was in a snapshot as a drive, once a dialog
// has asked which, offering the free ones. It opens in Explorer once it's ready. One mounted already is just
// opened again.
async function mountFolder(snap, rel) {
  if (mountOf(snap, rel)) return mountOn(snap, rel, null);
  const loc = storage.find(l => l.snapshots.includes(snap));
  const drives = await fetch('/api/free-drives').then(r => (r.ok ? r.json() : null)).catch(() => null);
  const select = el('select', { disabled: !drives?.length }, (drives || []).map(drive => el('option', { value: drive }, drive)));
  // The last free one, as Windows picks, unless another was picked last time and is still free
  select.value = drives?.includes(lastDrive) ? lastDrive : drives?.at(-1) ?? '';
  const cancel = el('button', { class: 'btn', onclick: () => dialog.close() }, 'Cancel');
  const go = el('button', {
    class: 'btn primary', disabled: !drives?.length,
    onclick: () => {
      lastDrive = select.value;
      dialog.close();
      mountOn(snap, rel, select.value);
    },
  }, 'Mount');
  const dialog = el('dialog', { class: 'confirm', 'aria-labelledby': 'confirm-title' },
    el('h2', { id: 'confirm-title' }, 'Mount as a drive?'),
    el('p', { class: 'what' }, el('b', {}, rel ? `${loc.path.replace(/\\$/, '')}\\${rel.replaceAll('/', '\\')}` : loc.path),
      `, ${formatFull(snap.time)} (${shortId(snap.id)})`),
    el('label', { class: 'field' }, 'Drive', select),
    drives?.length ? el('p', {}, rel ? 'Mounts the folder from the snapshot as a read-only drive in Explorer.' : 'Mounts the snapshot as a read-only drive in Explorer.')
      : el('p', { class: 'error' }, drives ? 'There are no free drive letters to mount it on.' : 'Couldn\'t find out which drive letters are free.'),
    el('div', { class: 'actions' }, cancel, go));
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  (drives?.length ? go : cancel).focus();
}

// A folder's mount still going, if it's mounted, or being mounted or unmounted: by what's mounted, so any
// snapshot with the same contents has it too, as it's only one of them a mount found running is put down to
const mountOf = (snap, rel) => jobList.find(j => j.kind === 'mount' && j.obj === (rel ? `${snap.root}/${rel}` : snap.root) && jobActive(j));

// A drive as it's shown, like Y:, without the backslash that opens it
export const driveName = drive => drive?.replace(/\\$/, '');

// Mount a folder as it was in a snapshot as a drive, or once it's mounted, unmount it
export function mountButton(snap, rel, present) {
  const job = mountOf(snap, rel);
  const deleting = beingDeleted(snap);
  const drive = driveName(job?.drive);
  return el('button', {
    class: 'btn mount', 'data-snapshot': snap.id, 'data-path': rel, 'data-present': present ? '1' : '',
    disabled: job ? job.state !== 'mounted' : !present || deleting,
    title: job?.state === 'mounted' ? `Take drive ${drive} away again`
      : job ? null
      : !present ? 'It isn\'t in this snapshot'
      : deleting ? 'This snapshot is being deleted'
      : `Mount it as a read-only drive in Explorer, as it was on ${formatFull(snap.time)}`,
    onclick: () => (job ? unmount(job) : mountFolder(snap, rel)),
  }, { mounting: 'Mounting…', mounted: `Unmount ${drive}`, unmounting: 'Unmounting…' }[job?.state] || 'Mount as drive…');
}

function mountOn(snap, rel, drive) {
  jobsShown = true;
  startJob('/api/mount', { snapshot: snap.id, path: rel, drive },
    { kind: 'mount', name: rel.split('/').pop() || 'this location', snapshotTime: snap.time });
}

export async function unmount(job) {
  try {
    Object.assign(job, await api.post('/api/unmount', { id: job.id }));
  } catch (error) {
    job.error = `Couldn't unmount: ${error instanceof TypeError ? 'can\'t reach the server' : error.message}`;
  }
  jobsChanged();
  followJobs();
}

// Back up a location now, or a folder inside one on its own, which makes it a location of its own
export function backUp(path) {
  jobsShown = true;
  startJob('/api/backup', { source: path }, { kind: 'backup', name: path, source: path });
}

// Start a restore, backup, mount or delete, or if the server won't, list it as failed, saying why. A mount
// already going comes back as it is, so it's listed once.
export async function startJob(url, body, job) {
  try {
    const started = await api.post(url, body);
    jobList = [...jobList.filter(j => j.id !== started.id), started];
  } catch (error) {
    jobList = [...jobList, { ...job, id: `failed-${Date.now()}`, state: 'failed',
      error: error instanceof TypeError ? 'Can\'t reach the server' : error.message }];
  }
  jobsChanged();
  followJobs();
}

// The panel at the bottom, the snapshots panel's backup buttons, one for each location, the Snapshot panel's
// mount button, and the Mounts and Fixes windows, which say whether one's going
export function jobsChanged() {
  renderJobs();
  renderFixes();
  renderMounts();
  for (const button of document.querySelectorAll('.backup-now')) {
    const loc = storage.find(l => l.path === button.dataset.location);
    if (loc) button.replaceWith(backupButton(loc));
  }
  for (const button of document.querySelectorAll('.btn.mount')) {
    const snap = storage.flatMap(l => l.snapshots).find(s => s.id === button.dataset.snapshot);
    if (snap) button.replaceWith(mountButton(snap, button.dataset.path, !!button.dataset.present));
  }
}

// Back up a location now, or while it's being backed up, cancel that
export function backupButton(loc) {
  const job = backupOf(loc);
  const button = el('button', {
    class: 'btn backup-now', style: 'font-size:0.8rem;flex:none', 'data-location': loc.path,
    disabled: job?.state === 'cancelling',
    title: job ? 'Stop it, keeping what it got through as an incomplete snapshot' : `Take a snapshot of ${loc.path} now, as its schedule would`,
    onclick: () => (job ? cancelBackup(job) : backUp(loc.path)),
  }, job?.state === 'cancelling' ? 'Cancelling…' : job ? 'Cancel backup' : 'Back up now');
  return button;
}

export async function cancelBackup(job) {
  try {
    Object.assign(job, await api.post('/api/backup/cancel', { id: job.id }));
  } catch (error) {
    job.error = `Couldn't cancel: ${error instanceof TypeError ? 'can\'t reach the server' : error.message}`;
  }
  jobsChanged();
}

// Delete a snapshot for good, once a dialog has said exactly what goes: the whole snapshot of the
// location, whatever's being looked at inside it, and what that does and doesn't free up. It's deleted in
// the background, followed in the panel at the bottom, with its row marked until it's gone.
export function confirmDelete(loc, snap, rel, isFolder) {
  const kept = KEEP_KINDS.find(([kind]) => snap.keep?.some(r => r.startsWith(`${kind}-`)));
  const cancel = el('button', { class: 'btn', onclick: () => dialog.close() }, 'Cancel');
  const remove = el('button', {
    class: 'btn danger',
    onclick: () => {
      dialog.close();
      jobsShown = true;
      startJob('/api/snapshot/delete', { id: snap.id },
        { kind: 'delete', name: loc.path, source: loc.path, snapshot: snap.id, snapshotTime: snap.time }).then(render);
    },
  }, 'Delete');
  const inside = rel && `${rel.replaceAll('/', '\\')}${isFolder ? '\\' : ''}`;
  const dialog = el('dialog', { class: 'confirm', 'aria-labelledby': 'confirm-title' },
    el('h2', { id: 'confirm-title' }, 'Delete this snapshot?'),
    el('p', { class: 'what' }, el('b', {}, loc.path), `, ${formatFull(snap.time)} (${shortId(snap.id)})`,
      snap.size != null ? `, ${formatSize(snap.size)}` : '', snap.incomplete ? `, ${unfinished(snap).status.toLowerCase()}` : ''),
    el('p', {}, inside ? `This deletes the whole snapshot of ${loc.path}, not just ${inside}. ` : '', 'It can\'t be undone.'),
    // Earlier checkpoints of the same backup are shown as it, so they go too
    snap.checkpoints ? el('p', {}, `The ${plural(snap.checkpoints, 'earlier checkpoint')} kopia saved of the same backup ${snap.checkpoints === 1 ? 'goes' : 'go'} too.`) : null,
    kept && kept[0] !== 'latest' ? el('p', {}, `It's kept ${kept[1]} by kopia's retention policy at the moment, so another snapshot may take its place.`) : null,
    el('p', {}, 'Space on disk is only freed once kopia\'s maintenance runs, and only for data no other snapshot uses.'),
    el('div', { class: 'actions' }, cancel, remove));
  // Gone once closed, however that happens
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  cancel.focus();
}

// Being pinned or unpinned, which it can't be deleted meanwhile, as kopia gives it a new ID
export const beingPinned = snap => jobList.some(j => j.kind === 'pin' && j.snapshot === snap.id && jobActive(j));

// Pin a snapshot under names, so kopia's retention policy never deletes it, or take pins off it, in the
// background, followed in the panel at the bottom, which offers to undo it
export function changePins(loc, snap, add, remove) {
  jobsShown = true;
  startJob('/api/snapshot/pin', { id: snap.id, add, remove },
    { kind: 'pin', name: loc.path, source: loc.path, snapshot: snap.id, snapshotTime: snap.time, add, remove }).then(render);
}

// Pinning asks what to call the pin, as KopiaUI does, starting with the name KopiaUI suggests unless it's pinned
// as that already; unpinning takes off the pins given. Either way it's asked first, so it's never done by an
// accidental click.
export function confirmPin(loc, snap, remove = null) {
  const unpin = !!remove?.length;
  const pins = snap.pins || [];
  const name = el('input', { type: 'text', value: pins.includes('do-not-delete') ? '' : 'do-not-delete', autocomplete: 'off' });
  const error = el('p', { class: 'error', hidden: true });
  const cancel = el('button', { class: 'btn', onclick: () => dialog.close() }, 'Cancel');
  const go = el('button', {
    class: 'btn primary',
    onclick: () => {
      const pin = name.value.trim();
      if (!unpin && (!pin || pins.includes(pin))) {
        error.textContent = pin ? 'It\'s pinned as that already' : 'The pin needs a name';
        error.hidden = false;
        return name.focus();
      }
      dialog.close();
      changePins(loc, snap, unpin ? [] : [pin], unpin ? remove : []);
    },
  }, unpin ? 'Unpin' : 'Pin');
  name.addEventListener('keydown', event => { if (event.key === 'Enter') go.click(); });
  const dialog = el('dialog', { class: 'confirm', 'aria-labelledby': 'confirm-title' },
    // Headings are in capitals, so the pin's name, which they'd change, goes under it
    el('h2', { id: 'confirm-title' }, unpin ? `Remove the ${remove.length === 1 ? 'pin' : 'pins'}?` : 'Pin this snapshot?'),
    el('p', { class: 'what' }, el('b', {}, loc.path), `, ${formatFull(snap.time)} (${shortId(snap.id)})`,
      unpin ? `, pinned as ${pinNames(remove)}` : pins.length ? `, pinned as ${pinNames(pins)} already` : ''),
    unpin ? null : [el('label', { class: 'field' }, 'Name of the pin', name),
      el('p', {}, 'Kopia\'s retention policy never deletes a pinned snapshot. ',
        `One pinned as “${LAST_GOOD}” has the pin moved on to each new snapshot without missing files.`)],
    error,
    el('div', { class: 'actions' }, cancel, go));
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  if (unpin) cancel.focus();
  else name.select();
}

export const pinNames = pins => listOf(pins.map(p => `“${p}”`));

// Kopia saves a snapshot again under a new ID when it's pinned or unpinned, so once it's done, it's kept as the
// same object with that ID, and what's loaded or picked for it follows it there
function pinned(snap, info) {
  followRenamed(snap, info.id);
  Object.assign(snap, info);
}

// What's being opened in Explorer, so clicking again while it's on its way doesn't open it twice
const revealing = new Set();

// Open something in Windows Explorer, via the server; if that fails, the button says why
export function showInExplorer(path, button) {
  if (revealing.has(path)) return;
  revealing.add(path);
  api.post('/api/reveal', { path }).catch(error => {
    if (!button) return;
    button.textContent = `Couldn't open Explorer: ${error instanceof TypeError ? 'can\'t reach the server' : error.message}`;
  }).finally(() => revealing.delete(path));
}

// While a restore or backup is going, ask the server how it's getting on every second
export function followJobs() {
  if (jobPolling) return;
  jobPolling = setInterval(async () => {
    let list;
    try {
      list = await fetch('/api/jobs').then(r => r.json());
      jobsUnreachable = false;
    } catch {
      // Keep trying, as it may be restarting, but say so
      if (!jobsUnreachable) {
        jobsUnreachable = true;
        renderJobs();
      }
      return;
    }
    const ended = kind => list.some(j => j.kind === kind && !jobActive(j) && jobList.some(o => o.id === j.id && jobActive(o)));
    // A backup that's just ended has made a snapshot, even if cancelled, and a delete has removed one
    const snapshotsEnded = ended('backup') || ended('delete');
    const settingsEnded = ended('settings');
    const pinsEnded = ended('pin');
    const pinsDone = list.filter(j => j.kind === 'pin' && j.state === 'done' && jobList.some(o => o.id === j.id && jobActive(o)));
    jobList = list;
    // A snapshot pinned or unpinned is followed to its new ID
    for (const j of pinsDone) {
      const snap = storage.find(l => l.path === j.source)?.snapshots.find(s => s.id === j.snapshot);
      if (snap) pinned(snap, j.info);
    }
    if (pinsDone.length) writeHash(true);
    // Shown either way, as its buttons are back
    if (pinsEnded && !snapshotsEnded) snapshotsChanged();
    // Shown straight away, then read again for what isn't known yet. The panel links to a backup's snapshot
    // once it's among them, which may only be after this stops asking, so it's shown again then.
    if (snapshotsEnded) {
      applyJobs();
      snapshotsChanged();
      refreshStorage().then(jobsChanged);
    }
    jobsChanged();
    // Each location's settings are read again, as they're shown
    if (settingsEnded) {
      schedules.clear();
      redrawSoon();
      loadFixes();
    }
    if (!jobList.some(jobMoving)) {
      clearInterval(jobPolling);
      jobPolling = null;
    }
  }, 1000);
}

export function renderJobs() {
  const panel = document.getElementById('jobs');
  // Oldest first, so the latest is at the bottom, which it stays scrolled to unless scrolled up to look back
  const atBottom = panel.hidden || panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 4;
  panel.hidden = !jobsShown || !jobList.length;
  if (panel.hidden) return;
  const item = r => {
    if (r.kind === 'backup') return backupItem(r);
    if (r.kind === 'delete') return deleteItem(r);
    if (r.kind === 'pin') return pinItem(r);
    if (r.kind === 'mount') return mountItem(r);
    if (r.kind === 'settings') return settingsItems(r);
    const percent = r.totalBytes ? 100 * r.bytes / r.totalBytes : 0;
    const status = {
      // After a few seconds, the picker may well have opened behind something
      picking: () => el('div', { class: 'status muted' }, Date.now() / 1000 - r.started > 5
        ? 'Choosing where… (the picker may be behind other windows)' : 'Choosing where…'),
      restoring: () => [
        el('div', { class: 'status' }, 'To ', el('b', {}, r.target)),
        el('div', { class: 'status' },
          el('span', { class: 'bar' }, el('span', { class: 'fill', style: `display:block;width:${percent}%` })),
          r.totalBytes ? `${formatSize(r.bytes)} of ${formatSize(r.totalBytes)} · ${Math.floor(percent)}%` : 'Starting…'),
      ],
      finishing: () => el('div', { class: 'status' }, 'Moving into place at ', el('b', {}, r.target), '…'),
      done: () => el('div', { class: 'status' },
        el('span', { class: 'c-added' }, '✓ Restored'), ' to ', el('b', {}, r.target),
        el('button', { class: 'linklike', onclick: event => showInExplorer(r.target, event.currentTarget) }, 'Show in Explorer')),
      failed: () => el('div', { class: 'status c-removed' }, `Failed: ${r.error}`),
      cancelled: () => el('div', { class: 'status muted' }, 'Cancelled'),
    }[r.state]();
    return el('li', { class: `${r.state}${jobActive(r) ? ' active' : ''}` },
      el('div', { class: 'what' }, el('b', {}, r.name),
        el('span', { class: 'muted' }, ` as of ${formatFull(r.snapshotTime)}`)),
      status);
  };

  // What's going, of each kind, or if nothing is, what's listed
  const of = kind => jobList.filter(j => j.kind === kind);
  const going = kind => of(kind).filter(jobActive).length;
  const pinsGoing = pinning => of('pin').filter(j => jobActive(j) && !!j.add.length === pinning).length;
  const active = jobList.filter(jobActive).length;
  const kinds = [['backup', 'backups'], ['restore', 'restores'], ['mount', 'mounts'], ['delete', 'deletions'], ['pin', 'pins'], ['settings', 'parent settings fixes']]
    .filter(([kind]) => of(kind).length).map(([, name]) => name);
  const listed = listOf(kinds);
  const settingsJob = of('settings').find(jobActive);
  const heading = [
    going('backup') && `Backing up ${plural(going('backup'), 'location')}`,
    going('restore') && `Restoring ${going('restore')} of ${of('restore').length}`,
    going('mount') && `${plural(going('mount'), 'folder')} mounted`,
    going('delete') && `Deleting ${plural(going('delete'), 'snapshot')}`,
    pinsGoing(true) && `Pinning ${plural(pinsGoing(true), 'snapshot')}`,
    pinsGoing(false) && `Unpinning ${plural(pinsGoing(false), 'snapshot')}`,
    settingsJob && `${settingsJob.undo ? 'Removing parent settings fix' : 'Applying parent settings fix'}${settingsJob.items.length
      ? ` (${settingsJob.items.filter(i => ['done', 'failed'].includes(i.state)).length} of ${settingsJob.items.length})` : ''}`,
  ].filter(Boolean).join(' · ') || `${listed[0].toUpperCase()}${listed.slice(1)} (${jobList.length})`;
  panel.replaceChildren(
    el('div', { class: 'jobs-head' },
      el('h2', {}, heading),
      jobsUnreachable ? el('span', { class: 'c-removed', title: 'Is kopia_explorer.py still running?' }, 'Can\'t reach the server') : null,
      jobList.length > active ? el('button', {
        class: 'linklike', title: 'Remove finished ones from the list',
        onclick: async () => {
          await api.post('/api/jobs/clear', {});
          jobList = jobList.filter(jobActive);
          renderJobs();
        },
      }, 'Clear finished') : null,
      // It stays open until everything's finished
      active ? null : el('button', { class: 'btn', 'aria-label': 'Close', title: 'Close', onclick: () => { jobsShown = false; renderJobs(); } }, '×')),
    el('ul', {}, jobList.map(item)));
  if (atBottom) panel.scrollTop = panel.scrollHeight;
}

// The warnings above the panel at the bottom: KopiaUI not running to make the scheduled snapshots, locations
// inside others whose settings aren't used when the locations around them are backed up, and locations whose
// backups keep having errors. Each time the snapshots change, it's only drawn again if it says something else,
// so it isn't announced again.
export function renderNotice() {
  const notice = document.getElementById('notice');
  const parts = [kopiaUINotice(), actionsNotice(), settingsNotice(), failingNotice()].filter(Boolean).map(part => el('div', {}, part));
  const fresh = el('section', {}, parts);
  notice.hidden = !parts.length;
  if (fresh.innerHTML !== notice.innerHTML) notice.replaceChildren(...parts);
}

// Copying in the settings of locations inside others
function settingsNotice() {
  if (!settingsOffer) return null;
  const missing = listOf([...new Set(settingsOffer.flatMap(n => n.missing))], 'or');
  return [
    el('h2', {}, 'Parent settings not used'),
    el('p', {}, `Kopia doesn't use your ${missing} inside `,
      el('b', { title: settingsOffer.map(n => `${n.path} in ${n.container}`).join('\n') }, plural(settingsOffer.length, 'nested location')),
      ' when backing up the locations around them.'),
    el('div', { class: 'actions' },
      el('button', { class: 'btn', onclick: () => changeSettings(false) }, 'Apply parent settings fix'),
      el('button', { class: 'linklike', onclick: () => { settingsOffer = null; renderNotice(); } }, 'Not now')),
  ];
}

// Applying the parent settings fix to locations inside others, or removing it, in the panel at the bottom: an
// item for each location, with undoing it, unless it's been changed again since. Before the locations are
// known, or if none needed it, it's a single item.
export function settingsItems(j) {
  const what = path => el('div', { class: 'what' }, el('span', { class: 'muted' }, 'Parent settings fix for '), el('b', {}, path));
  const whole = (state, status) => el('li', { class: `${state}${jobActive(j) ? ' active' : ''}` }, what('nested locations'), status);
  if (j.state === 'checking') {
    return whole('checking', el('div', { class: 'status muted' },
      j.undo ? 'Searching for nested locations with the fix applied…' : 'Searching for nested locations requiring the fix…'));
  }
  if (j.state === 'failed') return whole('failed', el('div', { class: 'status c-removed' }, `Failed: ${j.error}`));
  if (!j.items.length) {
    return whole('done', el('div', { class: 'status muted' }, j.undo ? 'None had it applied' : 'None needed it'));
  }
  return j.items.map(item => {
    const later = jobList.some(o => o.kind === 'settings' && o.id > j.id && o.items?.some(i => i.path === item.path));
    const status = {
      waiting: () => el('div', { class: 'status muted' }, 'Waiting…'),
      running: () => el('div', { class: 'status muted' }, j.undo ? 'Removing…' : 'Applying…'),
      done: () => el('div', { class: 'status' },
        el('span', { class: 'c-added' }, j.undo ? '✓ Removed' : '✓ Applied'),
        later ? null : el('button', { class: 'linklike', onclick: () => changeSettings(!j.undo, [item.path]) }, 'Undo')),
      failed: () => el('div', { class: 'status c-removed' }, `Failed: ${item.error}`),
    }[item.state]();
    return el('li', { class: `${item.state}${item.state === 'running' ? ' active' : ''}` }, what(item.path), status);
  });
}

// A snapshot being deleted, in the panel at the bottom
export function deleteItem(j) {
  const status = {
    deleting: () => el('div', { class: 'status muted' }, 'Deleting…'),
    done: () => el('div', { class: 'status', title: 'Space on disk is freed once kopia\'s maintenance runs' },
      el('span', { class: 'c-added' }, '✓ Deleted')),
    failed: () => el('div', { class: 'status c-removed' }, `Failed: ${j.error}`),
  }[j.state]();
  return el('li', { class: `${j.state}${jobActive(j) ? ' active' : ''}` },
    el('div', { class: 'what' }, el('span', { class: 'muted' }, 'Snapshot of '), el('b', {}, j.source),
      el('span', { class: 'muted' }, `, ${formatFull(j.snapshotTime)}`)),
    status);
}

// A snapshot being pinned or unpinned, in the panel at the bottom, with undoing it, unless its pins have been
// changed again since, or it's gone
export function pinItem(j) {
  const pinning = !!j.add.length;
  const loc = storage.find(l => l.path === j.source);
  const now = j.info && loc?.snapshots.find(s => s.id === j.info.id);
  const later = jobList.some(o => o.kind === 'pin' && o.id > j.id && o.snapshot === j.info?.id);
  const status = {
    running: () => el('div', { class: 'status muted' }, pinning ? 'Pinning…' : 'Unpinning…'),
    done: () => el('div', { class: 'status' },
      el('span', { class: 'c-added' }, pinning ? `✓ Pinned as ${pinNames(j.add)}` : '✓ Unpinned'),
      now && !later ? el('button', { class: 'linklike', onclick: () => changePins(loc, now, j.remove, j.add) }, 'Undo') : null),
    failed: () => el('div', { class: 'status c-removed' }, `Failed: ${j.error}`),
  }[j.state]();
  return el('li', { class: `${j.state}${jobActive(j) ? ' active' : ''}` },
    el('div', { class: 'what' }, el('span', { class: 'muted' }, 'Snapshot of '), el('b', {}, j.source),
      el('span', { class: 'muted' }, `, ${formatFull(j.snapshotTime)}`)),
    status);
}

// A folder mounted as a drive in the panel at the bottom, with opening it again and unmounting it
export function mountItem(j) {
  const status = {
    mounting: () => el('div', { class: 'status muted' }, 'Mounting…'),
    mounted: () => el('div', { class: 'status' },
      el('span', { class: 'c-added' }, '✓ Mounted'), ' as ', el('b', {}, driveName(j.drive)),
      el('button', { class: 'linklike', onclick: event => showInExplorer(j.drive, event.currentTarget) }, 'Open'),
      el('button', { class: 'linklike', title: 'Take the drive away again', onclick: () => unmount(j) }, 'Unmount'),
      j.error ? el('span', { class: 'c-removed' }, j.error) : null),
    unmounting: () => el('div', { class: 'status muted' }, 'Unmounting…'),
    unmounted: () => el('div', { class: 'status muted' }, 'Unmounted'),
    failed: () => el('div', { class: 'status c-removed' }, `Failed: ${j.error}`),
  }[j.state]();
  // Where it's from in full, location and all, as it stays mounted. One found running was mounted some other
  // way, such as by an explorer that was ended outright, so it's put down to the newest snapshot with the same
  // contents, if there is one: one mounted at the command line may not be the top of a snapshot, or a folder
  // in one, so all that's known is kopia's ID for it.
  return el('li', {
    class: `${j.state}${jobActive(j) ? ' active' : ''}`,
    title: j.found ? `Found mounted, not mounted here${j.snapshotTime ? ' - the newest snapshot with the same contents' : ''}` : null,
  },
    el('div', { class: 'what' }, el('b', {}, j.from),
      el('span', { class: 'muted' }, j.snapshotTime ? ` as of ${formatFull(j.snapshotTime)}` : ' (not from a snapshot found here)')),
    status);
}

// A backup in the panel at the bottom: how far it's got, which kopia can only say once it's worked out
// roughly how much there is, then what it made
export function backupItem(j) {
  const errors = j.errors ? el('span', { class: 'c-removed' }, ` · ${plural(j.errors, 'error')}`) : null;
  const loc = storage.find(l => l.path === j.source);
  const made = j.snapshot && loc?.snapshots.find(s => s.id === j.snapshot);
  // kopia can take a while to estimate how much there is, so until then, it's going by the last snapshot
  const last = loc && latest(loc);
  const about = j.estimated ?? (last && !last.incomplete ? last.size : null);
  const percent = j.percent ?? (about ? Math.min(99, 100 * j.bytes / about) : null);
  const status = {
    running: () => [
      el('div', { class: 'status' },
        el('span', { class: 'bar' }, el('span', { class: 'fill', style: `display:block;width:${percent ?? 0}%` })),
        percent != null
          ? el('span', { title: j.estimated == null ? 'Going by the size of the last snapshot, until kopia has estimated it' : null },
            `${formatSize(j.bytes)} of about ${formatSize(about)} · ${Math.floor(percent)}%${j.left ? ` · ${j.left} left` : ''}`)
          : `${plural(j.files, 'file')} checked, ${formatSize(j.bytes)}`,
        el('button', { class: 'linklike', onclick: () => cancelBackup(j) }, 'Cancel')),
      el('div', { class: 'status muted' }, el('span', {}, `${formatSize(j.uploaded)} uploaded`, errors,
        j.error ? el('span', { class: 'c-removed' }, ` · ${j.error}`) : null)),
    ],
    cancelling: () => el('div', { class: 'status muted' }, 'Cancelling, keeping what it got through…'),
    done: () => el('div', { class: 'status' },
      el('span', { class: 'c-added' }, '✓ Backed up'),
      el('span', {}, el('span', { class: 'amount' }, formatSize(j.bytes)), ` in ${plural(j.files, 'file')}, `,
        el('span', { class: 'amount' }, formatSize(j.uploaded)), ' uploaded', errors),
      // Once the snapshots have been read again, it can be gone to
      made ? el('button', { class: 'linklike', onclick: () => navigate({ location: j.source, snapshot: made.id, asOf: null, scope: '', file: null }) }, 'View snapshot') : null),
    failed: () => el('div', { class: 'status c-removed' }, `Failed: ${j.error}`),
    cancelled: () => el('div', { class: 'status muted', title: 'kopia keeps what it got through as an incomplete snapshot, so the next backup doesn\'t upload it again' },
      `Cancelled after ${formatSize(j.uploaded)} uploaded`),
  }[j.state]();
  return el('li', { class: `${j.state}${jobActive(j) ? ' active' : ''}` },
    el('div', { class: 'what' }, el('span', { class: 'muted' }, 'Backup of '), el('b', {}, j.source),
      j.started ? el('span', { class: 'muted' }, `, started ${formatTime(new Date(j.started * 1000))}`) : null),
    status);
}

// Restores, backups and deletes carry on if the page is reloaded, so pick up any still going
export function pickUpJobs() {
  fetch('/api/jobs').then(r => r.json()).then(list => {
  jobList = list;
  if (list.some(jobActive)) {
    jobsShown = true;
    jobsChanged();
    followJobs();
  }
  }).catch(() => {});
}

// Mounts can come and go with nothing here doing it, as the server checks every minute: ones found running, and
// ones whose drive was taken away in Explorer. So while nothing's being followed, the list is asked for again
// every half minute, while the page is showing.
setInterval(async () => {
  if (document.hidden || jobPolling) return;
  const list = await fetch('/api/jobs').then(r => r.json()).catch(() => null);
  if (!list || JSON.stringify(list) === JSON.stringify(jobList)) return;
  jobList = list;
  if (list.some(jobActive)) jobsShown = true;
  jobsChanged();
  if (list.some(jobMoving)) followJobs();
}, 30 * 1000);
