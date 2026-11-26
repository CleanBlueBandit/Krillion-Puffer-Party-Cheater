// Puffer Party question reader.
// Opens Brave, joins a room, and prints every question (category) the server sends.
// It only listens: it never types or submits anything.
//
// Usage:
//   node questions.js              -> Quick Play (unrated)
//   node questions.js ABCD         -> join room code ABCD
//   NAME=bob node questions.js     -> choose your display name (default "reader")
//
// You still click the Cloudflare check yourself when it appears.
// Output: questions/<timestamp>.jsonl  (one line per question, plus game events)

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOM = process.argv[2]?.toUpperCase();
const NAME = process.env.NAME || 'reader';
const BRAVE =
  process.env.BRAVE_PATH || 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe';
const PORT = 9334;

fs.mkdirSync('questions', { recursive: true });
const outFile = path.join('questions', new Date().toISOString().replace(/[:.]/g, '-') + '.jsonl');
const out = fs.createWriteStream(outFile);
const save = (obj) => out.write(JSON.stringify({ at: Date.now(), ...obj }) + '\n');

// ------------------------------------------------------------ game state
let room = null; // { code, gameId, players: Map(id -> name) }
let current = null; // current question { index, text, threshold, answers: [], rejects: [] }

function playerName(id) {
  return room?.players.get(id) ?? id;
}

function updatePlayers(list = []) {
  for (const p of list) if (p?.id) room.players.set(p.id, p.name);
}

function finishQuestion(reason) {
  if (!current) return;
  save({ type: 'question', room: room?.code, gameId: room?.gameId, ended: reason, ...current });
  current = null;
}

function onCategory(cat) {
  if (!cat) return;
  if (current && current.index === cat.index && current.text === cat.text) return; // same question
  finishQuestion('next');
  current = { index: cat.index, text: cat.text, threshold: cat.threshold, answers: [], rejects: [] };
  console.log(`\n\x1b[1;36mQ${cat.index}: ${cat.text}\x1b[0m  \x1b[2m(threshold ${cat.threshold})\x1b[0m`);
}

const seenSeq = new Set(); // the server can resend recent events; each has a unique seq

function onEvents(events = []) {
  for (const e of events) {
    if (e.seq != null) {
      if (seenSeq.has(e.seq)) continue;
      seenSeq.add(e.seq);
    }
    switch (e.kind) {
      case 'pass':
        current?.answers.push({ by: playerName(e.from), answer: e.answer, tier: e.tier });
        console.log(`   ✓ ${playerName(e.from)}: ${e.answer} \x1b[2m[${e.tier}]\x1b[0m`);
        break;
      case 'reject':
        current?.rejects.push({ by: playerName(e.playerId), text: e.text, why: e.why });
        console.log(`   \x1b[2m✗ ${playerName(e.playerId)}: ${e.text} (${e.why})\x1b[0m`);
        break;
      case 'pop':
        console.log(`   \x1b[31m💥 ${playerName(e.playerId)} popped, ${e.livesLeft} lives left\x1b[0m`);
        save({ type: 'pop', room: room?.code, gameId: room?.gameId, player: playerName(e.playerId), livesLeft: e.livesLeft });
        break;
      case 'win':
        console.log(`\n\x1b[32m🏆 ${playerName(e.playerId)} wins\x1b[0m`);
        finishQuestion('game over');
        save({ type: 'win', room: room?.code, gameId: room?.gameId, player: playerName(e.playerId) });
        break;
    }
  }
}

function onMessage(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }

  if (msg.t === 'snap' && msg.room) {
    const r = msg.room;
    room = { code: r.code, gameId: r.gameId, players: new Map() };
    updatePlayers(r.players);
    console.log(`\x1b[32mJoined room ${r.code}\x1b[0m (${r.players.length} players, phase: ${r.phase})`);
    onCategory(r.category);
  } else if (msg.t === 'patch' && room) {
    const p = msg.patch;
    updatePlayers(p.players);
    if (p.set?.gameId && p.set.gameId !== room.gameId) {
      finishQuestion('new game');
      room.gameId = p.set.gameId;
    }
    onEvents(p.events); // events first, so answers attach to the question they belong to
    if (p.set && 'category' in p.set) onCategory(p.set.category);
  }
}

// Click Quick Play repeatedly until its label changes (= it's searching for a room).
// Clicks can get lost, e.g. when a Brave popup steals focus right after startup.
async function clickQuickPlayUntilSearching({ maxTries = 30, everyMs = 1500 } = {}) {
  // Several buttons share the .ds-begin-btn class (RATED, QUICK PLAY, HOST), so find it by its text,
  // then keep a handle to that exact element so we can watch its label change.
  const locator = page.locator('button', { hasText: /^\s*QUICK PLAY\s*$/ });
  await locator.waitFor({ state: 'visible', timeout: 30000 });
  const btn = await locator.elementHandle();
  // null = element was removed/replaced (page moved on)
  const label = async () => (await btn.evaluate((el) => (el.isConnected ? el.innerText : null)).catch(() => null))?.trim() ?? null;

  for (let i = 1; i <= maxTries; i++) {
    const before = await label();
    if (before === null) return console.log('Quick Play button gone, assuming we are in.');
    if (before !== 'QUICK PLAY') return console.log(`Quick Play started ("${before}")`);

    // The button bobs forever, so Playwright never sees it as "stable": skip that check.
    // Odd tries: real mouse click (force: it bobs forever, so it's never "stable").
    // Even tries: DOM click, in case something on screen is covering the button.
    if (i % 2) {
      await btn.click({ force: true, timeout: 2000 }).catch((e) => console.log(`  click ${i} failed: ${e.message.split('\n')[0]}`));
    } else {
      await btn.evaluate((el) => el.click()).catch(() => {});
    }

    // Give the page a moment to react, checking often
    const until = Date.now() + everyMs;
    while (Date.now() < until) {
      const now = await label();
      if (now !== 'QUICK PLAY') {
        return console.log(now === null ? 'Quick Play button gone, assuming we are in.' : `Quick Play started ("${now}")`);
      }
      await page.waitForTimeout(150);
    }
    console.log(`  label still "QUICK PLAY" after click ${i}, retrying...`);
  }
  throw new Error(`Quick Play never started after ${maxTries} clicks`);
}

// ------------------------------------------------------------ browser
const brave = spawn(
  BRAVE,
  [`--remote-debugging-port=${PORT}`, `--user-data-dir=${path.resolve('.brave-profile')}`, '--no-first-run', '--hide-crash-restore-bubble', 'about:blank'],
  { stdio: 'ignore' },
);

let browser;
for (let i = 0; i < 40 && !browser; i++) {
  try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`); }
  catch { await new Promise((r) => setTimeout(r, 250)); }
}
if (!browser) throw new Error('Could not connect to Brave. Close other Brave windows using .brave-profile and retry.');

const context = browser.contexts()[0];
const page = context.pages()[0] || (await context.newPage());

page.on('websocket', (ws) => {
  if (!ws.url().includes('party.krillion.io/rooms/')) return;
  ws.on('framereceived', ({ payload }) => typeof payload === 'string' && onMessage(payload));
  ws.on('close', () => console.log('\x1b[2m[connection closed]\x1b[0m'));
});

await page.goto('https://krillion.io/party/');

// Set the display name, then join
const nameBox = page.getByPlaceholder('what the ring calls you');
await nameBox.waitFor({ timeout: 30000 });
await nameBox.fill(NAME);

if (ROOM) {
  console.log(`Joining room ${ROOM}...`);
  await page.goto(`https://krillion.io/party/${ROOM}`);
} else {
  console.log('Starting Quick Play...');
  await clickQuickPlayUntilSearching();
}
console.log('If a Cloudflare check appears in Brave, click it. Close Brave to stop.\n');

// ------------------------------------------------------------ shutdown
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  finishQuestion('stopped');
  out.end(() => {
    console.log(`\nSaved to ${outFile}`);
    process.exit(0);
  });
}
browser.on('disconnected', stop);
// Optional auto-stop for testing: STOP_AFTER=30 closes the Brave window this script opened
// Close Brave politely so it doesn't offer to "restore pages" next launch; hard-kill only as fallback.
async function closeBrave() {
  try {
    const cdp = await browser.newBrowserCDPSession();
    await cdp.send('Browser.close');
  } catch {
    brave.kill();
  }
  setTimeout(stop, 3000); // in case 'disconnected' never fires
}
if (process.env.STOP_AFTER) setTimeout(closeBrave, Number(process.env.STOP_AFTER) * 1000);
process.on('SIGINT', closeBrave);
