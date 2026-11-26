#!/usr/bin/env node
/**
 * Update the Krillion Daily Dive dataset.
 *
 * Fetches any missing daily dives from the public reveal-sheet mirror and
 * adds them to data/krillion_dives.json as { "question": [answers...] }, with
 * answers ordered Plankton -> One in a Krillion (see krillion-format.mjs).
 * Fetched dates are tracked in data/krillion_fetched.json. Designed to run
 * unattended (GitHub Actions cron) and locally. An old-format database
 * (array of dives) is converted automatically on the first run.
 *
 * Usage:
 *     node update.mjs              # add only the latest edition (skips if already fetched)
 *     node update.mjs --missing    # add every edition not fetched yet
 *     node update.mjs --force      # refetch everything
 *
 * Requires Node 18+ (global fetch, AbortSignal.timeout).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import {
  FETCHED_FILE, addDive, convertDatabase, countAnswers, isOldFormat, serialize,
} from "./krillion-format.mjs";

// The script lives in the project root, so data paths are relative to its own folder.
const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA = join(ROOT, "data");
const JSON_PATH = join(ROOT, "answers.json");
const FETCHED_PATH = join(DATA, FETCHED_FILE);
const FIRST_DATE = Date.UTC(2026, 6, 16); // dive #1 (2026-07-16; months are 0-based)
const USER_AGENT = "Mozilla/5.0 (krillion-dataset updater)";
const MAX_PICKS = 10; // sample size kept per tier; the official sheet is complete
const DAY_MS = 86_400_000;

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
    redirect: "follow",
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’",
  ldquo: "“", rdquo: "”", hellip: "…", eacute: "é",
  times: "×", copy: "©", reg: "®", trade: "™",
};

function unescapeHtml(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, ent) => {
    if (ent[0] === "#") {
      const cp = ent[1] === "x" || ent[1] === "X"
        ? parseInt(ent.slice(2), 16)
        : parseInt(ent.slice(1), 10);
      try { return String.fromCodePoint(cp); } catch { return m; }
    }
    return NAMED_ENTITIES[ent] ?? NAMED_ENTITIES[ent.toLowerCase()] ?? m;
  });
}

function stripTags(s) {
  s = s.replace(/<[^>]+>/g, " ");
  return unescapeHtml(s).replace(/\s+/g, " ").trim();
}

function diveNumber(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - FIRST_DATE) / DAY_MS) + 1;
}

function parsePage(page, iso) {
  const blocks = page.split('<h2><span class="answer-num">').slice(1);
  if (!blocks.length) throw new Error("no prompt blocks found");

  const prompts = [];
  for (const block of blocks) {
    const idx = block.indexOf("</h2>");
    const head = idx === -1 ? block : block.slice(0, idx);
    const rest = idx === -1 ? "" : block.slice(idx + "</h2>".length);

    const q = stripTags(head).replace(/^\s*\d+\.\s*/, "");
    const cut = rest.split(/About this data|Challenge a friend/)[0];
    const text = stripTags(cut);
    const am = text.match(/(\d+)\s+valid answers/);
    const accepted = am ? parseInt(am[1], 10) : null;

    const tiers = [];
    const matches = [...text.matchAll(
      /(One in a Krillion|Deep cut|Rare|Schooler|Too Clever|Plankton)\s*\((\d+)\)/g)];
    matches.forEach((m, i) => {
      const name = m[1];
      const count = parseInt(m[2], 10);
      const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
      const seg = text.slice(m.index + m[0].length, end);
      // Capturing group keeps the point values in the result: [answer, pts, answer, pts, ...].
      // `(?:\s+|$)` lets the final point value (end of segment, no trailing space) split too,
      // so the last answer in each tier isn't dropped.
      const parts = seg.trim().split(/\s+(100|85|60|30|15|10)(?:\s+|$)/);
      const picks = [];
      for (let j = 0; j < parts.length - 1; j += 2) {
        const p = parts[j].trim();
        if (p) picks.push(p);
        if (picks.length >= MAX_PICKS) break;
      }
      tiers.push({ name, count, picks });
    });
    prompts.push({ q, accepted, tiers });
  }

  if (prompts.length !== 7) {
    console.error(`  ! ${iso}: ${prompts.length} prompts (expected 7)`);
  }
  return { n: diveNumber(iso), date: iso, prompts };
}

/** Load { db, dates } from disk, converting an old-format database if needed. */
function loadDatabase() {
  if (!existsSync(JSON_PATH)) return { db: {}, dates: [] };
  const raw = JSON.parse(readFileSync(JSON_PATH, "utf8"));
  if (isOldFormat(raw)) {
    console.log("converting old-format database to question -> answers");
    return convertDatabase(raw);
  }
  const dates = existsSync(FETCHED_PATH)
    ? JSON.parse(readFileSync(FETCHED_PATH, "utf8"))
    : [];
  if (!dates.length && Object.keys(raw).length) {
    console.error(`  ! ${FETCHED_FILE} missing; only the latest edition will be added (use --missing for all)`);
  }
  return { db: raw, dates };
}

async function main() {
  const force = process.argv.includes("--force");
  mkdirSync(DATA, { recursive: true });
  const { db, dates } = force ? { db: {}, dates: [] } : loadDatabase();
  const have = new Set(dates);

  const index = await fetchText("https://krilliongame.com/krillion-answers/");
  const allDates = [...new Set(
    [...index.matchAll(/\/krillion-answers\/(\d{4}-\d{2}-\d{2})\//g)].map((m) => m[1]),
  )].sort();
  // Default: only the newest edition. --missing: every date not yet fetched. --force: everything.
  const latest = allDates.at(-1);
  const todo = force || process.argv.includes("--missing")
    ? allDates.filter((d) => !have.has(d))
    : (latest && !have.has(latest) ? [latest] : []);
  console.log(`archive has ${allDates.length} dates (latest ${latest}); ${have.size} cached; fetching ${todo.length}`);

  const scraped = [];
  for (const iso of todo) {
    try {
      const dive = parsePage(
        await fetchText(`https://krilliongame.com/krillion-answers/${iso}/`), iso);
      scraped.push(dive);
      console.log(`  + ${iso} dive #${dive.n}`);
    } catch (e) {
      console.error(`  x ${iso}: ${e?.message ?? e}`);
    }
    await sleep(1000);
  }

  if (!scraped.length) console.log("no new dives");
  // New questions go on top (newest day first), then everything already stored.
  const out = {};
  for (const dive of scraped.sort((a, b) => (a.date < b.date ? 1 : -1))) addDive(out, dive);
  for (const [q, answers] of Object.entries(db)) {
    if (out[q]) for (const a of answers) { if (!out[q].includes(a)) out[q].push(a); }
    else out[q] = answers;
  }
  const allFetched = [...new Set([...dates, ...scraped.map((d) => d.date)])].sort();

  writeFileSync(JSON_PATH, serialize(out), "utf8");
  writeFileSync(FETCHED_PATH, JSON.stringify(allFetched) + "\n", "utf8");
  console.log(`wrote ${Object.keys(out).length} questions ` +
    `(${countAnswers(out).toLocaleString("en-US")} answers) -> ${basename(JSON_PATH)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
