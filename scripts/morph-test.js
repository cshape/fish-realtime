// Direct FishPipeline exercise — reproduces the mid-reply voice morph without
// Deepgram or the LLM. Mimics a directive turn exactly:
//
//   seg0 (marlowe): pre-tag sentences  ->  setVoice(rhys)  ->  seg1 sentences
//
// Reports the delivered-audio timeline (who/when/bytes) and compares total
// audio against single-voice baselines of the same text, so both symptoms are
// measurable: late switch (gap around the seam) and truncation (missing tail).
//
// Usage: FISH_DEBUG=1 node --env-file=.env scripts/morph-test.js

import { FishPipeline, TTS_SAMPLE_RATE } from "../tts.js";

const MARLOWE = "4501d82f5de3467ebf4d7ef095a2deee";
const RHYS = "43d0c55ea6814a9dab44a06ddfe03658";

const PRE = [
  "Of course, switching now. ",
  "Here it comes. ",
];
const POST = [
  "And this is the new voice speaking. ",
  "One. Two. Three. Four. Five. Six. Seven. Eight. Nine. Ten. ",
  "If you can hear every one of those numbers, nothing was truncated. ",
];

const secs = (bytes) => (bytes / 2 / TTS_SAMPLE_RATE).toFixed(2);

function run(label, fn) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    let bytes = 0;
    let lastAt = 0;
    const gaps = [];
    const pipe = new FishPipeline(fn.startVoice, {
      onAudio: (buf) => {
        const now = Date.now() - t0;
        if (lastAt && now - lastAt > 1500) gaps.push(`${lastAt}ms → ${now}ms`);
        lastAt = now;
        bytes += buf.length;
      },
      onFinish: () => {
        console.log(
          `[${label}] finish at ${Date.now() - t0}ms — ${bytes}B = ${secs(bytes)}s audio` +
          (gaps.length ? ` — delivery gaps: ${gaps.join(", ")}` : ""),
        );
        resolve(bytes);
      },
      onError: (err) => reject(new Error(`[${label}] ${err.message}`)),
    });
    fn.drive(pipe);
    setTimeout(() => reject(new Error(`[${label}] timed out (stuck pipeline)`)), 60000);
  });
}

const morphBytes = await run("morph", {
  startVoice: MARLOWE,
  drive(pipe) {
    for (const s of PRE) pipe.pushText(s);
    pipe.setVoice(RHYS);
    for (const s of POST) pipe.pushText(s);
    pipe.endInput();
  },
});

const preBytes = await run("solo:pre", {
  startVoice: MARLOWE,
  drive(pipe) {
    for (const s of PRE) pipe.pushText(s);
    pipe.endInput();
  },
});

const postBytes = await run("solo:post", {
  startVoice: RHYS,
  drive(pipe) {
    for (const s of POST) pipe.pushText(s);
    pipe.endInput();
  },
});

const expected = preBytes + postBytes;
const ratio = morphBytes / expected;
console.log(`\n[compare] morph ${secs(morphBytes)}s vs solo-sum ${secs(expected)}s (ratio ${ratio.toFixed(2)})`);
if (ratio < 0.85) {
  console.error("[compare] FAIL: morphed run lost audio (truncation)");
  process.exit(1);
}
console.log("[compare] PASS");
process.exit(0);
