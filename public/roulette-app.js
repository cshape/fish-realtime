// fish-roulette browser app: same transport as app.js (mic -> WS PCM16 @
// 16 kHz, WS -> speaker PCM16 @ 24 kHz), different product — a roulette of
// characters. You get a random stranger; either side can end it. Standalone
// on purpose: ui-shared.js is persona-rail shaped, so this page keeps its
// own small UI layer on top of the shared scene + worklets.

import { AUDIO_CONFIG, INACTIVITY_CONFIG } from "/config.js";
import { createScene } from "/visual.js";
import { createVoiceMeter } from "/ui-shared.js";
import { createPortrait } from "/portrait.js";

// ?typed — dev mode: a text box injects typed turns (server needs
// TEXT_INPUT=1) and the inactivity timers are off so slow typing doesn't
// end the session. Pairs with ?nomic for fully mic-free character testing.
const TYPED_MODE = new URLSearchParams(location.search).has("typed");

const $ = (id) => document.getElementById(id);
const els = {
  orb: $("orb"),
  mute: $("mute"),
  muteLabel: $("mute-label"),
  next: $("next"),
  start: $("start"),
  latency: $("latency"),
  who: $("who"),
  whoCam: $("who-cam"),
  whoName: document.querySelector("#who .who-name"),
  whoMeta: document.querySelector("#who .who-meta"),
  whoTag: document.querySelector("#who .who-tag"),
  veil: $("veil"),
  veilTitle: $("veil-title"),
  veilSub: $("veil-sub"),
  cast: $("cast"),
  achProgress: $("ach-progress"),
  toast: $("toast"),
  toastCam: $("toast-cam"),
  toastName: $("toast-name"),
  toastSub: $("toast-sub"),
  toastClaim: $("toast-claim"),
  toastLater: $("toast-later"),
  penny: $("penny"),
  sheet: $("sheet"),
  sheetTitle: $("sheet-title"),
  sheetSub: $("sheet-sub"),
  fbText: $("fb-text"),
  fbEmail: $("fb-email"),
  fbSend: $("fb-send"),
  fbClose: $("fb-close"),
  sheetDone: $("sheet-done"),
  typed: $("typed"),
  typedText: $("typed-text"),
};

const scene = createScene($("scene"));
window.__scene = scene; // console/test access
const portrait = createPortrait(els.whoCam);

// --- state -------------------------------------------------------------------

let ws = null;
let inCtx = null;
let outCtx = null;
let player = null;
let micStream = null;
let running = false;
let connecting = false;
let muted = false;

let sid = null;
let character = null; // { key, name, age, location, tagline, theme }
let agentSpeaking = false;
let userTurnActive = false;
let switching = false; // veil is up, waiting on the next character
let pendingKick = null; // character name; transition once playback drains
let pendingEnd = null; // character name; agent hung up (idle) — teardown after drain
let endFallbackTimer = 0; // hard stop if the goodbye never arrives
let endTransitionTimer = 0; // scheduled stop after the "hung up" veil

// A Next click (or a fresh character) proves the caller is still there:
// cancel any in-progress idle teardown so it can't kill the new call.
function cancelIdleTeardown() {
  pendingEnd = null;
  clearTimeout(endTransitionTimer);
  clearTimeout(endFallbackTimer);
  endTransitionTimer = endFallbackTimer = 0;
}
let lastAchievement = null; // { id, name, character } for the claim sheet
let sheetMode = "feedback"; // "feedback" | "claim"
let inactivityNudgeTimer = 0;
let inactivityDisconnectTimer = 0;

// --- small ui helpers -----------------------------------------------------------

function setOrb(state) {
  els.orb.className = state;
  scene.setState(state);
}

function applyTheme(theme) {
  if (!theme) return;
  document.documentElement.style.setProperty("--tint", theme.tint);
  document.documentElement.style.setProperty("--glow", theme.glow);
  scene.setTheme(theme.tint, theme.glow);
}

function setMuted(next) {
  muted = next;
  micStream?.getAudioTracks().forEach((track) => { track.enabled = !muted; });
  els.mute.setAttribute("aria-pressed", String(muted));
  els.muteLabel.textContent = muted ? "Unmute" : "Mute";
  els.mute.classList.toggle("on", muted);
  if (muted) scene.micLevel(0);
}

function showLatency(text) {
  els.latency.textContent = text;
  els.latency.classList.add("show");
}

const meter = createVoiceMeter((ms) => showLatency(`voice → voice ${ms} ms`));

function showVeil(title, sub = "") {
  els.veilTitle.textContent = title;
  els.veilSub.textContent = sub;
  els.veil.classList.remove("hidden", "off");
}

function hideVeil() {
  els.veil.classList.add("off");
}

function renderCharacter(c) {
  els.whoName.textContent = c.name;
  els.whoMeta.textContent = `${c.age} · ${c.location}`;
  els.whoTag.textContent = c.tagline;
  els.who.classList.remove("hidden");
  // Retrigger the entrance animation on every new character.
  els.who.style.animation = "none";
  void els.who.offsetWidth;
  els.who.style.animation = "";
}

// --- achievement progress (per browser, survives sessions) -------------------

const ACH_KEY = "fish-roulette-achievements";
let castTotal = 0;

function unlockedAchievements() {
  try {
    return JSON.parse(localStorage.getItem(ACH_KEY)) ?? {};
  } catch {
    return {};
  }
}

function renderProgress(bump = false) {
  const n = Object.keys(unlockedAchievements()).length;
  if (!n || !castTotal) return;
  els.achProgress.innerHTML = `<span class="star">✦</span> ${Math.min(n, castTotal)}/${castTotal} unlocked`;
  els.achProgress.classList.remove("hidden");
  if (bump) {
    els.achProgress.classList.remove("bump");
    void els.achProgress.offsetWidth;
    els.achProgress.classList.add("bump");
  }
}

function recordAchievement(id) {
  const all = unlockedAchievements();
  if (all[id]) return renderProgress();
  all[id] = true;
  try {
    localStorage.setItem(ACH_KEY, JSON.stringify(all));
  } catch {}
  renderProgress(true);
}

let toastTimer = 0;
function hideToast() {
  clearTimeout(toastTimer);
  els.toast.classList.add("hidden");
  els.who.classList.remove("celebrating");
}

function showToast(name, characterName) {
  // The celebration takes the card's spot; the card steps aside entirely
  // (no half-overlap), and returns when the toast goes.
  els.who.classList.add("celebrating");
  els.toastName.textContent = `“${name}”`;
  els.toastSub.textContent = `${characterName} is impressed. Leave an email to claim your free Fish credits.`;
  // The character's smiling face, if their art exists.
  els.toastCam.classList.add("missing");
  if (character) {
    els.toastCam.onload = () => els.toastCam.classList.remove("missing");
    els.toastCam.src = `/characters/${character.key}/f7.png`;
  }
  els.toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 18_000);
}

// Landing teaser: the cast's faces, shuffled, no names.
fetch("/cast.json")
  .then((r) => r.json())
  .then(({ cast }) => {
    castTotal = cast.length;
    renderProgress();
    for (const key of cast.sort(() => Math.random() - 0.5)) {
      const img = new Image();
      img.src = `/characters/${key}/f1.png`;
      img.alt = "";
      els.cast.appendChild(img);
    }
  })
  .catch(() => {});

// --- penny for your thoughts ------------------------------------------------------

function surfacePenny() {
  if (!els.penny.classList.contains("hidden")) return;
  els.penny.classList.remove("hidden");
  // Two frames so the browser paints the 0.12 state before the 5-minute
  // opacity transition to 1 begins.
  requestAnimationFrame(() => requestAnimationFrame(() => els.penny.classList.add("fading")));
}

function openSheet(mode) {
  sheetMode = mode;
  if (mode === "claim" && lastAchievement) {
    els.sheetTitle.textContent = "Claim your Fish credits";
    els.sheetSub.textContent =
      `You unlocked “${lastAchievement.name}” with ${lastAchievement.character}. ` +
      "Leave your email and we'll send your credits.";
  } else {
    els.sheetTitle.textContent = "Penny for your thoughts?";
    els.sheetSub.textContent = "What felt good? What felt off?";
  }
  els.sheetDone.classList.add("hidden");
  els.fbSend.disabled = false;
  els.sheet.classList.remove("hidden");
  els.fbText.focus();
}

function closeSheet() {
  els.sheet.classList.add("hidden");
}

async function sendFeedback() {
  const text = els.fbText.value.trim();
  const email = els.fbEmail.value.trim();
  if (!text && !email) return;
  els.fbSend.disabled = true;
  try {
    await fetch("/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sid,
        character: character?.key ?? "",
        email,
        text,
        kind: sheetMode === "claim" ? "achievement_claim" : "feedback",
        achievement: sheetMode === "claim" ? lastAchievement?.id ?? "" : "",
      }),
    });
    els.fbText.value = "";
    els.sheetDone.classList.remove("hidden");
    setTimeout(closeSheet, 1600);
  } catch {
    els.fbSend.disabled = false;
  }
}

// --- inactivity (same contract as app.js) ------------------------------------------

function clearInactivityTimers() {
  clearTimeout(inactivityNudgeTimer);
  clearTimeout(inactivityDisconnectTimer);
  inactivityNudgeTimer = 0;
  inactivityDisconnectTimer = 0;
}

function tryInactivityNudge() {
  if (!running || switching || pendingKick) return;
  const busy = userTurnActive || agentSpeaking || els.orb.className === "thinking" || els.orb.className === "connecting";
  if (busy) {
    inactivityNudgeTimer = setTimeout(tryInactivityNudge, INACTIVITY_CONFIG.busyRetryMs);
    return;
  }
  send({ type: "inactivity_nudge" });
  inactivityNudgeTimer = 0;
}

function tryInactivityDisconnect() {
  if (!running || switching || pendingKick || pendingEnd) return;
  if (userTurnActive) {
    inactivityDisconnectTimer = setTimeout(tryInactivityDisconnect, INACTIVITY_CONFIG.busyRetryMs);
    return;
  }
  // Ask the character to hang up in character; if the goodbye never lands
  // (error, dead connection), hard-stop anyway.
  send({ type: "end_call" });
  clearTimeout(endFallbackTimer);
  endFallbackTimer = setTimeout(() => { if (running) stop(); }, 20_000);
}

function resetInactivityTimers() {
  clearInactivityTimers();
  if (!running || TYPED_MODE) return;
  inactivityNudgeTimer = setTimeout(tryInactivityNudge, INACTIVITY_CONFIG.nudgeAfterMs);
  inactivityDisconnectTimer = setTimeout(tryInactivityDisconnect, INACTIVITY_CONFIG.disconnectAfterMs);
}

// --- audio -----------------------------------------------------------------------

async function initAudio() {
  if (micStream) {
    inCtx = new AudioContext({ sampleRate: AUDIO_CONFIG.inputSampleRate });
    await inCtx.audioWorklet.addModule("/mic-worklet.js");
    const src = inCtx.createMediaStreamSource(micStream);
    const mic = new AudioWorkletNode(inCtx, "mic-capture");
    src.connect(mic);
    mic.port.onmessage = (e) => {
      const pcm = e.data;
      if (!muted && ws?.readyState === WebSocket.OPEN) ws.send(pcm.buffer);
      let sum = 0;
      for (let i = 0; i < pcm.length; i += 4) sum += pcm[i] * pcm[i];
      if (pcm.length) {
        const rms = Math.sqrt(sum / Math.ceil(pcm.length / 4));
        scene.micLevel(Math.min(1, rms / AUDIO_CONFIG.micLevelReference));
        if (!muted) meter.mic(rms / 32768);
      }
    };
  }

  outCtx = new AudioContext({ sampleRate: AUDIO_CONFIG.outputSampleRate });
  await outCtx.audioWorklet.addModule("/player-worklet.js");
  player = new AudioWorkletNode(outCtx, "pcm-player");
  player.connect(outCtx.destination);
  player.port.onmessage = (e) => {
    if (e.data.level !== undefined) {
      scene.agentLevel(e.data.level);
      meter.agent(e.data.level / 4);
      portrait.level(e.data.level);
      return;
    }
    const wasSpeaking = agentSpeaking;
    agentSpeaking = e.data.playing;
    portrait.talking(agentSpeaking);
    els.whoCam.classList.toggle("talking", agentSpeaking);
    if (!running) return;
    if (!switching) setOrb(agentSpeaking ? "speaking" : "listening");
    if (agentSpeaking) {
      clearTimeout(inactivityNudgeTimer);
      inactivityNudgeTimer = 0;
    } else if (wasSpeaking) {
      // A goodbye just finished playing — now transition.
      if (pendingKick) {
        finishKickTransition();
        return;
      }
      if (pendingEnd) {
        finishEndTransition();
        return;
      }
      clearTimeout(inactivityNudgeTimer);
      inactivityNudgeTimer = setTimeout(tryInactivityNudge, INACTIVITY_CONFIG.nudgeAfterMs);
    }
  };
}

function send(obj) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function setDuck(on) {
  player?.port.postMessage({ cmd: "gain", value: on ? 0.15 : 1 });
}

// --- roulette flow ------------------------------------------------------------------

function nextCharacter(reason) {
  if (switching) return;
  switching = true;
  showVeil(reason === "post_kick" ? "Finding someone nicer…" : "Finding someone new…");
  send({ type: "roulette_next", reason: reason === "post_kick" ? "post_kick" : "skip" });
  // Failsafe: if the new character never arrives (hiccup, dropped message),
  // release the guard so Next can be pressed again instead of dying silently.
  setTimeout(() => { switching = false; }, 10_000);
}

function finishKickTransition() {
  const name = pendingKick;
  pendingKick = null;
  switching = true;
  showVeil(`${name} ended the chat`, "Some strangers are like that. Spinning again…");
  setTimeout(() => {
    switching = false;
    nextCharacter("post_kick");
  }, 2400);
}

// Idle hang-up: unlike a kick, don't spin to someone new — the caller is
// gone. Show the goodbye, then return to the landing.
function finishEndTransition() {
  const name = pendingEnd;
  pendingEnd = null;
  showVeil(`${name} hung up`, "You went quiet, so they said goodbye.");
  clearTimeout(endTransitionTimer);
  endTransitionTimer = setTimeout(() => { if (running) stop(); }, 2600);
}

// --- session ---------------------------------------------------------------------------

async function start() {
  if (running || connecting) return;
  connecting = true;
  setMuted(false);
  document.body.classList.remove("ru-idle");
  document.body.classList.add("session-fullscreen");
  setOrb("connecting");
  showVeil("Connecting…");
  const noMic = new URLSearchParams(location.search).has("nomic");
  try {
    if (!noMic) {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { ...AUDIO_CONFIG.captureConstraints },
      });
    }
  } catch {
    connecting = false;
    leaveSession();
    return;
  }

  await initAudio();
  if (noMic) {
    const silence = new ArrayBuffer(1024);
    const tick = setInterval(() => {
      if (!ws || ws.readyState > WebSocket.OPEN) clearInterval(tick);
      else if (ws.readyState === WebSocket.OPEN) ws.send(silence);
    }, 32);
  }
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.binaryType = "arraybuffer";
  ws.onmessage = (e) => {
    if (e.data instanceof ArrayBuffer) {
      player?.port.postMessage(new Int16Array(e.data), [e.data]);
      return;
    }
    handleEvent(JSON.parse(e.data));
  };
  ws.onclose = stop;
  ws.onerror = stop;
}

function leaveSession() {
  document.body.classList.add("ru-idle");
  document.body.classList.remove("session-fullscreen");
  portrait.reset();
  els.whoCam.classList.add("hidden");
  els.whoCam.classList.remove("talking");
  els.who.classList.add("hidden");
  els.veil.classList.add("hidden");
  els.toast.classList.add("hidden");
  meter.reset();
  els.latency.classList.remove("show");
  setOrb("idle");
  scene.agentLevel(0);
  scene.micLevel(0);
}

function stop() {
  if (!running && !connecting) return;
  clearInactivityTimers();
  cancelIdleTeardown();
  running = false;
  connecting = false;
  switching = false;
  pendingKick = null;
  ws?.close();
  ws = null;
  micStream?.getTracks().forEach((t) => t.stop());
  inCtx?.close();
  outCtx?.close();
  inCtx = outCtx = player = micStream = null;
  agentSpeaking = false;
  userTurnActive = false;
  character = null;
  setMuted(false);
  leaveSession();
}

function handleEvent(msg) {
  switch (msg.type) {
    case "session":
      sid = msg.sid;
      break;

    case "ready":
      connecting = false;
      running = true;
      switching = true; // veil stays until the first character lands
      send({ type: "roulette_start" });
      resetInactivityTimers();
      break;

    case "character":
      character = msg.character;
      switching = false;
      pendingKick = null;
      cancelIdleTeardown(); // a live character defuses any scheduled stop
      applyTheme(character.theme);
      renderCharacter(character);
      // Webcam bubble if this character has generated frames; text card if not.
      els.whoCam.classList.add("hidden");
      portrait.load(character.key).then((ok) => {
        if (ok && character === msg.character) els.whoCam.classList.remove("hidden");
      });
      hideVeil();
      setOrb("listening");
      surfacePenny();
      resetInactivityTimers();
      break;

    case "kicked":
      // The goodbye line may still be playing; transition when it drains.
      clearInactivityTimers();
      pendingKick = msg.character ?? "They";
      if (!agentSpeaking) {
        setTimeout(() => { if (pendingKick) finishKickTransition(); }, 800);
      }
      break;

    case "call_ended":
      // The agent hung up on an idle caller — same drain-then-transition
      // dance as a kick, but the session ends instead of respinning.
      // (A Next click during any of this cancels the teardown and respins.)
      clearInactivityTimers();
      clearTimeout(endFallbackTimer);
      endFallbackTimer = setTimeout(() => { if (running) stop(); }, 20_000);
      pendingEnd = msg.character ?? "They";
      if (!agentSpeaking) {
        setTimeout(() => { if (pendingEnd) finishEndTransition(); }, 800);
      }
      break;

    case "achievement":
      // The toast shows the smiling frame; the live tile keeps lipsyncing.
      lastAchievement = { id: msg.id, name: msg.name, character: msg.character };
      showToast(msg.name, msg.character);
      els.penny.classList.add("lit");
      recordAchievement(msg.id);
      break;

    case "user_start":
      userTurnActive = true;
      if (!switching) setOrb("listening");
      break;

    case "user_final":
      userTurnActive = false;
      if (!switching && !pendingKick) setOrb("thinking");
      resetInactivityTimers();
      break;

    case "duck":
      setDuck(true);
      break;

    case "unduck":
      setDuck(false);
      break;

    case "clear":
      player?.port.postMessage({ cmd: "clear" });
      setDuck(false);
      break;

    case "inactivity_nudge_deferred":
      if (running && !inactivityNudgeTimer) {
        inactivityNudgeTimer = setTimeout(tryInactivityNudge, INACTIVITY_CONFIG.busyRetryMs);
      }
      break;

    case "inactivity_nudge_started":
      if (running && !switching) setOrb("thinking");
      break;

    case "echo_suppressed":
      userTurnActive = false;
      break;

    case "metrics":
      console.log("[fish] server pipeline metrics", msg);
      break;

    case "stt_closed":
      if (running) stop();
      break;
  }
}

// --- wiring --------------------------------------------------------------------------------

els.start.onclick = start;
els.orb.onclick = () => (running || connecting ? stop() : start());
els.mute.onclick = () => { if (running || connecting) setMuted(!muted); };
els.next.onclick = () => {
  if (!running || pendingKick) return;
  // Clicking Next mid-hang-up means "I'm still here — someone new please":
  // cancel the idle teardown so it can't kill the fresh call.
  if (pendingEnd || endTransitionTimer) cancelIdleTeardown();
  nextCharacter("skip");
};
els.penny.onclick = () => openSheet(lastAchievement ? "claim" : "feedback");
els.toastClaim.onclick = () => {
  hideToast();
  openSheet("claim");
};
els.toastLater.onclick = hideToast;
els.fbSend.onclick = sendFeedback;
els.fbClose.onclick = closeSheet;
els.sheet.onclick = (e) => { if (e.target === els.sheet) closeSheet(); };

if (TYPED_MODE) {
  els.typed.classList.remove("hidden");
  els.typed.onsubmit = (e) => {
    e.preventDefault();
    const text = els.typedText.value.trim();
    if (!text || !running) return;
    send({ type: "text_input", text });
    els.typedText.value = "";
  };
}
