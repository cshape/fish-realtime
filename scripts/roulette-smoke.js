// Roulette smoke test — structural, no microphone. Requires the server to
// run with TEXT_INPUT=1 (typed turns) so no STT is involved; the Deepgram
// path is covered by scripts/smoke.js.
//
//   1. roulette_start -> a character card + spoken greeting audio.
//   2. typed turn -> user_final echo + streamed reply audio + agent_done.
//   3. roulette_next -> a DIFFERENT character + greeting audio.
//   4. POST /feedback -> 204, and the line lands in data/feedback-*.jsonl.
//
// Usage: TEXT_INPUT=1 npm start   (in another shell)
//        node scripts/roulette-smoke.js

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const PORT = Number(process.env.PORT || 8787);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const fail = (msg) => {
  console.error(`[roulette-smoke] FAIL: ${msg}`);
  process.exit(1);
};
const ok = (msg) => console.log(`[roulette-smoke] ok: ${msg}`);

const timeout = setTimeout(() => fail("timed out after 90s"), 90_000);

const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
ws.binaryType = "arraybuffer";

// Keep Deepgram's socket fed so it doesn't idle-close mid-test.
const silence = Buffer.alloc(1024);
const keepalive = setInterval(() => {
  if (ws.readyState === WebSocket.OPEN) ws.send(silence);
}, 32);

let sid = null;
let phase = "boot"; // boot -> greet1 -> turn -> greet2 -> done
const characters = [];
let audioBytes = 0;
let turnAudioBytes = 0;
let sawUserFinal = false;

ws.on("open", () => console.log("[roulette-smoke] connected"));
ws.on("error", (e) => fail(`ws error: ${e.message}`));

ws.on("message", async (data, isBinary) => {
  if (isBinary || data instanceof ArrayBuffer) {
    const len = data.byteLength ?? data.length ?? 0;
    audioBytes += len;
    if (phase === "turn") turnAudioBytes += len;
    return;
  }
  const msg = JSON.parse(data.toString());

  if (msg.type === "session") sid = msg.sid;

  if (msg.type === "ready" && phase === "boot") {
    phase = "greet1";
    ws.send(JSON.stringify({ type: "roulette_start" }));
  }

  if (msg.type === "character") {
    characters.push(msg.character);
    const c = msg.character;
    if (!c.key || !c.name || !c.theme?.tint || typeof c.age !== "number") {
      fail(`character card incomplete: ${JSON.stringify(c)}`);
    }
    ok(`character ${characters.length}: ${c.name}, ${c.age} — ${c.location}`);
  }

  if (msg.type === "user_final") sawUserFinal = true;

  if (msg.type === "agent_done") {
    if (phase === "greet1") {
      if (characters.length !== 1) fail("greeting finished but no character card");
      if (audioBytes < 10_000) fail(`greeting produced almost no audio (${audioBytes}B)`);
      ok(`greeting audio: ${audioBytes} bytes`);
      phase = "turn";
      ws.send(JSON.stringify({ type: "text_input", text: "Hi! Tell me a little about yourself." }));
    } else if (phase === "turn") {
      if (!sawUserFinal) fail("typed turn: no user_final echo (is TEXT_INPUT=1 set?)");
      if (turnAudioBytes < 10_000) fail(`reply produced almost no audio (${turnAudioBytes}B)`);
      ok(`typed turn answered: ${turnAudioBytes} bytes of reply audio`);
      phase = "greet2";
      ws.send(JSON.stringify({ type: "roulette_next", reason: "skip" }));
    } else if (phase === "greet2") {
      if (characters.length !== 2) fail("skip did not produce a second character");
      if (characters[1].key === characters[0].key) fail("skip returned the same character");
      ok(`skip -> new character: ${characters[0].key} -> ${characters[1].key}`);
      phase = "done";
      await checkFeedback();
    }
  }
});

async function checkFeedback() {
  const res = await fetch(`http://localhost:${PORT}/feedback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sid,
      character: characters[1].key,
      email: "smoke@test.local",
      text: "roulette smoke test feedback",
      kind: "feedback",
    }),
  });
  if (res.status !== 204) fail(`POST /feedback -> ${res.status}`);
  const day = new Date().toISOString().slice(0, 10);
  const file = path.join(ROOT, "data", `feedback-${day}.jsonl`);
  await new Promise((r) => setTimeout(r, 300)); // async append
  const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n") : [];
  const mine = lines.map((l) => JSON.parse(l)).filter((e) => e.sid === sid);
  if (mine.length !== 1) fail(`expected 1 feedback line for sid, found ${mine.length}`);
  ok("feedback recorded in data/feedback-*.jsonl");

  const rlog = path.join(ROOT, "data", `roulette-${day}.jsonl`);
  const evs = fs.readFileSync(rlog, "utf8").trim().split("\n")
    .map((l) => JSON.parse(l)).filter((e) => e.sid === sid).map((e) => e.ev);
  for (const want of ["session_start", "character_start", "greeting", "user", "agent", "skip"]) {
    if (!evs.includes(want)) fail(`roulette log missing "${want}" event (has: ${[...new Set(evs)].join(",")})`);
  }
  ok(`conversation log has: ${[...new Set(evs)].join(", ")}`);

  clearInterval(keepalive);
  clearTimeout(timeout);
  ws.close();
  console.log("[roulette-smoke] PASS");
  process.exit(0);
}
