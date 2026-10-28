// Files as of a date: the picker in the header, and stepping between snapshots
import { el, formatFull, timeAgo } from './format.js';
import { locationsBelow, treeNodes } from './sidebar.js';
import { render } from './render.js';
import { asOfFor } from './snapshots.js';
import { navigate, state, ui } from './state.js';
import { selectedSnapshot, storage } from './storage.js';

// The input works in local time, as "2026-10-26T12:00", while the state keeps an ISO date
export const toLocalInput = iso => {
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};

// A time, like Google's time pickers: "now", "today", "yesterday", an amount ago such as 15m, 3h, 2d, 1w,
// 1mo or 1y, or a date. A Date, or null if it can't be read.
export const AGO_UNITS = { s: 1, m: 60, min: 60, h: 3600, d: 86400, w: 604800, mo: 2629800, y: 31557600 };

export function parseWhen(text) {
  const t = text.trim().toLowerCase();
  const midnight = days => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - days); return d; };
  if (t === 'now') return new Date();
  if (t === 'today') return midnight(0);
  if (t === 'yesterday') return midnight(1);
  const ago = t.match(/^(\d+(?:\.\d+)?)\s*(s|min|mo|m|h|d|w|y)$/);
  if (ago) return new Date(Date.now() - Number(ago[1]) * AGO_UNITS[ago[2]] * 1000);
  // Dates as typed, like 2026-10-20 12:00, in local time
  const date = new Date(/^\d{4}-\d\d-\d\d \d/.test(t) ? t.replace(' ', 'T') : text);
  return isNaN(date) ? null : date;
}

// The menu's choices, in groups, each with its shorthand
export const AS_OF_CHOICES = [
  [['Now', 'now']],
  [['Start of today', 'today'], ['Start of yesterday', 'yesterday']],
  [['15 minutes ago', '15m'], ['1 hour ago', '1h'], ['3 hours ago', '3h'], ['6 hours ago', '6h'], ['12 hours ago', '12h']],
  [['1 day ago', '1d'], ['2 days ago', '2d'], ['1 week ago', '1w'], ['2 weeks ago', '2w']],
  [['1 month ago', '1mo'], ['3 months ago', '3mo'], ['6 months ago', '6mo'], ['1 year ago', '1y']],
];

export const asOfMenu = document.getElementById('as-of-menu');

export const asOfButton = document.getElementById('as-of-button');

export const asOfText = document.getElementById('as-of-text');

export const asOfError = document.getElementById('as-of-error');

export const asOfInput = document.getElementById('as-of-input');

// A time within the last couple of minutes, or later, is the same as now, so it keeps following the latest
export function applyWhen(date) {
  closeAsOfMenu();
  navigate({ asOf: date < new Date(Date.now() - 120000) ? date.toISOString() : null });
}

export function openAsOfMenu() {
  asOfMenu.hidden = false;
  asOfButton.setAttribute('aria-expanded', 'true');
  asOfText.value = '';
  asOfError.hidden = true;
  asOfInput.value = toLocalInput(state.asOf || new Date().toISOString());
  document.getElementById('as-of-list').replaceChildren(...AS_OF_CHOICES.flatMap((group, i) => [
    i ? el('li', { class: 'gap', role: 'separator' }) : null,
    ...group.map(([label, short]) => el('li', {},
      el('button', { type: 'button', 'aria-current': String(short === 'now' && !state.asOf), onclick: () => applyWhen(parseWhen(short)) },
        el('span', {}, label), el('span', { class: 'short' }, short))))
  ].filter(Boolean)));
  asOfText.focus();
}

export function closeAsOfMenu() {
  asOfMenu.hidden = true;
  asOfButton.setAttribute('aria-expanded', 'false');
}

asOfButton.addEventListener('click', () => (asOfMenu.hidden ? openAsOfMenu() : closeAsOfMenu()));

document.addEventListener('mousedown', event => {
  if (!asOfMenu.hidden && !document.getElementById('as-of').contains(event.target)) closeAsOfMenu();
});

asOfMenu.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  closeAsOfMenu();
  asOfButton.focus();
});

document.getElementById('as-of-typed').addEventListener('submit', event => {
  event.preventDefault();
  const date = parseWhen(asOfText.value);
  if (date) return applyWhen(date);
  asOfError.textContent = 'Try something like 15m, 3h, 2d, 1w, today, or 2026-10-20 12:00';
  asOfError.hidden = false;
});

document.getElementById('as-of-custom').addEventListener('submit', event => {
  event.preventDefault();
  if (asOfInput.value) applyWhen(new Date(asOfInput.value));
});

// Including locations with nothing as old as the date, at their oldest snapshot, which are otherwise hidden;
// remembered in this browser like the sidebar's sort
const includeOldest = document.getElementById('as-of-include-oldest');
try {
  ui.includeOldest = localStorage.getItem('includeOldest') === '1';
} catch {}
includeOldest.checked = ui.includeOldest;
includeOldest.addEventListener('change', () => {
  ui.includeOldest = includeOldest.checked;
  try {
    localStorage.setItem('includeOldest', ui.includeOldest ? '1' : '0');
  } catch {}
  render();
});

// The snapshots to step through with ‹ and ›: the location being viewed's, or on a folder page, every
// location's inside it. The current one is the one viewed, or for a folder page, the latest as of the date.
export function asOfSteps() {
  const loc = storage.find(l => l.path === state.location);
  if (loc) {
    const complete = loc.snapshots.filter(s => !s.incomplete);
    const current = selectedSnapshot(loc);
    const at = complete.indexOf(current?.incomplete ? complete[complete.length - 1] : current);
    const asOf = snap => asOfFor(loc, snap);
    return { older: at > 0 ? asOf(complete[at - 1]) : undefined, newer: at >= 0 && at < complete.length - 1 ? asOf(complete[at + 1]) : undefined };
  }
  const node = state.folder && treeNodes.get(state.folder.toLowerCase());
  const times = [...new Set((node ? locationsBelow(node) : storage).flatMap(l => l.snapshots.filter(s => !s.incomplete).map(s => s.time)))]
    .sort((a, b) => new Date(a) - new Date(b));
  const limit = state.asOf ? new Date(state.asOf) : new Date();
  const at = times.findLastIndex(t => new Date(t) <= limit);
  return {
    older: at > 0 ? times[at - 1] : undefined,
    // Stepping onto the newest is the same as now
    newer: at >= 0 && at < times.length - 1 ? (at + 1 === times.length - 1 ? null : times[at + 1]) : undefined,
  };
}

export function renderAsOf() {
  const box = document.getElementById('as-of');
  box.classList.toggle('set', !!state.asOf);
  document.getElementById('as-of-label').textContent = state.asOf ? `${formatFull(state.asOf)} · ${timeAgo(state.asOf)}` : 'Now';
  const { older, newer } = asOfSteps();
  const step = (id, target, which) => {
    const button = document.getElementById(id);
    button.disabled = target === undefined;
    button.title = target === undefined ? `No snapshot ${which}` : `Snapshot ${which}: ${target ? formatFull(target) : 'the latest'}`;
    button.onclick = () => navigate({ asOf: target });
  };
  step('as-of-older', older, 'before');
  step('as-of-newer', newer, 'after');
}

setInterval(() => { if (state.asOf) renderAsOf(); }, 15000);
