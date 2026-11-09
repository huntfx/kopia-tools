// Drawing the whole page
import { renderAsOf } from './asof.js';
import { renderMain } from './pages.js';
import { renderLocations } from './sidebar.js';
import { renderSide } from './snapshots.js';
import { state } from './state.js';
import { storage } from './storage.js';

export function render() {
  // Until the locations are read, there's nothing to draw; the page draws itself once they are
  if (!storage) return;
  if (!state.location && !state.folder && storage.length) state.location = storage.find(l => l.path === 'C:\\Users\\Peter')?.path || storage[0].path;
  renderAsOf();
  renderLocations();
  keepingPlace(document.getElementById('main'), renderMain);
  renderSide();
}

// The page last drawn in the middle, so redrawing the same one keeps its place, but another starts where it does
let drawnPage = null;

// Redrawing swaps every section for a new one, so the browser can't keep what's being read in place as the
// sections above it grow, as they do while loading. The section nearest the middle of the view, as the one most
// likely being read, stays where it was on screen instead, found again by its heading, as long as it's the same
// page; ones above it grow upwards. Ones still loading are passed over, as they're about to grow themselves.
// Within it, the row nearest the middle stays put, if its rows say what they are (data-place), as rows can be
// added among them too, like the changes tree's files with only a date change, found later.
function keepingPlace(main, draw) {
  const page = JSON.stringify([state.folder, state.location, state.scope, state.file]);
  const same = page === drawnPage;
  drawnPage = page;
  // The middle scrolls on its own beside the sidebar, or with the page when they're stacked on a narrow window
  const scroller = getComputedStyle(main).overflowY === 'auto' ? main : document.scrollingElement;
  const view = scroller === main ? main.getBoundingClientRect() : { top: 0, bottom: innerHeight };
  const middle = (view.top + Math.min(view.bottom, innerHeight)) / 2;
  const keyed = () => {
    const seen = new Map();
    return [...main.children].map(section => {
      const name = `${section.tagName}.${section.className}:${section.querySelector('h2')?.textContent || ''}`;
      seen.set(name, (seen.get(name) || 0) + 1);
      return [`${name}#${seen.get(name)}`, section];
    });
  };
  const away = node => {
    const { top, bottom } = node.getBoundingClientRect();
    return top > middle ? top - middle : bottom < middle ? middle - bottom : 0;
  };
  const inView = node => {
    const { top, bottom, height } = node.getBoundingClientRect();
    return height > 0 && bottom > view.top && top < view.bottom;
  };
  const nearest = nodes => nodes.filter(inView).sort((a, b) => away(a) - away(b))[0];
  const showing = !same || !scroller.scrollTop ? null : keyed().filter(([, section]) => !section.querySelector('.loading'))
    .filter(([, section]) => inView(section)).sort(([, a], [, b]) => away(a) - away(b))[0];
  if (!showing) return draw();
  const row = nearest([...showing[1].querySelectorAll('[data-place]')]);
  const [rowWas, sectionWas] = [row?.getBoundingClientRect().top, showing[1].getBoundingClientRect().top];
  draw();
  // The row again, or if it's gone, as when a merged row's split, the section
  const section = keyed().find(([key]) => key === showing[0])?.[1];
  const again = row && section?.querySelector(`[data-place="${CSS.escape(row.dataset.place)}"]`);
  if (again) scroller.scrollTop += again.getBoundingClientRect().top - rowWas;
  else if (section) scroller.scrollTop += section.getBoundingClientRect().top - sectionWas;
}
