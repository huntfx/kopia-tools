// Screenshot a page in headless Edge, optionally running steps in it first, over the DevTools protocol.
//   node .claude/tools/screenshot.mjs <url> <out.png> [steps.js] [width] [height]
// steps.js is a file of JavaScript run in the page (awaited, so it can wait for things); whatever it returns
// is printed. The page gets a few seconds to load first.
import { spawn } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const [url, out, stepsFile, width = '1400', height = '900'] = process.argv.slice(2);
if (!url || !out) {
  console.error('usage: node screenshot.mjs <url> <out.png> [steps.js] [width] [height]');
  process.exit(2);
}
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9333;
const profile = mkdtempSync(join(tmpdir(), 'edge-shot-'));
const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  `--window-size=${width},${height}`, '--force-dark-mode', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

try {
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    await sleep(200);
    target = await fetch(`http://127.0.0.1:${PORT}/json`).then(r => r.json()).then(t => t.find(x => x.type === 'page')).catch(() => null);
  }
  if (!target) throw new Error('Edge didn\'t start');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = event => {
    const msg = JSON.parse(event.data);
    if (pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  const send = (method, params = {}) => new Promise(resolve => {
    pending.set(++id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await send('Page.navigate', { url });
  await sleep(5000);
  if (stepsFile) {
    const steps = readFileSync(stepsFile, 'utf8');
    const result = await send('Runtime.evaluate', { expression: `(async () => { ${steps} })()`, awaitPromise: true, returnByValue: true });
    const value = result.result?.result?.value;
    if (result.result?.exceptionDetails) console.error(result.result.exceptionDetails.exception?.description);
    else if (value !== undefined) console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 1));
    await sleep(500);
  }
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
  console.log(`saved ${out}`);
  ws.close();
} finally {
  edge.kill();
  await sleep(500);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
