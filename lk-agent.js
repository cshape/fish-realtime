// LiveKit-mode agent worker. The same product as server.js's fish pipeline,
// rebuilt on LiveKit Agents: Deepgram Flux STT (direct /v2/listen, BYO
// DEEPGRAM_API_KEY — the inference-gateway hop cost ~1.5s of turn latency),
// Gemma 4 31B via LiveKit Inference, and the Fish TTS plugin with the same
// voice reference ids. Hosted on LiveKit Cloud; the browser side lives at /lk.
//
// Latency parity: fish mode reports voice-to-voice as (last audible mic chunk
// arriving at the server) -> (first reply audio written to the client socket).
// The equivalent span here is EOUMetrics.lastSpeakingTimeMs (when the user
// stopped speaking, as observed by the agent) -> the agent_state transition to
// "speaking" (first reply audio being published to the room). Both spans
// include STT finalization, LLM TTFT, and TTS TTFB, and both exclude the
// final downstream hop to the browser.

import { cli, defineAgent, inference, voice, ServerOptions } from "@livekit/agents";
import * as deepgram from "@livekit/agents-plugin-deepgram";
import * as fishaudio from "@livekit/agents-plugin-fishaudio";
import { fileURLToPath } from "node:url";
import { VOICES, PERSONAS, DEFAULT_PERSONA, lkSystemPromptFor, pickGreeting } from "./personas.js";
import { INACTIVITY_CONFIG, LLM_CONFIG, LK_AGENT_NAME_DEFAULT } from "./public/config.js";

const STT_MODEL = process.env.LK_STT_MODEL || "flux-general-en";
const LLM_MODEL = process.env.LK_LLM_MODEL || "google/gemma-4-31b-it";
// Override for local dev so a dev worker never collides with the deployed
// agent registered under the production name on the same LiveKit project.
const AGENT_NAME = process.env.LK_AGENT_NAME || LK_AGENT_NAME_DEFAULT;

const encoder = new TextEncoder();

export default defineAgent({
  entry: async (ctx) => {
    let personaId = DEFAULT_PERSONA;
    try {
      const meta = JSON.parse(ctx.job.metadata || "{}");
      if (PERSONAS[meta.persona]) personaId = meta.persona;
    } catch {}
    const persona = PERSONAS[personaId];
    const voiceRef = VOICES[persona.voice].id;

    const session = new voice.AgentSession({
      // Direct Deepgram Flux over /v2/listen (DEEPGRAM_API_KEY), skipping the
      // LiveKit inference gateway — the extra hop delayed Flux's view of the
      // user's silence and turn confirmations landed ~1.5s late. Thresholds
      // are tuned aggressive (snappier than fish mode's 0.7/0.5): quicker
      // turn commits and earlier speculative generation.
      stt: new deepgram.STTv2({
        model: STT_MODEL,
        eotThreshold: Number(process.env.DEEPGRAM_EOT_THRESHOLD || 0.6),
        eagerEotThreshold: Number(process.env.DEEPGRAM_EAGER_EOT_THRESHOLD || 0.4),
        eotTimeoutMs: Number(process.env.DEEPGRAM_EOT_TIMEOUT_MS || 3000),
      }),
      llm: new inference.LLM({
        model: LLM_MODEL,
        // Same sampling params as fish mode (shared via config.js).
        modelOptions: {
          temperature: LLM_CONFIG.temperature,
          max_completion_tokens: LLM_CONFIG.maxTokens,
        },
      }),
      // Direct Fish plugin (FISH_API_KEY), not the inference gateway: same
      // crackle-free path as livekit-demo, patched (patches/) with
      // livekit/agents-js#2033 so audio streams from the opening chunk.
      tts: new fishaudio.TTS({
        model: process.env.FISH_MODEL || "s2.1-pro",
        voiceId: voiceRef,
        latencyMode: process.env.FISH_LATENCY_MODE || "low",
      }),
      // Matches fish mode's 10s "still there?" nudge window.
      userAwayTimeout: INACTIVITY_CONFIG.nudgeAfterMs / 1000,
      turnHandling: {
        // Flux owns turn-taking (EndOfTurn / EagerEndOfTurn), same as fish
        // mode — no separate turn-detector model, no added endpointing floor.
        turnDetection: "stt",
        endpointing: { minDelay: 0 },
        // Speculate LLM + TTS on Flux's EagerEndOfTurn, play on EndOfTurn.
        // This is the same bet fish mode's engine makes, so voice-to-voice
        // numbers stay comparable.
        preemptiveGeneration: { enabled: true, preemptiveTts: true },
        // Match fish mode's smart barge-in: only proven speech (2+ words)
        // counts as an interruption. Without this, a breath or stray noise at
        // turn end pauses the reply and strands it on the false-interruption
        // timeout — the flat ~2s turns seen in testing (SDK default 2000ms).
        interruption: { minWords: 2, falseInterruptionTimeout: 1000 },
      },
    });

    const sendData = (obj) => {
      ctx.room.localParticipant
        ?.publishData(encoder.encode(JSON.stringify(obj)), { reliable: true })
        .catch(() => {});
    };

    // --- voice-to-voice latency (see header comment for parity rationale) ---
    let lastEou = null; // EOUMetrics for the turn the agent is about to answer
    const components = {}; // ttft / ttfb by speechId, for the breakdown log

    let lastFinalWall = 0; // wall time the user turn's final transcript landed

    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (ev) => {
      if (ev.isFinal) lastFinalWall = ev.createdAt;
    });

    session.on(voice.AgentSessionEventTypes.MetricsCollected, (ev) => {
      const m = ev.metrics;
      if (m.type === "eou_metrics") {
        lastEou = m;
      } else if (m.type === "llm_metrics" && m.speechId) {
        (components[m.speechId] ??= {}).ttft = Math.round(m.ttftMs);
      } else if (m.type === "tts_metrics" && m.speechId) {
        (components[m.speechId] ??= {}).ttfb = Math.round(m.ttfbMs);
      }
    });

    session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
      sendData({ type: "agent_state", state: ev.newState });
      if (ev.newState !== "speaking") return;
      if (!lastEou?.lastSpeakingTimeMs) return; // greeting/nudge: no user turn
      const eou = lastEou;
      lastEou = null;
      const total = Math.round(ev.createdAt - eou.lastSpeakingTimeMs);
      if (total <= 0 || total > 30_000) return; // stale anchor; don't report junk
      const parts = components[eou.speechId] ?? {};
      delete components[eou.speechId];
      // Interrupted/abandoned speeches never reach "speaking", so their
      // entries would otherwise accumulate for the life of the session.
      for (const key of Object.keys(components).slice(0, -4)) delete components[key];
      sendData({
        type: "metrics",
        total,
        stt: Math.round(eou.transcriptionDelayMs),
        llm: parts.ttft ?? null,
        tts: parts.ttfb ?? null,
      });
      // tail: user stopped speaking -> Flux's final transcript (turn commit).
      // confirm: turn commit -> first reply audio published. Splitting the
      // total here is what located the inference-gateway stall.
      const tail = lastFinalWall ? Math.round(lastFinalWall - eou.lastSpeakingTimeMs) : null;
      const confirm = lastFinalWall ? Math.round(ev.createdAt - lastFinalWall) : null;
      console.log(
        `[lk-agent] voice->voice ${total}ms (tail ${tail ?? "?"}ms, confirm ${confirm ?? "?"}ms, ` +
        `llm ttft ${parts.ttft ?? "?"}ms, tts ttfb ${parts.ttfb ?? "?"}ms)`,
      );
    });

    // --- inactivity: nudge at 10s away, hang up at the 30s deadline ---------
    let disconnectTimer = null;
    session.on(voice.AgentSessionEventTypes.UserStateChanged, (ev) => {
      if (ev.newState === "away") {
        session.generateReply({ instructions: INACTIVITY_CONFIG.prompt });
        clearTimeout(disconnectTimer);
        disconnectTimer = setTimeout(() => {
          ctx.shutdown("inactivity");
        }, INACTIVITY_CONFIG.disconnectAfterMs - INACTIVITY_CONFIG.nudgeAfterMs);
      } else {
        clearTimeout(disconnectTimer);
        disconnectTimer = null;
      }
    });

    await session.start({
      agent: voice.Agent.create({ instructions: lkSystemPromptFor(personaId) }),
      room: ctx.room,
    });
    await ctx.connect();

    console.log(`[lk-agent] session started in ${ctx.room.name} as ${personaId} (${persona.voice})`);
    session.say(pickGreeting(personaId)); // interruptible, like every reply
  },
});

cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url), agentName: AGENT_NAME }));
