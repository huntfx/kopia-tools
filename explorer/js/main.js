// The page's start: the snapshots are read first, as everything is built from them, then the page is drawn
import { loadStorage, followStorage, currentFolder } from './storage.js';
import { pickUpJobs } from './jobs.js';
import { buildSidebarTree, reveal, renderSort } from './sidebar.js';
import { repositoryTitle } from './data.js';
import { readHash, writeHash } from './state.js';
import { render } from './render.js';
// These only listen for things, such as the search box and the "files as of" picker
import './search.js';
import './asof.js';

await loadStorage();
pickUpJobs();
buildSidebarTree();
followStorage();
document.getElementById('repo-status').title = repositoryTitle();
readHash();
reveal(currentFolder());
renderSort();
render();
writeHash(true);
