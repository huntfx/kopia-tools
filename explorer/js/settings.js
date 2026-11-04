// The Settings window, from the header's gear button. So far that's snapshot actions, with every policy that has
// any, what each runs, and whether it will, which is asked about again when the window opens.
import { actions, changeError, changing, checkActions, policyName, setActions } from './actions.js';
import { el } from './format.js';

let dialog = null;

export function openSettings() {
  if (dialog) return;
  dialog = el('dialog', { class: 'confirm listing settings', 'aria-labelledby': 'settings-title' });
  dialog.addEventListener('close', () => {
    dialog.remove();
    dialog = null;
  });
  document.body.append(dialog);
  dialog.showModal();
  renderSettings();
  checkActions();
  dialog.querySelector('[data-key="close"]').focus({ preventScroll: true });
}

// Drawn again whenever what's known about actions changes, but only if it says something else, keeping the focus
// on the same button where it's still there
export function renderSettings() {
  if (!dialog) return;
  const fresh = el('div', {},
    el('h2', { id: 'settings-title' }, 'Settings'),
    el('div', { class: 'section-head' }, el('h3', {}, 'Snapshot actions'), actionsSwitch()),
    el('p', {}, 'Lets policies run commands before and after snapshots. Kopia disables them unless they\'re enabled in the Kopia config, as an action can run anything on this PC.'),
    actions?.kopiaUIBehind ? el('p', { class: 'warn' }, 'The Kopia config has changed since KopiaUI was started, so any changes will not take effect in KopiaUI until it\'s next restarted.') : null,
    changeError ? el('p', { class: 'c-removed' }, changeError) : null,
    el('ul', {}, actionRows()),
    el('div', { class: 'actions' }, el('button', { class: 'btn', 'data-key': 'close', onclick: () => dialog.close() }, 'Close')));
  if (fresh.innerHTML === dialog.innerHTML) return;
  const key = dialog.contains(document.activeElement) ? document.activeElement.dataset.key : null;
  dialog.replaceChildren(...fresh.childNodes);
  if (key) (dialog.querySelector(`[data-key="${CSS.escape(key)}"]`) || dialog.querySelector('[data-key="close"]')).focus();
}

// Beside the heading: whether actions are enabled, and enabling or disabling them, once that's known
function actionsSwitch() {
  if (actions?.enabled == null) return null;
  const { enabled } = actions;
  return el('div', { class: 'actions' },
    changing ? el('span', { class: 'muted' }, enabled ? 'Disabling…' : 'Enabling…')
      : enabled ? el('span', { class: 'c-added' }, '✓ Enabled') : el('span', { class: 'warn' }, 'Disabled'),
    el('button', {
      class: 'linklike', 'data-key': 'switch', disabled: changing, title: `Set enableActions in the Kopia config, ${actions.config}`,
      onclick: () => setActions(!enabled),
    }, enabled ? 'Disable' : 'Enable'));
}

// Each policy with actions: going to its location, if it's for one, what each of its actions runs, and whether
// they will
function actionRows() {
  if (!actions) return el('li', { class: 'muted' }, 'Reading the policies…');
  if (actions.enabled === null) return el('li', { class: 'c-removed' }, 'Couldn\'t read the Kopia config');
  if (!actions.policies.length) return el('li', { class: 'muted' }, 'No policies have actions');
  return actions.policies.map(policy => el('li', {},
    el('div', { class: 'what' },
      policyName(policy, () => dialog.close(), true),
      policy.actions.map(a => el('div', { class: 'detail' }, `${a.when}: ${a.command}`))),
    el('div', { class: 'status' },
      actions.enabled ? el('span', { class: 'c-added' }, '✓ Will run') : el('span', { class: 'warn' }, 'Will not run'))));
}
