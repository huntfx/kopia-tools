// Formatting sizes, dates and counts, building elements, and the colour scales

export function formatSize(size) {
  if (size == null) return '';
  if (size < 1000) return `${size} B`;
  for (const unit of ['KB', 'MB', 'GB', 'TB', 'PB']) {
    size /= 1000;
    if (Math.round(size * 10) / 10 < 1000 || unit === 'PB') return `${size.toFixed(1)} ${unit}`;
  }
}

export const signedSize = n => `${n > 0 ? '+' : '−'}${formatSize(Math.abs(n))}`;

export const dateFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export const fullFormat = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

export const formatTime = iso => dateFormat.format(new Date(iso));

// How long ago something was, like "3 hours ago" or "yesterday", in the largest unit that fits
export const relativeFormat = new Intl.RelativeTimeFormat('en-GB', { numeric: 'auto' });

export function timeAgo(iso) {
  const seconds = (new Date(iso) - Date.now()) / 1000;
  const units = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return relativeFormat.format(Math.round(seconds / size), unit);
  }
  return 'just now';
}

export const formatFull = iso => fullFormat.format(new Date(iso));

export const shortId = id => id.slice(0, 8);

export const plural = (n, word) => `${n.toLocaleString('en-GB')} ${word}${n === 1 ? '' : 's'}`;

// Append children, skipping empty optional ones (append() would print null as text)
export const appendAll = (parent, ...children) => parent.append(...children.flat(Infinity).filter(c => c != null && c !== false));

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'style') node.style.cssText = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(child));
  }
  return node;
}

// The same for SVG, whose elements need their namespace
export function svgEl(tag, attrs = {}, ...children) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(child));
  }
  return node;
}

export const GRADIENT = [[90, 200, 120], [230, 210, 90], [240, 90, 80]];

export const GAP_LIMIT = 0.5, GAP_SCALE = 0.1, MIN_RANGE = 3;

export const NO_CHANGE = [240, 240, 240], GROWTH = [240, 90, 80], SHRINK = [90, 200, 120];

// Log scale from the smallest to the largest amount, at least MIN_RANGE powers of 10 deep,
// with big jumps between neighbours shrunk so one huge amount doesn't squash the rest.
export function gradientPositions(amounts) {
  const result = new Map();
  if (!amounts.length) return result;
  const unique = [...new Set(amounts.map(a => Math.log10(a)))];
  const floor = Math.min(Math.min(...unique), Math.max(...unique) - MIN_RANGE);
  const logs = [...new Set([...unique, floor])].sort((a, b) => a - b);
  const scaled = new Map([[logs[0], 0]]);
  for (let i = 1; i < logs.length; i++) {
    let gap = logs[i] - logs[i - 1];
    if (gap > GAP_LIMIT) gap = GAP_LIMIT + (gap - GAP_LIMIT) * GAP_SCALE;
    scaled.set(logs[i], scaled.get(logs[i - 1]) + gap);
  }
  const end = scaled.get(logs[logs.length - 1]);
  for (const a of amounts) result.set(a, end ? scaled.get(Math.log10(a)) / end : 0.5);
  return result;
}

export const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

export function gradientRgb(position) {
  const p = Math.min(Math.max(position, 0), 1) * (GRADIENT.length - 1);
  const i = Math.min(Math.floor(p), GRADIENT.length - 2);
  return mix(GRADIENT[i], GRADIENT[i + 1], p - i);
}

export const changeRgb = (amount, positions) => mix(NO_CHANGE, amount > 0 ? GROWTH : SHRINK, positions.get(Math.abs(amount)));

export const isDark = () => document.documentElement.dataset.theme === 'dark' ||
  (document.documentElement.dataset.theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);

// Bright colours are made for dark backgrounds, so darken them for text on a light one
export const textColour = rgb => `rgb(${(isDark() ? rgb : rgb.map(v => Math.round(v * 0.55))).join(' ')})`;

export const fillColour = rgb => `rgb(${rgb.join(' ')})`;
