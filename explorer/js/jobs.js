// Restores, backups, deletes and settings changes, which run on the server, and the panel at the bottom that
// follows them
import { api, redrawSoon } from './data.js';
import { el, formatFull, formatSize, formatTime, listOf, plural, shortId } from './format.js';
import { render } from './render.js';
import { schedules } from './schedules.js';
import { KEEP_KINDS } from './snapshots.js';
import { navigate, state } from './state.js';
import { applyJobs, isCancelled, latest, refreshStorage, snapshotsChanged, storage } from './storage.js';

// Restores and backups run on the server, and the panel at the bottom follows them. A restore asks where in
// a folder picker, then has kopia write it there, so it keeps its modified times; a backup takes a snapshot
// of a location now, as a scheduled one would.
export let jobList = [];

export let jobsShown = false;

export let jobPolling = null;

export let jobsUnreachable = false;  // The server stopped answering while following them

// Still going: choosing where, restoring, moving the finished restore into place, backing up or changing
// settings, cancelling, deleting a snapshot, finding the locations whose settings to change, or waiting for
// another settings change to finish
export const jobActive = j => ['picking', 'restoring', 'finishing', 'running', 'cancelling', 'deleting', 'checking', 'waiting'].includes(j.state);

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

// Back up a location now, or a folder inside one on its own, which makes it a location of its own
export function backUp(path) {
  jobsShown = true;
  startJob('/api/backup', { source: path }, { kind: 'backup', name: path, source: path });
}

// Start a restore, backup or delete, or if the server won't, list it as failed, saying why
export async function startJob(url, body, job) {
  try {
    jobList = [...jobList, await api.post(url, body)];
  } catch (error) {
    jobList = [...jobList, { ...job, id: `failed-${Date.now()}`, state: 'failed',
      error: error instanceof TypeError ? 'Can\'t reach the server' : error.message }];
  }
  jobsChanged();
  followJobs();
}

// The panel at the bottom, and the snapshots panel's backup buttons, one for each location, which say whether
// one's going
export function jobsChanged() {
  renderJobs();
  for (const button of document.querySelectorAll('.backup-now')) {
    const loc = storage.find(l => l.path === button.dataset.location);
    if (loc) button.replaceWith(backupButton(loc));
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
      snap.size != null ? `, ${formatSize(snap.size)}` : '', isCancelled(snap) ? ', cancelled before it finished' : ''),
    el('p', {}, inside ? `This deletes the whole snapshot of ${loc.path}, not just ${inside}. ` : '', 'It can\'t be undone.'),
    kept && kept[0] !== 'latest' ? el('p', {}, `It's kept ${kept[1]} by kopia's retention policy at the moment, so another snapshot may take its place.`) : null,
    el('p', {}, 'Space on disk is only freed once kopia\'s maintenance runs, and only for data no other snapshot uses.'),
    el('div', { class: 'actions' }, cancel, remove));
  // Gone once closed, however that happens
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  cancel.focus();
}

// Open something in Windows Explorer, via the server; if that fails, the button says why
export function showInExplorer(path, button) {
  api.post('/api/reveal', { path }).catch(error => {
    if (!button) return;
    button.textContent = `Couldn't open Explorer: ${error instanceof TypeError ? 'can\'t reach the server' : error.message}`;
  });
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
    jobList = list;
    jobsChanged();
    // Shown straight away, then read again for what isn't known yet
    if (snapshotsEnded) {
      applyJobs();
      snapshotsChanged();
      refreshStorage();
    }
    // Each location's settings are read again, as they're shown
    if (settingsEnded) {
      schedules.clear();
      redrawSoon();
    }
    if (!jobList.some(jobActive)) {
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
  const active = jobList.filter(jobActive).length;
  const kinds = [['backup', 'backups'], ['restore', 'restores'], ['delete', 'deletions'], ['settings', 'parent settings fixes']]
    .filter(([kind]) => of(kind).length).map(([, name]) => name);
  const listed = listOf(kinds);
  const settingsJob = of('settings').find(jobActive);
  const heading = [
    going('backup') && `Backing up ${plural(going('backup'), 'location')}`,
    going('restore') && `Restoring ${going('restore')} of ${of('restore').length}`,
    going('delete') && `Deleting ${plural(going('delete'), 'snapshot')}`,
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

// The warning above the panel at the bottom: locations inside others whose settings aren't used when the
// locations around them are backed up, with copying them in
export function renderNotice() {
  const notice = document.getElementById('notice');
  notice.hidden = !settingsOffer;
  if (!settingsOffer) return;
  const missing = listOf([...new Set(settingsOffer.flatMap(n => n.missing))], 'or');
  notice.replaceChildren(
    el('h2', {}, 'Parent settings not used'),
    el('p', {}, `Kopia doesn't use your ${missing} inside `,
      el('b', { title: settingsOffer.map(n => `${n.path} in ${n.container}`).join('\n') }, plural(settingsOffer.length, 'nested location')),
      ' when backing up the locations around them.'),
    el('div', { class: 'actions' },
      el('button', { class: 'btn', onclick: () => changeSettings(false) }, 'Apply parent settings fix'),
      el('button', { class: 'linklike', onclick: () => { settingsOffer = null; renderNotice(); } }, 'Not now')));
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
