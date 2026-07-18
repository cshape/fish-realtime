// Pixel webcam portrait driver: swaps pre-generated frames on one <img> to
// fake a live feed. Mouth follows the agent's audio level (energy-based
// lipsync — no phoneme data needed). The smile frame is only used OUTSIDE
// the live tile (the achievement toast) — freezing the tile on an
// expression mid-speech breaks the lipsync illusion.
//
// Frames come from /characters/<key>/manifest.json (see gen-portraits.js);
// load() resolves false when a character has no art yet so the caller can
// fall back to the text-only card.

const TICK_MS = 90; // mouth update rate — snappy but not strobing

export function createPortrait(img) {
  let frames = {}; // role -> preloaded Image
  let current = null;
  let talking = false;
  let level = 0; // latest agent audio level (rms*4 from player-worklet)
  let generation = 0; // invalidates loops/loads across character switches
  let tickTimer = 0;

  function show(role) {
    const frame = frames[role] ?? frames.neutral;
    if (!frame || role === current) return;
    img.src = frame.src;
    current = role;
  }

  // The same bucket logic portrait-test.html prototypes: pick a mouth frame
  // from the current audio level, with a dash of "oo" so it doesn't flap.
  function mouthRole() {
    if (level < 0.08) return "neutral";
    if (Math.random() < 0.18 && frames.mouthRound) return "mouthRound";
    if (level < 0.3) return "mouthSlight";
    if (level < 0.7) return "mouthOpen";
    return "mouthWide";
  }

  function tick() {
    show(talking ? mouthRole() : "neutral");
  }

  function stopLoops() {
    clearInterval(tickTimer);
    tickTimer = 0;
  }

  return {
    // Load a character's frames; resolves false if there's no art.
    async load(key) {
      const gen = ++generation;
      stopLoops();
      frames = {};
      current = null;
      level = 0;
      try {
        const res = await fetch(`/characters/${key}/manifest.json`, { cache: "no-store" });
        if (!res.ok) return false;
        const manifest = await res.json();
        const loaded = await Promise.all(
          Object.entries(manifest.frames).map(
            ([role, file]) =>
              new Promise((resolve) => {
                const im = new Image();
                im.onload = () => resolve([role, im]);
                im.onerror = () => resolve(null);
                im.src = `/characters/${key}/${file}`;
              }),
          ),
        );
        if (gen !== generation) return false; // superseded by a newer load
        frames = Object.fromEntries(loaded.filter(Boolean));
        if (!frames.neutral) return false;
        show("neutral");
        tickTimer = setInterval(tick, TICK_MS);
        return true;
      } catch {
        return false;
      }
    },

    level(v) {
      level = v;
    },

    talking(on) {
      talking = on;
      if (!on) level = 0;
    },

    reset() {
      generation++;
      stopLoops();
      frames = {};
      current = null;
    },
  };
}
