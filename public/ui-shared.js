// Shared UI layer for the two transport apps (app.js = fish websocket,
// lk-app.js = LiveKit/WebRTC). Everything here is transport-agnostic —
// persona cards, orb + theme + mute presentation, the latency pill, the idle
// catalog boot, and the ear-to-ear voice→voice stopwatch — so each app file
// is only its transport.

import { createScene } from "/visual.js";
import { VOICE_METER } from "/config.js";

export const $ = (id) => document.getElementById(id);

export function createUI({ onPickPersona }) {
  const els = {
    orb: $("orb"),
    mute: $("mute"),
    muteLabel: $("mute-label"),
    personas: $("personas"),
    latency: $("latency"),
  };

  const scene = createScene($("scene"));
  window.__scene = scene; // console/test access

  const state = {
    catalog: { personas: [], voices: [] },
    personaId: "guide",
  };

  const personaByKey = () =>
    Object.fromEntries(state.catalog.personas.map((p) => [p.key, p]));

  function setOrb(s) {
    els.orb.className = s;
    els.orb.setAttribute("aria-label", s === "idle" ? "Start talking" : "Stop talking");
    scene.setState(s);
  }

  function applyTheme(p) {
    if (!p?.theme) return;
    document.documentElement.style.setProperty("--tint", p.theme.tint);
    document.documentElement.style.setProperty("--glow", p.theme.glow);
    scene.setTheme(p.theme.tint, p.theme.glow);
  }

  function renderPersonas() {
    els.personas.innerHTML = "";
    for (const p of state.catalog.personas) {
      const b = document.createElement("button");
      b.className = "persona" + (p.key === state.personaId ? " on" : "");
      b.setAttribute("aria-label", `${p.name} — ${p.tagline}`);
      b.setAttribute("aria-pressed", p.key === state.personaId ? "true" : "false");
      b.style.setProperty("--p-tint", p.theme.tint);
      b.innerHTML = `<span class="p-name">${p.name}</span><span class="p-tag">${p.tagline}</span>`;
      b.onclick = () => onPickPersona(p.key);
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

  // Presentation half of muting; the transport half (disabling the actual
  // track) stays in each app.
  function setMuteButton(muted) {
    els.mute.setAttribute("aria-pressed", String(muted));
    els.mute.setAttribute("aria-label", muted ? "Unmute microphone" : "Mute microphone");
    els.muteLabel.textContent = muted ? "Unmute" : "Mute";
    els.mute.classList.toggle("on", muted);
    if (muted) scene.micLevel(0);
  }

  function showLatency(text) {
    els.latency.textContent = text;
    els.latency.classList.add("show");
  }

  function hideLatency() {
    els.latency.classList.remove("show");
  }

  let personaFitFrame = 0;
  addEventListener("resize", () => {
    cancelAnimationFrame(personaFitFrame);
    personaFitFrame = requestAnimationFrame(fitPersonaLabels);
  });

  // Idle boot: render personas from the static catalog so the page is alive
  // before any connection; a live session's catalog wins if it arrives first.
  fetch("/catalog.json")
    .then((r) => r.json())
    .then((data) => {
      if (!data || state.catalog.personas.length) return;
      state.catalog = data;
      applyTheme(personaByKey()[state.personaId]);
      renderPersonas();
    })
    .catch(() => {});

  return {
    els,
    scene,
    state,
    personaByKey,
    setOrb,
    applyTheme,
    renderPersonas,
    setMuteButton,
    showLatency,
    hideLatency,
  };
}

// Ear-to-ear voice→voice stopwatch: last mic sample with voice energy → first
// audible agent sample after a quiet gap, all observed in this tab, so the
// number includes STT turn confirmation, both network legs, and playout
// buffering — what the user actually experiences. Feed NORMALIZED float RMS
// (0..1) from whatever sampler the transport uses; the shared gate keeps the
// two pages' numbers comparable.
export function createVoiceMeter(onReplyMs) {
  let lastMicVoiceWall = 0;
  let awaitingReply = false;
  let quietTicks = 99;
  let voicedTicks = 0;
  return {
    mic(rms) {
      if (rms > VOICE_METER.voiceRms) {
        voicedTicks++;
        lastMicVoiceWall = performance.now();
        if (voicedTicks >= VOICE_METER.armTicks) awaitingReply = true;
      } else {
        voicedTicks = 0;
      }
    },
    agent(rms) {
      if (rms > VOICE_METER.voiceRms) {
        if (quietTicks >= VOICE_METER.quietTicks && awaitingReply && lastMicVoiceWall) {
          awaitingReply = false;
          const ms = Math.round(performance.now() - lastMicVoiceWall);
          if (ms >= VOICE_METER.minPlausibleMs) onReplyMs(ms);
        }
        quietTicks = 0;
      } else {
        quietTicks++;
      }
    },
    reset() {
      lastMicVoiceWall = 0;
      awaitingReply = false;
      quietTicks = 99;
      voicedTicks = 0;
    },
  };
}
