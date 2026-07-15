// fish-realtime browser app: mic -> WS (PCM16 @ 16 kHz), WS -> speaker
// (PCM16 @ 24 kHz), JSON events for personas/tools. Shared UI (persona cards,
// orb, theme, latency pill) lives in ui-shared.js.

import { AUDIO_CONFIG, INACTIVITY_CONFIG } from "/config.js";
import { createUI, createVoiceMeter } from "/ui-shared.js";

const ui = createUI({ onPickPersona: pickPersona });
const { els, scene } = ui;

// --- state -------------------------------------------------------------------

let ws = null;
let inCtx = null;
let outCtx = null;
let player = null;
let micStream = null;
let running = false;
let connecting = false;
let muted = false;

let pendingPersona = null; // chosen while idle; applied on start
let agentSpeaking = false;
let userTurnActive = false;
const mobilePersonaQuery = matchMedia("(max-width: 820px)");
let inactivityNudgeTimer = 0;
let inactivityDisconnectTimer = 0;

// The server's pipeline metrics still land in the console; the pill shows
// this ear-to-ear measurement.
const meter = createVoiceMeter((ms) => ui.showLatency(`voice → voice ${ms} ms`));

// --- ui helpers ----------------------------------------------------------------

function setMuted(next) {
  muted = next;
  micStream?.getAudioTracks().forEach((track) => { track.enabled = !muted; });
  ui.setMuteButton(muted);
}

function clearInactivityTimers() {
  clearTimeout(inactivityNudgeTimer);
  clearTimeout(inactivityDisconnectTimer);
  inactivityNudgeTimer = 0;
  inactivityDisconnectTimer = 0;
}

function tryInactivityNudge() {
  if (!running) return;
  const agentBusy = userTurnActive || agentSpeaking || els.orb.className === "thinking" || els.orb.className === "connecting";
  if (agentBusy) {
    inactivityNudgeTimer = setTimeout(tryInactivityNudge, INACTIVITY_CONFIG.busyRetryMs);
    return;
  }
  send({ type: "inactivity_nudge" });
  inactivityNudgeTimer = 0;
}

function tryInactivityDisconnect() {
  if (!running) return;
  if (userTurnActive) {
    inactivityDisconnectTimer = setTimeout(tryInactivityDisconnect, INACTIVITY_CONFIG.busyRetryMs);
    return;
  }
  stop();
}

function resetInactivityTimers() {
  clearInactivityTimers();
  if (!running) return;
  inactivityNudgeTimer = setTimeout(tryInactivityNudge, INACTIVITY_CONFIG.nudgeAfterMs);
  inactivityDisconnectTimer = setTimeout(tryInactivityDisconnect, INACTIVITY_CONFIG.disconnectAfterMs);
}

function pickPersona(key) {
  if (running || connecting) {
    if (key !== ui.state.personaId) send({ type: "set_persona", id: key });
  } else {
    const wasSelected = key === ui.state.personaId;
    pendingPersona = key;
    ui.state.personaId = key;
    ui.applyTheme(ui.personaByKey()[key]);
    ui.renderPersonas();
    if (mobilePersonaQuery.matches && !wasSelected) {
      return;
    }
    start();
  }
}

// --- audio ------------------------------------------------------------------------

async function initAudio() {
  if (micStream) {
    // Capture context pinned to 16 kHz (the browser resamples the mic for us).
    inCtx = new AudioContext({ sampleRate: AUDIO_CONFIG.inputSampleRate });
    await inCtx.audioWorklet.addModule("/mic-worklet.js");
    const src = inCtx.createMediaStreamSource(micStream);
    const mic = new AudioWorkletNode(inCtx, "mic-capture");
    src.connect(mic);
    mic.port.onmessage = (e) => {
      const pcm = e.data; // Int16Array, 32 ms
      if (!muted && ws?.readyState === WebSocket.OPEN) ws.send(pcm.buffer);
      // Mic energy feeds the scene's ripples and the ear-to-ear stopwatch.
      let sum = 0;
      for (let i = 0; i < pcm.length; i += 4) sum += pcm[i] * pcm[i];
      if (pcm.length) {
        const rms = Math.sqrt(sum / Math.ceil(pcm.length / 4));
        scene.micLevel(Math.min(1, rms / AUDIO_CONFIG.micLevelReference));
        if (!muted) meter.mic(rms / 32768);
      }
    };
  }

  // Playback context pinned to Fish's 24 kHz output.
  outCtx = new AudioContext({ sampleRate: AUDIO_CONFIG.outputSampleRate });
  await outCtx.audioWorklet.addModule("/player-worklet.js");
  player = new AudioWorkletNode(outCtx, "pcm-player");
  player.connect(outCtx.destination);
  player.port.onmessage = (e) => {
    if (e.data.level !== undefined) {
      scene.agentLevel(e.data.level);
      meter.agent(e.data.level / 4); // level is rms*4 (see player-worklet.js)
      return;
    }
    const wasSpeaking = agentSpeaking;
    agentSpeaking = e.data.playing;
    if (running) {
      ui.setOrb(agentSpeaking ? "speaking" : "listening");
      // The "still there?" countdown is anchored to agent playback: any
      // pending nudge (or busy-retry poll) is cancelled while audio plays,
      // and the full window starts only once playback stops.
      if (agentSpeaking) {
        clearTimeout(inactivityNudgeTimer);
        inactivityNudgeTimer = 0;
      } else if (wasSpeaking) {
        clearTimeout(inactivityNudgeTimer);
        inactivityNudgeTimer = setTimeout(tryInactivityNudge, INACTIVITY_CONFIG.nudgeAfterMs);
      }
    }
  };
}

function send(obj) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function setDuck(on) {
  player?.port.postMessage({ cmd: "gain", value: on ? 0.15 : 1 });
}

// --- session ------------------------------------------------------------------------

async function start() {
  if (running || connecting) return;
  connecting = true;
  setMuted(false);
  document.body.classList.remove("idle");
  document.body.classList.add("session-fullscreen");
  ui.setOrb("connecting");
  // ?nomic — dev/preview mode: run the session without capture (you hear the
  // agent and can drive personas/voices from the UI, it just can't hear you).
  const noMic = new URLSearchParams(location.search).has("nomic");
  try {
    if (!noMic) {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { ...AUDIO_CONFIG.captureConstraints },
      });
    }
  } catch {
    connecting = false;
    document.body.classList.add("idle");
    document.body.classList.remove("session-fullscreen");
    ui.setOrb("idle");
    return;
  }

  await initAudio();
  if (noMic) {
    // Keep Deepgram's socket alive with silence so the session doesn't idle out.
    const silence = new ArrayBuffer(1024);
    const tick = setInterval(() => {
      // ws is created just after this interval; keep ticking while it
      // connects and only stop once it's gone or closing.
      if (!ws || ws.readyState > WebSocket.OPEN) clearInterval(tick);
      else if (ws.readyState === WebSocket.OPEN) ws.send(silence);
    }, 32);
  }
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.binaryType = "arraybuffer";
  ws.onmessage = (e) => {
    if (e.data instanceof ArrayBuffer) {
      player?.port.postMessage(new Int16Array(e.data));
      return;
    }
    handleEvent(JSON.parse(e.data));
  };
  ws.onclose = stop;
  ws.onerror = stop;
}

function stop() {
  if (!running && !connecting) return;
  clearInactivityTimers();
  running = false;
  connecting = false;
  document.body.classList.add("idle");
  document.body.classList.remove("session-fullscreen");
  ws?.close();
  ws = null;
  micStream?.getTracks().forEach((t) => t.stop());
  inCtx?.close();
  outCtx?.close();
  inCtx = outCtx = player = micStream = null;
  agentSpeaking = false;
  userTurnActive = false;
  meter.reset();
  setMuted(false);
  pendingPersona = null;
  ui.hideLatency();
  ui.setOrb("idle");
  scene.agentLevel(0);
  scene.micLevel(0);
}

function handleEvent(msg) {
  switch (msg.type) {
    case "session":
      ui.state.catalog = { personas: msg.personas };
      ui.state.personaId = msg.persona;
      ui.renderPersonas();
      break;

    case "ready": {
      connecting = false;
      running = true;
      ui.setOrb("listening");
      resetInactivityTimers();
      // Greet with the chosen persona (also applies its voice + theme).
      send({ type: "set_persona", id: pendingPersona ?? ui.state.personaId });
      pendingPersona = null;
      break;
    }

    case "persona": {
      ui.state.personaId = msg.persona;
      ui.applyTheme(ui.personaByKey()[msg.persona]);
      ui.renderPersonas();
      break;
    }

    case "user_start":
      userTurnActive = true;
      ui.setOrb("listening");
      break;

    case "user_final":
      userTurnActive = false;
      ui.setOrb("thinking");
      resetInactivityTimers();
      break;

    case "duck":
      setDuck(true);
      break;

    case "unduck":
      setDuck(false);
      break;

    case "clear":
      // "clear" also arrives as a safety flush on ordinary turn starts.
      player?.port.postMessage({ cmd: "clear" });
      setDuck(false);
      break;

    case "inactivity_nudge_deferred":
      if (running && !inactivityNudgeTimer) {
        inactivityNudgeTimer = setTimeout(tryInactivityNudge, INACTIVITY_CONFIG.busyRetryMs);
      }
      break;

    case "inactivity_nudge_started":
      if (running) ui.setOrb("thinking");
      break;

    case "echo_suppressed":
      userTurnActive = false;
      break;

    case "metrics":
      // Server-side pipeline view (speech end at server -> first byte on the
      // wire); the pill shows the ear-to-ear measurement instead.
      console.log("[fish] server pipeline metrics", msg);
      break;

    case "stt_closed":
      if (running) stop();
      break;

    // user_partial / agent_text / agent_done / error: intentionally ignored.
  }
}

// --- wiring -------------------------------------------------------------------------

els.orb.onclick = () => (running || connecting ? stop() : start());
els.mute.onclick = () => {
  if (running || connecting) setMuted(!muted);
};
