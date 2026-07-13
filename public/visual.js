// Ambient scene: ink-in-water currents on Fish's warm paper, tinted by the
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

  const DPR = Math.min(devicePixelRatio || 1, 1.75);
  let W = 0, H = 0;            // canvas size in device px
  let orbX = 0, orbY = 0;      // energy source (the orb), device px

  // Colors, all as [r,g,b]; current values ease toward targets for the
  // persona crossfade.
  let tint = [13, 148, 136];
  let glow = [45, 212, 191];
  let tintTarget = tint, glowTarget = glow;
  let bg = [250, 248, 245];

  // Conversation energy (0..1), smoothed with fast attack / slow release.
  let agentE = 0, agentTarget = 0;
  let micE = 0, micTarget = 0;
  let live = false;

  const PARTICLES = 130;
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
  const rgba = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
  const lerp = (a, b, t) => a + (b - a) * t;
  const lerp3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

  function refreshBg() {
    bg = darkQuery.matches ? [15, 14, 13] : [250, 248, 245];
    ctx.fillStyle = rgba(bg, 1);
    ctx.fillRect(0, 0, W, H);
  }

  function updateGlowEl() {
    const inner = rgba(glow, darkQuery.matches ? 0.34 : 0.3);
    const mid = rgba(tint, darkQuery.matches ? 0.16 : 0.14);
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
    p.life = 140 + Math.random() * 240;
    p.jitter = 0.6 + Math.random() * 0.8;
    return p;
  }

  // Layered sines — a cheap, smoothly evolving flow field.
  function fieldAngle(x, y, t) {
    return (
      Math.sin(x * 0.0016 + t * 0.00019) +
      Math.cos(y * 0.0021 - t * 0.00013) +
      Math.sin((x + y) * 0.0009 + t * 0.00007)
    ) * Math.PI * 0.75;
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
    if (!document.hidden) requestAnimationFrame(frame);
  }

  function render(t) {
    // A page loaded in a hidden/zero-size tab has no dimensions yet.
    if (!W || !H) {
      if (!innerWidth || !innerHeight) return;
      resize();
    }

    // Ease colors and energy. The glow gradient follows the crossfade.
    if (Math.abs(tint[0] - tintTarget[0]) + Math.abs(tint[1] - tintTarget[1]) + Math.abs(tint[2] - tintTarget[2]) > 2) {
      updateGlowEl();
    }
    tint = lerp3(tint, tintTarget, 0.025);
    glow = lerp3(glow, glowTarget, 0.025);
    agentE = agentTarget > agentE ? lerp(agentE, agentTarget, 0.38) : lerp(agentE, agentTarget, 0.045);
    micE = micTarget > micE ? lerp(micE, micTarget, 0.5) : lerp(micE, micTarget, 0.08);
    micTarget *= 0.94; // mic reports are event-driven; decay between them

    // Fade previous frame into trails.
    ctx.fillStyle = rgba(bg, 0.055);
    ctx.fillRect(0, 0, W, H);

    // Ink filaments.
    const speed = (0.7 + agentE * 2.6 + micE * 0.7) * (live ? 1 : 0.6) * DPR;
    const alpha = (darkQuery.matches ? 0.14 : 0.12) + agentE * 0.12;
    ctx.lineWidth = DPR * (1.1 + agentE * 0.8);
    ctx.strokeStyle = rgba(tint, alpha);
    ctx.beginPath();
    for (const p of particles) {
      const a = fieldAngle(p.x, p.y, t);
      const vx = Math.cos(a) * speed * p.jitter;
      const vy = Math.sin(a) * speed * p.jitter;
      ctx.moveTo(p.x, p.y);
      p.x += vx;
      p.y += vy;
      ctx.lineTo(p.x, p.y);
      if (--p.life <= 0 || p.x < -20 || p.x > W + 20 || p.y < -20 || p.y > H + 20) spawn(p);
    }
    ctx.stroke();

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
      ctx.strokeStyle = rgba(tint, rp.a);
      ctx.lineWidth = DPR;
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
    const grad = ctx.createRadialGradient(W / 2, H * 0.75, 0, W / 2, H * 0.75, H * 0.7);
    grad.addColorStop(0, rgba(tint, 0.1));
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
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && !reduced) requestAnimationFrame(frame);
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
      live = state !== "idle";
      if (!live) agentTarget = 0;
    },
    agentLevel(v) {
      agentTarget = Math.max(0, Math.min(1, v));
    },
    micLevel(v) {
      micTarget = Math.max(micTarget, Math.min(1, v));
    },
    // Test hook: advance the scene manually (RAF is dead in headless panes).
    tick(t) {
      render(t);
    },
  };
}
