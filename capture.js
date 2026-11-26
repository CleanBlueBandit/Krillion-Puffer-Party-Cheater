// Capture how krillion.io party questions are sent/received.
// Opens a visible browser, you play normally, and every WebSocket frame,
// XHR/fetch request+response and loaded JS bundle URL is logged.
//
// Usage:  node capture.js [url]
// Output: logs/<timestamp>/traffic.jsonl  (one event per line)
//         logs/<timestamp>/summary.txt    (written when you close the browser)
//
// Env options:
//   BROWSER=brave (default)  launch your real Brave with its own profile and attach to it,
//                            so the Cloudflare check behaves like a normal browser
//   BROWSER=playwright       use Playwright's bundled Chromium instead
//   BRAVE_PATH=...           override Brave's location
//   BLOCK=0                  don't block non-krillion hosts
//   EXTRA_HOSTS=a.com,b.com  extra hosts to allow
//   ALL=1                    print third-party HTTP too
//   HEADLESS=1, CAPTURE_SECONDS=N  (playwright mode) for quick tests

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const TARGET = process.argv[2] || 'https://krillion.io/party/';
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.join('logs', stamp);
fs.mkdirSync(outDir, { recursive: true });
const out = fs.createWriteStream(path.join(outDir, 'traffic.jsonl'));

const stats = { ws: {}, http: {}, msgTypes: {}, blocked: {} };
const QUESTION_HINT = /question|answer|choice|option|correct|round|quiz|prompt/i;

function log(evt) {
  evt.t = Date.now();
  out.write(JSON.stringify(evt) + '\n');
}

// Try to decode a frame payload into something readable.
function decode(payload) {
  if (typeof payload === 'string') {
    // Socket.IO / engine.io frames look like `42["event",{...}]`
    const m = payload.match(/^(\d+)(.*)$/s);
    const body = m && m[2] ? m[2] : payload;
    try {
      return { kind: 'json', prefix: m ? m[1] : null, data: JSON.parse(body) };
    } catch {
      return { kind: 'text', data: payload };
    }
  }
  // Binary (Buffer) — could be msgpack/protobuf; show hex + utf8 preview
  const buf = Buffer.from(payload);
  return {
    kind: 'binary',
    bytes: buf.length,
    hex: buf.subarray(0, 256).toString('hex'),
    utf8: buf.toString('utf8').replace(/[^\x20-\x7e]/g, '.').slice(0, 256),
  };
}

function msgType(decoded) {
  const d = decoded.data;
  if (Array.isArray(d) && typeof d[0] === 'string') return d[0]; // socket.io event name
  if (d && typeof d === 'object') return d.type ?? d.t ?? d.event ?? d.op ?? d.action ?? '(object)';
  return `(${decoded.kind})`;
}

function print(dir, decoded) {
  const type = msgType(decoded);
  const key = `${dir} ${type}`;
  stats.msgTypes[key] = (stats.msgTypes[key] || 0) + 1;
  const preview = decoded.kind === 'binary' ? decoded.utf8 : JSON.stringify(decoded.data);
  const flag = QUESTION_HINT.test(preview) ? '  <== QUESTION/ANSWER?' : '';
  const arrow = dir === 'send' ? '\x1b[33m→ SEND\x1b[0m' : '\x1b[36m← RECV\x1b[0m';
  console.log(`${arrow} [${type}] ${preview.slice(0, 300)}${flag}`);
}

// ---------------------------------------------------------------- browser
let browser, context, braveProc;

if ((process.env.BROWSER || 'brave') === 'brave') {
  const bravePath =
    process.env.BRAVE_PATH || 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe';
  const port = 9333;
  const profile = path.resolve('.brave-profile'); // separate profile, keeps your normal Brave untouched
  braveProc = spawn(
    bravePath,
    [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'],
    { stdio: 'ignore' },
  );
  // wait for the debug port
  let lastErr;
  for (let i = 0; i < 40 && !browser; i++) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  if (!browser) throw new Error(`Could not attach to Brave: ${lastErr?.message}`);
  context = browser.contexts()[0];
} else {
  browser = await chromium.launch({ headless: process.env.HEADLESS === '1' });
  context = await browser.newContext();
}

// ---- Block everything except krillion + Cloudflare Turnstile ----
const ALLOWED = [
  'krillion.io',
  'challenges.cloudflare.com', // Turnstile: needed to pass the join verification
  ...(process.env.EXTRA_HOSTS || '').split(',').filter(Boolean),
];
const isAllowed = (host) => ALLOWED.some((h) => host === h || host.endsWith('.' + h));
if (process.env.BLOCK !== '0') {
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (!/^https?:/.test(url)) return route.continue();
    const host = new URL(url).hostname;
    if (isAllowed(host)) return route.continue();
    stats.blocked[host] = (stats.blocked[host] || 0) + 1;
    return route.abort('blockedbyclient');
  });
}

// ---------------------------------------------------------------- listeners
function hook(page) {
  page.on('websocket', (ws) => {
    const url = ws.url();
    stats.ws[url] = { sent: 0, recv: 0 };
    console.log(`\n\x1b[32m[WS OPEN]\x1b[0m ${url}`);
    log({ ev: 'ws_open', url });

    ws.on('framesent', ({ payload }) => {
      stats.ws[url].sent++;
      const d = decode(payload);
      log({ ev: 'ws_send', url, ...d });
      print('send', d);
    });
    ws.on('framereceived', ({ payload }) => {
      stats.ws[url].recv++;
      const d = decode(payload);
      log({ ev: 'ws_recv', url, ...d });
      print('recv', d);
    });
    ws.on('close', () => {
      console.log(`\x1b[31m[WS CLOSE]\x1b[0m ${url}`);
      log({ ev: 'ws_close', url });
    });
  });

  page.on('request', (req) => {
    const type = req.resourceType();
    if (!['xhr', 'fetch', 'script', 'eventsource'].includes(type)) return;
    log({ ev: 'http_req', type, method: req.method(), url: req.url(), body: req.postData() });
  });

  page.on('response', async (res) => {
    const req = res.request();
    const type = req.resourceType();
    if (!['xhr', 'fetch', 'eventsource'].includes(type)) {
      if (type === 'script') log({ ev: 'script', url: res.url(), status: res.status() });
      return;
    }
    const u = new URL(res.url());
    const firstParty = /krillion/i.test(u.hostname) || process.env.ALL === '1';
    const key = `${req.method()} ${u.hostname}${u.pathname}`;
    if (firstParty) stats.http[key] = (stats.http[key] || 0) + 1;
    let body = null;
    try {
      const text = await res.text();
      try { body = JSON.parse(text); } catch { body = text.slice(0, 5000); }
    } catch { /* streaming / no body */ }
    log({ ev: 'http_res', type, status: res.status(), url: res.url(), reqBody: req.postData(), body });
    if (!firstParty) return;
    const preview = JSON.stringify(body ?? '').slice(0, 200);
    const flag = QUESTION_HINT.test(preview) ? '  <== QUESTION/ANSWER?' : '';
    console.log(`\x1b[35m[HTTP ${res.status()}]\x1b[0m ${key} ${preview}${flag}`);
  });

  page.on('console', (m) => log({ ev: 'console', type: m.type(), text: m.text() }));
}

context.pages().forEach(hook);
context.on('page', hook); // new tabs/popups too

const page = context.pages()[0] || (await context.newPage());
await page.goto(TARGET);
console.log(`\nOpened ${TARGET}. Join/host a party and play — close the browser window when done.\n`);

// ---------------------------------------------------------------- finish
async function finish() {
  out.end();
  const summary = [
    `Capture of ${TARGET} at ${stamp}`,
    '',
    'WebSockets:',
    ...Object.entries(stats.ws).map(([u, s]) => `  ${u}  sent=${s.sent} recv=${s.recv}`),
    '',
    'Message types (direction + type: count):',
    ...Object.entries(stats.msgTypes).sort((a, b) => b[1] - a[1]).map(([k, v]) => `  ${k}: ${v}`),
    '',
    'HTTP endpoints:',
    ...Object.entries(stats.http).map(([k, v]) => `  ${k}: ${v}`),
    '',
    'Blocked hosts (requests):',
    ...Object.entries(stats.blocked).sort((a, b) => b[1] - a[1]).map(([k, v]) => `  ${k}: ${v}`),
  ].join('\n');
  fs.writeFileSync(path.join(outDir, 'summary.txt'), summary);
  console.log('\n' + summary + `\n\nFull log: ${path.join(outDir, 'traffic.jsonl')}`);
  process.exit(0);
}

if (process.env.CAPTURE_SECONDS) {
  setTimeout(async () => {
    await browser.close().catch(() => {});
    braveProc?.kill();
  }, Number(process.env.CAPTURE_SECONDS) * 1000);
}
process.on('SIGINT', finish); // Ctrl+C also saves
browser.on('disconnected', finish);
