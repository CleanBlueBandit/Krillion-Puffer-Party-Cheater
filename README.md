# Krillion Puffer Party Cheater

A Node.js bot for **Puffer Party**, the multiplayer mode on [krillion.io/party](https://krillion.io/party/). It reads each category the game server sends, looks it up in a local answers database, and types answers into the game at a human-like speed. If it runs out of saved answers, it asks Google Gemini for more. It also saves answers it sees opponents use.

> **Heads-up:** Using a bot in multiplayer games is usually against the game's terms and isn't fair to the people you play against. This is just a fun little coding experiment, so treat it just like one.
## How it works

1. `main.js` starts your installed **Brave** browser with remote debugging turned on, then attaches to it with Playwright over CDP. Using a real browser lets the Cloudflare check pass normally. (If you dont have brave, this wont work. Im just too lazy to add support for other browsers)
2. It fills in your display name, then joins a room, starts Quick Play, or queues for Rated.
3. It listens to the game's WebSocket (`party.krillion.io/rooms/...`) for new categories, turn changes and answer results.
4. For each category it goes through the matching list in `answers.json` and skips answers that were already used.
5. Answers are typed by `humanTyping.mjs`, a typing simulator that varies the speed and makes and fixes neighbour-key typos. There is also an optional typo on purpose and a random wait before each answer. The pace speeds up over the first few turns.
6. When the saved answers run out, `geminifallback.mjs` generates batches of new ones and writes them back into `answers.json`.
7. When a game ends, it clicks **NEW OPPONENT** and starts again.

## Requirements

- Node.js 18 or newer
- [Brave browser](https://brave.com/). It is expected at `C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe` by default. Set `BRAVE_PATH` if yours is somewhere else.
- One or more Google Gemini API keys (optional; only used by the fallback)

## Setup

```bash
npm install
```

To use the Gemini fallback, create `gemini-keys.json` in the project root. The file is gitignored. If one key fails with 401, 403 or 429, the next key is tried.

```json
{
  "keys": ["YOUR_GEMINI_KEY_1", "YOUR_GEMINI_KEY_2"]
}
```

You can also put any of the settings below in a `.env` file (also gitignored). `main.js` loads it through `dotenv`.

## Usage

### Run the bot

```bash
node main.js
```

That starts Quick Play (unrated). Other modes:

```bash
node main.js ABCD
```

```bash
node main.js --rated
```

`ABCD` joins a private room by its code. `--rated` uses matchmaking, so it can't be combined with a room code.

If a Cloudflare check shows up in Brave, click it yourself. To stop, close Brave or press Ctrl+C (press it twice to force-quit). Answers learned during the run are saved before the bot exits.

### Watch questions without playing

```bash
node questions.js
```

This joins the same way (`node questions.js ABCD` for a room) but never types anything. It just prints and logs every category and answer.

### Record network traffic

```bash
node capture.js
```

This opens a browser while you play normally. It logs every WebSocket frame, XHR/fetch call and JS bundle URL to `logs/<timestamp>/traffic.jsonl`, and writes a summary when you close the browser. See the comment at the top of `capture.js` for its options (`BROWSER`, `BLOCK`, `EXTRA_HOSTS`, `ALL`, `HEADLESS`, `CAPTURE_SECONDS`).

### Update the answers database

```bash
npm run update
```

This scrapes the public Krillion **Daily Dive** answer archive at `krilliongame.com/krillion-answers/` and merges the new questions into `answers.json`. Dates already fetched are tracked in `data/krillion_fetched.json`.

- `node update.mjs` adds only the latest edition.
- `node update.mjs --missing` adds every edition that hasn't been fetched yet.
- `node update.mjs --force` fetches everything again.

## Configuration

All settings are environment variables and all are optional.

| Variable | Default | Description |
| --- | --- | --- |
| `NAME` | `reader` | Display name in the game |
| `ROOM` | – | Room code (same as the positional argument) |
| `BRAVE_PATH` | Windows Brave path | Path to the Brave executable |
| `PORT` | `9334` | Remote debugging port for Brave |
| `ANSWERS_DB` | `./answers.json` | Path to the answers database |
| `WPM` | `65` | Base typing speed |
| `MAX_WPM` | `WPM × 1.6` | Typing speed at the end of the ramp |
| `WPM_CAP` | `85` | Hard limit on typing speed |
| `LAYOUT` | `qwerty` | Keyboard layout used to pick typo keys |
| `TYPO_CHANCE` | `0.08` | Chance (0–1) of a typo left in on purpose |
| `MIN_DELAY` / `MAX_DELAY` | `1500` / `6000` | Wait before typing, in ms, at the start of the ramp |
| `MIN_DELAY_FAST` / `MAX_DELAY_FAST` | `300` / `1200` | Wait before typing, in ms, at the end of the ramp |
| `PACE_RAMP_TURNS` | `10` | Number of turns to go from the slow pace to the fast one |
| `RESULT_TIMEOUT_MS` | `6000` | How long to wait for the server to accept or reject an answer |
| `NEW_OPPONENT_MIN_DELAY` / `NEW_OPPONENT_MAX_DELAY` | `3000` / `5000` | Wait in ms before clicking NEW OPPONENT |
| `GEMINI_MAX_ATTEMPTS` | `3` | Gemini attempts per category |
| `STOP_AFTER` | `0` (off) | Close the browser after this many seconds |

Example:

```bash
NAME=puffer WPM=55 TYPO_CHANCE=0.05 node main.js --rated
```

## Project layout

| File | Purpose |
| --- | --- |
| `main.js` | The bot: browser control, game state, answer queue, typing |
| `humanTyping.mjs` | Human-like typing simulator (also works as a CLI: `node humanTyping.mjs "text" --mode demo`) |
| `geminifallback.mjs` | Generates answers with Gemini, rotates API keys, saves results safely |
| `questions.js` | Read-only question logger |
| `capture.js` | Records network traffic, used to work out the game protocol |
| `update.mjs` | Scrapes Daily Dive answers into `answers.json` |
| `krillion-format.mjs` | Shared database format helpers (answer tiers from Plankton to One in a Krillion) |
| `convert.mjs` | One-off converter from the old database format (an array of dives) |
| `answers.json` | Answers database: `{ "category": ["answer", ...] }` |
| `data/krillion_fetched.json` | Daily Dive dates already fetched |

## Output

- `questions/<timestamp>.jsonl` holds one line per question with its answers and rejected answers, plus game events. Both `main.js` and `questions.js` write it.
- `logs/<timestamp>/` is written by `capture.js`.
- `.brave-profile/` is the separate Brave profile the scripts use. It's kept apart from your normal browser profile.


**Note:** `convert.mjs` expects to be in a `scripts/` folder and uses `data/krillion_dives.json` by default. Pass the file path to it directly (for example `node convert.mjs answers.json`).
