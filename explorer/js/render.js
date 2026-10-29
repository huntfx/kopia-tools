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
  renderMain();
  renderSide();
}
