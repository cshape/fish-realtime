// End-to-end smoke test, no microphone needed (macOS: uses `say`).
//
// Exercises the full pipeline:
//   1. set_persona -> spoken greeting audio arrives.
//   2. Speaks a question, expects transcript + streamed reply audio.
//   3. As soon as reply audio starts, speaks a second question over it —
//      expects a "clear" (playback flush) and a second answered turn.
//
// Usage: npm run smoke   (server must be running; PORT must match)

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";

const PORT = Number(process.env.PORT || 8787);
const QUESTIONS = [
  "Please tell me a nice long story about a fish.",
  "What is two plus two?",
];

const CHUNK = 1024; // 32 ms @ 16 kHz mono PCM16
const SILENCE = Buffer.alloc(CHUNK);

function synth(text) {
  const wav = path.join(os.tmpdir(), `fish-realtime-smoke-${process.pid}.wav`);
  execFileSync("say", ["-o", wav, "--file-format=WAVE", "--data-format=LEI16@16000", text]);
  const pcm = fs.readFileSync(wav).subarray(44); // strip WAV header
  fs.unlinkSync(wav);
  // 500 ms of leading silence so Flux has context before speech starts.
  return Buffer.concat([Buffer.alloc(16000), pcm]);
}

console.log("[smoke] synthesizing test utterances…");
const utterances = QUESTIONS.map(synth);

const ws = new WebSocket(`ws://localhost:${PORT}/ws`);

// "Mic": a realtime sender that plays queued PCM, silence when idle.
const outQueue = [];
function enqueue(pcm) {
  for (let off = 0; off < pcm.length; off += CHUNK) outQueue.push(pcm.subarray(off, off + CHUNK));
}

// Phases: greet -> turn1 -> turn2 (barge-in)
let phase = "greet";
let done = false;
const finals = [];
let greetingAudio = 0;
let clears = 0;
let audioBytes = 0;
let audioAfterClear = 0;
let bargedIn = false;

const timeout = setTimeout(() => fail(`timed out in phase "${phase}" after 180s`), 180000);

function fail(why) {
  console.error(`[smoke] FAIL: ${why}`);
  process.exit(1);
}

function pass() {
  clearTimeout(timeout);
  done = true;
  console.log(`[smoke] clears: ${clears}, audio total ${audioBytes}B, after barge-in ${audioAfterClear}B`);
  console.log("[smoke] PASS");
  process.exit(0);
}

ws.on("open", async () => {
  console.log("[smoke] connected");
  while (!done && ws.readyState === WebSocket.OPEN) {
    ws.send(outQueue.shift() ?? SILENCE);
    await new Promise((r) => setTimeout(r, 31));
  }
});

function onAudio(n) {
  audioBytes += n;
  if (clears > 0) audioAfterClear += n;
  switch (phase) {
    case "greet":
      greetingAudio += n;
      break;
    case "turn1":
      // Reply 1 is audibly playing — barge in with question 2.
      if (finals.length >= 1 && !bargedIn) {
        bargedIn = true;
        console.log("[smoke] reply audio started — barging in with turn 2…");
        enqueue(utterances[1]);
        phase = "turn2";
      }
      break;
  }
}

function onAgentDone() {
  switch (phase) {
    case "greet":
      if (greetingAudio < 24000) fail(`greeting produced almost no audio (${greetingAudio}B)`);
      console.log(`[smoke] greeting spoken (${greetingAudio}B) — streaming turn 1…`);
      enqueue(utterances[0]);
      phase = "turn1";
      break;
    case "turn2":
      if (finals.length < 2) break; // done event from an earlier fragment
      if (clears < 1) fail("no clear event after barge-in");
      if (audioAfterClear < 24000) fail("no reply audio after barge-in");
      console.log("[smoke] barge-in ok");
      pass();
      break;
  }
}

ws.on("message", (data, isBinary) => {
  if (isBinary) {
    onAudio(data.length);
    return;
  }
  const msg = JSON.parse(data.toString());
  switch (msg.type) {
    case "session":
      if (!msg.personas?.length) fail("session message missing persona catalog");
      console.log(`[smoke] session: ${msg.personas.length} personas`);
      break;
    case "ready":
      console.log("[smoke] STT ready — requesting greeting…");
      ws.send(JSON.stringify({ type: "set_persona", id: "guide" }));
      break;
    case "user_final":
      finals.push(msg.text);
      console.log(`[smoke] transcript ${finals.length}: "${msg.text}"`);
      break;
    case "persona":
      console.log(`[smoke] persona event: persona=${msg.persona}`);
      break;
    case "clear":
      if (bargedIn) clears++;
      break;
    case "metrics":
      console.log(
        `[smoke] latency: turn-detect ${msg.stt}ms | llm ${msg.llm}ms | tts ${msg.tts}ms | voice->voice ${msg.total}ms${msg.eager ? " (eager)" : ""}`,
      );
      break;
    case "agent_done":
      onAgentDone();
      break;
    case "error":
      console.error(`[smoke] server error: ${msg.message}`);
      break;
  }
});

ws.on("error", (err) => fail(`websocket error: ${err.message} (is the server running?)`));
