// LiveKit-mode browser app (/lk). Same UI as app.js, different transport:
// the browser joins a LiveKit room over WebRTC, the agent (lk-agent.js) is
// dispatched into it, and UI state + latency metrics arrive as reliable data
// messages from the agent. Uses the livekit-client UMD bundle (global
// `LivekitClient`), served at /vendor/livekit-client.umd.js.

import { createScene } from "/visual.js";

const LK = window.LivekitClient;
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

let room = null;
let running = false;
let connecting = false;
let muted = false;

let catalog = { personas: [], voices: [] };
let personaId = "guide";
const mobilePersonaQuery = matchMedia("(max-width: 820px)");

const personaByKey = () => Object.fromEntries(catalog.personas.map((p) => [p.key, p]));

const BOOT = fetch("/catalog.json").then((r) => r.json()).catch(() => null);

// --- ui helpers ----------------------------------------------------------------

function setOrb(state) {
  els.orb.className = state;
  els.orb.setAttribute("aria-label", state === "idle" ? "Start talking" : "Stop talking");
  scene.setState(state);
}

function setMuted(next) {
  muted = next;
  room?.localParticipant.setMicrophoneEnabled(!muted).catch(() => {});
  els.mute.setAttribute("aria-pressed", String(muted));
  els.mute.setAttribute("aria-label", muted ? "Unmute microphone" : "Mute microphone");
  els.muteLabel.textContent = muted ? "Unmute" : "Mute";
  els.mute.classList.toggle("on", muted);
  if (muted) scene.micLevel(0);
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
    label.style.fontSize = "";
    if (label.scrollWidth <= label.clientWidth) continue;
    const naturalSize = Number.parseFloat(getComputedStyle(label).fontSize);
    const fittedSize = naturalSize * (label.clientWidth / label.scrollWidth) * 0.97;
    label.style.fontSize = `${Math.max(28, fittedSize).toFixed(2)}px`;
  }
}

function pickPersona(key) {
  const wasSelected = key === personaId;
  personaId = key;
  applyTheme(personaByKey()[key]);
  renderPersonas();
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
    els.latency.textContent = "livekit-client failed to load";
    els.latency.classList.add("show");
    return;
  }
  connecting = true;
  setMuted(false);
  document.body.classList.remove("idle");
  document.body.classList.add("session-fullscreen");
  setOrb("connecting");

  try {
    const res = await fetch(`/lk-token?persona=${encodeURIComponent(personaId)}`);
    if (!res.ok) throw new Error(`token: ${res.status}`);
    const { url, token } = await res.json();

    room = new LK.Room({
      audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
    });

    room.on(LK.RoomEvent.TrackSubscribed, (track) => {
      if (track.kind !== "audio") return;
      const el = track.attach();
      el.style.display = "none";
      document.body.appendChild(el);
    });

    room.on(LK.RoomEvent.DataReceived, (payload) => {
      try {
        handleEvent(JSON.parse(new TextDecoder().decode(payload)));
      } catch {}
    });

    // Drive the ambient scene from LiveKit's speaker levels.
    room.on(LK.RoomEvent.ActiveSpeakersChanged, (speakers) => {
      let mic = 0;
      let agent = 0;
      for (const s of speakers) {
        if (s === room.localParticipant) mic = s.audioLevel;
        else agent = s.audioLevel;
      }
      scene.micLevel(muted ? 0 : Math.min(1, mic * 2.5));
      scene.agentLevel(Math.min(1, agent * 2.5));
    });

    room.on(LK.RoomEvent.Disconnected, () => stop());

    await room.connect(url, token);
    try {
      await room.localParticipant.setMicrophoneEnabled(true);
    } catch (err) {
      // No mic (denied / unavailable): stay in the session listen-only,
      // mirroring fish mode's ?nomic behavior.
      console.warn("[lk] mic unavailable, listen-only session", err);
    }

    connecting = false;
    running = true;
    setOrb("listening");
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
  try {
    await r?.disconnect();
  } catch {}
  for (const el of document.querySelectorAll("audio")) el.remove();
  setMuted(false);
  els.latency.classList.remove("show");
  setOrb("idle");
  scene.agentLevel(0);
  scene.micLevel(0);
}

// --- agent data messages -------------------------------------------------------

function handleEvent(msg) {
  switch (msg.type) {
    case "agent_state":
      if (!running) break;
      // Agent states map 1:1 onto the orb states used by fish mode.
      if (msg.state === "speaking") setOrb("speaking");
      else if (msg.state === "thinking") setOrb("thinking");
      else setOrb("listening");
      break;

    case "metrics":
      if (msg.total != null) {
        els.latency.textContent = `voice → voice ${msg.total} ms`;
        els.latency.classList.add("show");
      }
      break;
  }
}

// --- wiring ----------------------------------------------------------------------

els.orb.onclick = () => (running || connecting ? stop() : start());
els.mute.onclick = () => {
  if (!running) return;
  setMuted(!muted);
};
addEventListener("resize", () => requestAnimationFrame(fitPersonaLabels));

BOOT.then((data) => {
  if (!data || catalog.personas.length) return;
  catalog = data;
  const first = personaByKey()[personaId];
  applyTheme(first);
  renderPersonas();
});
