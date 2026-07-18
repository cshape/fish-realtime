// fish-realtime — a realtime.ai-style voice demo built on Fish Audio.
//
// Pipeline per browser connection:
//   browser mic (PCM16 @ 16 kHz, binary WS frames)
//     -> Deepgram Flux STT (turn-taking built in: StartOfTurn / EndOfTurn,
//        plus EagerEndOfTurn for speculative generation)
//     -> Gemma LLM (OpenAI-compatible /chat/completions, streamed SSE)
//     -> sentence chunker
//     -> Fish TTS websocket (/v1/tts/live, msgpack)
//     -> browser (PCM16 @ 24 kHz, binary WS frames)
//
// Latency strategy: when Flux says "the user is probably done" (EagerEndOfTurn)
// we start the LLM + TTS immediately but buffer the output server-side. When
// the real EndOfTurn arrives we flush the buffer to the browser — the LLM and
// TTS ran during Deepgram's confirmation window, so the reply starts almost
// instantly. If the user was just pausing (TurnResumed), the speculative work
// is discarded and the browser never hears about it.
//
// No agent framework, no LiveKit — one Node process, plain http + ws.
// Engine ported from github.com/cshape/fish-bare-agent (WS transport only).

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { AccessToken, RoomConfiguration, RoomAgentDispatch } from "livekit-server-sdk";
import { VOICES, PERSONAS, DEFAULT_PERSONA, isPersona, systemPromptFor, publicCatalog, pickGreeting } from "./personas.js";
import { CHARACTERS, pickCharacter, characterSystemPrompt, pickCharacterGreeting, characterVoiceId, publicCharacter } from "./characters.js";
import { logRoulette, logFeedback } from "./datalog.js";
import { judgeTurn, judgeEnabled } from "./judge.js";
import { FishPipeline, TTS_SAMPLE_RATE, FISH_MODEL, FISH_LATENCY_MODE } from "./tts.js";
import { AUDIO_CONFIG, INACTIVITY_CONFIG, LLM_CONFIG, LK_AGENT_NAME_DEFAULT } from "./public/config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT || 8787);

const DEEPGRAM_API_KEY = required("DEEPGRAM_API_KEY");
const DEEPGRAM_MODEL = process.env.DEEPGRAM_MODEL || "flux-general-en";
// End-of-turn confidence (0.5–0.9, lower = snappier) and max-silence forcing.
const DEEPGRAM_EOT_THRESHOLD = process.env.DEEPGRAM_EOT_THRESHOLD || "0.7";
const DEEPGRAM_EOT_TIMEOUT_MS = process.env.DEEPGRAM_EOT_TIMEOUT_MS || "3000";
// Confidence at which Flux emits EagerEndOfTurn (speculative generation
// trigger). Lower = earlier head start but more wasted LLM/TTS work.
const DEEPGRAM_EAGER_EOT_THRESHOLD = process.env.DEEPGRAM_EAGER_EOT_THRESHOLD || "0.5";

const LLM_BASE_URL = required("LLM_BASE_URL");
const LLM_API_KEY = required("LLM_API_KEY");
const LLM_MODEL = process.env.LLM_MODEL || "google/gemma-4-26B-A4B-it";

required("FISH_API_KEY"); // consumed by tts.js

const MIC_SAMPLE_RATE = AUDIO_CONFIG.inputSampleRate; // browser -> Deepgram; TTS_SAMPLE_RATE from tts.js

// Dev-only: TEXT_INPUT=1 lets the browser (or a test script) inject typed
// user turns over the websocket — for exercising roulette characters
// (kicks, achievements) without speaking into a mic. Off in production.
const TEXT_INPUT_ENABLED = process.env.TEXT_INPUT === "1";

// Energy gate for latency measurement (NOT for turn-taking — that's Flux's
// job). A mic chunk whose RMS clears this is treated as "the user is audibly
// speaking"; turn-detect latency is measured from the last such chunk.
const VAD_THRESHOLD_DB = Number(process.env.VAD_THRESHOLD_DB || -40); // dBFS
const VAD_RMS = 32768 * 10 ** (VAD_THRESHOLD_DB / 20);

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var ${name} (see .env.example)`);
    process.exit(1);
  }
  return v;
}

// ---------------------------------------------------------------------------
// Sentence chunker — buffers streamed LLM tokens and emits complete clauses,
// so Fish receives whole sentences instead of arbitrary token boundaries.
// ---------------------------------------------------------------------------

const SENTENCE_PUNCT = new Set([...".。,，!！?？;；:：\n"]);

class SentenceChunker {
  #buf = "";

  // Returns an array of completed clauses (possibly empty).
  push(token) {
    this.#buf += token;
    const out = [];
    for (;;) {
      let idx = -1;
      for (let i = 0; i < this.#buf.length; i++) {
        if (SENTENCE_PUNCT.has(this.#buf[i])) {
          idx = i;
          break;
        }
      }
      if (idx === -1) break;
      // Extend through a punctuation run ("...", "?!") so it stays together.
      let end = idx + 1;
      while (end < this.#buf.length && SENTENCE_PUNCT.has(this.#buf[end])) end++;
      // Punctuation at the very end of the buffer: wait for the next token to
      // see whether more punctuation follows before splitting.
      if (end === this.#buf.length) break;
      out.push(this.#buf.slice(0, end));
      this.#buf = this.#buf.slice(end);
    }
    return out;
  }

  // Returns whatever is left (trailing text without final punctuation).
  flush() {
    const rest = this.#buf;
    this.#buf = "";
    return rest;
  }
}

// ---------------------------------------------------------------------------
// Roulette reaction prompts — spoken lines the server injects when a judge
// verdict (judge.js) lands. The voice LLM never decides kicks/achievements.
// ---------------------------------------------------------------------------

const KICK_GOODBYE_PROMPT =
  "You've had enough of this caller — they've been rude, creepy, or " +
  "hopelessly dull. In character, say ONE short parting line as you hang " +
  "up on them. Blunt is fine. No questions, under two sentences.";

function achievementPrompt(c) {
  return (
    `The caller just did something special: they genuinely ${c.achievement.trigger} ` +
    `That unlocked the hidden achievement "${c.achievement.name}". React in ` +
    "character with real delight: tell them they've unlocked a hidden " +
    "achievement and can claim free Fish Audio credits by tapping the " +
    "little feedback button and leaving their email. Keep it to two short " +
    "sentences and stay in the flow of the conversation."
  );
}

// ---------------------------------------------------------------------------
// Echo detection — is this "user" transcript actually the agent's own voice
// leaking speaker -> mic? Compared against what the agent recently said.
// ---------------------------------------------------------------------------

function normalizeText(s) {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Echo preserves word ORDER, so fuzzy matching compares consecutive-word
// pairs (bigrams), not word bags — "what is two plus two" reuses common
// words from a story but shares none of its bigrams, while STT-mangled echo
// keeps long runs intact. threshold = minimum bigram coverage; callers pick
// per stakes: suppressing a finished turn wants high confidence (0.6),
// merely *continuing to hold* a barge-in wants low (0.35), because cutting
// the agent's audio is the irreversible action.
function isEchoOf(transcript, agentText, threshold = 0.6) {
  const t = normalizeText(transcript);
  const a = normalizeText(agentText);
  if (!t || !a) return false;
  if (a.includes(t)) return true;
  const tw = t.split(" ");
  if (tw.length < 2) return false;
  const aw = a.split(" ");
  const agentBigrams = new Set();
  for (let i = 0; i < aw.length - 1; i++) agentBigrams.add(aw[i] + " " + aw[i + 1]);
  let hits = 0;
  for (let i = 0; i < tw.length - 1; i++) {
    if (agentBigrams.has(tw[i] + " " + tw[i + 1])) hits++;
  }
  return hits / (tw.length - 1) >= threshold;
}

// ---------------------------------------------------------------------------
// Gemma LLM — OpenAI-compatible streaming chat completion.
// ---------------------------------------------------------------------------

async function streamLLM(messages, signal, onDelta) {
  const res = await fetch(`${LLM_BASE_URL}/chat/completions`, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LLM_API_KEY}`,
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages,
      stream: true,
      temperature: LLM_CONFIG.temperature,
      max_tokens: LLM_CONFIG.maxTokens,
    }),
  });
  if (!res.ok) {
    throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop(); // keep the trailing partial line
    for (const line of lines) {
      const data = line.startsWith("data:") ? line.slice(5).trim() : null;
      if (!data || data === "[DONE]") continue;
      let delta;
      try {
        delta = JSON.parse(data).choices?.[0]?.delta?.content;
      } catch {
        continue;
      }
      if (delta) onDelta(delta);
    }
  }
}

// ---------------------------------------------------------------------------
// Session — one per browser websocket. Owns the Deepgram connection, the
// conversation history, the current persona/voice, and at most one in-flight
// agent turn (which may be speculative, i.e. started on EagerEndOfTurn and
// not yet heard by the user).
// ---------------------------------------------------------------------------

class Session {
  constructor(client) {
    this.sid = randomUUID();
    this.client = client;
    this.history = [];
    this.turn = null;
    this.turnCounter = 0;
    this.personaId = DEFAULT_PERSONA;
    // "persona" (the curated demo) or "roulette" (random character line).
    this.mode = "persona";
    this.roulette = null; // { seen, character, unlocked }
    // The agent hung up (kick or idle): the line is dead — no barge-in, no
    // new turns. Roulette revives it with the next character.
    this.callOver = false;
    // Spoken reactions waiting for the current turn to finish (judge
    // verdicts: achievement congrats, kick goodbye).
    this.pendingActions = [];
    this.destroyed = false;
    // Wall time of the last mic chunk with speech-level energy. Flux's
    // TurnInfo events have no word timings (audio_window_end just tracks how
    // much audio it has processed, silence included), so this energy gate is
    // what "the user stopped speaking" is measured against.
    this.lastSpeechWall = 0;
    // Self-interruption defenses (speakerphone: speaker -> mic leakage).
    //   bargeMode  "instant": StartOfTurn cuts agent audio immediately.
    //              "smart":   while the agent is audible, hold the cut until
    //                         the transcript proves real speech (non-echo,
    //                         >= minWords).
    //   echoFilter drop user turns whose transcript matches what the agent
    //              was just saying.
    // Fixed policy — nothing tunes this at runtime.
    this.cfg = { bargeMode: "smart", echoFilter: true, minWords: 2 };
    // Playback horizon: wall time when the client's speaker goes quiet if we
    // send nothing more. Audio is played in real time, so shipped-bytes fully
    // determine it. This is how the engine knows the agent is audibly
    // speaking without any client reporting.
    this.playbackHorizon = 0;
    this.userTurnAudible = false; // was the agent audible when this user turn began?
    this.bargeHeld = false; // smart mode: cut deferred, awaiting proof
    this.dg = this.#connectDeepgram();
  }

  // Switch persona (from the UI). Keeps conversation history — the new
  // persona knows what was said — but swaps prompt and voice, and greets.
  setPersona(id) {
    if (!isPersona(id)) return;
    this.callOver = false; // picking a persona revives a hung-up line
    this.personaId = id;
    this.sendJson({ type: "persona", persona: id });
    if (this.turn) this.#cancelTurn();
    this.sendClear();
    this.#startSpokenLine(pickGreeting(id));
  }

  // Enter roulette mode: the session stops being a persona demo and becomes
  // a random-stranger line. Idempotent.
  startRoulette() {
    if (this.mode === "roulette") return;
    this.mode = "roulette";
    this.roulette = { seen: [], character: null, unlocked: false };
    logRoulette(this.sid, "session_start");
    this.nextCharacter("start");
  }

  // Spin to a new character: fresh history, fresh achievement, new voice,
  // spoken greeting. reason: "start" | "skip" (user) | after a kick the
  // client also sends "skip"-style next, logged as "post_kick".
  nextCharacter(reason) {
    if (this.mode !== "roulette") return;
    const r = this.roulette;
    if (reason === "skip" && r.character && !this.callOver) {
      logRoulette(this.sid, "skip", { character: r.character.key });
    }
    if (this.turn) this.#cancelTurn();
    this.sendClear();
    this.history = [];
    r.unlocked = false;
    this.callOver = false;
    this.pendingActions.length = 0; // reactions meant for the old character
    const c = pickCharacter(r.seen);
    r.character = c;
    r.seen.push(c.key);
    logRoulette(this.sid, "character_start", { character: c.key, reason });
    this.sendJson({ type: "character", character: publicCharacter(c) });
    const greeting = pickCharacterGreeting(c);
    logRoulette(this.sid, "greeting", { character: c.key, text: greeting });
    this.#startSpokenLine(greeting);
  }

  // Dev-only (TEXT_INPUT=1): a typed user turn, as if Flux emitted EndOfTurn
  // with this transcript. Lets characters be tested without a microphone.
  onTextInput(text) {
    if (!text) return;
    if (this.callOver) return;
    if (this.turn) this.#cancelTurn();
    this.sendClear();
    this.sendJson({ type: "user_final", text });
    if (this.mode === "roulette") {
      logRoulette(this.sid, "user", { character: this.roulette.character?.key, text, typed: true });
      this.#judgeUserTurn(text);
    }
    this.#startTurn(text, { speculative: false });
    this.#commitTurn(0, Date.now());
  }

  // The agent hangs up: one short in-character parting line via a
  // system-event turn, then the line goes dead. reason "idle" (silent
  // caller — shared with the persona demo via {type:"end_call"}) or "kick"
  // (judge verdict), each with its own goodbye prompt.
  endCall(reason = "idle", prompt = INACTIVITY_CONFIG.hangupPrompt) {
    if (this.callOver || this.turn?.endCall) return;
    // Never cut audio that's already playing: with no turn in flight the
    // goodbye simply queues behind whatever the agent is still saying.
    // (Kick verdicts arrive via the action queue, so the reply always gets
    // to finish; cancel+clear only happens for a genuinely mid-flight turn.)
    if (this.turn) {
      this.#cancelTurn();
      this.sendClear();
    }
    this.#startTurn(prompt, { speculative: false, systemEvent: true });
    if (this.turn) this.turn.endCall = reason;
  }

  // Queue a spoken reaction; it runs once no turn is in flight, so verdicts
  // never cut the character off mid-reply.
  #queueAction(fn) {
    this.pendingActions.push(fn);
    this.#tryDrain();
  }

  #tryDrain() {
    if (this.destroyed || !this.pendingActions.length) return;
    if (this.turn) {
      setTimeout(() => this.#tryDrain(), 400);
      return;
    }
    this.pendingActions.shift()();
    if (this.pendingActions.length) setTimeout(() => this.#tryDrain(), 400);
  }

  // Fire-and-forget referee call for the user turn that just ended.
  #judgeUserTurn(userText) {
    if (this.mode !== "roulette" || this.callOver) return;
    const c = this.roulette.character;
    if (!c) return;
    const history = [...this.history, { role: "user", content: userText }];
    judgeTurn({ character: c, history, achievementUnlocked: this.roulette.unlocked }).then(
      (verdict) => this.#applyVerdict(verdict, c.key),
    );
  }

  #applyVerdict(verdict, characterKey) {
    if (this.destroyed || this.callOver || this.mode !== "roulette") return;
    if (this.roulette.character?.key !== characterKey) return; // caller skipped on
    if (!verdict.kick && !verdict.achievement) return;
    logRoulette(this.sid, "judge", { character: characterKey, ...verdict });
    const stillValid = () =>
      !this.destroyed && !this.callOver && this.mode === "roulette" &&
      this.roulette.character?.key === characterKey;
    if (verdict.achievement && !this.roulette.unlocked) {
      const c = this.roulette.character;
      this.roulette.unlocked = true;
      logRoulette(this.sid, "achievement", { character: c.key, achievement: c.achievement.id });
      // Toast can show immediately; the spoken reaction waits its turn.
      this.sendJson({
        type: "achievement",
        id: c.achievement.id,
        name: c.achievement.name,
        character: c.name,
      });
      this.#queueAction(() => {
        if (stillValid()) this.#startTurn(achievementPrompt(c), { speculative: false, systemEvent: true });
      });
    }
    if (verdict.kick) {
      this.#queueAction(() => {
        if (stillValid()) this.endCall("kick", KICK_GOODBYE_PROMPT);
      });
    }
  }

  triggerInactivityNudge() {
    if (this.callOver) return;
    // Never interrupt an active turn. The browser retries this narrow command
    // while preserving the original 30-second disconnect deadline.
    if (this.turn || this.agentAudible()) {
      this.sendJson({ type: "inactivity_nudge_deferred" });
      return;
    }
    this.sendJson({ type: "inactivity_nudge_started" });
    this.#startTurn(INACTIVITY_CONFIG.prompt, { speculative: false, systemEvent: true });
  }

  sendJson(obj) {
    if (this.client.readyState === WebSocket.OPEN) {
      this.client.send(JSON.stringify(obj));
    }
  }

  sendAudio(buf) {
    if (this.client.readyState === WebSocket.OPEN) {
      this.client.send(buf, { binary: true });
      const ms = (buf.length / 2 / TTS_SAMPLE_RATE) * 1000;
      this.playbackHorizon = Math.max(Date.now(), this.playbackHorizon) + ms;
    }
  }

  // Is agent audio (probably) still coming out of the client's speaker?
  // 300 ms of grace covers transit, playout buffering, and echo tail.
  agentAudible() {
    return Date.now() < this.playbackHorizon + 300;
  }

  sendClear() {
    this.playbackHorizon = 0;
    this.sendJson({ type: "clear" });
  }

  onMicAudio(buf) {
    let sum = 0;
    const samples = buf.length >> 1;
    for (let i = 0; i < buf.length - 1; i += 2) {
      const s = buf.readInt16LE(i);
      sum += s * s;
    }
    if (samples && Math.sqrt(sum / samples) > VAD_RMS) {
      this.lastSpeechWall = Date.now();
    }
    if (this.dg.readyState === WebSocket.OPEN) this.dg.send(buf);
  }

  #connectDeepgram() {
    const params = new URLSearchParams({
      model: DEEPGRAM_MODEL,
      encoding: "linear16",
      sample_rate: String(MIC_SAMPLE_RATE),
      eot_threshold: DEEPGRAM_EOT_THRESHOLD,
      eot_timeout_ms: DEEPGRAM_EOT_TIMEOUT_MS,
      eager_eot_threshold: DEEPGRAM_EAGER_EOT_THRESHOLD,
    });
    const dg = new WebSocket(`wss://api.deepgram.com/v2/listen?${params}`, {
      headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` },
    });

    dg.on("message", (data, isBinary) => {
      if (isBinary) return;
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.type === "Connected") {
        this.sendJson({ type: "ready" });
      } else if (msg.type === "TurnInfo") {
        this.#onTurnInfo(msg);
      } else if (msg.type === "FatalError" || msg.type === "Error") {
        console.error("[deepgram]", msg);
        this.sendJson({ type: "error", message: `STT error: ${msg.error || msg.description || "unknown"}` });
      }
    });
    dg.on("error", (err) => {
      console.error("[deepgram] socket error:", err.message);
      this.sendJson({ type: "error", message: "STT connection error" });
    });
    dg.on("close", () => this.sendJson({ type: "stt_closed" }));
    return dg;
  }

  // What the agent has been saying lately — the echo filter's reference.
  #recentAgentText() {
    let last = "";
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i].role === "assistant") {
        last = this.history[i].content;
        break;
      }
    }
    return (last + " " + (this.turn?.spoken ?? "")).slice(-600);
  }

  // Echo filter verdict for a transcript belonging to the current user turn.
  #isSuppressedEcho(transcript) {
    return this.cfg.echoFilter && this.userTurnAudible && isEchoOf(transcript, this.#recentAgentText());
  }

  // Smart mode: a barge-in is held until the transcript proves real speech.
  // `final` (EndOfTurn) waives the minWords requirement — Flux is sure.
  #maybeConfirmBarge(transcript, final = false) {
    if (!this.bargeHeld) return;
    const words = transcript.split(/\s+/).filter(Boolean).length;
    // Low threshold on purpose: anything even half-resembling the agent's
    // own phrasing keeps the hold. Real interruptions share ~no bigrams with
    // the agent's speech, so they still confirm instantly.
    const echo = this.cfg.echoFilter && isEchoOf(transcript, this.#recentAgentText(), 0.35);
    if (!echo && (final || words >= this.cfg.minWords)) {
      console.log(`[session] ${this.sid} barge confirmed by: "${transcript}"`);
      this.bargeHeld = false;
      if (this.turn) this.#cancelTurn();
      this.sendClear();
    }
  }

  #onTurnInfo(msg) {
    // Once the agent hung up (or its goodbye is in flight), the line is
    // dead: no barge-in (the goodbye plays out), no new turns. The client
    // moves on (roulette_next) or tears down (call_ended).
    if (this.callOver || this.turn?.endCall) return;
    const transcript = (msg.transcript || "").trim();
    switch (msg.event) {
      case "StartOfTurn":
        // A new user turn began. Remember whether the agent was audibly
        // speaking — that's the echo-suspicion window for this whole turn.
        this.userTurnAudible = this.agentAudible();
        this.bargeHeld = this.userTurnAudible && this.cfg.bargeMode === "smart";
        if (this.bargeHeld) {
          // Duck playback immediately (feels responsive; also physically
          // shrinks the echo), cut fully once the transcript proves real
          // speech, swell back if it turns out to be our own echo.
          this.sendJson({ type: "duck" });
        } else {
          // Instant cut. Clear even with no turn in flight — the client-side
          // playback queue can outlive the server-side turn.
          if (this.turn) this.#cancelTurn();
          this.sendClear();
        }
        this.sendJson({ type: "user_start" });
        break;

      case "Update":
        if (!transcript) break;
        this.#maybeConfirmBarge(transcript);
        break;

      case "EagerEndOfTurn":
        // Flux thinks the user is probably done — start generating now,
        // buffered, while it waits for enough silence to be sure.
        if (!transcript) break;
        this.#maybeConfirmBarge(transcript);
        if (this.bargeHeld) break; // agent still talking; speech unproven
        if (this.#isSuppressedEcho(transcript)) break; // don't speculate on echo
        if (this.turn && !this.turn.committed && this.turn.userText === transcript) break;
        if (this.turn) this.#cancelTurn();
        this.#startTurn(transcript, { speculative: true });
        break;

      case "TurnResumed":
        // False alarm — the user kept talking. Drop the speculative work;
        // nothing was sent to the browser, so it's a silent rollback.
        if (this.turn && !this.turn.committed) this.#cancelTurn();
        break;

      case "EndOfTurn": {
        if (!transcript) {
          if (this.turn && !this.turn.committed) this.#cancelTurn();
          if (this.bargeHeld) this.sendJson({ type: "unduck" });
          this.bargeHeld = false;
          break;
        }
        if (this.#isSuppressedEcho(transcript)) {
          // The "user" was the agent's own voice. Never answer it. In smart
          // mode nothing was cut — swell the volume back and talk on.
          console.log(`[session] ${this.sid} echo suppressed: "${transcript}"`);
          if (this.bargeHeld) this.sendJson({ type: "unduck" });
          this.bargeHeld = false;
          this.sendJson({ type: "echo_suppressed", text: transcript });
          break;
        }
        this.#maybeConfirmBarge(transcript, true);
        // How long Deepgram took to call the turn, measured from the last
        // mic chunk that had speech-level energy — i.e. the silence Flux
        // waited out before deciding the user was done, plus transit.
        const speechEndWall = this.lastSpeechWall || Date.now();
        const sttMs = Math.max(0, Date.now() - speechEndWall);
        this.sendJson({ type: "user_final", text: transcript });
        if (this.mode === "roulette") {
          logRoulette(this.sid, "user", { character: this.roulette.character?.key, text: transcript });
          this.#judgeUserTurn(transcript);
        }
        if (this.turn && !this.turn.committed && this.turn.userText === transcript) {
          this.#commitTurn(sttMs, speechEndWall);
        } else {
          // No usable speculation (none, or the transcript changed).
          if (this.turn) this.#cancelTurn();
          this.#startTurn(transcript, { speculative: false });
          this.#commitTurn(sttMs, speechEndWall);
        }
        break;
      }
    }
  }

  // Deliver a message to the browser through the turn: sent immediately once
  // the turn is committed, buffered until then.
  #deliver(turn, kind, data) {
    if (!turn.committed) {
      turn.outbox.push([kind, data]);
      return;
    }
    if (kind === "audio") {
      if (turn.firstDeliveredWall === 0) {
        turn.firstDeliveredWall = Date.now();
        if (!turn.spokenLine && !turn.systemEvent) this.#sendMetrics(turn);
      }
      this.sendAudio(data);
    } else {
      this.sendJson(data);
    }
  }

  #commitTurn(sttMs, speechEndWall) {
    const turn = this.turn;
    if (!turn || turn.committed) return;
    turn.committed = true;
    turn.sttMs = sttMs;
    turn.speechEndWall = speechEndWall;
    const buffered = turn.outbox.splice(0);
    for (const [kind, data] of buffered) this.#deliver(turn, kind, data);
    // Speculative turn that already finished synthesis while buffered.
    if (turn.finished) this.turn = null;
  }

  #sendMetrics(turn) {
    this.sendJson({
      type: "metrics",
      stt: Math.round(turn.sttMs),
      llm: turn.firstDeltaWall ? Math.round(turn.firstDeltaWall - turn.llmStartWall) : null,
      tts: turn.firstAudioWall && turn.firstTextPushWall
        ? Math.round(turn.firstAudioWall - turn.firstTextPushWall)
        : null,
      // Voice-to-voice: user stopped speaking -> first reply audio on the wire.
      total: Math.round(turn.firstDeliveredWall - turn.speechEndWall),
      eager: turn.eager,
    });
  }

  #cancelTurn() {
    const t = this.turn;
    if (!t) return;
    this.turn = null;
    t.abort.abort();
    t.fish?.close();
    if (t.committed) {
      // The user may have heard part of the reply — keep it coherent. (If the
      // LLM already finished, #runAgentTurn recorded the exchange; don't
      // record it twice.)
      if (t.spoken && !t.inHistory) {
        if (t.userText && !t.systemEvent) this.history.push({ role: "user", content: t.userText });
        this.history.push({ role: "assistant", content: t.spoken + "…" });
        if (this.mode === "roulette") {
          logRoulette(this.sid, "agent", {
            character: this.roulette.character?.key,
            text: t.spoken,
            interrupted: true,
          });
        }
      }
      this.sendClear(); // flush queued playback everywhere
    }
    // Speculative turns roll back silently: no client messages, no history.
    // (Judge verdicts don't ride turns, so there's nothing to roll back.)
  }

  #newTurn(userText, { speculative = false, spokenLine = false, systemEvent = false } = {}) {
    return {
      id: ++this.turnCounter,
      userText,
      abort: new AbortController(),
      fish: null,
      spoken: "",
      committed: false,
      finished: false,
      inHistory: false,
      eager: speculative,
      spokenLine, // greeting: no LLM, no metrics
      systemEvent, // synthetic committed LLM turn; not attributed to the user
      endCall: null, // "kick" | "idle": the agent hangs up after this reply
      outbox: [],
      // Latency bookkeeping (wall-clock ms)
      llmStartWall: Date.now(),
      firstDeltaWall: 0,
      firstTextPushWall: 0,
      firstAudioWall: 0,
      firstDeliveredWall: 0,
      sttMs: 0,
      speechEndWall: 0,
    };
  }

  // Voice for the current speaker: the roulette character's, else the persona's.
  #voiceId() {
    if (this.mode === "roulette" && this.roulette.character) {
      return characterVoiceId(this.roulette.character);
    }
    return VOICES[PERSONAS[this.personaId].voice];
  }

  #systemPrompt() {
    if (this.mode === "roulette" && this.roulette.character) {
      return characterSystemPrompt(this.roulette.character);
    }
    return systemPromptFor(this.personaId);
  }

  #openTurnPipeline(turn) {
    return new FishPipeline(this.#voiceId(), {
      onAudio: (buf) => {
        if (this.turn?.id !== turn.id) return;
        if (turn.firstAudioWall === 0) turn.firstAudioWall = Date.now();
        this.#deliver(turn, "audio", buf);
      },
      onFinish: () => {
        if (this.turn?.id !== turn.id) return;
        turn.finished = true;
        this.#deliver(turn, "json", { type: "agent_done" });
        if (turn.endCall) {
          // The goodbye is fully synthesized; hang up. The client waits for
          // playback to drain before moving on / tearing down.
          this.callOver = true;
          const c = this.mode === "roulette" ? this.roulette.character : null;
          if (this.mode === "roulette") {
            logRoulette(this.sid, turn.endCall === "kick" ? "kick" : "call_ended", {
              character: c?.key,
              reason: turn.endCall,
            });
          }
          this.#deliver(
            turn,
            "json",
            turn.endCall === "kick"
              ? { type: "kicked", character: c?.name ?? null }
              : { type: "call_ended", reason: turn.endCall, character: c?.name ?? null },
          );
        }
        if (turn.committed) this.turn = null;
      },
      onError: (err) => {
        console.error("[fish]", err.message);
        if (this.turn?.id !== turn.id) return;
        // A segment erroring is NOT fatal: the pipeline marks it finished and
        // keeps delivering the healthy segments, and onFinish still fires.
        // Only give up when the turn has produced no audio at all — a genuine
        // startup failure.
        if (turn.firstAudioWall !== 0) return;
        this.turn = null;
        turn.fish?.close();
        this.sendJson({ type: "error", message: "TTS error" });
        this.sendJson({ type: "agent_done" });
      },
    });
  }

  // A canned line (persona greeting) — TTS only, no LLM. It
  // still occupies the turn slot so barge-in and clear work normally.
  #startSpokenLine(text) {
    const turn = this.#newTurn(null, { spokenLine: true });
    turn.committed = true;
    turn.inHistory = true; // recorded below, not by the LLM path
    this.turn = turn;
    turn.fish = this.#openTurnPipeline(turn);
    turn.spoken = text;
    turn.fish.pushText(text);
    turn.fish.endInput();
    this.history.push({ role: "assistant", content: text });
  }

  #startTurn(userText, { speculative, systemEvent = false }) {
    const turn = this.#newTurn(userText, { speculative, systemEvent });
    if (systemEvent) turn.committed = true;
    this.turn = turn;
    this.#runAgentTurn(turn);
  }

  async #runAgentTurn(turn) {
    const live = () => this.turn?.id === turn.id;
    turn.fish = this.#openTurnPipeline(turn);

    const chunker = new SentenceChunker();
    let full = ""; // full reply text, for history
    const pushToFish = (text) => {
      if (!text) return;
      if (turn.firstTextPushWall === 0) turn.firstTextPushWall = Date.now();
      turn.spoken += text;
      turn.fish.pushText(text);
    };
    const onText = (text) => {
      if (!text) return;
      full += text;
      for (const sentence of chunker.push(text)) pushToFish(sentence);
    };

    try {
      await streamLLM(
        [
          { role: "system", content: this.#systemPrompt() },
          ...this.history,
          { role: turn.systemEvent ? "system" : "user", content: turn.userText },
        ],
        turn.abort.signal,
        (delta) => {
          if (!live()) return;
          if (turn.firstDeltaWall === 0) turn.firstDeltaWall = Date.now();
          onText(delta);
        },
      );
      if (!live()) return;
      pushToFish(chunker.flush());
      turn.fish.endInput();
      turn.inHistory = true;
      if (turn.systemEvent) {
        this.history.push({ role: "assistant", content: full });
      } else {
        this.history.push(
          { role: "user", content: turn.userText },
          { role: "assistant", content: full },
        );
      }
      if (this.mode === "roulette") {
        logRoulette(this.sid, "agent", { character: this.roulette.character?.key, text: full });
      }
    } catch (err) {
      if (err.name === "AbortError") return; // barge-in / rollback — handled
      console.error("[llm]", err.message);
      if (live()) {
        this.turn = null;
        turn.fish.close();
        this.sendJson({ type: "error", message: "LLM error" });
        this.sendJson({ type: "agent_done" });
      }
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.pendingActions.length = 0;
    if (this.mode === "roulette") {
      logRoulette(this.sid, "session_end", { characters_met: this.roulette.seen.length });
    }
    this.turn?.abort.abort();
    this.turn?.fish?.close();
    this.turn = null;
    try {
      this.dg.close();
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// HTTP server (static files) + websocket endpoint
// ---------------------------------------------------------------------------

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const sessions = new Map(); // sid -> Session

// LiveKit mode (/lk): the browser joins a LiveKit room and an agent worker
// (lk-agent.js, spawned below) is dispatched into it.
const LK_ENABLED = Boolean(
  process.env.LIVEKIT_URL && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET,
);

async function lkToken(personaParam) {
  const persona = isPersona(personaParam) ? personaParam : DEFAULT_PERSONA;
  const room = `lk-${randomUUID().slice(0, 8)}`;
  const at = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, {
    identity: `user-${randomUUID().slice(0, 8)}`,
    ttl: "1h",
  });
  at.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true, canPublishData: true });
  at.roomConfig = new RoomConfiguration({
    agents: [
      new RoomAgentDispatch({
        agentName: process.env.LK_AGENT_NAME || LK_AGENT_NAME_DEFAULT,
        metadata: JSON.stringify({ persona }),
      }),
    ],
  });
  return { url: process.env.LIVEKIT_URL, token: await at.toJwt() };
}

const LK_CLIENT_PATH = path.join(__dirname, "node_modules/livekit-client/dist/livekit-client.umd.js");
let lkClientBundle = null; // ~540KB and immutable per deploy: read once, cache

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/feedback" && req.method === "POST") {
    // "Penny for your thoughts" + achievement credit claims. Append-only
    // into data/feedback-*.jsonl; everything is length-capped, nothing is
    // trusted.
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 10_000) req.destroy();
    });
    req.on("end", () => {
      try {
        const p = JSON.parse(body);
        logFeedback({
          sid: String(p.sid ?? "").slice(0, 64),
          character: String(p.character ?? "").slice(0, 32),
          email: String(p.email ?? "").slice(0, 200),
          text: String(p.text ?? "").slice(0, 4000),
          kind: p.kind === "achievement_claim" ? "achievement_claim" : "feedback",
          achievement: String(p.achievement ?? "").slice(0, 64),
        });
        res.writeHead(204).end();
      } catch {
        res.writeHead(400).end();
      }
    });
    return;
  }
  if (url.pathname === "/cast.json") {
    // Roulette landing teaser: which characters have portrait art on disk.
    // Faces only — names and cards stay a surprise until you're connected.
    const keys = Object.keys(CHARACTERS).filter((k) =>
      fs.existsSync(path.join(__dirname, "public", "characters", k, "manifest.json")),
    );
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ cast: keys }));
    return;
  }
  if (url.pathname === "/catalog.json") {
    // The idle page renders personas/voices before any websocket exists.
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ persona: DEFAULT_PERSONA, ...publicCatalog() }));
    return;
  }
  if (url.pathname === "/lk-token") {
    if (!LK_ENABLED) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "LiveKit mode is not configured (LIVEKIT_* env vars)" }));
      return;
    }
    lkToken(url.searchParams.get("persona")).then(
      (body) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      },
      (err) => {
        console.error("[lk-token]", err);
        res.writeHead(500).end();
      },
    );
    return;
  }
  if (url.pathname === "/vendor/livekit-client.umd.js") {
    const serve = (buf) => {
      res.writeHead(200, { "Content-Type": MIME[".js"], "Cache-Control": "public, max-age=3600" });
      res.end(buf);
    };
    if (lkClientBundle) return void serve(lkClientBundle);
    fs.readFile(LK_CLIENT_PATH, (err, data) => {
      if (err) return void res.writeHead(404).end("not found");
      lkClientBundle = data;
      serve(data);
    });
    return;
  }
  let file = url.pathname === "/" ? "/index.html" : url.pathname;
  // Persona deep links: /guide, /airbnb, … serve the app with that persona
  // preselected (the client reads the path — see ui-shared.js). Same for
  // LiveKit mode at /lk/<persona>.
  if (url.pathname === "/lk" || (url.pathname.startsWith("/lk/") && isPersona(url.pathname.slice(4)))) {
    file = "/lk.html";
  } else if (url.pathname === "/roulette") {
    file = "/roulette.html";
  } else if (isPersona(url.pathname.slice(1))) {
    file = "/index.html";
  }
  file = path.normalize(file).replace(/^(\.\.[/\\])+/, "");
  const full = path.join(__dirname, "public", file);
  if (!full.startsWith(path.join(__dirname, "public"))) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(full)] || "application/octet-stream" });
    res.end(data);
  });
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (client) => {
    const session = new Session(client);
    console.log(`[session] ${session.sid} connected`);
    session.sendJson({
      type: "session",
      sid: session.sid,
      persona: session.personaId,
      ...publicCatalog(),
    });
    client.on("message", (data, isBinary) => {
      if (isBinary) {
        session.onMicAudio(data);
        return;
      }
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "set_persona") {
          session.setPersona(msg.id);
        } else if (msg.type === "inactivity_nudge") {
          session.triggerInactivityNudge();
        } else if (msg.type === "roulette_start") {
          session.startRoulette();
        } else if (msg.type === "roulette_next") {
          session.nextCharacter(msg.reason === "post_kick" ? "post_kick" : "skip");
        } else if (msg.type === "end_call") {
          session.endCall("idle");
        } else if (msg.type === "text_input" && TEXT_INPUT_ENABLED) {
          session.onTextInput(String(msg.text ?? "").slice(0, 500).trim());
        }
      } catch {}
    });
    client.on("close", () => {
      console.log(`[session] ${session.sid} closed`);
      session.destroy();
    });
    client.on("error", () => session.destroy());
  });
});

server.listen(PORT, () => {
  console.log(`fish-realtime listening on http://localhost:${PORT}`);
  console.log(`  stt:  deepgram ${DEEPGRAM_MODEL} (eot ${DEEPGRAM_EOT_THRESHOLD}, eager ${DEEPGRAM_EAGER_EOT_THRESHOLD}, timeout ${DEEPGRAM_EOT_TIMEOUT_MS}ms)`);
  console.log(`  llm:  ${LLM_MODEL} @ ${LLM_BASE_URL}`);
  console.log(`  tts:  fish ${FISH_MODEL} latency=${FISH_LATENCY_MODE}`);
  console.log(`  personas: ${Object.keys(PERSONAS).join(", ")} | voices: ${Object.keys(VOICES).join(", ")}`);
  console.log(`  livekit mode (/lk): ${LK_ENABLED ? "enabled" : "disabled (set LIVEKIT_* env vars)"}`);
  console.log(`  roulette (/roulette): enabled${TEXT_INPUT_ENABLED ? " (TEXT_INPUT dev mode ON)" : ""} | judge: ${judgeEnabled() ? (process.env.JUDGE_MODEL || "gpt-5.2") : "DISABLED (no OPENAI_API_KEY)"}`);
});

// The LiveKit agent worker is hosted on LiveKit Cloud (see Dockerfile +
// livekit.toml; deploy with `lk agent deploy`). Running it inside this
// service OOM'd the Render instance, so the local spawn is opt-in dev-only.
if (LK_ENABLED && process.env.LK_AGENT_LOCAL) {
  const spawnLkAgent = () => {
    const child = spawn(process.execPath, [path.join(__dirname, "lk-agent.js"), "start"], {
      stdio: "inherit",
      env: process.env,
    });
    child.on("exit", (code) => {
      console.error(`[lk-agent] worker exited (code ${code}); restarting in 5s`);
      setTimeout(spawnLkAgent, 5000).unref();
    });
    process.on("exit", () => child.kill());
  };
  spawnLkAgent();
}
