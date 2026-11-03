// The filter on a location's page: only files whose paths below the folder being looked at match any of its
// patterns, anywhere in them, so in the file's name or any folder's, ignoring case, and none of those starting
// with !, which leave out what matches the rest, as the server tests them. They have the wildcards of ignore rules,
// with / or \ between names, like Unreal\**\*.exe, and one starting with either matches from the folder being
// looked at, like \Unreal.exe. Starting with file: they only match the file's name, and with a \ from its start,
// and with folder: only the folders it's in, and ext: matches its extension exactly, like ext:.png, or ext:png,
// and by itself, files without one. A pattern filters as it's typed in the box beside the page's path, and Enter keeps
// it as a tag under the box, to type another. Everything on the page narrows to those files.
import { api } from './data.js';
import { el, formatSize, plural } from './format.js';
import { render } from './render.js';
import { navigate, state } from './state.js';
import { folderObj } from './storage.js';

// What's typed in the box and not kept yet, which filters too, and the redraw waiting for typing to pause
let typed = '';
let redraw = null;

// Whether a pattern's one of the tags, in any case
export const hasPattern = pattern => state.match.some(p => p.toLowerCase() === pattern.toLowerCase());

// The patterns filtering the page: the tags, and whatever's typed
export function patterns() {
  const text = typed.trim();
  return text && text !== '!' && !hasPattern(text) ? [...state.match, text] : state.match;
}

// The patterns that let names through and the ones that leave them out, without their !
function split(list) {
  return {
    include: list.filter(p => !p.startsWith('!')),
    exclude: list.filter(p => p.startsWith('!') && p.length > 1).map(p => p.slice(1)),
  };
}

// A pattern's wildcards as a regex, as in ignore rules and as glob_to_regex in snapshot_diff.py turns them into
// one: * for any run of characters in one name, ** for any across folders too, **/ for any folders or none, ? for
// any one character and [abc] for any of those, or [!abc] for any but. A \ is a separator here, so never escapes.
function globRegex(pattern) {
  const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let out = '';
  for (let i = 0; i < pattern.length;) {
    const end = pattern[i] === '[' ? pattern.indexOf(']', i + 2) : -1;
    if (pattern.startsWith('**/', i)) [out, i] = [`${out}(?:.*/)?`, i + 3];
    else if (pattern.startsWith('**', i)) [out, i] = [`${out}.*`, i + 2];
    else if (pattern[i] === '*') [out, i] = [`${out}[^/]*`, i + 1];
    else if (pattern[i] === '?') [out, i] = [`${out}[^/]`, i + 1];
    else if (end !== -1) {
      const body = pattern.slice(i + 1, end).replaceAll('\\', '\\\\');
      [out, i] = [`${out}[${body.startsWith('!') ? `^${body.slice(1)}` : body}]`, end + 1];
    } else [out, i] = [out + escape(pattern[i]), i + 1];
  }
  return out;
}

// A file tested against the patterns, from its path below the folder being looked at, like /Unreal/Unreal.exe,
// worked out again only when they change
let tester = { key: null, test: () => true };

function test(path) {
  const list = patterns();
  const key = list.join('\n');
  if (tester.key !== key) {
    // Each kind's patterns as one regex, by what they're tested on, with / for either separator
    const regexes = found => {
      const kinds = {};
      for (const pattern of found) {
        const [, kind = '', rest] = pattern.match(/^(?:(ext|file|folder):)?(.*)$/is);
        const p = rest.replaceAll('\\', '/');
        const regex = kind.toLowerCase() === 'ext' ? (p ? `^${globRegex(`.${p.replace(/^\.+/, '')}`)}$` : '^$')
          : (p.startsWith('/') ? '^' : '') + globRegex(p);
        (kinds[kind.toLowerCase()] ||= []).push(regex);
      }
      return Object.entries(kinds).map(([kind, parts]) => [kind, new RegExp(parts.join('|'), 'i')]);
    };
    const { include, exclude } = split(list);
    const [keep, leave] = [regexes(include), regexes(exclude)];
    tester = {
      key,
      test: path => {
        const cut = path.lastIndexOf('/') + 1;
        const tested = { '': path, file: `/${path.slice(cut)}`, folder: path.slice(0, cut), ext: extensionOf(path.slice(cut)) };
        const found = kinds => kinds.some(([kind, regex]) => regex.test(tested[kind]));
        return (!keep.length || found(keep)) && !found(leave);
      },
    };
  }
  return tester.test(path);
}

// A file's extension, as the server counts its type, lower case: from its last dot, so all of a name starting with
// one, like .gitignore, or '' for none
function extensionOf(name) {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot).toLowerCase();
}

// Whether a path in the location, with / separators and folders ending in one, is a file the filter lets through,
// if there is one. One outside the folder being looked at is tested from the top of the location.
export function inFilter(path) {
  if (!patterns().length) return true;
  if (path.endsWith('/')) return false;
  return test(state.scope && path.startsWith(`${state.scope}/`) ? path.slice(state.scope.length) : `/${path}`);
}

// What the filter lets through in a folder, from its tally by type, which the server only counts those files in:
// how many and how big, or undefined if there are none
export function filteredCounts(tally) {
  const counts = Object.values(tally || {});
  return counts.length ? counts.reduce(([files, size], [f, s]) => [files + f, size + s], [0, 0]) : undefined;
}

// The files the filter lets through, in words, like files matching “.png” or “.jpg” but not matching “thumb”
export function matchingFiles() {
  const words = found => found.map((p, i) => `${i ? (i === found.length - 1 ? ' or ' : ', ') : ''}“${p}”`).join('');
  const { include, exclude } = split(patterns());
  return `files${include.length ? ` matching ${words(include)}` : ''}${exclude.length ? `${include.length ? ' but' : ''} not matching ${words(exclude)}` : ''}`;
}

// What's typed kept as a tag, as Enter does, and moving somewhere else, so it carries on filtering there: the tags
// with it, or as they were if there's nothing new
export function keepTyped() {
  const text = typed.trim();
  typed = '';
  clearTimeout(redraw);
  return text && text !== '!' && !hasPattern(text) ? [...state.match, text] : state.match;
}

// Adding a tag, or taking it out
export function togglePattern(pattern) {
  navigate({ match: hasPattern(pattern) ? state.match.filter(p => p.toLowerCase() !== pattern.toLowerCase()) : [...state.match, pattern] });
}

// How to write patterns, shown while pointing at the empty box, like a tooltip but with the operators in bold
const HELP_RULES = [
  ['*', 'matches anything in a name'],
  ['**', 'matches across folders'],
  ['\\', 'between names matches a path'],
  ['\\', 'at the beginning matches only in the present location'],
  ['file:', 'matches a filename only'],
  ['folder:', 'matches a folder name only'],
  ['ext:', 'matches an extension exactly'],
  ['!', 'at the beginning ignores the match'],
];

const help = () => el('div', { class: 'filter-help', id: 'filter-help', role: 'tooltip' },
  el('p', {}, 'Filters files and folders with the current search term. Advanced operators can be used:'),
  el('ul', {}, HELP_RULES.map(([operator, text]) => el('li', {}, el('b', {}, operator), ` ${text}`))),
  el('p', {}, 'Press Enter to apply the current filter.'));

// The box to type a pattern in, at the right of the page's path, which filters as it's typed, once typing pauses,
// with the tags under it, each with a way to take it out, then what the filter lets through in here at the snapshot
// being viewed. Enter keeps what's typed as a tag, as moving somewhere else does, Backspace in an empty box takes
// the last tag out, and Escape empties it. The page is redrawn whenever anything arrives, so the cursor carries over to the new box.
export function filterControls(selected) {
  const old = document.querySelector('.filter-box');
  const input = el('input', {
    type: 'text', class: 'filter-box', value: typed, placeholder: 'Filter contents…', 'aria-label': 'Filter contents',
    'aria-describedby': 'filter-help',
    oninput: () => {
      typed = input.value;
      clearTimeout(redraw);
      redraw = setTimeout(render, 200);
    },
    onkeydown: event => {
      const text = input.value.trim();
      if (event.key === 'Enter' && text && text !== '!') {
        navigate({ match: keepTyped() });
      } else if (event.key === 'Backspace' && !input.value && state.match.length) {
        navigate({ match: state.match.slice(0, -1) });
      } else if (event.key === 'Escape' && input.value) {
        typed = '';
        clearTimeout(redraw);
        render();
      }
    },
  });
  // Once it's on the page, which happens just after this returns
  if (old && document.activeElement === old) {
    const [start, end] = old.value === typed ? [old.selectionStart, old.selectionEnd] : [typed.length, typed.length];
    queueMicrotask(() => {
      input.focus();
      input.setSelectionRange(start, end);
    });
  }

  const obj = patterns().length && !selected.incomplete && folderObj(selected, state.scope);
  const tally = obj ? api.types(obj, patterns(), state.scope) : null;
  const counts = filteredCounts(tally);
  // Each as a share of everything in here, counted the same way, which the server has by the time it's filtered
  const all = tally && filteredCounts(api.types(obj));
  const share = i => {
    const percent = all?.[i] ? 100 * counts[i] / all[i] : null;
    return percent == null ? '' : ` (${percent > 0 && percent < 1 ? '<1' : Math.round(percent)}%)`;
  };
  const summary = !tally ? null : !counts ? 'None in here' : el('span', {
    title: all ? `${formatSize(counts[1])} of ${formatSize(all[1])}, in ${counts[0].toLocaleString('en-GB')} of ${plural(all[0], 'file')}` : null,
  }, `${formatSize(counts[1])}${share(1)} in ${plural(counts[0], 'file')}${share(0)}`);
  return el('div', { class: 'name-filter' },
    el('div', { class: 'filter-field' }, input, help()),
    state.match.length || tally ? el('div', { class: 'filter-tags' },
      state.match.map(pattern => {
        const leftOut = pattern.startsWith('!');
        return el('span', { class: `filter-tag${leftOut ? ' left-out' : ''}` },
          el('span', { class: 'mono' }, pattern),
          el('button', {
            class: 'linklike', 'aria-label': `Remove ${pattern}`,
            title: leftOut ? `Stop leaving out “${pattern.slice(1)}”` : `Stop matching “${pattern}”`, onclick: () => togglePattern(pattern),
          }, '×'));
      }),
      summary ? el('span', { class: 'muted' }, summary) : null) : null);
}
