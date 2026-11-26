/**
 * Shared output format for the Krillion dataset.
 *
 * The database maps each question straight to its answers, ordered from
 * Plankton up to One in a Krillion (newest questions first):
 *
 * {
 *   "Name a fish": ["Salmon", "Tuna", "Cod", "Haddock", "Coelacanth"],
 *   "Name a bird": ["Pigeon", "Robin", "Crow", "Kakapo"]
 * }
 *
 * Which days have been fetched is tracked separately in a small sidecar file
 * (see FETCHED_FILE), so the database itself holds nothing but questions and answers.
 */

/** Tier names, lowest to highest. Answers are written in this order. */
export const TIER_ORDER = [
  "Plankton", "Too Clever", "Schooler", "Rare", "Deep cut", "One in a Krillion",
];

/** Sidecar file name (next to the database) listing the dive dates already fetched. */
export const FETCHED_FILE = "krillion_fetched.json";

function tierRank(name) {
  const i = TIER_ORDER.indexOf(name);
  return i === -1 ? TIER_ORDER.length : i; // unknown tiers go last
}

/** Flatten a parsed prompt ({ q, tiers: [{ name, picks }] }) to its answers, Plankton first. */
export function flattenAnswers(prompt) {
  return [...(prompt.tiers ?? [])]
    .sort((a, b) => tierRank(a.name) - tierRank(b.name)) // stable: same-tier order kept
    .flatMap((t) => t.picks ?? []);
}

/**
 * Add a question to `db`. If the question was already asked on another day,
 * new answers are appended after the existing ones, skipping duplicates.
 */
export function addQuestion(db, q, answers) {
  const list = db[q] ?? (db[q] = []);
  for (const a of answers) if (!list.includes(a)) list.push(a);
}

/** Add every prompt of a parsed dive ({ prompts }) to `db`. */
export function addDive(db, dive) {
  for (const p of dive.prompts) addQuestion(db, p.q, flattenAnswers(p));
}

/** True if `db` is the old array-of-dives format ([{ n, date, prompts }]). */
export function isOldFormat(db) {
  return Array.isArray(db);
}

/**
 * Convert an old-format database to { db, dates }: the question -> answers
 * object (newest dives first) and the list of dive dates it covered.
 */
export function convertDatabase(oldDb) {
  const dives = [...oldDb].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const db = {};
  for (const dive of dives) addDive(db, dive);
  return { db, dates: dives.map((d) => d.date).sort() };
}

/** Number of answers stored in a database. */
export function countAnswers(db) {
  return Object.values(db).reduce((n, list) => n + list.length, 0);
}

/** Serialize a database the same way everywhere. */
export function serialize(db) {
  return JSON.stringify(db, null, 1) + "\n";
}
