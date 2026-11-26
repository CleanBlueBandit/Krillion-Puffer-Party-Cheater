import 'dotenv/config';

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { HumanTyper } from './humanTyping.mjs';
import { GeminiAnswerFallback } from './geminifallback.mjs';

// ------------------------------------------------------------ configuration

// Usage: node main.js [ROOM] [--rated]
const ARGS = process.argv.slice(2);
const FLAGS = new Set(ARGS.filter((a) => a.startsWith('--')).map((a) => a.toLowerCase()));
const POSITIONAL = ARGS.filter((a) => !a.startsWith('--'));

for (const flag of FLAGS) {
  if (flag !== '--rated' && flag !== '--unrated') {
    throw new Error(`Unknown option: ${flag} (use --rated or --unrated)`);
  }
}

if (FLAGS.has('--rated') && FLAGS.has('--unrated')) {
  throw new Error('Use either --rated or --unrated, not both');
}

const RATED = FLAGS.has('--rated');
const ROOM = (POSITIONAL[0] || process.env.ROOM || '').toUpperCase();

if (RATED && ROOM) {
  throw new Error('--rated uses matchmaking and cannot be combined with a ROOM code');
}
const NAME = process.env.NAME || 'reader';

const BRAVE =
  process.env.BRAVE_PATH ||
  'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe';

const PORT = Number(process.env.PORT || 9334);
const ANSWERS_DB_PATH = path.resolve(process.env.ANSWERS_DB || './answers.json');

const geminiFallback = new GeminiAnswerFallback({
  keysPath: './gemini-keys.json',
  answersPath: ANSWERS_DB_PATH
});

const WPM = Number(process.env.WPM || 65);
const LAYOUT = process.env.LAYOUT || 'qwerty';

const MIN_DELAY = Number(process.env.MIN_DELAY || 1500);
const MAX_DELAY = Number(process.env.MAX_DELAY || 6000);

const STOP_AFTER = Number(process.env.STOP_AFTER || 0);
const TYPO_CHANCE = Number(process.env.TYPO_CHANCE ?? 0.08);
const RESULT_TIMEOUT_MS = Number(process.env.RESULT_TIMEOUT_MS || 6000);

// Pace at the end of the ramp (see currentPace()).
// Hard ceiling on typing speed; anything faster looks unnatural.
const WPM_CAP = Number(process.env.WPM_CAP || 85);
const MAX_WPM = Math.min(Number(process.env.MAX_WPM || WPM * 1.6), WPM_CAP);
const MIN_DELAY_FAST = Number(process.env.MIN_DELAY_FAST || 300);
const MAX_DELAY_FAST = Number(process.env.MAX_DELAY_FAST || 1200);
const PACE_RAMP_TURNS = Number(process.env.PACE_RAMP_TURNS || 10);

const NEW_OPPONENT_MIN_DELAY = Number(process.env.NEW_OPPONENT_MIN_DELAY || 3000);
const NEW_OPPONENT_MAX_DELAY = Number(process.env.NEW_OPPONENT_MAX_DELAY || 5000);
const GEMINI_MAX_ATTEMPTS = Number(process.env.GEMINI_MAX_ATTEMPTS || 3);

if (!Number.isFinite(PORT) || PORT <= 0) {
  throw new Error('PORT must be a positive number');
}

if (!Number.isFinite(WPM) || WPM <= 0) {
  throw new Error('WPM must be a positive number');
}

if (
  !Number.isFinite(MIN_DELAY) ||
  !Number.isFinite(MAX_DELAY) ||
  MIN_DELAY < 0 ||
  MAX_DELAY < MIN_DELAY
) {
  throw new Error('Invalid MIN_DELAY / MAX_DELAY configuration');
}

if (!Number.isFinite(MAX_WPM) || MAX_WPM <= 0) {
  throw new Error('MAX_WPM must be a positive number');
}

if (
  !Number.isFinite(MIN_DELAY_FAST) ||
  !Number.isFinite(MAX_DELAY_FAST) ||
  MIN_DELAY_FAST < 0 ||
  MAX_DELAY_FAST < MIN_DELAY_FAST
) {
  throw new Error('Invalid MIN_DELAY_FAST / MAX_DELAY_FAST configuration');
}

if (!Number.isFinite(PACE_RAMP_TURNS) || PACE_RAMP_TURNS <= 0) {
  throw new Error('PACE_RAMP_TURNS must be a positive number');
}

if (
  !Number.isFinite(NEW_OPPONENT_MIN_DELAY) ||
  !Number.isFinite(NEW_OPPONENT_MAX_DELAY) ||
  NEW_OPPONENT_MIN_DELAY < 0 ||
  NEW_OPPONENT_MAX_DELAY < NEW_OPPONENT_MIN_DELAY
) {
  throw new Error('Invalid NEW_OPPONENT_MIN_DELAY / NEW_OPPONENT_MAX_DELAY configuration');
}

if (!Number.isFinite(TYPO_CHANCE) || TYPO_CHANCE < 0 || TYPO_CHANCE > 1) {
  throw new Error('TYPO_CHANCE must be between 0 and 1');
}

// ------------------------------------------------------------ answers database

if (!fs.existsSync(ANSWERS_DB_PATH)) {
  throw new Error(`Answers database not found: ${ANSWERS_DB_PATH}`);
}

let ANSWERS_DB;

try {
  ANSWERS_DB = JSON.parse(fs.readFileSync(ANSWERS_DB_PATH, 'utf8'));
} catch (err) {
  throw new Error(`Could not load answers database: ${err.message}`);
}

if (
  !ANSWERS_DB ||
  typeof ANSWERS_DB !== 'object' ||
  Array.isArray(ANSWERS_DB)
) {
  throw new Error('Answers database must be a JSON object');
}

const typer = new HumanTyper({
  wpm: WPM,
  layout: LAYOUT
});

// ------------------------------------------------------------ output logging

fs.mkdirSync('questions', { recursive: true });

const outFile = path.join(
  'questions',
  new Date().toISOString().replace(/[:.]/g, '-') + '.jsonl'
);

const out = fs.createWriteStream(outFile);

out.on('error', (err) => {
  console.error(`Log file error: ${err.message}`);
});

const save = (obj) => {
  if (out.destroyed || !out.writable) return;

  out.write(JSON.stringify({
    at: Date.now(),
    ...obj
  }) + '\n');
};

// ------------------------------------------------------------ helpers

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function normalizeAnswer(answer) {
  return String(answer)
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

// Introduces at most one adjacent-key typo into an answer.
// The typo is intentional and will not be corrected by HumanTyper.
function introduceTypo(answer) {
  if (
    answer.length < 5 ||
    Math.random() >= TYPO_CHANCE
  ) {
    return answer;
  }

  const rows = [
    'qwertyuiop',
    'asdfghjkl',
    'zxcvbnm'
  ];

  const chars = [...answer];
  const candidates = [];

  for (let i = 1; i < chars.length - 1; i++) {
    const lower = chars[i].toLowerCase();

    if (!/[a-z]/.test(lower)) continue;

    const row = rows.find((r) => r.includes(lower));
    if (!row) continue;

    const position = row.indexOf(lower);
    const neighbors = [];

    if (position > 0) neighbors.push(row[position - 1]);
    if (position < row.length - 1) neighbors.push(row[position + 1]);

    if (neighbors.length) {
      candidates.push({
        index: i,
        replacement: neighbors[randomInt(0, neighbors.length - 1)],
        uppercase: chars[i] !== lower
      });
    }
  }

  if (!candidates.length) return answer;

  const chosen = candidates[randomInt(0, candidates.length - 1)];

  chars[chosen.index] = chosen.uppercase
    ? chosen.replacement.toUpperCase()
    : chosen.replacement;

  return chars.join('');
}

// ------------------------------------------------------------ game state

let room = null;
let current = null;

let answerQueue = [];
let answerIndex = 0;

let usedAnswers = new Set();

let questionToken = 0;
let isTyping = false;
let awaitingResult = false;
let generatingToken = null;
let nextAnswerRequested = false;
let resultTimer = null;
let generationAttempts = 0;

// Our own player id, learned from the result of an answer we submitted.
// Until it is known, a display-name match is used only if it is unique.
let selfId = null;
let lastSubmitted = null;

let page = null;

// Declared early: websocket events (e.g. a win) can arrive before startup ends.
let stopping = false;

function playerName(id) {
  return room?.players.get(id) ?? id;
}

function isSelfPlayer(id) {
  if (id == null) return false;
  if (selfId) return id === selfId;

  const wanted = NAME.toLowerCase();
  const matches = room
    ? [...room.players].filter(([, n]) => String(n).toLowerCase() === wanted)
    : [];

  return matches.length === 1 && matches[0][0] === id;
}

// True when the self id cannot be determined yet (no unique name match).
function selfUnknown() {
  if (selfId) return false;
  if (!room) return true;

  const wanted = NAME.toLowerCase();
  let count = 0;

  for (const n of room.players.values()) {
    if (String(n).toLowerCase() === wanted) count++;
  }

  return count !== 1;
}

// Whether the bot currently holds the turn. While our id is still unknown,
// allow submission so the result of that answer can reveal our id.
function isMyTurn() {
  if (!room || room.holderId == null) return false;
  if (selfUnknown()) return true;

  return isSelfPlayer(room.holderId);
}

// Learn our id from the result of the answer we just submitted.
function learnSelfId(id, text) {
  if (selfId || id == null || !awaitingResult || !lastSubmitted || text == null) {
    return;
  }

  const n = normalizeAnswer(text);

  if (n === lastSubmitted.original || n === lastSubmitted.typed) {
    selfId = id;
    console.log(`\x1b[2m[self id learned: ${id}]\x1b[0m`);
  }
}

function clearAwaitingResult() {
  awaitingResult = false;

  if (resultTimer) {
    clearTimeout(resultTimer);
    resultTimer = null;
  }
}

function beginAwaitingResult(token) {
  clearAwaitingResult();
  awaitingResult = true;

  resultTimer = setTimeout(() => {
    resultTimer = null;

    if (!awaitingResult || token !== questionToken || !current) return;

    console.warn(
      `   \x1b[33m[BOT] No result after ${RESULT_TIMEOUT_MS} ms, moving on.\x1b[0m`
    );

    awaitingResult = false;
    requestNextAnswer();
  }, RESULT_TIMEOUT_MS);
}

function updatePlayers(list = []) {
  if (!room || !Array.isArray(list)) return;

  for (const p of list) {
    if (p?.id && typeof p.name === 'string') {
      room.players.set(p.id, p.name);
    }
  }
}

function finishQuestion(reason) {
  if (!current) return;

  save({
    type: 'question',
    room: room?.code,
    gameId: room?.gameId,
    ended: reason,
    ...current
  });

  current = null;
}

// ------------------------------------------------------------ learning from opponents

let answersSaveTimer = null;

// Adds an answer the server accepted from an opponent to the answers
// database for the current category, if it isn't already there.
function learnOpponentAnswer(answer) {
  if (!current || typeof answer !== 'string' || !answer.trim()) return;

  // Our own answer, while our player id is not known yet.
  if (
    awaitingResult &&
    lastSubmitted &&
    [lastSubmitted.original, lastSubmitted.typed].includes(normalizeAnswer(answer))
  ) {
    return;
  }

  const clean = answer.replace(/\s+/g, ' ').trim();
  const category = current.text;

  if (!Array.isArray(ANSWERS_DB[category])) {
    ANSWERS_DB[category] = [];
  }

  const list = ANSWERS_DB[category];
  const n = normalizeAnswer(clean);

  if (list.some((a) => typeof a === 'string' && normalizeAnswer(a) === n)) {
    return;
  }

  list.push(clean);

  // A category with no saved answers started with a separate empty queue;
  // point it at the database list so it sees new answers too.
  if (answerQueue !== list) {
    answerQueue = list;
  }

  console.log(`   \x1b[2m+ learned: ${clean}\x1b[0m`);
  scheduleAnswersSave();
}

// Debounced so a burst of answers is written once.
function scheduleAnswersSave() {
  if (answersSaveTimer) clearTimeout(answersSaveTimer);

  answersSaveTimer = setTimeout(() => {
    answersSaveTimer = null;
    void flushAnswers();
  }, 2000);
}

function flushAnswers() {
  if (answersSaveTimer) {
    clearTimeout(answersSaveTimer);
    answersSaveTimer = null;
  }

  return geminiFallback.saveAnswers(ANSWERS_DB).catch((err) => {
    console.error(`\x1b[31mCould not save answers database: ${err.message}\x1b[0m`);
  });
}

// ------------------------------------------------------------ pacing

const INPUT_SELECTOR =
  'input.ds-input[placeholder="your puffer — type!"], ' +
  'input.ds-input[placeholder*=" is up"]';

// Turn time shrinks the longer a category runs, so speed up gradually:
// 0 at the first answer of a category, 1 after PACE_RAMP_TURNS answers.
function currentPace() {
  const turns = current?.answers.length ?? 0;
  const ramp = Math.min(1, turns / PACE_RAMP_TURNS);
  const lerp = (a, b) => a + (b - a) * ramp;

  return {
    wpm: Math.min(lerp(WPM, MAX_WPM), WPM_CAP),
    delayMin: Math.round(lerp(MIN_DELAY, MIN_DELAY_FAST)),
    delayMax: Math.round(lerp(MAX_DELAY, MAX_DELAY_FAST))
  };
}

// Sleeps for ms, but if the turn becomes ours part-way through a delay that
// started on the opponent's turn, waits at most `onTurnMs` more.
async function paceDelay(token, ms, onTurnMs) {
  const startedOnTurn = isMyTurn();
  let until = Date.now() + ms;
  let shortened = startedOnTurn;

  while (Date.now() < until) {
    if (token !== questionToken || !current) return;

    if (!shortened && isMyTurn()) {
      shortened = true;
      until = Math.min(until, Date.now() + onTurnMs);
    }

    await sleep(Math.min(100, Math.max(0, until - Date.now())));
  }
}

// Waits until the turn is ours. Returns 'turn', 'used' (an opponent got
// this answer accepted first) or 'stale' (question changed / too long).
async function waitForTurn(token, answer, maxMs = 60000) {
  const n = normalizeAnswer(answer);
  const until = Date.now() + maxMs;

  while (Date.now() < until) {
    if (token !== questionToken || !current) return 'stale';
    if (usedAnswers.has(n)) return 'used';
    if (isMyTurn()) return 'turn';

    await sleep(50);
  }

  return 'stale';
}

// ------------------------------------------------------------ answer submission

function requestNextAnswer() {
  if (!current || !page || awaitingResult) return;

  // Typing is allowed during the opponent's turn too (Enter waits for ours),
  // so only require that a round is running.
  if (!room || room.holderId == null) return;

  // Events can arrive while Playwright is delaying or typing. Never lose
  // those requests; the active submission will service them when it exits.
  if (isTyping) {
    nextAnswerRequested = true;
    return;
  }

  // Gemini owns the empty-queue case and will resume submission on completion.
  if (generatingToken === questionToken) {
    nextAnswerRequested = true;
    return;
  }

  nextAnswerRequested = false;
  void submitNextAnswer();
}

async function generateMoreAnswers(token) {
  if (
    generatingToken === token ||
    token !== questionToken ||
    !current
  ) {
    return;
  }

  if (generationAttempts >= GEMINI_MAX_ATTEMPTS) {
    return;
  }

  generationAttempts++;

  const category = current.text;
  generatingToken = token;
  nextAnswerRequested = false;

  console.log(
    `\n\x1b[35m[Gemini] Generating more answers for: "${category}"...\x1b[0m`
  );

  let shouldResume = false;

  try {
    const generated = await geminiFallback.getAnswers(
      category,
      ANSWERS_DB,
      usedAnswers
    );

    if (token !== questionToken || !current || current.text !== category) {
      return;
    }

    answerQueue = Array.isArray(ANSWERS_DB[category])
      ? ANSWERS_DB[category]
      : [];

    console.log(
      `\x1b[35m[Gemini] Added ${generated.length} answers. ` +
      `${answerQueue.length} total available.\x1b[0m`
    );

    shouldResume = answerIndex < answerQueue.length;

    if (!shouldResume) {
      console.warn(
        `\x1b[33m[Gemini] No new unused answers were produced for: "${category}".\x1b[0m`
      );
    }
  } catch (err) {
    console.error(
      `\x1b[31m[Gemini] Could not generate answers: ${err.message}\x1b[0m`
    );
  } finally {
    // Only clear the lock belonging to this generation. An older request
    // must not unlock a newer category's generation.
    if (generatingToken === token) {
      generatingToken = null;
    }
  }

  if (shouldResume && token === questionToken && current?.text === category) {
    nextAnswerRequested = false;
    requestNextAnswer();
  } else if (token === questionToken) {
    // Avoid an immediate retry loop if Gemini failed or returned no usable
    // answers. A later game event can request another attempt.
    nextAnswerRequested = false;
  }
}

async function submitNextAnswer() {
  if (isTyping || awaitingResult || !current || !page) return;

  const token = questionToken;
  let needsFallback = false;
  let reservedIndex = null;
  let enterAttempted = false;

  isTyping = true;
  nextAnswerRequested = false;

  try {
    while (
      token === questionToken &&
      current &&
      answerIndex < answerQueue.length
    ) {
      // Skip answers already accepted by another player.
      while (
        answerIndex < answerQueue.length &&
        usedAnswers.has(normalizeAnswer(answerQueue[answerIndex]))
      ) {
        console.log(
          `   \x1b[2m↪ Skipping already accepted: ${answerQueue[answerIndex]}\x1b[0m`
        );

        answerIndex++;
      }

      if (answerIndex >= answerQueue.length) break;

      // Reserve the next answer. If typing fails before Enter is attempted,
      // restore this index so the answer is not silently lost.
      reservedIndex = answerIndex;
      const originalAnswer = answerQueue[answerIndex++];

      if (typeof originalAnswer !== 'string' || !originalAnswer.trim()) {
        reservedIndex = null;
        continue;
      }

      const pace = currentPace();

      console.log(
        `   \x1b[2mPreparing answer ${answerIndex}/${answerQueue.length}` +
        ` (${Math.round(pace.wpm)} WPM, delay ${pace.delayMin}-${pace.delayMax} ms` +
        `${isMyTurn() ? '' : ', pre-typing on opponent turn'})\x1b[0m`
      );

      // The input is open on our turn ("your puffer — type!") and on the
      // opponent's turn ("<name> is up..."). Start the delay once it is open.
      const input = page.locator(INPUT_SELECTOR);

      await input.waitFor({
        state: 'visible',
        timeout: 15000
      });

      if (token !== questionToken || !current) return;

      await paceDelay(token, randomInt(pace.delayMin, pace.delayMax), pace.delayMin);

      if (token !== questionToken || !current) return;

      if (usedAnswers.has(normalizeAnswer(originalAnswer))) {
        console.log(
          `   \x1b[2m↪ Skipping newly accepted: ${originalAnswer}\x1b[0m`
        );
        reservedIndex = null;
        continue;
      }

      const finalAnswer = introduceTypo(originalAnswer);

      if (finalAnswer !== originalAnswer) {
        console.log(
          `   \x1b[2mIntentional typo: ${originalAnswer} → ${finalAnswer}\x1b[0m`
        );
      }

      await input.click();
      await input.fill('');

      console.log(`   \x1b[36m[BOT] Typing: ${finalAnswer}\x1b[0m`);
      typer.wpm = pace.wpm;
      await typer.type(input, finalAnswer);

      if (token !== questionToken || !current) {
        await input.fill('').catch(() => {});
        return;
      }

      // Typed during the opponent's turn: hold the answer until the turn is ours.
      const ready = await waitForTurn(token, originalAnswer);

      if (ready === 'stale') {
        await input.fill('').catch(() => {});
        if (token === questionToken && current) {
          answerIndex = Math.min(answerIndex, reservedIndex);
        }
        reservedIndex = null;
        return;
      }

      if (ready === 'used') {
        console.log(
          `   \x1b[2m↪ Opponent used it first: ${originalAnswer}\x1b[0m`
        );
        await input.fill('');
        reservedIndex = null;
        continue;
      }

      // The input may re-render when the turn changes; make sure our text is
      // still there before submitting.
      if ((await input.inputValue().catch(() => '')) !== finalAnswer) {
        await input.fill(finalAnswer);
      }

      // Set this before Enter because the server may emit the result before
      // Playwright's press() promise resolves. The timer clears it if no
      // result ever arrives.
      lastSubmitted = {
        original: normalizeAnswer(originalAnswer),
        typed: normalizeAnswer(finalAnswer)
      };
      beginAwaitingResult(token);
      enterAttempted = true;
      await input.press('Enter');

      console.log(
        `   \x1b[32m[BOT] Submitted: ${finalAnswer}\x1b[0m`
      );

      reservedIndex = null;
      return;
    }

    if (
      token === questionToken &&
      current &&
      answerIndex >= answerQueue.length
    ) {
      needsFallback = true;
    }
  } catch (err) {
    // Before Enter, retry the same answer on the next request. Once Enter
    // has been attempted, its delivery is ambiguous, so wait for a result
    // event rather than risk submitting the same answer twice.
    if (token === questionToken && current) {
      if (!enterAttempted && reservedIndex != null) {
        answerIndex = Math.min(answerIndex, reservedIndex);
      }

      if (!enterAttempted) {
        clearAwaitingResult();
      }
    }

    console.error(
      `   \x1b[31m[BOT] Submission error: ${err.message}\x1b[0m`
    );
  } finally {
    isTyping = false;

    // A successful/ambiguous submission must wait for its own pass/reject.
    if (awaitingResult) {
      nextAnswerRequested = false;
    } else if (
      nextAnswerRequested &&
      !needsFallback &&
      current
    ) {
      // This also handles the fast-result race where pass/reject arrives
      // before the awaited Playwright Enter call has returned, and a request
      // for a newer question that arrived while this (stale) one was typing.
      nextAnswerRequested = false;
      requestNextAnswer();
    }
  }

  if (token !== questionToken || !current) return;

  if (needsFallback) {
    nextAnswerRequested = false;
    void generateMoreAnswers(token);
    return;
  }

  // Service any event that arrived while the previous submission was busy.
  if (nextAnswerRequested && !awaitingResult) {
    nextAnswerRequested = false;
    requestNextAnswer();
  }
}

// ------------------------------------------------------------ categories

function onCategory(cat) {
  if (!cat) {
    if (current) {
      questionToken++;
      finishQuestion('category cleared');
    }

    answerQueue = [];
    answerIndex = 0;
    usedAnswers.clear();
    clearAwaitingResult();
    nextAnswerRequested = false;
    return;
  }

  if (
    current &&
    current.index === cat.index &&
    current.text === cat.text
  ) {
    return;
  }

  // Invalidate any outstanding submission from the previous category.
  questionToken++;

  finishQuestion('next');
  generationAttempts = 0;

  current = {
    index: cat.index,
    text: cat.text,
    threshold: cat.threshold,
    answers: [],
    rejects: []
  };

  answerQueue = Array.isArray(ANSWERS_DB[cat.text])
    ? ANSWERS_DB[cat.text]
    : [];

  answerIndex = 0;
  usedAnswers.clear();
  clearAwaitingResult();
  nextAnswerRequested = false;

  console.log(
    `\n\x1b[1;36mQ${cat.index}: ${cat.text}\x1b[0m` +
    `  \x1b[2m(threshold ${cat.threshold})\x1b[0m`
  );

  if (answerQueue.length === 0) {
    console.log(
      `\x1b[33mNo saved answers for: "${cat.text}". Using Gemini fallback...\x1b[0m`
    );

    void generateMoreAnswers(questionToken);
    return;
  }

  console.log(
    `Loaded ${answerQueue.length} saved answers. Starting...`
  );

  requestNextAnswer();
}

// ------------------------------------------------------------ websocket events

const seenSeq = new Set();

function onEvents(events = []) {
  for (const e of events) {
    if (e.seq != null) {
      if (seenSeq.has(e.seq)) continue;
      seenSeq.add(e.seq);

      if (seenSeq.size > 10000) {
        const oldest = seenSeq.values().next().value;
        seenSeq.delete(oldest);
      }
    }

    switch (e.kind) {
      case 'pass': {
        const answer = e.answer;
        const player = playerName(e.from);

        learnSelfId(e.from, answer);

        // Track accepted answers from EVERY player.
        if (answer) {
          usedAnswers.add(normalizeAnswer(answer));
        }

        current?.answers.push({
          by: player,
          answer,
          tier: e.tier
        });

        if (!isSelfPlayer(e.from)) {
          learnOpponentAnswer(answer);
        }

        console.log(
          `   ✓ ${player}: ${answer} \x1b[2m[${e.tier}]\x1b[0m`
        );

        // If this was our answer, its result has arrived.
        if (isSelfPlayer(e.from)) {
          clearAwaitingResult();
          requestNextAnswer();
        } else if (!awaitingResult) {
          // An opponent answered while we weren't waiting for our own result.
          requestNextAnswer();
        }

        break;
      }

      case 'reject': {
        learnSelfId(e.playerId, e.text);

        const player = playerName(e.playerId);

        current?.rejects.push({
          by: player,
          text: e.text,
          why: e.why
        });

        console.log(
          `   \x1b[2m✗ ${player}: ${e.text} (${e.why})\x1b[0m`
        );

        // Our rejection resolves our in-flight answer. An opponent rejection
        // also means the bot may take its turn if it is not awaiting its own result.
        if (isSelfPlayer(e.playerId)) {
          clearAwaitingResult();
          requestNextAnswer();
        } else if (!awaitingResult) {
          requestNextAnswer();
        }

        break;
      }

      case 'pop': {
        console.log(
          `   \x1b[31m💥 ${playerName(e.playerId)} popped, ${e.livesLeft} lives left\x1b[0m`
        );

        save({
          type: 'pop',
          room: room?.code,
          gameId: room?.gameId,
          player: playerName(e.playerId),
          livesLeft: e.livesLeft
        });

        // A pop commonly represents a player timing out or failing to answer.
        // Treat it as a turn-resolution event, but never interrupt our own
        // answer while we are still waiting for its result.
        if (isSelfPlayer(e.playerId)) {
          clearAwaitingResult();
          requestNextAnswer();
        } else if (!awaitingResult) {
          requestNextAnswer();
        }

        break;
      }

      case 'win': {
        console.log(
          `\n\x1b[32m🏆 ${playerName(e.playerId)} wins\x1b[0m`
        );

        questionToken++;
        clearAwaitingResult();

        finishQuestion('game over');

        save({
          type: 'win',
          room: room?.code,
          gameId: room?.gameId,
          player: playerName(e.playerId)
        });

        void clickNewOpponent();

        break;
      }
    }
  }
}

// ------------------------------------------------------------ websocket messages

function onMessage(raw) {
  let msg;

  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }

  if (msg.t === 'snap' && msg.room) {
    const r = msg.room;

    if (room?.code !== r.code) {
      // New room (e.g. after NEW OPPONENT): player ids and event sequence
      // numbers are per room, so forget the old ones.
      selfId = null;
      lastSubmitted = null;
      seenSeq.clear();
    }

    room = {
      code: r.code,
      gameId: r.gameId,
      holderId: r.holderId ?? null,
      players: new Map()
    };

    updatePlayers(r.players);

    console.log(
      `\x1b[32mJoined room ${r.code}\x1b[0m (${r.players.length} players, phase: ${r.phase})`
    );

    onCategory(r.category);

    // On a reconnect to the same question, onCategory returns early; resume
    // if the turn is ours.
    requestNextAnswer();
  } else if (msg.t === 'patch' && room) {
    const p = msg.patch;

    updatePlayers(p.players);

    if (p.set?.gameId && p.set.gameId !== room.gameId) {
      questionToken++;
      clearAwaitingResult();
      nextAnswerRequested = false;
      answerQueue = [];
      answerIndex = 0;
      usedAnswers.clear();
      generationAttempts = 0;

      finishQuestion('new game');

      room.gameId = p.set.gameId;
    }

    // Update whose turn it is before handling events, so requests made by
    // the event handlers are gated on the new holder.
    const holderChanged = Boolean(p.set) && 'holderId' in p.set &&
      p.set.holderId !== room.holderId;

    if (p.set && 'holderId' in p.set) {
      room.holderId = p.set.holderId ?? null;
    }

    // Process events before category changes so answers attach
    // to the question they belong to.
    onEvents(p.events);

    if (p.set && 'category' in p.set) {
      onCategory(p.set.category);
    }

    // The turn arrived without an event that requested an answer.
    if (holderChanged && isMyTurn()) {
      requestNextAnswer();
    }
  }
}

// ------------------------------------------------------------ menu buttons

// Clicks a button until its label changes or it disappears, alternating a
// Playwright click with a DOM click in case one of them is swallowed.
async function clickButtonUntilChanged({
  title,
  pattern,
  maxTries = 30,
  everyMs = 1500,
  waitTimeout = 30000,
  beforeClickMs = 0
}) {
  const locator = page.locator('button', { hasText: pattern }).first();

  await locator.waitFor({
    state: 'visible',
    timeout: waitTimeout
  });

  if (beforeClickMs > 0) {
    console.log(`  waiting ${beforeClickMs} ms before clicking ${title}...`);
    await sleep(beforeClickMs);
  }

  const btn = await locator.elementHandle();

  const label = async () =>
    (
      await btn.evaluate(
        (el) => (el.isConnected ? el.innerText : null)
      ).catch(() => null)
    )?.trim() ?? null;

  const unchanged = (text) => text !== null && pattern.test(text);

  const report = (text) => console.log(
    text === null
      ? `${title} button gone, assuming we are in.`
      : `${title} started ("${text}")`
  );

  for (let i = 1; i <= maxTries; i++) {
    const before = await label();

    if (!unchanged(before)) return report(before);

    if (i % 2) {
      await btn.click({
        force: true,
        timeout: 2000
      }).catch((e) => {
        console.log(
          `  click ${i} failed: ${e.message.split('\n')[0]}`
        );
      });
    } else {
      await btn.evaluate((el) => el.click()).catch(() => {});
    }

    const until = Date.now() + everyMs;

    while (Date.now() < until) {
      const now = await label();

      if (!unchanged(now)) return report(now);

      await page.waitForTimeout(150);
    }

    console.log(
      `  ${title} label unchanged after click ${i}, retrying...`
    );
  }

  throw new Error(
    `${title} never started after ${maxTries} clicks`
  );
}

const QUICK_PLAY = { title: 'Quick Play', pattern: /^\s*QUICK PLAY\s*$/ };
const RATED_PLAY = { title: 'Rated', pattern: /^\s*▶\s*RATED\s*◀\s*$/ };
const NEW_OPPONENT = { title: 'New Opponent', pattern: /^\s*NEW OPPONENT\s*$/ };

let newOpponentPending = false;

// After a game ends, queue for the next one.
async function clickNewOpponent() {
  if (newOpponentPending || stopping || !page) return;

  newOpponentPending = true;

  try {
    console.log('Game over, looking for NEW OPPONENT...');

    await clickButtonUntilChanged({
      ...NEW_OPPONENT,
      waitTimeout: 60000,
      // Leave time to see the result and rating change.
      beforeClickMs: randomInt(NEW_OPPONENT_MIN_DELAY, NEW_OPPONENT_MAX_DELAY)
    });
  } catch (err) {
    console.error(
      `\x1b[31mCould not click NEW OPPONENT: ${err.message.split('\n')[0]}\x1b[0m`
    );
  } finally {
    newOpponentPending = false;
  }
}

// ------------------------------------------------------------ browser startup

console.log('Starting Brave...');
console.log(`Name: ${NAME}`);
console.log(`Mode: ${ROOM ? `room ${ROOM}` : RATED ? 'rated' : 'unrated (quick play)'}`);
console.log(`Answers database: ${ANSWERS_DB_PATH}`);
console.log(`Human typing speed: ${WPM} WPM`);
console.log(`Typo probability: ${(TYPO_CHANCE * 100).toFixed(1)}%`);

const brave = spawn(
  BRAVE,
  [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${path.resolve('.brave-profile')}`,
    '--no-first-run',
    '--hide-crash-restore-bubble',
    'https://krillion.io/party/'
  ],
  {
    stdio: 'ignore'
  }
);

brave.on('error', (err) => {
  console.error(`Could not start Brave: ${err.message}`);
});

let browser;

for (let i = 0; i < 40 && !browser; i++) {
  try {
    browser = await chromium.connectOverCDP(
      `http://127.0.0.1:${PORT}`
    );
  } catch {
    await sleep(250);
  }
}

if (!browser) {
  brave.kill();

  throw new Error(
    'Could not connect to Brave. Close other Brave windows using .brave-profile and retry.'
  );
}

const context = browser.contexts()[0];

page = context.pages()[0] || await context.newPage();

// ------------------------------------------------------------ websocket listener

page.on('websocket', (ws) => {
  if (!ws.url().includes('party.krillion.io/rooms/')) {
    return;
  }

  console.log('\x1b[2m[WebSocket connected]\x1b[0m');

  ws.on('framereceived', ({ payload }) => {
    if (typeof payload === 'string') {
      onMessage(payload);
    } else if (Buffer.isBuffer(payload)) {
      onMessage(payload.toString('utf8'));
    }
  });

  ws.on('close', () => {
    console.log('\x1b[2m[connection closed]\x1b[0m');
  });
});

// ------------------------------------------------------------ join room

await page.goto('https://krillion.io/party/');

const nameBox = page.getByPlaceholder('what the ring calls you');

await nameBox.waitFor({
  timeout: 30000
});

await nameBox.fill(NAME);

if (ROOM) {
  console.log(`Joining room ${ROOM}...`);

  await page.goto(`https://krillion.io/party/${ROOM}`);
} else {
  const mode = RATED ? RATED_PLAY : QUICK_PLAY;

  console.log(`Starting ${mode.title}...`);

  await clickButtonUntilChanged(mode);
}

console.log(
  'If a Cloudflare check appears in Brave, click it. Close Brave to stop.\n'
);

// ------------------------------------------------------------ shutdown


function stop() {
  if (stopping) return;

  stopping = true;

  questionToken++;
  clearAwaitingResult();

  finishQuestion('stopped');

  // If the log stream has errored, end()'s callback may never fire.
  const exitTimer = setTimeout(() => process.exit(0), 5000);

  // Write any learned answers still waiting for the debounce.
  const pending = answersSaveTimer ? flushAnswers() : Promise.resolve();

  pending.finally(() => {
    out.end(() => {
      clearTimeout(exitTimer);
      console.log(`\nSaved to ${outFile}`);
      process.exit(0);
    });
  });
}

browser.on('disconnected', stop);

let closingBrowser = false;

async function closeBrave() {
  if (stopping) return;

  // A second Ctrl+C while closing forces the browser down and exits.
  if (closingBrowser) {
    brave.kill();
    stop();
    return;
  }

  closingBrowser = true;

  // Schedule the fallback first so a hung CDP call cannot block shutdown.
  setTimeout(stop, 3000);

  try {
    const cdp = await browser.newBrowserCDPSession();
    await cdp.send('Browser.close');
  } catch {
    brave.kill();
  }
}

if (Number.isFinite(STOP_AFTER) && STOP_AFTER > 0) {
  console.log(`Auto-stop enabled: ${STOP_AFTER} seconds`);

  setTimeout(closeBrave, STOP_AFTER * 1000);
} else {
  console.log('Auto-stop disabled.');
}

process.on('SIGINT', closeBrave);