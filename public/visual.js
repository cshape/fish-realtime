import { VISUAL_CONFIG } from "/config.js";

// Ambient scene: pearlescent ink currents on Fish's warm paper, tinted by the
// active persona and driven by the conversation's audio.
//
//   - flow-field particles drift like ink filaments (always, slowly)
//   - the agent's voice radiates a glow from the orb (playback RMS)
//   - the user's voice sends thin rings out from the orb (mic RMS)
//
// Canvas 2D only — no WebGL, cheap enough for phones. Trails come from
// fading the frame with a translucent background fill.

export function createScene(canvas) {
  const ctx = canvas.getContext("2d");
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const darkQuery = matchMedia("(prefers-color-scheme: dark)");
  const isDark = () => false;

  const DPR = Math.min(devicePixelRatio || 1, 1.75);
  let W = 0, H = 0;            // canvas size in device px
  let orbX = 0, orbY = 0;      // energy source (the orb), device px

  // Colors, all as [r,g,b]; current values ease toward targets for the
  // persona crossfade.
  let tint = [42, 157, 144];
  let glow = [60, 203, 127];
  let tintTarget = tint, glowTarget = glow;
  let bg = [250, 248, 245];
  let paper = [253, 252, 252];
  let coral = [245, 97, 56];
  let lavender = [83, 177, 253];

  // Rollback switch: set false to restore persona-colored ribbons without
  // changing any state logic or palette code.
  const STATE_DRIVEN_RIBBONS = VISUAL_CONFIG.stateDrivenRibbons;
  const STATE_PALETTES = {
    connecting: [[83, 177, 253], [23, 92, 211], [83, 177, 253]],
    listening: [[60, 203, 127], [42, 157, 144], [60, 203, 127]],
    thinking: [[83, 177, 253], [23, 92, 211], [83, 177, 253]],
    speaking: [[244, 164, 98], [245, 97, 56], [231, 110, 80]],
  };
  let ribbonColors = [lavender.slice(), tint.slice(), coral.slice()];

  // Conversation energy (0..1), smoothed with fast attack / slow release.
  let agentE = 0, agentTarget = 0;
  let micE = 0, micTarget = 0;
  let live = false;
  let conversationState = "idle";

  const PARTICLES = 170;
  const particles = [];
  const ripples = [];
  let lastRipple = 0;

  // The glow layer is a DOM element (CSS radial gradient) so its per-frame
  // opacity never accumulates into the canvas trails.
  const glowEl = document.createElement("div");
  glowEl.id = "scene-glow";
  Object.assign(glowEl.style, {
    position: "fixed",
    left: "0", top: "0",
    width: "1200px", height: "1200px",
    marginLeft: "-600px", marginTop: "-600px",
    borderRadius: "50%",
    pointerEvents: "none",
    zIndex: "0",
    opacity: "0",
    willChange: "opacity, transform",
  });
  canvas.after(glowEl);

  function hex(c) {
    return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
  }
  const rgba = (c, a) => {
    const alpha = Number.isFinite(a) ? Math.max(0, Math.min(1, a)) : 0;
    return `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${alpha})`;
  };
  const lerp = (a, b, t) => a + (b - a) * t;
  const lerp3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

  function refreshBg() {
    bg = isDark() ? [15, 14, 13] : [250, 248, 245];
    paper = isDark() ? [26, 24, 22] : [253, 252, 252];
    const wash = ctx.createLinearGradient(0, 0, W, H);
    wash.addColorStop(0, rgba(paper, 1));
    wash.addColorStop(0.42, rgba(bg, 1));
    wash.addColorStop(1, isDark() ? "rgba(18,17,15,1)" : rgba(paper, 1));
    ctx.fillStyle = wash;
    ctx.fillRect(0, 0, W, H);
  }

  function updateGlowEl() {
    const inner = rgba(glow, isDark() ? 0.34 : 0.3);
    const mid = rgba(tint, isDark() ? 0.16 : 0.14);
    glowEl.style.background = `radial-gradient(circle, ${inner} 0%, ${mid} 30%, transparent 62%)`;
  }

  function resize() {
    W = Math.round(innerWidth * DPR);
    H = Math.round(innerHeight * DPR);
    canvas.width = W;
    canvas.height = H;
    const orb = document.getElementById("orb");
    if (orb) {
      const r = orb.getBoundingClientRect();
      orbX = (r.left + r.width / 2) * DPR;
      orbY = (r.top + r.height / 2) * DPR;
    } else {
      orbX = W / 2;
      orbY = H * 0.78;
    }
    glowEl.style.transform = `translate(${orbX / DPR}px, ${orbY / DPR}px) scale(0.8)`;
    refreshBg();
  }

  function spawn(p = {}) {
    p.x = Math.random() * W;
    p.y = Math.random() * H;
    p.life = 150 + Math.random() * 300;
    p.jitter = 0.45 + Math.random() * 1.25;
    p.tone = Math.random();
    return p;
  }

  // Layered sines — a cheap, smoothly evolving flow field.
  function fieldAngle(x, y, t) {
    return (
      Math.sin(x * 0.00125 + t * 0.00016) +
      Math.cos(y * 0.0018 - t * 0.00012) +
      Math.sin((x + y) * 0.0007 + t * 0.00007) +
      Math.cos((x - y) * 0.00085 - t * 0.00009) * 0.45
    ) * Math.PI * 0.68;
  }

  let lastFrame = 0;
  let lastGlowStyle = "";

  function frame(t) {
    // Idle scenes don't need 60 fps — halve the rate when nothing is hot.
    const calm = !live && agentE < 0.02 && micE < 0.02;
    if (calm && t - lastFrame < 30) {
      requestAnimationFrame(frame);
      return;
    }
    lastFrame = t;
    render(t);
    // Keep a frame scheduled at all times. Browsers already throttle RAF in
    // background tabs; conditionally dropping it here could permanently stop
    // the scene after a brief visibility transition.
    requestAnimationFrame(frame);
  }

  function render(t) {
    // A page loaded in a hidden/zero-size tab has no dimensions yet.
    if (!W || !H) {
      if (!innerWidth || !innerHeight) return;
      resize();
    }

    // Audio worklets can briefly report a non-finite RMS while their buffers
    // are being created or cleared. Recover here as a final guard so a single
    // bad sample can never poison the persistent render state.
    if (!Number.isFinite(agentE)) agentE = 0;
    if (!Number.isFinite(agentTarget)) agentTarget = 0;
    if (!Number.isFinite(micE)) micE = 0;
    if (!Number.isFinite(micTarget)) micTarget = 0;

    // Ease colors and energy. The glow gradient follows the crossfade.
    if (Math.abs(tint[0] - tintTarget[0]) + Math.abs(tint[1] - tintTarget[1]) + Math.abs(tint[2] - tintTarget[2]) > 2) {
      updateGlowEl();
    }
    tint = lerp3(tint, tintTarget, 0.025);
    glow = lerp3(glow, glowTarget, 0.025);
    agentE = agentTarget > agentE ? lerp(agentE, agentTarget, 0.38) : lerp(agentE, agentTarget, 0.045);
    micE = micTarget > micE ? lerp(micE, micTarget, 0.5) : lerp(micE, micTarget, 0.08);
    micTarget *= 0.94; // mic reports are event-driven; decay between them

    // Fade previous frame into trails, preserving a soft paper sheen.
    const veil = ctx.createLinearGradient(0, 0, W, H);
    veil.addColorStop(0, rgba(paper, darkQuery.matches ? 0.055 : 0.065));
    veil.addColorStop(0.55, rgba(bg, darkQuery.matches ? 0.052 : 0.058));
    veil.addColorStop(1, rgba(bg, darkQuery.matches ? 0.07 : 0.048));
    ctx.fillStyle = veil;
    ctx.fillRect(0, 0, W, H);

    // Broad translucent washes give the scene depth without adding DOM blobs.
    const aura = ctx.createRadialGradient(W * 0.5, H * 0.72, 0, W * 0.5, H * 0.72, H * 0.86);
    aura.addColorStop(0, rgba(glow, isDark() ? 0.028 + agentE * 0.05 : 0.038 + agentE * 0.05));
    aura.addColorStop(0.34, rgba(tint, isDark() ? 0.018 : 0.026));
    aura.addColorStop(1, rgba(tint, 0));
    ctx.fillStyle = aura;
    ctx.fillRect(0, 0, W, H);

    const sideWash = ctx.createLinearGradient(0, H * 0.18, W, H * 0.88);
    sideWash.addColorStop(0, rgba(coral, isDark() ? 0.012 : 0.025));
    sideWash.addColorStop(0.5, rgba(lavender, isDark() ? 0.012 : 0.02));
    sideWash.addColorStop(1, rgba(tint, isDark() ? 0.016 : 0.024));
    ctx.fillStyle = sideWash;
    ctx.fillRect(0, 0, W, H);

    // Ink filaments.
    const thinking = conversationState === "thinking" ? (0.55 + Math.sin(t * 0.004) * 0.2) : 0;
    const listening = conversationState === "listening" ? micE : 0;
    const speed = (0.62 + agentE * 2.4 + listening * 2.1 + thinking * 1.35) * (live ? 1 : 0.52) * DPR;
    const alpha = (isDark() ? 0.105 : 0.085) + agentE * 0.115;
    ctx.lineWidth = DPR * (0.9 + agentE * 0.75);
    ctx.beginPath();
    for (const p of particles) {
      const a = fieldAngle(p.x, p.y, t);
      const vx = Math.cos(a) * speed * p.jitter;
      const vy = Math.sin(a) * speed * p.jitter;
      const ink = p.tone < 0.68 ? tint : p.tone < 0.86 ? glow : (p.tone < 0.94 ? coral : lavender);
      ctx.strokeStyle = rgba(ink, alpha * (p.tone < 0.68 ? 1 : 0.55));
      ctx.moveTo(p.x, p.y);
      p.x += vx;
      p.y += vy;
      ctx.lineTo(p.x, p.y);
      if (--p.life <= 0 || p.x < -20 || p.x > W + 20 || p.y < -20 || p.y > H + 20) spawn(p);
      ctx.stroke();
      ctx.beginPath();
    }

    // The horizontal ribbons are the conversation UI. They are always in
    // motion while live; loudness changes their amplitude and a localized wave
    // packet visibly travels across the field while the agent is thinking.
    const ribbons = 3;
    const personaPalette = [lavender, tint, coral];
    const targetPalette = STATE_DRIVEN_RIBBONS && STATE_PALETTES[conversationState]
      ? STATE_PALETTES[conversationState]
      : personaPalette;
    ribbonColors = ribbonColors.map((color, i) => lerp3(color, targetPalette[i], 0.055));
    for (let r = 0; r < ribbons; r++) {
      const yBase = H * (0.48 + r * 0.08);
      const inputLift = listening * (82 + r * 18);
      const voiceLift = agentE * (72 + r * 14);
      const thoughtLift = thinking * (38 + r * 9);
      const amp = (18 + r * 10 + inputLift + voiceLift + thoughtLift) * DPR;
      const phaseSpeed = conversationState === "thinking" || conversationState === "connecting"
        ? 0.0031 + r * 0.00034
        : conversationState === "speaking"
          ? 0.0021 + r * 0.00028
          : 0.00145 + r * 0.00022;
      const travel = t * phaseSpeed;
      const packetX = ((t * 0.00028 + r * 0.13) % 1) * W;
      const packetWidth = W * 0.14;
      ctx.beginPath();
      for (let x = -20 * DPR; x <= W + 20 * DPR; x += 18 * DPR) {
        let y = yBase +
          Math.sin(x * (0.002 + r * 0.0004) + travel) * amp +
          Math.cos(x * (0.0013 + listening * 0.0012) - t * (0.00072 + listening * 0.0016)) * amp * 0.45;
        if (conversationState === "thinking" || conversationState === "connecting") {
          const distance = x - packetX;
          const envelope = Math.exp(-(distance * distance) / (2 * packetWidth * packetWidth));
          y += Math.sin(distance * 0.018 - t * 0.009 - r * 0.8) * envelope * (38 + r * 12) * DPR;
        }
        if (x < 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      const activeAlpha = listening * 0.28 + thinking * 0.14 + agentE * 0.2;
      const liveAlpha = live ? 0.075 : 0;
      ctx.strokeStyle = rgba(ribbonColors[r], (isDark() ? 0.035 : 0.05) + liveAlpha + activeAlpha);
      ctx.lineWidth = DPR * (1.2 + r * 0.65 + listening * 1.7 + agentE * 1.1 + thinking * 0.55);
      ctx.stroke();
    }

    // User rings from the orb.
    if (live && micE > 0.13 && t - lastRipple > 170) {
      lastRipple = t;
      ripples.push({ r: 30 * DPR, v: (1.6 + micE * 2.4) * DPR, a: 0.4 });
    }
    for (let i = ripples.length - 1; i >= 0; i--) {
      const rp = ripples[i];
      rp.r += rp.v;
      rp.a *= 0.972;
      if (rp.a < 0.01) {
        ripples.splice(i, 1);
        continue;
      }
      ctx.beginPath();
      ctx.strokeStyle = rgba(tint, rp.a * 0.82);
      ctx.lineWidth = DPR * 1.15;
      ctx.arc(orbX, orbY, rp.r, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Voice glow: scale + opacity ride the agent's level. Only touch style
    // when it meaningfully changed — style churn keeps the compositor busy.
    const g = Math.min(1, agentE * 1.6);
    const glowStyle = `${(g * 0.85).toFixed(2)}|${(0.55 + g * 0.65).toFixed(2)}`;
    if (glowStyle !== lastGlowStyle) {
      lastGlowStyle = glowStyle;
      glowEl.style.opacity = (g * 0.85).toFixed(2);
      glowEl.style.transform =
        `translate(${orbX / DPR}px, ${orbY / DPR}px) scale(${(0.55 + g * 0.65).toFixed(2)})`;
    }
  }

  // Static fallback: one quiet wash, no animation.
  function staticScene() {
    refreshBg();
    const grad = ctx.createRadialGradient(W / 2, H * 0.72, 0, W / 2, H * 0.72, H * 0.78);
    grad.addColorStop(0, rgba(glow, 0.09));
    grad.addColorStop(0.32, rgba(tint, 0.06));
    grad.addColorStop(1, rgba(tint, 0));
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
  }

  for (let i = 0; i < PARTICLES; i++) particles.push(spawn({}));
  addEventListener("resize", resize);
  darkQuery.addEventListener("change", () => {
    refreshBg();
    updateGlowEl();
    if (reduced) staticScene();
  });
  resize();
  updateGlowEl();
  if (reduced) staticScene();
  else requestAnimationFrame(frame);

  return {
    setTheme(tintHex, glowHex) {
      tintTarget = hex(tintHex);
      glowTarget = hex(glowHex);
      updateGlowEl();
      if (reduced) staticScene();
    },
    setState(state) {
      conversationState = state;
      live = state !== "idle";
      if (!live) agentTarget = 0;
    },
    agentLevel(v) {
      if (!Number.isFinite(v)) return;
      agentTarget = Math.max(0, Math.min(1, v * 3.5));
    },
    micLevel(v) {
      if (!Number.isFinite(v)) return;
      micTarget = Math.max(micTarget, Math.min(1, v * 2.2));
    },
    // Test hook: advance the scene manually (RAF is dead in headless panes).
    tick(t) {
      render(t);
    },
  };
}
