// LiveKit-mode agent worker. The same product as server.js's fish pipeline,
// rebuilt on LiveKit Agents with every model served through LiveKit Inference:
// Deepgram Flux STT (same EOT settings), Gemma 4 31B, and Fish s2.1-pro with
// the same voice reference ids. Spawned by server.js when LIVEKIT_* creds are
// present; the browser side lives at /lk.
//
// Latency parity: fish mode reports voice-to-voice as (last audible mic chunk
// arriving at the server) -> (first reply audio written to the client socket).
// The equivalent span here is EOUMetrics.lastSpeakingTimeMs (when the user
// stopped speaking, as observed by the agent) -> the agent_state transition to
// "speaking" (first reply audio being published to the room). Both spans
// include STT finalization, LLM TTFT, and TTS TTFB, and both exclude the
// final downstream hop to the browser.

import { cli, defineAgent, inference, voice, ServerOptions } from "@livekit/agents";
import * as fishaudio from "@livekit/agents-plugin-fishaudio";
import { fileURLToPath } from "node:url";
import { VOICES, PERSONAS, DEFAULT_PERSONA, lkSystemPromptFor, pickGreeting } from "./personas.js";
import { INACTIVITY_CONFIG } from "./public/config.js";

const STT_MODEL = process.env.LK_STT_MODEL || "deepgram/flux-general-en";
const LLM_MODEL = process.env.LK_LLM_MODEL || "google/gemma-4-31b-it";
// Override for local dev so a dev worker never collides with the deployed
// agent registered under the production name on the same LiveKit project.
const AGENT_NAME = process.env.LK_AGENT_NAME || "fish-lk";

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
      stt: new inference.STT({
        model: STT_MODEL,
        modelOptions: {
          // Mirrors the fish-mode Deepgram Flux settings in server.js.
          eot_threshold: Number(process.env.DEEPGRAM_EOT_THRESHOLD || 0.7),
          eager_eot_threshold: Number(process.env.DEEPGRAM_EAGER_EOT_THRESHOLD || 0.5),
          eot_timeout_ms: Number(process.env.DEEPGRAM_EOT_TIMEOUT_MS || 3000),
        },
      }),
      llm: new inference.LLM({
        model: LLM_MODEL,
        // Mirrors the fish-mode LLM call params.
        modelOptions: { temperature: 1.5, max_completion_tokens: 500 },
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
      },
    });

    const sendData = (obj) => {
      ctx.room.localParticipant
        ?.publishData(new TextEncoder().encode(JSON.stringify(obj)), { reliable: true })
        .catch(() => {});
    };

    // --- voice-to-voice latency (see header comment for parity rationale) ---
    let lastEou = null; // EOUMetrics for the turn the agent is about to answer
    const components = {}; // ttft / ttfb by speechId, for the breakdown log

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
      sendData({
        type: "metrics",
        total,
        stt: Math.round(eou.transcriptionDelayMs),
        llm: parts.ttft ?? null,
        tts: parts.ttfb ?? null,
      });
      console.log(
        `[lk-agent] voice->voice ${total}ms (eou ${Math.round(eou.endOfUtteranceDelayMs)}ms, ` +
        `stt ${Math.round(eou.transcriptionDelayMs)}ms, llm ttft ${parts.ttft ?? "?"}ms, tts ttfb ${parts.ttfb ?? "?"}ms)`,
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
