// The header's buttons: the Fixes window, and refreshing, beside when the snapshots were read
import { openFixes } from './fixes.js';
import { hardRefresh, refreshNow } from './storage.js';

document.getElementById('fixes-button').addEventListener('click', openFixes);

document.getElementById('refresh').addEventListener('click', event => (event.shiftKey ? hardRefresh() : refreshNow()));
