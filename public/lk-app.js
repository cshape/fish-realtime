// LiveKit-mode browser app (/lk). Same UI as app.js (via ui-shared.js),
// different transport: the browser joins a LiveKit room over WebRTC, the
// agent (lk-agent.js) is dispatched into it, and orb state + pipeline metrics
// arrive as reliable data messages from the agent. Uses the livekit-client
// UMD bundle (global `LivekitClient`), served at /vendor/livekit-client.umd.js.

import { AUDIO_CONFIG } from "/config.js";
import { createUI, createVoiceMeter } from "/ui-shared.js";

const LK = window.LivekitClient;
const decoder = new TextDecoder();

const ui = createUI({ onPickPersona: pickPersona });
const { scene } = ui;

// --- state -------------------------------------------------------------------

let room = null;
let running = false;
let connecting = false;
let muted = false;
let meterCtx = null; // WebAudio context for local level metering
let meterTimer = 0;
const meters = { mic: null, agent: null }; // AnalyserNodes
const mobilePersonaQuery = matchMedia("(max-width: 820px)");

// The agent's pipeline metrics still land in the console; the pill shows
// this ear-to-ear measurement.
const meter = createVoiceMeter((ms) => ui.showLatency(`voice → voice ${ms} ms`));

function setMuted(next) {
  muted = next;
  room?.localParticipant.setMicrophoneEnabled(!muted).catch(() => {});
  ui.setMuteButton(muted);
}

// --- level metering ---------------------------------------------------------
// The scene animation and the ear-to-ear stopwatch run off LOCAL WebAudio
// analysers (~45ms cadence, same feel as the bare agent's worklet metering).
// LiveKit's ActiveSpeakersChanged is a server round-trip and visibly lags.

function meterTrack(kind, mediaStreamTrack) {
  if (!mediaStreamTrack) return;
  meterCtx ??= new AudioContext();
  const src = meterCtx.createMediaStreamSource(new MediaStream([mediaStreamTrack]));
  const analyser = meterCtx.createAnalyser();
  analyser.fftSize = 512;
  src.connect(analyser);
  meters[kind] = analyser;
  if (!meterTimer) {
    const buf = new Float32Array(512);
    const rms = (a) => {
      if (!a) return 0;
      a.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      return Math.sqrt(sum / buf.length);
    };
    meterTimer = setInterval(() => {
      const mic = rms(meters.mic);
      const agent = rms(meters.agent);
      scene.micLevel(muted ? 0 : Math.min(1, mic / 0.18));
      scene.agentLevel(Math.min(1, agent * 4));
      if (!muted) meter.mic(mic);
      meter.agent(agent);
    }, 45);
  }
}

function stopMeters() {
  clearInterval(meterTimer);
  meterTimer = 0;
  meters.mic = meters.agent = null;
  meter.reset();
  meterCtx?.close().catch(() => {});
  meterCtx = null;
}

function pickPersona(key) {
  const wasSelected = key === ui.state.personaId;
  ui.state.personaId = key;
  ui.applyTheme(ui.personaByKey()[key]);
  ui.renderPersonas();
  if (running || connecting) {
    // Persona is fixed per LiveKit room; switching means a fresh room.
    stop().then(start);
    return;
  }
  if (mobilePersonaQuery.matches && !wasSelected) return;
  start();
}

// --- session ------------------------------------------------------------------------

async function start() {
  if (running || connecting) return;
  if (!LK) {
    ui.showLatency("livekit-client failed to load");
    return;
  }
  connecting = true;
  setMuted(false);
  document.body.classList.remove("idle");
  document.body.classList.add("session-fullscreen");
  ui.setOrb("connecting");

  try {
    const res = await fetch(`/lk-token?persona=${encodeURIComponent(ui.state.personaId)}`);
    if (!res.ok) throw new Error(`token: ${res.status}`);
    const { url, token } = await res.json();

    room = new LK.Room({
      audioCaptureDefaults: { ...AUDIO_CONFIG.captureConstraints },
    });

    room.on(LK.RoomEvent.TrackSubscribed, (track) => {
      if (track.kind !== "audio") return;
      const el = track.attach();
      el.style.display = "none";
      document.body.appendChild(el);
      meterTrack("agent", track.mediaStreamTrack);
    });

    room.on(LK.RoomEvent.DataReceived, (payload) => {
      try {
        handleEvent(JSON.parse(decoder.decode(payload)));
      } catch {}
    });

    room.on(LK.RoomEvent.Disconnected, () => stop());

    await room.connect(url, token);
    try {
      await room.localParticipant.setMicrophoneEnabled(true);
      const pub = room.localParticipant.getTrackPublication(LK.Track.Source.Microphone);
      meterTrack("mic", pub?.track?.mediaStreamTrack);
    } catch (err) {
      // No mic (denied / unavailable): stay in the session listen-only,
      // mirroring fish mode's ?nomic behavior.
      console.warn("[lk] mic unavailable, listen-only session", err);
    }

    connecting = false;
    running = true;
    ui.setOrb("listening");
  } catch (err) {
    console.error("[lk]", err);
    connecting = false;
    await stop();
  }
}

async function stop() {
  if (!running && !connecting) return;
  running = false;
  connecting = false;
  document.body.classList.add("idle");
  document.body.classList.remove("session-fullscreen");
  const r = room;
  room = null;
  stopMeters();
  try {
    await r?.disconnect();
  } catch {}
  for (const el of document.querySelectorAll("audio")) el.remove();
  setMuted(false);
  ui.hideLatency();
  ui.setOrb("idle");
  scene.agentLevel(0);
  scene.micLevel(0);
}

// --- agent data messages -------------------------------------------------------

function handleEvent(msg) {
  switch (msg.type) {
    case "agent_state":
      if (!running) break;
      // Agent states map 1:1 onto the orb states used by fish mode.
      if (msg.state === "speaking") ui.setOrb("speaking");
      else if (msg.state === "thinking") ui.setOrb("thinking");
      else ui.setOrb("listening");
      break;

    case "metrics":
      // Pipeline-internal view from the agent; the pill shows the ear-to-ear
      // measurement from the local meters instead (see meterTrack).
      console.log("[lk] agent pipeline metrics", msg);
      break;
  }
}

// --- wiring ----------------------------------------------------------------------

ui.els.orb.onclick = () => (running || connecting ? stop() : start());
ui.els.mute.onclick = () => {
  if (running || connecting) setMuted(!muted);
};
