// Kopia's documentation, shown in the explorer, over whatever opened it: a page of it for the kopia installed, from
// kopia's repository via the server, which keeps it once fetched, so it's there offline, shown in the explorer's
// own style. Links in it open outside the explorer, with ones to other pages going to kopia.io. A page that can't
// be fetched is the explorer's own copy, which says which version it's for.
import { el } from './format.js';
import { marked } from './marked.js';

// By page, while the page is open
const pages = new Map();

function loadDoc(page) {
  if (!pages.has(page)) {
    pages.set(page, fetch(`/api/docs?page=${encodeURIComponent(page)}`)
      .then(response => (response.ok ? response.json() : Promise.reject(new Error(response.statusText || `Error ${response.status}`))))
      .catch(error => {
        pages.delete(page);
        throw error;
      }));
  }
  return pages.get(page);
}

// A heading's anchor, as kopia's website makes them, like kopiaignore-files for "Kopiaignore Files"
const anchor = text => text.trim().toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');

// The page's HTML made safe to show here: nothing that runs or embeds, and links and images made full addresses,
// from where kopia.io has the page, with links opening outside the explorer. Links to a heading on the page
// scroll to it instead, without touching the explorer's own address, which says where it's at.
function tidy(html, site) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script, style, iframe, object, embed, form, link, meta').forEach(node => node.remove());
  for (const node of doc.body.querySelectorAll('*')) {
    for (const attr of [...node.attributes]) if (attr.name.startsWith('on')) node.removeAttribute(attr.name);
  }
  for (const heading of doc.querySelectorAll('h1, h2, h3, h4, h5, h6')) heading.dataset.anchor = anchor(heading.textContent);
  for (const link of doc.querySelectorAll('a[href]')) {
    const href = link.getAttribute('href');
    if (href.startsWith('#')) {
      link.dataset.target = anchor(decodeURIComponent(href.slice(1)).replace(/-/g, ' '));
      link.removeAttribute('href');
      link.tabIndex = 0;
      continue;
    }
    const url = new URL(href, site);
    if (!/^https?:$/.test(url.protocol)) {
      link.removeAttribute('href');
      continue;
    }
    link.href = url.href;
    link.target = '_blank';
    link.rel = 'noopener';
  }
  for (const image of doc.querySelectorAll('img[src]')) image.src = new URL(image.getAttribute('src'), site).href;
  return [...doc.body.childNodes];
}

// A page by its name, as the server knows it, like kopiaignore
export function docsDialog(page) {
  const body = el('div', { class: 'docs-body' }, el('p', { class: 'muted' }, 'Loading…'));
  const version = el('span', { class: 'docs-version' });
  const dialog = el('dialog', { class: 'confirm docs', 'aria-label': 'Kopia\'s documentation' },
    body,
    el('div', { class: 'actions' }, version, el('button', { class: 'btn', onclick: () => dialog.close() }, 'Close')));
  // Links to a heading on the page scroll to it
  const follow = event => {
    const link = event.target.closest('a[data-target]');
    if (!link || (event.type === 'keydown' && event.key !== 'Enter')) return;
    event.preventDefault();
    body.querySelector(`[data-anchor="${CSS.escape(link.dataset.target)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  body.addEventListener('click', follow);
  body.addEventListener('keydown', follow);
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  loadDoc(page).then(doc => {
    if (!dialog.isConnected) return;
    if (doc.title) dialog.setAttribute('aria-label', doc.title);
    // The explorer's own copy, when the right one couldn't be fetched, may be from another version
    version.textContent = `For kopia ${doc.version}${doc.version === doc.wanted ? '' : ` (failed to fetch ${doc.wanted})`}`;
    body.replaceChildren(...tidy(marked.parse(doc.markdown), doc.site));
  }).catch(error => {
    if (dialog.isConnected) body.replaceChildren(el('p', { class: 'error' }, `Couldn't load it: ${error instanceof TypeError ? 'can\'t reach the server' : error.message}`));
  });
}
