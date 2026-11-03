// The header's buttons: the Mounts and Fixes windows, and refreshing, beside when the snapshots were read
import { openFixes } from './fixes.js';
import { openMounts } from './mounts.js';
import { hardRefresh, refreshNow } from './storage.js';

document.getElementById('mounts-button').addEventListener('click', openMounts);

document.getElementById('fixes-button').addEventListener('click', openFixes);

document.getElementById('refresh').addEventListener('click', event => (event.shiftKey ? hardRefresh() : refreshNow()));
