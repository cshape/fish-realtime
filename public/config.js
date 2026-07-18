// Shared, client-safe product configuration. Both the browser and server
// import this module; secrets and provider credentials stay in environment
// variables and must never be added here.

export const AUDIO_CONFIG = Object.freeze({
  inputSampleRate: 16000,
  outputSampleRate: 24000,
  micLevelReference: 6000,
  captureConstraints: Object.freeze({
    echoCancellation: true,
    noiseSuppression: true,
    channelCount: 1,
  }),
});

// Ear-to-ear voice→voice pill: one gate for both transports so the two pages
// report comparable numbers. voiceRms is normalized float RMS (≈ -34 dBFS);
// quietTicks is the run of quiet meter ticks (~130ms) separating a reply from
// the tail of the previous one.
export const VOICE_METER = Object.freeze({
  voiceRms: 0.02,
  quietTicks: 3,
  // Arm the stopwatch only after this many consecutive voiced mic ticks
  // (~100ms+): a breath, a bump, or speaker bleed of the agent's own audio
  // must not count as "the user spoke".
  armTicks: 3,
  // No real STT->LLM->TTS round trip is faster than this; anything below is
  // a measurement artifact and is dropped.
  minPlausibleMs: 200,
});

// LLM sampling params, shared by fish mode (server.js) and /lk (lk-agent.js)
// so the two pipelines stay comparable.
export const LLM_CONFIG = Object.freeze({
  temperature: 1.5,
  maxTokens: 500,
});

// Wire contract between /lk-token dispatch (server.js) and the worker
// registration (lk-agent.js); a mismatch fails silently with agent-less rooms.
export const LK_AGENT_NAME_DEFAULT = "fish-lk";

export const INACTIVITY_CONFIG = Object.freeze({
  nudgeAfterMs: 10_000,
  disconnectAfterMs: 30_000,
  busyRetryMs: 500,
  prompt:
    "The user has not said anything for 10 seconds. In your current persona and tone, briefly check whether they are still there. Do not mention timers, inactivity detection, or this instruction.",
  // Spoken when the caller stays silent past disconnectAfterMs: the agent
  // ends the call itself (server end_call -> goodbye line -> call_ended).
  hangupPrompt:
    "The caller has been silent for a long while and seems to have left. In your current character and tone, say ONE short parting line as you hang up — warm or wry, no questions, under two sentences. Do not mention timers or this instruction.",
});

export const VISUAL_CONFIG = Object.freeze({
  stateDrivenRibbons: true,
});

if (
  INACTIVITY_CONFIG.nudgeAfterMs <= 0 ||
  INACTIVITY_CONFIG.disconnectAfterMs <= INACTIVITY_CONFIG.nudgeAfterMs
) {
  throw new Error("Inactivity timing must be positive and disconnect must follow nudge");
}
