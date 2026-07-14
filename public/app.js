// fish-realtime browser app: mic -> WS (PCM16 @ 16 kHz), WS -> speaker
// (PCM16 @ 24 kHz), JSON events for personas/tools, and hooks into
// the ambient scene (visual.js).

import { createScene } from "/visual.js";
import { AUDIO_CONFIG, INACTIVITY_CONFIG } from "/config.js";

const $ = (id) => document.getElementById(id);

const els = {
  orb: $("orb"),
  mute: $("mute"),
  muteLabel: $("mute-label"),
  personas: $("personas"),
  latency: $("latency"),
};

const scene = createScene($("scene"));
window.__scene = scene; // console/test access

// --- state -------------------------------------------------------------------

let ws = null;
let inCtx = null;
let outCtx = null;
let player = null;
let micStream = null;
let running = false;
let connecting = false;
let muted = false;

let catalog = { personas: [], voices: [] };
let personaId = "guide";
let voiceId = null;
let pendingPersona = null; // chosen while idle; applied on start
let agentSpeaking = false;
let userTurnActive = false;
// Ear-to-ear voice→voice measurement (same definition as /lk): last mic chunk
// with voice energy → first audible playback after a quiet gap, both observed
// in this tab. The server's pipeline metrics still land in the console.
let lastMicVoiceWall = 0;
let awaitingReply = false;
let agentQuietLevels = 99;
const MIC_VOICE_RMS = 655; // int16 rms ≈ -34 dBFS
const AGENT_VOICE_LEVEL = 0.08; // player level units (rms*4)
const mobilePersonaQuery = matchMedia("(max-width: 820px)");
let inactivityNudgeTimer = 0;
let inactivityDisconnectTimer = 0;

const personaByKey = () => Object.fromEntries(catalog.personas.map((p) => [p.key, p]));
const voiceByKey = () => Object.fromEntries(catalog.voices.map((v) => [v.key, v]));

// Personas are known before the first connection so the idle page can render
// them; the server's session message is the source of truth once connected.
const BOOT = fetch("/catalog.json").then((r) => r.json()).catch(() => null);

// --- ui helpers ----------------------------------------------------------------

function setOrb(state) {
  els.orb.className = state;
  els.orb.setAttribute("aria-label", state === "idle" ? "Start talking" : "Stop talking");
  scene.setState(state);
}

function setMuted(next) {
  muted = next;
  micStream?.getAudioTracks().forEach((track) => { track.enabled = !muted; });
  els.mute.setAttribute("aria-pressed", String(muted));
  els.mute.setAttribute("aria-label", muted ? "Unmute microphone" : "Mute microphone");
  els.muteLabel.textContent = muted ? "Unmute" : "Mute";
  els.mute.classList.toggle("on", muted);
  if (muted) scene.micLevel(0);
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

function applyTheme(p) {
  if (!p?.theme) return;
  document.documentElement.style.setProperty("--tint", p.theme.tint);
  document.documentElement.style.setProperty("--glow", p.theme.glow);
  scene.setTheme(p.theme.tint, p.theme.glow);
}

function renderPersonas() {
  els.personas.innerHTML = "";
  for (const p of catalog.personas) {
    const b = document.createElement("button");
    b.className = "persona" + (p.key === personaId ? " on" : "");
    b.setAttribute("aria-label", `${p.name} — ${p.tagline}`);
    b.setAttribute("aria-pressed", p.key === personaId ? "true" : "false");
    b.style.setProperty("--p-tint", p.theme.tint);
    b.innerHTML = `<span class="p-name">${p.name}</span><span class="p-tag">${p.tagline}</span>`;
    b.onclick = () => pickPersona(p.key);
    els.personas.appendChild(b);
  }
  requestAnimationFrame(fitPersonaLabels);
}

function fitPersonaLabels() {
  for (const label of els.personas.querySelectorAll(".p-name")) {
    // Start from the CSS-defined size on every layout pass, then reduce only
    // when the unbroken label is wider than its actual card content box.
    label.style.fontSize = "";
    if (label.scrollWidth <= label.clientWidth) continue;
    const naturalSize = Number.parseFloat(getComputedStyle(label).fontSize);
    const fittedSize = naturalSize * (label.clientWidth / label.scrollWidth) * 0.97;
    label.style.fontSize = `${Math.max(28, fittedSize).toFixed(2)}px`;
  }
}

function pickPersona(key) {
  if (running || connecting) {
    if (key !== personaId) send({ type: "set_persona", id: key });
  } else {
    const wasSelected = key === personaId;
    pendingPersona = key;
    personaId = key;
    applyTheme(personaByKey()[key]);
    renderPersonas();
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
        if (!muted && rms > MIC_VOICE_RMS) {
          lastMicVoiceWall = performance.now();
          awaitingReply = true;
        }
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
      if (e.data.level > AGENT_VOICE_LEVEL) {
        // ≥3 quiet level ticks (~130ms) separates a reply from the tail of
        // the previous one.
        if (agentQuietLevels >= 3 && awaitingReply && lastMicVoiceWall) {
          awaitingReply = false;
          els.latency.textContent = `voice → voice ${Math.round(performance.now() - lastMicVoiceWall)} ms`;
          els.latency.classList.add("show");
        }
        agentQuietLevels = 0;
      } else {
        agentQuietLevels++;
      }
      return;
    }
    const wasSpeaking = agentSpeaking;
    agentSpeaking = e.data.playing;
    if (running) {
      setOrb(agentSpeaking ? "speaking" : "listening");
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
  setOrb("connecting");
  // ?nomic — dev/preview mode: run the session without capture (you hear the
  // agent and can drive personas/voices from the UI, it just can't hear you).
  const noMic = new URLSearchParams(location.search).has("nomic");
  try {
    if (!noMic) {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
      });
      setMuted(muted);
    }
  } catch {
    connecting = false;
    document.body.classList.add("idle");
    document.body.classList.remove("session-fullscreen");
    setOrb("idle");
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
  lastMicVoiceWall = 0;
  awaitingReply = false;
  agentQuietLevels = 99;
  setMuted(false);
  pendingPersona = null;
  els.latency.classList.remove("show");
  setOrb("idle");
  scene.agentLevel(0);
  scene.micLevel(0);
}

function handleEvent(msg) {
  switch (msg.type) {
    case "session":
      catalog = { personas: msg.personas, voices: msg.voices };
      personaId = msg.persona;
      voiceId = msg.voice;
      renderPersonas();
      break;

    case "ready": {
      connecting = false;
      running = true;
      setOrb("listening");
      resetInactivityTimers();
      // Greet with the chosen persona (also applies its voice + theme).
      send({ type: "set_persona", id: pendingPersona ?? personaId });
      pendingPersona = null;
      break;
    }

    case "persona": {
      personaId = msg.persona;
      voiceId = msg.voice;
      const p = personaByKey()[personaId];
      applyTheme(p);
      renderPersonas();
      break;
    }

    case "tool": {
      if (msg.tool === "change_persona") {
        personaId = msg.persona;
        voiceId = msg.voice;
        applyTheme(personaByKey()[personaId]);
        renderPersonas();
      } else if (msg.tool === "change_voice") {
        voiceId = msg.voice;
      }
      break;
    }

    case "user_start":
      userTurnActive = true;
      setOrb("listening");
      break;

    case "user_partial":
      break;

    case "user_final":
      userTurnActive = false;
      setOrb("thinking");
      resetInactivityTimers();
      break;

    case "agent_text":
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

    case "agent_done":
      break;

    case "inactivity_nudge_deferred":
      if (running && !inactivityNudgeTimer) {
        inactivityNudgeTimer = setTimeout(tryInactivityNudge, INACTIVITY_CONFIG.busyRetryMs);
      }
      break;

    case "inactivity_nudge_started":
      if (running) setOrb("thinking");
      break;

    case "echo_suppressed":
      userTurnActive = false;
      break;

    case "metrics":
      // Server-side pipeline view (speech end at server -> first byte on the
      // wire); the pill shows the ear-to-ear measurement instead.
      console.log("[fish] server pipeline metrics", msg);
      break;

    case "error":
      break;

    case "stt_closed":
      if (running) stop();
      break;
  }
}

// --- wiring -------------------------------------------------------------------------

els.orb.onclick = () => (running || connecting ? stop() : start());
els.mute.onclick = () => {
  if (running || connecting) setMuted(!muted);
};
let personaFitFrame = 0;
addEventListener("resize", () => {
  cancelAnimationFrame(personaFitFrame);
  personaFitFrame = requestAnimationFrame(fitPersonaLabels);
});

// Idle boot: render personas from the static catalog so the page is alive
// before any connection.
BOOT.then((data) => {
  if (!data || catalog.personas.length) return;
  catalog = data;
  const first = personaByKey()[personaId];
  applyTheme(first);
  renderPersonas();
});
