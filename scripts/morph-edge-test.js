// Edge-case probes for the voice-morph pipeline — reproduces the failure
// shapes seen in real sessions (double directives, whitespace-only segments).
//
// Usage: FISH_DEBUG=1 node --env-file=.env scripts/morph-edge-test.js

import { FishPipeline, TTS_SAMPLE_RATE } from "../tts.js";

const MARLOWE = "4501d82f5de3467ebf4d7ef095a2deee";
const RHYS = "43d0c55ea6814a9dab44a06ddfe03658";
const BRIONY = "10b2254869cf4340bdb801928e2fc88e";

const secs = (bytes) => (bytes / 2 / TTS_SAMPLE_RATE).toFixed(2);

function scenario(label, drive) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let bytes = 0;
    const errors = [];
    const done = (how) => {
      console.log(
        `[${label}] ${how} at ${Date.now() - t0}ms — ${secs(bytes)}s audio` +
        (errors.length ? ` — errors: ${errors.join(" | ")}` : ""),
      );
      resolve({ bytes, errors });
    };
    const pipe = new FishPipeline(MARLOWE, {
      onAudio: (buf) => (bytes += buf.length),
      onFinish: () => done("finish"),
      onError: (err) => errors.push(err.message),
    });
    drive(pipe);
    setTimeout(() => done("TIMEOUT"), 30000);
  });
}

// 1. Whitespace-only text lands in the post-switch segment before real text.
await scenario("ws-between-tags", (p) => {
  p.pushText("Switching twice now. ");
  p.setVoice(RHYS);
  p.pushText(" "); // what chunker.flush() yields between adjacent tags
  p.setVoice(BRIONY);
  p.pushText("Did I survive the double switch? ");
  p.endInput();
});

// 2. Whitespace-only FINAL segment (tag at the very end of the reply).
await scenario("ws-final-segment", (p) => {
  p.pushText("The tag came last. ");
  p.setVoice(RHYS);
  p.pushText("\n");
  p.endInput();
});

// 3. Newline-run chunk first into a fresh segment (chunker emits "\n\n").
await scenario("newline-first", (p) => {
  p.pushText("Before the tag. ");
  p.setVoice(BRIONY);
  p.pushText("\n\n");
  p.pushText("After a blank line, more speech. ");
  p.endInput();
});

// 4. Rapid double switch with NO text between (segment dropped path).
await scenario("empty-mid-segment", (p) => {
  p.pushText("Watch this. ");
  p.setVoice(RHYS);
  p.setVoice(BRIONY);
  p.pushText("Straight to the third voice. ");
  p.endInput();
});

process.exit(0);
