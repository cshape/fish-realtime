// Pixel webcam portraits for the roulette cast — gpt-image-2 pipeline.
//
// Per character:
//   1. Generate ONE base portrait (1024x768, pixel-art webcam framing).
//   2. Ask a vision model for mouth / eyes / head bounding boxes.
//   3. images/edits with alpha masks over those boxes -> 7 variant frames
//      (mouth positions, blink, smile, look-away). Outside the mask the
//      pixels are untouched, which is what keeps the background static.
//   4. Nearest-neighbor downscale everything to 80x60 -> public/characters/.
//
// Full-res intermediates land in portraits-src/<key>/ (gitignored) so
// frames can be re-derived without re-spending on generation.
//
// Usage:
//   npm run portraits -- rosa              # full pipeline
//   npm run portraits -- rosa --from-base  # reuse existing base.png
//   npm run portraits -- rosa --post-only  # only redo the downscale step
//
// Needs OPENAI_API_KEY in .env (script runs with --env-file).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { CHARACTERS } from "../characters.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://api.openai.com/v1";
const KEY = process.env.OPENAI_API_KEY;
if (!KEY) {
  console.error("Missing OPENAI_API_KEY (run via: npm run portraits -- <key>)");
  process.exit(1);
}

const IMAGE_MODEL = process.env.IMAGE_MODEL || "gpt-image-2";
const VISION_MODEL = process.env.VISION_MODEL || "gpt-4o";
const GEN_W = 1024;
const GEN_H = 768;
const OUT_W = 160;
const OUT_H = 120;

// Scene direction per character; anything missing falls back to the tagline.
const SCENES = {
  rosa:
    "a warm, cluttered Texan kitchen at golden hour — papel picado banners, " +
    "a simmering pot on the stove behind her, a small TV glowing with a " +
    "telenovela, family photos on the wall",
  earl: "the wheelhouse of an old shrimp boat at dawn, nets and rigging visible through the window behind him, warm sunrise light",
  maddie: "a movie theater lobby at night, neon marquee glow, a popcorn machine behind her",
  jojo:
    "a dim comedy-club corner with a brick wall and a lone stage light. She " +
    "is a young Black woman with a big warm grin, braids, and a wing-spot " +
    "uniform shirt",
  viktor: "the driver's seat of a Chicago cab at night, city lights bokeh through the windshield behind him, a tiny chess piece on the dash",
  dex: "a cramped bedroom studio at night lit by LED strips, a mixing controller and headphones behind him",
  priya: "a hospital staff break room under fluorescent light, a giant mug of tea in front of her, lanyard and scrubs",
  agnes: "a sunny Irish convent garden with white beehives and rolling green hills behind her",
  tunde: "a bright London coworking space, laptop covered in startup stickers, whiteboard with arrows behind him",
  colette: "a moody jazz bar after closing, upturned chairs on tables, a double bass and warm stage lamp behind her",
};

// The 7 derived frames. mode "mask": images/edits with an alpha mask —
// reliable for small regions (mouths). mode "composite": maskless full-image
// edit (the model blends with full context), then WE paste only the region
// back onto the base — larger regions (eyes, whole face) fail with masks
// (the model sometimes fills them with black or redraws identity details),
// and self-compositing guarantees the background stays pixel-identical.
const FRAMES = [
  { file: "f2", region: "mouth", mode: "mask", prompt: "Open the mouth slightly, as if speaking quietly mid-word." },
  { file: "f3", region: "mouth", mode: "mask", prompt: "Open the mouth clearly, as if speaking normally mid-word." },
  { file: "f4", region: "mouth", mode: "mask", prompt: "Open the mouth wide, as if speaking loudly or laughing mid-word." },
  { file: "f5", region: "mouth", mode: "mask", prompt: "Round the mouth into a small 'oo' shape, as if mid-word saying 'oh'." },
  { file: "f7", region: "face", mode: "composite", prompt: "A big warm delighted smile, eyes bright and crinkled, genuinely happy." },
  // f6 (blink) and f8 (look-away) were cut: gpt-image-2 fails them too often
  // (won't close eyes, or repaints the region). Frame numbers are kept
  // stable so existing character folders stay valid.
];

// mask mode: the API only repaints inside our mask, so lean on preservation.
const MASK_SUFFIX =
  " Reproduce the image otherwise EXACTLY: same chunky retro pixel-art " +
  "style, same limited palette, same person with the same glasses, hair, " +
  "jewelry, and clothing, same lighting, and the background completely " +
  "unchanged. No text.";

// composite mode: WE paste only the target region back onto the base, so
// preservation outside the face costs nothing — stress the change instead
// (an over-strong "exactly the same" makes the model return a near-copy).
const COMPOSITE_SUFFIX =
  " Apply that one change clearly and visibly. Keep the same person, the " +
  "same chunky retro pixel-art style and palette, the same glasses, hair, " +
  "and clothing. No text.";

function basePrompt(c) {
  const scene = SCENES[c.key] ?? c.tagline;
  return (
    `Retro pixel art, chunky low-resolution video-game style, limited warm ` +
    `palette of about 24 colors, crisp large pixels, no anti-aliasing, no ` +
    `text. A webcam-style portrait: head and shoulders of ${c.name}, ` +
    `${c.age} years old, from ${c.location} — ${c.tagline}. Framed like a ` +
    `laptop webcam feed, face centered in the upper half of the image, ` +
    `mouth closed in a relaxed neutral expression, looking straight at the ` +
    `camera. Background: ${scene}. The background should read clearly but ` +
    `stay softer than the face.`
  );
}

// Retries: 429s (rate limits) and 5xx/network errors back off and retry;
// other 4xx (bad request, moderation) fail immediately. FormData bodies are
// rebuilt per attempt via a factory, since a FormData can't be re-sent.
const BACKOFF_MS = [2000, 5000, 15000, 30000, 60000, 90000];

async function api(pathname, makeBody) {
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      const body = typeof makeBody === "function" ? makeBody() : makeBody;
      res = await fetch(`${API}${pathname}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${KEY}`,
          ...(body instanceof FormData ? {} : { "Content-Type": "application/json" }),
        },
        body: body instanceof FormData ? body : JSON.stringify(body),
      });
    } catch (err) {
      if (attempt >= BACKOFF_MS.length) throw err;
      console.warn(`[portraits] ${pathname} network error (${err.message}); retry in ${BACKOFF_MS[attempt] / 1000}s`);
      await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt]));
      continue;
    }
    if (res.ok) return res.json();
    const text = (await res.text()).slice(0, 500);
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= BACKOFF_MS.length) {
      throw new Error(`${pathname} -> ${res.status}: ${text}`);
    }
    console.warn(`[portraits] ${pathname} -> ${res.status}; retry in ${BACKOFF_MS[attempt] / 1000}s`);
    await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt]));
  }
}

function imageFromResponse(json) {
  const b64 = json.data?.[0]?.b64_json;
  if (!b64) throw new Error(`no b64_json in response: ${JSON.stringify(json).slice(0, 300)}`);
  return Buffer.from(b64, "base64");
}

async function generateBase(c) {
  console.log(`[portraits] generating base portrait for ${c.name}…`);
  const json = await api("/images/generations", {
    model: IMAGE_MODEL,
    prompt: basePrompt(c),
    size: `${GEN_W}x${GEN_H}`,
    quality: "high",
  });
  return imageFromResponse(json);
}

// Vision pass: normalized bounding boxes for the editable regions.
async function detectRegions(basePng) {
  console.log("[portraits] locating mouth / eyes / head…");
  const json = await api("/chat/completions", {
    model: VISION_MODEL,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "This is a pixel-art portrait. Return STRICT JSON only, no " +
              "fences: bounding boxes normalized 0-1 as " +
              '{"mouth":{"x":..,"y":..,"w":..,"h":..},"eyes":{...},"head":{...}}. ' +
              "x,y is the top-left corner. mouth = just the mouth; eyes = " +
              "both eyes in one box; head = the entire head including hair.",
          },
          {
            type: "image_url",
            image_url: { url: `data:image/png;base64,${basePng.toString("base64")}` },
          },
        ],
      },
    ],
  });
  const text = json.choices[0].message.content.replace(/```json|```/g, "").trim();
  const boxes = JSON.parse(text);
  for (const k of ["mouth", "eyes", "head"]) {
    const b = boxes[k];
    if (!b || [b.x, b.y, b.w, b.h].some((v) => typeof v !== "number")) {
      throw new Error(`vision returned bad box for ${k}: ${text}`);
    }
  }
  console.log("[portraits] boxes:", JSON.stringify(boxes));
  return boxes;
}

// Padded pixel rect from a normalized box.
function boxToRect(box, padFrac) {
  const px = Math.round(box.w * GEN_W * padFrac);
  const py = Math.round(box.h * GEN_H * padFrac);
  const x0 = Math.max(0, Math.round(box.x * GEN_W) - px);
  const y0 = Math.max(0, Math.round(box.y * GEN_H) - py);
  const x1 = Math.min(GEN_W, Math.round((box.x + box.w) * GEN_W) + px);
  const y1 = Math.min(GEN_H, Math.round((box.y + box.h) * GEN_H) + py);
  return { left: x0, top: y0, width: x1 - x0, height: y1 - y0 };
}

function unionRect(a, b) {
  const left = Math.min(a.left, b.left);
  const top = Math.min(a.top, b.top);
  return {
    left,
    top,
    width: Math.max(a.left + a.width, b.left + b.width) - left,
    height: Math.max(a.top + a.height, b.top + b.height) - top,
  };
}

// Mask PNG: opaque everywhere, TRANSPARENT inside the rect (the transparent
// area is what the edit endpoint is allowed to change).
async function buildMask(rect) {
  const raw = Buffer.alloc(GEN_W * GEN_H * 4);
  for (let y = 0; y < GEN_H; y++) {
    for (let x = 0; x < GEN_W; x++) {
      const i = (y * GEN_W + x) * 4;
      const inside =
        x >= rect.left && x < rect.left + rect.width && y >= rect.top && y < rect.top + rect.height;
      raw[i + 3] = inside ? 0 : 255; // alpha only; rgb stays black
    }
  }
  return sharp(raw, { raw: { width: GEN_W, height: GEN_H, channels: 4 } }).png().toBuffer();
}

async function editFrame(basePng, prompt, maskPng = null) {
  const json = await api("/images/edits", () => {
    const fd = new FormData();
    fd.append("model", IMAGE_MODEL);
    fd.append("image", new Blob([basePng], { type: "image/png" }), "base.png");
    if (maskPng) fd.append("mask", new Blob([maskPng], { type: "image/png" }), "mask.png");
    fd.append("prompt", prompt + (maskPng ? MASK_SUFFIX : COMPOSITE_SUFFIX));
    fd.append("size", `${GEN_W}x${GEN_H}`);
    fd.append("quality", "high");
    return fd;
  });
  return imageFromResponse(json);
}

// Paste only `rect` of the edited image onto the base — everything outside
// the region is guaranteed byte-identical to the base frame.
async function compositeRegion(basePng, editPng, rect) {
  const patch = await sharp(editPng)
    .resize(GEN_W, GEN_H, { fit: "fill" }) // guard against size drift
    .extract(rect)
    .png()
    .toBuffer();
  return sharp(basePng)
    .composite([{ input: patch, left: rect.left, top: rect.top }])
    .png()
    .toBuffer();
}

async function downscale(srcPng) {
  return sharp(srcPng).resize(OUT_W, OUT_H, { kernel: "nearest" }).png().toBuffer();
}

// ---------------------------------------------------------------------------

const key = process.argv[2];
const flags = new Set(process.argv.slice(3));
const c = CHARACTERS[key];
if (!c) {
  console.error(`Unknown character "${key}". One of: ${Object.keys(CHARACTERS).join(", ")}`);
  process.exit(1);
}

const srcDir = path.join(ROOT, "portraits-src", key);
const outDir = path.join(ROOT, "public", "characters", key);
fs.mkdirSync(srcDir, { recursive: true });
fs.mkdirSync(outDir, { recursive: true });

const basePath = path.join(srcDir, "f1.png");

let basePng;
if (flags.has("--from-base") || flags.has("--post-only")) {
  basePng = fs.readFileSync(basePath);
  console.log("[portraits] reusing existing base.png");
} else {
  basePng = await generateBase(c);
  fs.writeFileSync(basePath, basePng);
  console.log(`[portraits] base saved -> ${path.relative(ROOT, basePath)}`);
}

// --only=f6,f7 limits which derived frames are (re)generated.
const only = [...flags].find((f) => f.startsWith("--only="))?.slice(7).split(",");

if (!flags.has("--post-only")) {
  const boxes = await detectRegions(basePng);
  const rects = {
    mouth: boxToRect(boxes.mouth, 0.45),
    eyes: boxToRect(boxes.eyes, 0.35),
  };
  rects.face = unionRect(boxToRect(boxes.mouth, 0.9), boxToRect(boxes.eyes, 0.6));
  for (const f of FRAMES) {
    const outPath = path.join(srcDir, `${f.file}.png`);
    if (only && !only.includes(f.file)) continue;
    if (flags.has("--missing-only") && fs.existsSync(outPath)) continue;
    console.log(`[portraits] edit ${f.file} (${f.region}/${f.mode}): ${f.prompt}`);
    const rect = rects[f.region];
    let frame;
    if (f.mode === "mask") {
      frame = await editFrame(basePng, f.prompt, await buildMask(rect));
    } else {
      frame = await compositeRegion(basePng, await editFrame(basePng, f.prompt), rect);
    }
    fs.writeFileSync(outPath, frame);
  }
}

// Post: downscale every full-res frame to the pixel grid + write manifest.
const roles = {
  f1: "neutral",
  f2: "mouthSlight",
  f3: "mouthOpen",
  f4: "mouthWide",
  f5: "mouthRound",
  f7: "smile",
};
const frames = {};
for (const [file, role] of Object.entries(roles)) {
  const src = path.join(srcDir, `${file}.png`);
  if (!fs.existsSync(src)) {
    console.warn(`[portraits] missing ${file}.png — skipping ${role}`);
    continue;
  }
  fs.writeFileSync(path.join(outDir, `${file}.png`), await downscale(fs.readFileSync(src)));
  frames[role] = `${file}.png`;
}
fs.writeFileSync(
  path.join(outDir, "manifest.json"),
  JSON.stringify({ key, size: [OUT_W, OUT_H], frames }, null, 2) + "\n",
);
console.log(`[portraits] ${Object.keys(frames).length} frames -> ${path.relative(ROOT, outDir)}/ (${OUT_W}x${OUT_H})`);
