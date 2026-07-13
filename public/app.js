// fish-realtime browser app: mic -> WS (PCM16 @ 16 kHz), WS -> speaker
// (PCM16 @ 24 kHz), JSON events for captions/personas/tools, and hooks into
// the ambient scene (visual.js).

import { createScene } from "/visual.js";

const $ = (id) => document.getElementById(id);

const els = {
  hero: $("hero"),
  captions: $("captions"),
  userLine: $("user-line"),
  agentLine: $("agent-line"),
  orb: $("orb"),
  icMic: $("ic-mic"),
  icStop: $("ic-stop"),
  status: $("status"),
  personas: $("personas"),
  voiceChip: $("voice-chip"),
  voiceChipName: $("voice-chip-name"),
  voiceSheet: $("voice-sheet"),
  voiceGrid: $("voice-grid"),
  aboutSheet: $("about-sheet"),
  aboutLink: $("about-link"),
  latency: $("latency"),
  toast: $("toast"),
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

let catalog = { personas: [], voices: [] };
let personaId = "guide";
let voiceId = null;
let pendingPersona = null; // chosen while idle; applied on start
let agentSpeaking = false;
let agentInterrupted = false;
let toastTimer = null;

const personaByKey = () => Object.fromEntries(catalog.personas.map((p) => [p.key, p]));
const voiceByKey = () => Object.fromEntries(catalog.voices.map((v) => [v.key, v]));

// Personas are known before the first connection so the idle page can render
// them; the server's session message is the source of truth once connected.
const BOOT = fetch("/catalog.json").then((r) => r.json()).catch(() => null);

// --- ui helpers ----------------------------------------------------------------

function setStatus(text) {
  els.status.textContent = text;
}

function setOrb(state) {
  els.orb.className = state;
  els.icMic.classList.toggle("hidden", state !== "idle" && state !== "connecting");
  els.icStop.classList.toggle("hidden", state === "idle" || state === "connecting");
  scene.setState(state);
}

function applyTheme(p) {
  if (!p?.theme) return;
  document.documentElement.style.setProperty("--tint", p.theme.tint);
  document.documentElement.style.setProperty("--glow", p.theme.glow);
  scene.setTheme(p.theme.tint, p.theme.glow);
}

function toast(text) {
  clearTimeout(toastTimer);
  els.toast.innerHTML = `<span class="t-dot"></span>${text}`;
  els.toast.classList.remove("hidden", "bye");
  toastTimer = setTimeout(() => {
    els.toast.classList.add("bye");
    toastTimer = setTimeout(() => els.toast.classList.add("hidden"), 320);
  }, 2400);
}

function renderPersonas() {
  els.personas.innerHTML = "";
  for (const p of catalog.personas) {
    const b = document.createElement("button");
    b.className = "persona" + (p.key === personaId ? " on" : "");
    b.setAttribute("aria-label", `${p.name} — ${p.tagline}`);
    b.style.setProperty("--p-tint", p.theme.tint);
    b.innerHTML = `<span class="p-name">${p.name}</span><span class="p-tag">${p.tagline}</span>`;
    b.onclick = () => pickPersona(p.key);
    els.personas.appendChild(b);
  }
}

function renderVoiceState() {
  const v = voiceByKey()[voiceId];
  els.voiceChipName.textContent = v ? v.name : "Voice";
  for (const card of els.voiceGrid.children) {
    card.classList.toggle("on", card.dataset.key === voiceId);
  }
}

function renderVoiceGrid() {
  els.voiceGrid.innerHTML = "";
  for (const v of catalog.voices) {
    const b = document.createElement("button");
    b.className = "voice-card" + (v.key === voiceId ? " on" : "");
    b.dataset.key = v.key;
    b.innerHTML = `<span class="v-name">${v.name}</span><span class="v-meta">${v.gender} · ${v.accent}</span>`;
    b.onclick = () => {
      closeSheets();
      if (v.key === voiceId) return;
      send({ type: "set_voice", id: v.key });
    };
    els.voiceGrid.appendChild(b);
  }
}

function pickPersona(key) {
  if (running || connecting) {
    if (key !== personaId) send({ type: "set_persona", id: key });
  } else {
    pendingPersona = key;
    personaId = key;
    applyTheme(personaByKey()[key]);
    renderPersonas();
    start();
  }
}

function closeSheets() {
  els.voiceSheet.classList.add("hidden");
  els.aboutSheet.classList.add("hidden");
}

// --- captions --------------------------------------------------------------------

function showCaptions() {
  els.hero.classList.add("hidden");
  els.captions.classList.remove("hidden");
}

function showHero() {
  els.captions.classList.add("hidden");
  els.hero.classList.remove("hidden");
  els.userLine.textContent = "";
  els.agentLine.textContent = "";
}

function setUserLine(text, cls = "") {
  els.userLine.textContent = text;
  els.userLine.className = cls;
}

function beginAgentUtterance() {
  els.agentLine.textContent = "";
  els.agentLine.classList.remove("interrupted");
  agentInterrupted = false;
}

// --- audio ------------------------------------------------------------------------

async function initAudio() {
  if (micStream) {
    // Capture context pinned to 16 kHz (the browser resamples the mic for us).
    inCtx = new AudioContext({ sampleRate: 16000 });
    await inCtx.audioWorklet.addModule("/mic-worklet.js");
    const src = inCtx.createMediaStreamSource(micStream);
    const mic = new AudioWorkletNode(inCtx, "mic-capture");
    src.connect(mic);
    mic.port.onmessage = (e) => {
      const pcm = e.data; // Int16Array, 32 ms
      if (ws?.readyState === WebSocket.OPEN) ws.send(pcm.buffer);
      // Mic energy feeds the scene's ripples.
      let sum = 0;
      for (let i = 0; i < pcm.length; i += 4) sum += pcm[i] * pcm[i];
      scene.micLevel(Math.min(1, Math.sqrt(sum / (pcm.length / 4)) / 6000));
    };
  }

  // Playback context pinned to Fish's 24 kHz output.
  outCtx = new AudioContext({ sampleRate: 24000 });
  await outCtx.audioWorklet.addModule("/player-worklet.js");
  player = new AudioWorkletNode(outCtx, "pcm-player");
  player.connect(outCtx.destination);
  player.port.onmessage = (e) => {
    if (e.data.level !== undefined) {
      scene.agentLevel(e.data.level);
      return;
    }
    agentSpeaking = e.data.playing;
    if (running) setOrb(agentSpeaking ? "speaking" : "listening");
    if (running && !agentSpeaking) setStatus("listening");
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
  setOrb("connecting");
  setStatus("requesting microphone…");
  // ?nomic — dev/preview mode: run the session without capture (you hear the
  // agent and can drive personas/voices from the UI, it just can't hear you).
  const noMic = new URLSearchParams(location.search).has("nomic");
  try {
    if (!noMic) {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
      });
    }
  } catch {
    connecting = false;
    setOrb("idle");
    setStatus("microphone permission needed");
    return;
  }

  await initAudio();
  if (noMic) {
    // Keep Deepgram's socket alive with silence so the session doesn't idle out.
    const silence = new ArrayBuffer(1024);
    const tick = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(silence);
      else clearInterval(tick);
    }, 32);
  }
  setStatus("connecting…");

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
  ws.onclose = () => stop("tap to start again");
  ws.onerror = () => stop("connection error — tap to retry");
}

function stop(reason) {
  if (!running && !connecting) return;
  running = false;
  connecting = false;
  ws?.close();
  ws = null;
  micStream?.getTracks().forEach((t) => t.stop());
  inCtx?.close();
  outCtx?.close();
  inCtx = outCtx = player = micStream = null;
  agentSpeaking = false;
  pendingPersona = null;
  showHero();
  els.voiceChip.classList.add("hidden");
  els.latency.classList.remove("show");
  setOrb("idle");
  setStatus(reason || "tap to start talking");
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
      renderVoiceGrid();
      renderVoiceState();
      break;

    case "ready": {
      connecting = false;
      running = true;
      els.voiceChip.classList.remove("hidden");
      showCaptions();
      setOrb("listening");
      setStatus("listening");
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
      renderVoiceState();
      // A UI-driven switch is followed by a fresh spoken line — clear the stage.
      setUserLine("");
      beginAgentUtterance();
      break;
    }

    case "tool": {
      const v = voiceByKey()[msg.voice];
      if (msg.tool === "change_persona") {
        personaId = msg.persona;
        voiceId = msg.voice;
        const p = personaByKey()[personaId];
        applyTheme(p);
        renderPersonas();
        renderVoiceState();
        toast(`${p?.name ?? msg.persona} takes over`);
      } else if (msg.tool === "change_voice") {
        voiceId = msg.voice;
        renderVoiceState();
        toast(`Voice → ${v?.name ?? msg.voice}`);
      }
      break;
    }

    case "user_start":
      setUserLine("", "partial");
      break;

    case "user_partial":
      setUserLine(msg.text, "partial");
      break;

    case "user_final":
      setUserLine(msg.text);
      beginAgentUtterance();
      setOrb("thinking");
      setStatus("thinking…");
      break;

    case "agent_text":
      if (agentInterrupted) beginAgentUtterance();
      els.agentLine.textContent += msg.text;
      break;

    case "duck":
      setDuck(true);
      break;

    case "unduck":
      setDuck(false);
      break;

    case "clear":
      // "clear" also arrives as a safety flush on ordinary turn starts; only
      // mark the reply interrupted if it was audibly cut off.
      if (agentSpeaking) {
        els.agentLine.classList.add("interrupted");
        agentInterrupted = true;
      }
      player?.port.postMessage({ cmd: "clear" });
      setDuck(false);
      break;

    case "agent_done":
      break;

    case "echo_suppressed":
      setUserLine(msg.text, "echo");
      break;

    case "metrics":
      if (msg.total != null) {
        els.latency.textContent = `voice → voice ${msg.total} ms`;
        els.latency.classList.add("show");
      }
      break;

    case "error":
      setStatus(msg.message || "error");
      break;

    case "stt_closed":
      if (running) stop("connection lost — tap to retry");
      break;
  }
}

// --- wiring -------------------------------------------------------------------------

els.orb.onclick = () => (running || connecting ? stop() : start());
els.voiceChip.onclick = () => els.voiceSheet.classList.remove("hidden");
els.aboutLink.onclick = () => els.aboutSheet.classList.remove("hidden");
for (const sheet of [els.voiceSheet, els.aboutSheet]) {
  sheet.querySelector("[data-close]").onclick = closeSheets;
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeSheets();
});

// Idle boot: render personas from the static catalog so the page is alive
// before any connection.
BOOT.then((data) => {
  if (!data || catalog.personas.length) return;
  catalog = data;
  const first = personaByKey()[personaId];
  applyTheme(first);
  renderPersonas();
  renderVoiceGrid();
});
