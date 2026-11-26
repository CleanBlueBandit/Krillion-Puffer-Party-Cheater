#!/usr/bin/env node
/**
 * HumanTyping - realistic keyboard typing simulator (Node.js ESM port)
 * ====================================================================
 *
 * Simulates human typing behaviour (variable speed, neighbour-key errors,
 * swap errors, corrections, fatigue) with a Markov-chain model.
 * Zero dependencies. Requires Node.js >= 18.3.
 *
 * Library usage (Playwright / Puppeteer / selenium-webdriver / WebdriverIO):
 *
 *     import { HumanTyper } from "./humantyping.mjs";
 *
 *     const typer = new HumanTyper({ wpm: 70 });
 *     const input = page.locator("input[name='search']");
 *     await input.click();
 *     await typer.type(input, "Hello, realistic typing!");
 *
 * CLI usage:
 *
 *     node humantyping.mjs "some text" --mode demo --wpm 60
 *     node humantyping.mjs "some text" --mode montecarlo --n 500
 *
 * MIT License.
 */

import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { setTimeout as sleepMs } from "node:timers/promises";

export const VERSION = "1.0.3";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Default average typing speed (words per minute)
export const DEFAULT_WPM = 60;
export const WPM_STD = 10; // WPM standard deviation

// Average word length (standard)
export const AVG_WORD_LENGTH = 5;

// Probabilities
export const PROB_ERROR = 0.04;
export const PROB_SWAP_ERROR = 0.015;
export const PROB_NOTICE_ERROR = 0.85;

// Correction probabilities
export const DRIFT_CORRECTION_PROB = 0.8; // Probability to notice error at distance >= 2

// Error multipliers by context
export const COMPLEX_WORD_ERROR_MULT = 1.5;
export const COMMON_WORD_ERROR_MULT = 0.5;
export const COMPOSED_ACCENT_ERROR_MULT = 2.0;

// Speed factors (multipliers on keystroke time, < 1.0 = faster)
export const SPEED_BOOST_COMMON_WORD = 0.6;
export const SPEED_PENALTY_COMPLEX_WORD = 1.3;
export const SPEED_BOOST_CLOSE_KEYS = 0.5;
export const SPEED_BOOST_BIGRAM = 0.4;

// Key distance thresholds
export const CLOSE_KEY_THRESHOLD = 2.0;
export const FAR_KEY_THRESHOLD = 4.0;
export const FAR_KEY_PENALTY = 1.2;

// Minimum speed multiplier to prevent unrealistic stacking of boosts
export const MIN_SPEED_MULTIPLIER = 0.15;

// Time (in seconds)
export const TIME_KEYSTROKE_STD = 0.03;
export const TIME_BACKSPACE_MEAN = 0.12;
export const TIME_BACKSPACE_STD = 0.02;
export const TIME_REACTION_MEAN = 0.35;
export const TIME_REACTION_STD = 0.1;

// Floor values for time samples
export const MIN_KEYSTROKE_TIME = 0.02;
export const MIN_REACTION_TIME = 0.1;
export const MIN_BACKSPACE_TIME = 0.03;

// Specific penalties
export const TIME_DIRECT_ACCENT_PENALTY = 0.15;
export const TIME_COMPOSED_ACCENT_PENALTY = 0.4;
export const TIME_UPPERCASE_PENALTY = 0.2;
export const TIME_SPACE_PAUSE_MEAN = 0.25;
export const TIME_SPACE_PAUSE_STD = 0.05;

// Fatigue
export const FATIGUE_FACTOR = 1.0005;
export const FATIGUE_CAP = 1.5; // Maximum fatigue multiplier

// ---------------------------------------------------------------------------
// Random helpers
// ---------------------------------------------------------------------------

/** Sample from a normal distribution (Box-Muller). */
function randomNormal(mean, std) {
  let u = 0;
  while (u === 0) u = Math.random();
  const v = Math.random();
  return mean + std * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function randomChoice(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Python-style str.isupper() for a single character. */
function isUpper(ch) {
  return ch !== ch.toLowerCase() && ch === ch.toUpperCase();
}

// ---------------------------------------------------------------------------
// Language model
// ---------------------------------------------------------------------------

// List of very common English words
export const COMMON_WORDS = new Set([
  "the", "be", "to", "of", "and", "a", "in", "that", "have", "it",
  "for", "not", "on", "with", "he", "as", "you", "do", "at", "this",
  "but", "his", "by", "from", "they", "we", "say", "her", "she", "or",
  "an", "will", "my", "one", "all", "would", "there", "their", "what",
  "so", "up", "out", "if", "about", "who", "get", "which", "go", "me",
  "when", "make", "can", "like", "time", "no", "just", "him", "know",
  "take", "people", "into", "year", "your", "good", "some", "could",
  "them", "see", "other", "than", "then", "now", "look", "only", "come",
  "its", "over", "think", "also", "back", "after", "use", "two", "how",
  "our", "work", "first", "well", "way", "even", "new", "want", "because",
]);

// Common bigrams in English (for burst typing)
export const COMMON_BIGRAMS = new Set([
  "th", "he", "in", "er", "an", "re", "on", "at", "en", "nd", "ti", "es",
  "or", "te", "of", "ed", "is", "it", "al", "ar", "st", "to", "nt", "ng",
  "se", "ha", "as", "ou", "io", "le", "ve", "co", "me", "de", "hi", "ri",
  "ro", "ic", "ne", "ea", "ra", "ce",
]);

const PUNCTUATION_CHARS = new Set(".,!?;:'\"-()[]{}/");

function stripPunctuation(word) {
  let start = 0;
  let end = word.length;
  while (start < end && PUNCTUATION_CHARS.has(word[start])) start++;
  while (end > start && PUNCTUATION_CHARS.has(word[end - 1])) end--;
  return word.slice(start, end);
}

/** @returns {"common" | "complex" | "normal"} */
export function getWordDifficulty(word) {
  const w = stripPunctuation(word.toLowerCase());
  if (COMMON_WORDS.has(w)) return "common";
  const isLong = w.length > 8;
  const hasComplexChars = /[zxqj]/.test(w);
  if (isLong || hasComplexChars) return "complex";
  return "normal";
}

export function isCommonBigram(char1, char2) {
  return COMMON_BIGRAMS.has((char1 + char2).toLowerCase());
}

// ---------------------------------------------------------------------------
// Keyboard layout
// ---------------------------------------------------------------------------

const LAYOUTS = {
  qwerty: ["`1234567890-=", "qwertyuiop[]\\", "asdfghjkl;'", "zxcvbnm,./"],
  azerty: ["&é\"'(-è_çà)=", "azertyuiop^$", "qsdfghjklmù*", "wxcvbn,;:!"],
};

export class KeyboardLayout {
  constructor(layoutName = "qwerty") {
    if (!Object.hasOwn(LAYOUTS, layoutName)) {
      throw new Error(`Unsupported layout: '${layoutName}'. Use 'qwerty' or 'azerty'.`);
    }
    this.layoutName = layoutName;
    this.grid = LAYOUTS[layoutName].map((row) => [...row]);
    this.posMap = this.#buildPosMap();

    if (layoutName === "azerty") {
      this.directAccents = new Set("éèàùç");
      this.composedAccents = new Set("âêîôûäëïöü");
    } else {
      // QWERTY has no direct accent keys
      this.directAccents = new Set();
      this.composedAccents = new Set("âêîôûäëïöüéèàùç");
    }
  }

  #buildPosMap() {
    const mapping = new Map();
    this.grid.forEach((row, r) => row.forEach((ch, c) => mapping.set(ch, [r, c])));

    // AZERTY: map digits to the same positions as row 0 characters
    if (this.layoutName === "azerty") {
      const row0 = "&é\"'(-è_çà)";
      const digits = "1234567890";
      for (let i = 0; i < digits.length; i++) {
        if (mapping.has(row0[i]) && !mapping.has(digits[i])) {
          mapping.set(digits[i], mapping.get(row0[i]));
        }
      }
    }
    return mapping;
  }

  /** Normalize a character for keyboard position lookup. */
  #normalizeChar(ch) {
    ch = ch.toLowerCase();
    if (this.composedAccents.has(ch)) {
      return ch.normalize("NFD").replace(/\p{Mn}/gu, "");
    }
    return ch;
  }

  /** Check if a character exists on this keyboard layout. */
  hasKey(ch) {
    return this.posMap.has(this.#normalizeChar(ch));
  }

  /** Return the neighbouring keys for a given character. */
  getNeighborKeys(ch) {
    const pos = this.posMap.get(this.#normalizeChar(ch));
    if (!pos) return [];
    const [r, c] = pos;
    const neighbors = [];
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const nr = r + dr;
        const nc = c + dc;
        if (nr >= 0 && nr < this.grid.length && nc >= 0 && nc < this.grid[nr].length) {
          neighbors.push(this.grid[nr][nc]);
        }
      }
    }
    return neighbors;
  }

  /** Euclidean distance between two keys. */
  getDistance(char1, char2) {
    const p1 = this.posMap.get(this.#normalizeChar(char1));
    const p2 = this.posMap.get(this.#normalizeChar(char2));
    if (!p1 || !p2) return FAR_KEY_THRESHOLD;
    return Math.hypot(p1[0] - p2[0], p1[1] - p2[1]);
  }

  /** Return a random neighbouring key, preserving case. */
  getRandomNeighbor(ch) {
    const wasUpper = isUpper(ch);
    const neighbors = this.getNeighborKeys(ch);
    const result = neighbors.length ? randomChoice(neighbors) : randomChoice(this.grid.flat());
    return wasUpper ? result.toUpperCase() : result;
  }

  isDirectAccent(ch) {
    return this.directAccents.has(ch.toLowerCase());
  }

  isComposedAccent(ch) {
    return this.composedAccents.has(ch.toLowerCase());
  }
}

// ---------------------------------------------------------------------------
// Markov typer
// ---------------------------------------------------------------------------

/**
 * A history event: [timeSeconds, action, currentText].
 * Action is one of: "INIT (...)", "BACKSPACE", "TYPED 'x'",
 * "TYPED_ERROR 'x'", "TYPED_SWAP 'xy'".
 * @typedef {[number, string, string]} TypingEvent
 */

const WORD_BOUNDARY_CHARS = new Set(" \n\t.,;!?:()[]{}<>\"'");

export class MarkovTyper {
  constructor(targetText, targetWpm = DEFAULT_WPM, layout = "qwerty") {
    if (typeof targetText !== "string" || targetText.length === 0) {
      throw new Error("targetText must be a non-empty string");
    }
    if (typeof targetWpm !== "number" || !(targetWpm > 0)) {
      throw new Error("targetWpm must be a positive number");
    }

    this.targetText = targetText;
    this.keyboard = new KeyboardLayout(layout);
    this.state = {
      currentText: "",
      targetText,
      totalTime: 0,
      /** @type {TypingEvent[]} */
      history: [],
      lastCharTyped: null,
      fatigueMultiplier: 1.0,
      mentalCursorPos: 0,
    };

    this.sessionWpm = Math.max(10, randomNormal(targetWpm, WPM_STD));
    this.baseKeystrokeTime = 60 / (this.sessionWpm * AVG_WORD_LENGTH);

    this.state.history.push([0, `INIT (WPM: ${this.sessionWpm.toFixed(1)})`, ""]);
  }

  #getCurrentWordContext() {
    const text = this.targetText;
    const idx = this.state.mentalCursorPos;
    if (idx >= text.length) return null;
    let start = idx;
    while (start > 0 && text[start - 1] !== " ") start--;
    let end = idx;
    while (end < text.length && text[end] !== " ") end++;
    return text.slice(start, end);
  }

  #calculateKeystrokeTime(charToType) {
    const s = this.state;
    let t = this.baseKeystrokeTime * s.fatigueMultiplier;

    const word = this.#getCurrentWordContext();
    if (word) {
      const difficulty = getWordDifficulty(word);
      if (difficulty === "common") t *= SPEED_BOOST_COMMON_WORD;
      else if (difficulty === "complex") t *= SPEED_PENALTY_COMPLEX_WORD;
    }

    if (s.lastCharTyped) {
      if (isCommonBigram(s.lastCharTyped, charToType)) {
        t *= SPEED_BOOST_BIGRAM;
      } else {
        const dist = this.keyboard.getDistance(s.lastCharTyped, charToType);
        if (dist > 0 && dist < CLOSE_KEY_THRESHOLD) t *= SPEED_BOOST_CLOSE_KEYS;
        else if (dist > FAR_KEY_THRESHOLD) t *= FAR_KEY_PENALTY;
      }
    }

    if (charToType === " ") t += randomNormal(TIME_SPACE_PAUSE_MEAN, TIME_SPACE_PAUSE_STD);
    else if (this.keyboard.isComposedAccent(charToType)) t += TIME_COMPOSED_ACCENT_PENALTY;
    else if (this.keyboard.isDirectAccent(charToType)) t += TIME_DIRECT_ACCENT_PENALTY;
    else if (isUpper(charToType)) t += TIME_UPPERCASE_PENALTY;

    // Apply floor to prevent unrealistic stacking of boosts
    t = Math.max(MIN_SPEED_MULTIPLIER * this.baseKeystrokeTime, t);

    return Math.max(MIN_KEYSTROKE_TIME, randomNormal(t, TIME_KEYSTROKE_STD));
  }

  #bumpFatigue() {
    this.state.fatigueMultiplier = Math.min(FATIGUE_CAP, this.state.fatigueMultiplier * FATIGUE_FACTOR);
  }

  #record(action) {
    /** @type {TypingEvent} */
    const event = [this.state.totalTime, action, this.state.currentText];
    this.state.history.push(event);
    return event;
  }

  /** Advance one step. Returns the event, or null when finished. */
  step() {
    const s = this.state;
    const target = this.targetText;

    // 1. Check for completion
    if (s.currentText === target) return null;

    // --- MONITORING & CORRECTION PHASE ---

    // Divergence point (over-typing counts as an error at target.length)
    let firstErrorPos = target.length;
    const minLen = Math.min(s.currentText.length, target.length);
    for (let i = 0; i < minLen; i++) {
      if (s.currentText[i] !== target[i]) {
        firstErrorPos = i;
        break;
      }
    }

    if (firstErrorPos < s.currentText.length) {
      let shouldCorrect = false;
      const lastAction = s.history.length ? s.history[s.history.length - 1][1] : "";

      if (lastAction.includes("BACKSPACE")) {
        // Case 0: continued backspacing
        shouldCorrect = true;
      } else if (s.mentalCursorPos >= target.length) {
        // Case A: end of text (always correct)
        shouldCorrect = true;
      } else if (s.currentText.length > 0) {
        // Case B: end of word / context check
        const lastChar = s.currentText[s.currentText.length - 1];
        const distance = s.currentText.length - firstErrorPos;

        if (WORD_BOUNDARY_CHARS.has(lastChar)) {
          shouldCorrect = true;
        } else if (distance >= 2) {
          // Drift check (don't let errors linger)
          if (Math.random() < DRIFT_CORRECTION_PROB) shouldCorrect = true;
        } else if (distance === 1) {
          // Immediate reaction (1 char past error)
          if (Math.random() < PROB_NOTICE_ERROR) shouldCorrect = true;
        }
      }

      if (shouldCorrect) {
        // Reaction time (only if we weren't already backspacing)
        if (!lastAction.includes("BACKSPACE")) {
          s.totalTime += Math.max(MIN_REACTION_TIME, randomNormal(TIME_REACTION_MEAN, TIME_REACTION_STD));
        }

        // Perform backspace
        s.totalTime += Math.max(MIN_BACKSPACE_TIME, randomNormal(TIME_BACKSPACE_MEAN, TIME_BACKSPACE_STD));
        s.currentText = s.currentText.slice(0, -1);
        const event = this.#record("BACKSPACE");

        // Sync mental cursor immediately
        s.mentalCursorPos = s.currentText.length;
        return event;
      }
    }

    // --- TYPING PHASE ---

    if (s.mentalCursorPos > s.currentText.length) s.mentalCursorPos = s.currentText.length;
    if (s.mentalCursorPos >= target.length) return null;

    const charIntended = target[s.mentalCursorPos];

    // Character not on our keyboard: type it literally (no error modelling)
    if (!this.keyboard.hasKey(charIntended) && charIntended !== " ") {
      this.#bumpFatigue();
      const mean = this.baseKeystrokeTime * s.fatigueMultiplier;
      s.totalTime += Math.max(MIN_KEYSTROKE_TIME, randomNormal(mean, TIME_KEYSTROKE_STD));
      s.currentText += charIntended;
      s.lastCharTyped = charIntended;
      const event = this.#record(`TYPED '${charIntended}'`);
      s.mentalCursorPos += 1;
      return event;
    }

    this.#bumpFatigue();

    // Swap error (anticipation): "the" -> "hte"
    if (target.length > s.mentalCursorPos + 1) {
      const charAfter = target[s.mentalCursorPos + 1];
      if (charAfter !== " " && charAfter !== charIntended && Math.random() < PROB_SWAP_ERROR) {
        s.totalTime += this.#calculateKeystrokeTime(charAfter);
        s.currentText += charAfter;

        s.totalTime += this.#calculateKeystrokeTime(charIntended);
        s.currentText += charIntended;

        s.lastCharTyped = charIntended;
        const event = this.#record(`TYPED_SWAP '${charAfter}${charIntended}'`);
        s.mentalCursorPos += 2;
        return event;
      }
    }

    // Normal typing (success or error)
    let probError = PROB_ERROR;
    const wordDiff = getWordDifficulty(this.#getCurrentWordContext() ?? "");
    if (wordDiff === "complex") probError *= COMPLEX_WORD_ERROR_MULT;
    else if (wordDiff === "common") probError *= COMMON_WORD_ERROR_MULT;
    if (this.keyboard.isComposedAccent(charIntended)) probError *= COMPOSED_ACCENT_ERROR_MULT;

    let event;
    if (Math.random() < probError) {
      const wrongChar = this.keyboard.getRandomNeighbor(charIntended);
      s.totalTime += this.#calculateKeystrokeTime(wrongChar);
      s.currentText += wrongChar;
      s.lastCharTyped = wrongChar;
      event = this.#record(`TYPED_ERROR '${wrongChar}'`);
    } else {
      s.totalTime += this.#calculateKeystrokeTime(charIntended);
      s.currentText += charIntended;
      s.lastCharTyped = charIntended;
      event = this.#record(`TYPED '${charIntended}'`);
    }
    s.mentalCursorPos += 1;
    return event;
  }

  /** Run to completion. @returns {{ totalTime: number, history: TypingEvent[] }} */
  run() {
    const maxSteps = this.targetText.length * 10;
    let steps = 0;
    while (this.step() !== null) {
      if (++steps > maxSteps) break;
    }
    return { totalTime: this.state.totalTime, history: this.state.history };
  }
}

// ---------------------------------------------------------------------------
// Automation integration
// ---------------------------------------------------------------------------

/** Extract the typed character(s) from an action like TYPED 'x' or TYPED_SWAP 'ht'. */
function extractChars(action) {
  return action.slice(action.indexOf("'") + 1, action.lastIndexOf("'"));
}

function typingHistory(text, wpm, layout) {
  if (typeof text !== "string" || text.length === 0) {
    throw new Error("text must be a non-empty string");
  }
  return new MarkovTyper(text, wpm, layout).run().history;
}

/**
 * Replays a simulated typing session, awaiting `onBackspace()` / `onKey(char)`
 * with realistic delays between keystrokes.
 */
async function replay(history, onKey, onBackspace) {
  let lastTime = 0;
  for (const [t, action] of history) {
    const delay = t - lastTime;
    if (delay > 0) await sleepMs(delay * 1000);
    lastTime = t;

    if (action.includes("BACKSPACE")) {
      await onBackspace();
    } else if (action.startsWith("TYPED")) {
      // TYPED, TYPED_ERROR, TYPED_SWAP
      for (const ch of extractChars(action)) await onKey(ch);
    }
  }
}

// selenium-webdriver's Key.BACK_SPACE (WebDriver code point U+E003)
const WEBDRIVER_BACKSPACE = "";

/**
 * Integrates realistic typing into automation frameworks such as
 * Playwright, Puppeteer, selenium-webdriver, WebdriverIO and Appium.
 */
export class HumanTyper {
  constructor({ wpm = 60, layout = "qwerty" } = {}) {
    if (typeof wpm !== "number" || !(wpm > 0)) {
      throw new Error("wpm must be a positive number");
    }
    this.wpm = wpm;
    this.layout = layout;
  }

  /**
   * Types text into an element with realistic human behaviour.
   *
   * Supports any element exposing either:
   * - `press(key)`    — Playwright Locator/ElementHandle, Puppeteer ElementHandle
   * - `sendKeys(...)` — selenium-webdriver WebElement
   * - `addValue(...)` — WebdriverIO element
   */
  async type(element, text) {
    const history = typingHistory(text, this.wpm, this.layout);

    if (typeof element?.press === "function") {
      return replay(history, (ch) => element.press(ch), () => element.press("Backspace"));
    }
    if (typeof element?.sendKeys === "function") {
      return replay(history, (ch) => element.sendKeys(ch), () => element.sendKeys(WEBDRIVER_BACKSPACE));
    }
    if (typeof element?.addValue === "function") {
      return replay(history, (ch) => element.addValue(ch), () => element.addValue(WEBDRIVER_BACKSPACE));
    }
    throw new TypeError("Unsupported element: expected press(), sendKeys() or addValue()");
  }

  /**
   * Types text into the currently focused element at the driver level
   * (WebdriverIO / Appium `driver.keys()`). The element must already be focused.
   */
  async typeAppium(driver, text) {
    if (typeof driver?.keys !== "function") {
      throw new TypeError("Unsupported driver: expected keys()");
    }
    const history = typingHistory(text, this.wpm, this.layout);
    return replay(history, (ch) => driver.keys(ch), () => driver.keys(WEBDRIVER_BACKSPACE));
  }
}

// ---------------------------------------------------------------------------
// Simulation (CLI)
// ---------------------------------------------------------------------------

/** Runs n simulations to estimate the typing-time distribution. */
export function runMonteCarlo(targetText, wpm, nSimulations = 100) {
  console.log(`Running ${nSimulations} simulations for text: '${targetText}' (Target WPM: ${wpm})`);

  const startGlobal = performance.now();
  const times = [];
  for (let i = 0; i < nSimulations; i++) {
    times.push(new MarkovTyper(targetText, wpm).run().totalTime);
  }
  const elapsed = (performance.now() - startGlobal) / 1000;

  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  const std = Math.sqrt(times.reduce((a, b) => a + (b - mean) ** 2, 0) / times.length);

  console.log("\n--- Monte Carlo Results ---");
  console.log(`Estimated Mean Time : ${mean.toFixed(4)} s`);
  console.log(`Standard Deviation  : ${std.toFixed(4)} s`);
  console.log(`Min / Max           : ${Math.min(...times).toFixed(4)} s / ${Math.max(...times).toFixed(4)} s`);
  console.log(`Computation Time    : ${elapsed.toFixed(4)} s`);

  return times;
}

/** Displays a detailed real-time simulation in the terminal. */
export async function demoSingleRun(targetText, wpm) {
  const out = process.stdout;
  if (targetText.includes("\n")) {
    console.log(`\n--- Real-Time Simulation Demo:\n${targetText}\n(Target WPM: ${wpm}) ---`);
  } else {
    console.log(`\n--- Real-Time Simulation Demo: '${targetText}' (Target WPM: ${wpm}) ---`);
  }
  console.log("Preparing simulation...\n");

  // 1. Calculate trajectory instantly
  const { totalTime, history } = new MarkovTyper(targetText, wpm).run();

  // 2. Replay history
  console.log("START TYPING:");
  console.log("-".repeat(40));

  let lastTime = 0;
  let current = "";

  for (const [t, , text] of history) {
    const delay = t - lastTime;
    if (delay > 0) await sleepMs(delay * 1000);
    lastTime = t;

    if (text.startsWith(current)) {
      // Characters added (normal typing or swap)
      out.write(text.slice(current.length));
    } else if (current.startsWith(text)) {
      // Characters removed (backspacing)
      const removed = current.slice(text.length);
      for (const ch of [...removed].reverse()) {
        if (ch === "\n") {
          // Move cursor up one line, then to the end of that line
          const lines = text.split("\n");
          out.write("\x1b[A");
          out.write(`\x1b[${lines[lines.length - 1].length + 1}G`);
        } else {
          out.write("\b \b");
        }
      }
    } else {
      // Divergence: clear block and redraw
      const prevLines = current.split("\n").length - 1;
      if (prevLines > 0) out.write(`\x1b[${prevLines}A`);
      out.write("\r\x1b[J");
      out.write(text);
    }
    current = text;
  }

  console.log("\n" + "-".repeat(40));
  console.log(`Total Simulated Time: ${totalTime.toFixed(4)}s`);

  const errors = history.filter(([, action]) => action.includes("ERROR") || action.includes("SWAP"));
  if (errors.length) console.log(`Errors made and corrected: ${errors.length}`);
}

const DEFAULT_DEMO_TEXT = `from module import Class1
import asyncio

async def example():
instance = Class1(
    # keyword_arg=value,
)
instance.method1()
`;

const USAGE = `Keyboard Typing Simulation via Markov Chains

Usage: node humantyping.mjs [text] [options]

Options:
  --mode <demo|montecarlo>  Execution mode (default: demo)
  --n <int>                 Number of simulations for Monte Carlo (default: 100)
  --wpm <number>            Target average speed in WPM (default: 60)
  -h, --help                Show this help`;

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      mode: { type: "string", default: "demo" },
      n: { type: "string", default: "100" },
      wpm: { type: "string", default: "60" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) {
    console.log(USAGE);
    return;
  }

  const text = positionals[0] ?? DEFAULT_DEMO_TEXT;
  const wpm = Number(values.wpm);
  const n = Number.parseInt(values.n, 10);

  if (!Number.isFinite(wpm) || wpm <= 0) throw new Error("--wpm must be a positive number");
  if (!Number.isInteger(n) || n <= 0) throw new Error("--n must be a positive integer");

  if (values.mode === "demo") await demoSingleRun(text, wpm);
  else if (values.mode === "montecarlo") runMonteCarlo(text, wpm, n);
  else throw new Error(`--mode must be 'demo' or 'montecarlo', got '${values.mode}'`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`error: ${err.message}`);
    process.exitCode = 1;
  });
}

export default HumanTyper;
