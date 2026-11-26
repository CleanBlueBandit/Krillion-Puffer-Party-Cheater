#!/usr/bin/env node
/**
 * Convert an existing Krillion database (array of dives) to the flat
 * { "question": [answers...] } format, answers ordered Plankton -> One in a Krillion
 * (see krillion-format.mjs).
 *
 * The file is rewritten in place. The original is kept next to it as
 * <name>.bak.json first, and the fetched dates are written to krillion_fetched.json
 * in the same folder so update.mjs only fetches new days. A file that is already
 * converted is left alone.
 *
 * Usage:
 *     node scripts/convert.mjs                        # data/krillion_dives.json
 *     node scripts/convert.mjs path/to/dives.json     # any other file
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FETCHED_FILE, convertDatabase, countAnswers, isOldFormat, serialize,
} from "./krillion-format.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = resolve(process.argv[2] ?? join(ROOT, "data", "krillion_dives.json"));

if (!existsSync(target)) {
  console.error(`not found: ${target}`);
  process.exit(1);
}

const raw = JSON.parse(readFileSync(target, "utf8"));
if (!isOldFormat(raw)) {
  console.log(`already converted, nothing to do: ${target}`);
  process.exit(0);
}

const backup = target.replace(/\.json$/i, "") + ".bak.json";
copyFileSync(target, backup);

const { db, dates } = convertDatabase(raw);
const fetchedPath = join(dirname(target), FETCHED_FILE);
writeFileSync(target, serialize(db), "utf8");
writeFileSync(fetchedPath, JSON.stringify(dates) + "\n", "utf8");
console.log(`converted ${dates.length} dives into ${Object.keys(db).length} questions ` +
  `(${countAnswers(db).toLocaleString("en-US")} answers) -> ${target}`);
console.log(`original saved as ${backup}`);
console.log(`fetched dates saved as ${fetchedPath}`);
