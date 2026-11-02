// The Tools menu in the header: things done across the whole repository, which run on the server and are
// followed in the panel at the bottom, and refreshing, with the button beside when the snapshots were read
import { changeSettings } from './jobs.js';
import { hardRefresh, refreshNow } from './storage.js';

const tools = document.getElementById('tools');
const button = document.getElementById('tools-button');
const menu = document.getElementById('tools-menu');

const RUN = {
  'copy-settings': () => changeSettings(false),
  'undo-settings': () => changeSettings(true),
  'hard-refresh': hardRefresh,
};

document.getElementById('refresh').addEventListener('click', event => (event.shiftKey ? hardRefresh() : refreshNow()));

function openMenu() {
  menu.hidden = false;
  button.setAttribute('aria-expanded', 'true');
  menu.querySelector('button:not(:disabled)')?.focus();
}

function closeMenu() {
  menu.hidden = true;
  button.setAttribute('aria-expanded', 'false');
}

button.addEventListener('click', () => (menu.hidden ? openMenu() : closeMenu()));

menu.addEventListener('click', event => {
  const item = event.target.closest('[data-tool]');
  if (!item) return;
  closeMenu();
  RUN[item.dataset.tool]();
});

document.addEventListener('mousedown', event => {
  if (!menu.hidden && !tools.contains(event.target)) closeMenu();
});

menu.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  closeMenu();
  button.focus();
});
