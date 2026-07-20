# fish-realtime

A [realtime.ai](https://realtime.ai)-style landing page for Fish Audio: land,
tap, talk. One Node process, no framework — the engine is a port of
[fish-bare-agent](https://github.com/cshape/fish-bare-agent) (WS transport)
with personas on top.

```
browser mic ── PCM16 @16k ──> server ──> Deepgram Flux    (STT + turn-taking)
                                │            │ EndOfTurn transcript
                                │            v
                                │         Gemma            (OpenAI-compatible, streamed)
                                │            │ tokens ─> sentence chunker
                                │            v
browser spk <── PCM16 @24k ── server <── Fish TTS         (/v1/tts/live, one WS per turn)
```

## The product surface

- **Personas** (`personas.js`) — Guide / Companion / Salesperson / Concierge,
  each with its own voice, system prompt, spoken greeting, and scene tint.
  They map to the target markets: product education, companions, sales,
  customer service. All are privately named "Fish" and know they're AIs
  powered by Fish Audio.
- **The page** (`public/`) — Fish Audio's design language (Onest, canonical
  warm-gray scale) over an audio-reactive canvas. Horizontal ribbons use
  state-driven Fish colors for listening, thinking, and speaking. The live
  surface is text-free and mobile-first.
- **Inactivity handling** (`public/config.js`) — after 10 seconds without
  confirmed user speech, the active persona checks in naturally. At 30 seconds
  the browser ends the conversation. The same client-safe config module holds
  shared audio and visual settings; provider credentials remain in `.env`.
- Barge-in, echo suppression, and speculative (eager) generation are inherited
  from fish-bare-agent and always on.

## Run it

Requires Node >= 20.12.

```sh
cp .env.example .env   # Deepgram + LLM + Fish keys
npm install
npm start              # http://localhost:8787
```

Headless end-to-end test (macOS, uses `say` as the mic) — covers the greeting
and barge-in:

```sh
npm run smoke
```

`?nomic` runs a session without microphone capture for preview and development.

Voices are Fish reference IDs in `personas.js` — edit the catalog to recast.

## Notes

- Phone testing needs an HTTPS origin for the mic (e.g. `ngrok http 8787`).
- The browser throttles the continuously scheduled scene in hidden tabs; under
  `prefers-reduced-motion` it falls back to a static wash.

## Deploy it anywhere

One stateless Node process — no framework, no database, no build step. It
serves the static pages, the `/ws` audio websocket, and `/feedback` from the
same port.

```sh
npm ci --omit=dev      # `patches/` must be present: postinstall runs patch-package
node server.js         # binds $PORT (default 8787)
```

Config comes from the environment. `npm start` reads a local `.env` *only if
one exists*, so platform-injected env vars (k8s secrets, systemd, ECS task
definitions) work with no file on disk. See `.env.example` for the full set —
`DEEPGRAM_API_KEY`, `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, and
`FISH_API_KEY` are the required five; everything else has a default.

What the platform has to give you:

- **Websocket upgrades on `/ws`.** The proxy/ingress must pass `Upgrade` through
  and must not buffer the connection — audio is streamed both ways in small
  PCM chunks (32ms up from the mic). Response buffering is the usual cause of
  "it connects but the voice is late or chunky."
- **TLS at the edge.** The process speaks plain HTTP; terminate upstream. The
  browser needs a secure context for `getUserMedia`, so mic capture will not
  work over plain HTTP from any origin except `localhost`.
- **Generous idle timeouts.** A conversation holds one websocket open for its
  whole life. A 30–60s idle timeout on the proxy will cut calls mid-sentence.
- **Outbound network** to Deepgram, your LLM endpoint, and Fish Audio.

Two things to get right in production:

- **Do not set `TEXT_INPUT`.** It enables typed turn injection and disables the
  inactivity timers — dev only.
- **`data/*.jsonl` is written to the instance disk** next to the app (see
  `datalog.js`). If that disk is ephemeral, set `LOG_EVENTS_STDOUT=1` so every
  event is mirrored to stdout and your log pipeline becomes the durable copy;
  otherwise mount something persistent at `data/`. Transcripts and submitted
  emails land here, so treat it as user data and give it a retention policy.

`render.yaml` is a working example of the above (Render Blueprint, the config
this was first deployed with) — useful as a reference for env wiring even if
you deploy elsewhere. `Dockerfile` builds the **LiveKit worker only**, not the
web server; the web server needs no Docker, but it containerizes with a stock
`node:22-slim` + `npm ci --omit=dev` + `node server.js` if you want an image.

## Roulette (`/roulette`)

An elegant chatroulette on the same engine: you're connected to a random
character (all 18+, English), talk about anything, and either side can end
it — you with **Next**, the character by hanging up on rudeness or
relentless boredom (a `[[kick]]` tag the LLM emits, stripped before TTS).

- **Cast** (`characters.js`) — ten characters, each with a life, a
  personality, a voice, and one **hidden achievement** (`[[achievement]]`
  tag) the caller can unlock — e.g. ask Rosa about her grandkids for
  *Respect Your Elders*. Unlocks pop a toast and can be claimed (email →
  Fish credits) via the feedback sheet. Placeholder writing; recast freely.
- **Penny for your thoughts** — a feedback button that fades in from
  near-transparent to fully visible over five minutes of talking (instantly
  on an achievement). Posts to `/feedback`.
- **Data** (`datalog.js` → `data/*.jsonl`, gitignored) — full transcripts,
  skips, kicks, achievements, session lifecycle in `roulette-YYYY-MM-DD.jsonl`;
  emails and feedback in `feedback-YYYY-MM-DD.jsonl`.

**Pixel webcam portraits** — each character appears as a 160×120 pixel-art
"webcam feed" (static background, animated face) with energy-based lipsync
driven by the agent audio level: four mouth shapes + neutral, and a smile
flash on achievements. Frames are generated by `scripts/gen-portraits.js`
(gpt-image-2: one base portrait at 1024×768, then per-region edits — masked
for mouths, maskless + self-composited for expressions — downscaled
nearest-neighbor; needs `OPENAI_API_KEY`):

```sh
npm run portraits -- rosa               # regenerate one character (~7 images)
npm run portraits -- rosa --post-only   # re-derive 160x120 from saved full-res
```

Frames land in `public/characters/<key>/` (committed); full-res
intermediates in `portraits-src/` (gitignored). Characters without frames
fall back to a text-only card. Review pages: `/portrait-review.html` (all
characters, all frames) and `/portrait-test.html?c=<key>` (animated tile).

Dev/testing without a mic: run `npm run start:dev` (sets `TEXT_INPUT=1`) and
open `/roulette?nomic&typed` — a text box injects typed caller turns and
inactivity timers are disabled. Tests:

```sh
npm run smoke:roulette   # structural: start -> greet -> turn -> skip -> feedback
npm run probe:roulette   # behavioral: does the achievement fire? does it kick?
```

## LiveKit mode (`/lk`)

The same demo served over WebRTC via [LiveKit Agents](https://docs.livekit.io/agents/):

- STT Deepgram Flux via the `deepgram` JS plugin (direct `DEEPGRAM_API_KEY`,
  not the inference gateway — the extra hop cost ~1.5s of turn latency);
  thresholds tuned aggressive (eot 0.6, eager 0.4)
- LLM `google/gemma-4-31b-it` via LiveKit Inference
- TTS `fishaudio` JS plugin (direct `FISH_API_KEY`, not the inference
  gateway) with the same voice reference ids from `personas.js` — patched via
  `patches/` with livekit/agents-js#2033 so audio streams from the opening
  chunk (crackle-free, same behavior as the Python plugin)

The worker (`lk-agent.js`) is HOSTED ON LIVEKIT CLOUD — deploy updates with
`lk agent deploy` (config in `livekit.toml`, image from `Dockerfile`, secrets:
`FISH_API_KEY`, `DEEPGRAM_API_KEY`). The web service only needs `LIVEKIT_URL` /
`LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` to mint tokens for `/lk`. For local
agent dev run the server with `LK_AGENT_LOCAL=1 LK_AGENT_NAME=fish-lk-dev` so
the dev worker never collides with the deployed one. Persona is chosen at join
(dispatch metadata); switching personas mid-session starts a fresh room.

Latency: both modes show the same ear-to-ear voice→voice pill, measured in the
browser (`ui-shared.js`) — last mic frame with voice energy → first audible
reply from the speaker — so it includes STT turn confirmation, both network
legs, and playout buffering. Pipeline-internal breakdowns log to the console
(fish: server `metrics` message; /lk: agent data message + `lk agent logs`).
