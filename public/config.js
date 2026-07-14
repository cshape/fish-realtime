// Shared, client-safe product configuration. Both the browser and server
// import this module; secrets and provider credentials stay in environment
// variables and must never be added here.

export const AUDIO_CONFIG = Object.freeze({
  inputSampleRate: 16000,
  outputSampleRate: 24000,
  micLevelReference: 6000,
});

export const INACTIVITY_CONFIG = Object.freeze({
  nudgeAfterMs: 10_000,
  disconnectAfterMs: 30_000,
  busyRetryMs: 500,
  prompt:
    "The user has not said anything for 10 seconds. In your current persona and tone, briefly check whether they are still there. Do not mention timers, inactivity detection, or this instruction.",
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
