// The last good pin: a pin the server moves on to each new snapshot of a location without missing files (ones kopia
// couldn't read), so its latest good snapshot is kept however many backups since have missed files, and only until
// there's a newer one. It's an ordinary pin by a name of its own, so kopia keeps it, and KopiaUI shows it. Several
// backups in a row with missing files are warned about, offering to pin the latest good snapshot, unless there's
// never been one.
import { el, formatFull, plural, timeAgo } from './format.js';
import { beingPinned, changePins, confirmPin, renderNotice } from './jobs.js';
import { navigate } from './state.js';
import { storage } from './storage.js';

export const LAST_GOOD = 'last-good';

// Backups in a row with missing files before they're warned about
const FAILING = 2;

// Finished, with everything read
const isGood = snap => !snap.incomplete && !snap.failed;

// A location's newest good snapshot, and the one pinned as its last good one, if any
const lastGood = loc => loc.snapshots.findLast(isGood);
const lastGoodPinned = loc => loc.snapshots.findLast(s => s.pins?.includes(LAST_GOOD));

// How many of a location's newest finished snapshots in a row have had missing files
function failingRun(loc) {
  const complete = loc.snapshots.filter(s => !s.incomplete);
  return complete.length - 1 - complete.findLastIndex(isGood);
}

const pinLastGood = loc => changePins(loc, lastGood(loc), [LAST_GOOD], []);

const view = snap => () => navigate({ snapshot: snap.id });

// Pinning the latest good snapshot, offered where there is one that isn't pinned yet
const OFFER = 'Kopia Explorer can automatically pin the latest good snapshot to ensure that Kopia\'s retention settings never accidentally delete these files.';
const PINNED = 'so Kopia\'s retention settings won\'t delete these files.';

// Warned about: several backups in a row with missing files since a good one. One that's never had a good one isn't,
// as there's nothing to keep.
const warned = loc => failingRun(loc) >= FAILING && !!lastGood(loc);

// Above a location's contents when it's warned about: how many, and its latest good snapshot, with pinning it unless
// it's pinned already
export function failingWarning(loc) {
  if (!warned(loc)) return null;
  const good = lastGood(loc);
  const pinned = lastGoodPinned(loc);
  const apply = el('button', { class: 'btn', onclick: () => { apply.disabled = true; pinLastGood(loc); } }, 'Pin latest good snapshot');
  return el('section', { class: 'panel warning' },
    el('div', { class: 'chart-head' }, el('h2', {}, 'Backups missing files')),
    el('p', {}, `The last ${failingRun(loc)} backups had missing files. `,
      pinned ? `Its latest good snapshot, from ${formatFull(good.time)} (${timeAgo(good.time)}), is pinned, ${PINNED}`
        : OFFER.replace('snapshot', `snapshot, from ${formatFull(good.time)} (${timeAgo(good.time)}),`)),
    el('div', { class: 'actions' },
      pinned || beingPinned(good) ? null : apply,
      el('button', { class: 'btn', onclick: view(good) }, 'View latest good snapshot')));
}

// At the top of a location's page, once its latest good snapshot is pinned, with viewing it and unpinning it
export function lastGoodStatus(loc) {
  const pinned = lastGoodPinned(loc);
  if (!pinned) return null;
  return el('span', { title: `${formatFull(pinned.time)}, pinned as “${LAST_GOOD}”, which moves on to each new snapshot without missing files` },
    'latest good snapshot pinned (',
    el('button', { class: 'linklike', onclick: view(pinned) }, 'view'), ', ',
    el('button', { class: 'linklike', disabled: beingPinned(pinned), onclick: () => confirmPin(loc, pinned, [LAST_GOOD]) }, 'undo'), ')');
}

// Each location's backups in a row with missing files when the notice about them was put off, so it's only shown
// again once there are more
const putOff = new Map();

// The notice above the panel at the bottom: locations warned about, each linking to its page, with pinning the
// latest good snapshot of those that haven't pinned it
export function failingNotice() {
  const failing = storage.filter(loc => warned(loc) && failingRun(loc) > (putOff.get(loc.path) ?? 0));
  if (!failing.length) return null;
  const unpinned = failing.filter(loc => !lastGoodPinned(loc));
  const close = () => {
    failing.forEach(loc => putOff.set(loc.path, failingRun(loc)));
    renderNotice();
  };
  const [only] = failing.length === 1 ? failing : [];
  const link = loc => el('button', {
    class: 'linklike', onclick: () => navigate({ location: loc.path }),
    title: `${plural(failingRun(loc), 'backup')} in a row with missing files - latest good snapshot ${formatFull(lastGood(loc).time)}${lastGoodPinned(loc) ? ', pinned' : ''}`,
  }, loc.path);
  // Pinning the ones that aren't, or with all pinned, saying so
  const after = unpinned.length ? (unpinned.length > 1 ? OFFER.replace('snapshot', 'snapshots') : OFFER)
    : only ? `Its latest good snapshot is pinned, ${PINNED}`
    : `Their latest good snapshots are pinned, ${PINNED}`;
  return [
    el('h2', {}, 'Backups missing files'),
    el('p', {}, joined(failing.map(link)),
      only ? ` had ${failingRun(only)} backups in a row with missing files. ` : ` each had ${FAILING} or more backups in a row with missing files. `,
      after),
    el('div', { class: 'actions' },
      unpinned.length ? el('button', { class: 'btn', onclick: () => { unpinned.forEach(pinLastGood); close(); } },
        unpinned.length > 1 ? 'Pin latest good snapshots' : 'Pin latest good snapshot') : null,
      el('button', { class: 'linklike', onclick: close }, unpinned.length ? 'Not now' : 'Dismiss')),
  ];
}

// Elements in a list, like listOf does for text: "a, b and c"
const joined = items => items.flatMap((item, i) => [i === 0 ? '' : i === items.length - 1 ? ' and ' : ', ', item]);
