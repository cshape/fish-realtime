// Roulette data collection: append-only JSONL, one file per UTC day, under
// data/ (gitignored). Every line is {ts, sid, ev, ...} — session lifecycle,
// full transcripts (user + agent), skips, kicks, achievements, feedback.
// Synchronous appends: lines are tiny (<1KB) and event ORDER matters for
// reading conversations back; the ~µs write cost is nothing next to the
// audio pipeline's network hops.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

function fileFor(prefix) {
  const day = new Date().toISOString().slice(0, 10);
  return path.join(DATA_DIR, `${prefix}-${day}.jsonl`);
}

function append(prefix, obj) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...obj }) + "\n";
  try {
    fs.appendFileSync(fileFor(prefix), line);
  } catch (err) {
    console.error("[datalog]", err.message);
  }
  // On Render the disk is ephemeral (wiped every deploy), so mirror every
  // event to stdout — the log stream is retained and searchable there.
  // RENDER is set automatically on Render instances.
  if (process.env.RENDER || process.env.LOG_EVENTS_STDOUT) {
    process.stdout.write(`[${prefix}] ${line}`);
  }
}

// ev: session_start | character_start | user | agent | greeting | skip |
//     kick | achievement | session_end
export function logRoulette(sid, ev, data = {}) {
  append("roulette", { sid, ev, ...data });
}

// Feedback and achievement claims get their own file so emails are easy to
// harvest without re-parsing conversation logs.
export function logFeedback(entry) {
  append("feedback", entry);
}
