# fish-realtime

A [realtime.ai](https://realtime.ai)-style landing page for Fish Audio: land,
tap, talk. One Node process, no framework — the engine is a port of
[fish-bare-agent](https://github.com/cshape/fish-bare-agent) (WS transport)
with personas and in-conversation tools on top.

```
browser mic ── PCM16 @16k ──> server ──> Deepgram Flux    (STT + turn-taking)
                                │            │ EndOfTurn transcript
                                │            v
                                │         Gemma            (OpenAI-compatible, streamed)
                                │            │ tokens ─> directive filter ─> sentence chunker
                                │            v
browser spk <── PCM16 @24k ── server <── Fish TTS         (/v1/tts/live, one WS per voice segment)
```

## The product surface

- **Personas** (`personas.js`) — Guide / Companion / Narrator / Concierge, each
  with its own voice, system prompt, spoken greeting, and scene tint. They map
  to the target markets: companions, accessible/interactive content, customer
  service.
- **In-conversation tools** — the LLM emits inline tags (`[[voice:rhys]]`,
  `[[persona:narrator]]`); the server strips them from the stream and swaps
  the Fish voice **mid-reply** ("Sure — *[voice changes]* — how's this?").
  Later voice segments synthesize concurrently and are delivered in order.
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

Requires Node >= 20.6.

```sh
cp .env.example .env   # Deepgram + LLM + Fish keys
npm install
npm start              # http://localhost:8787
```

Headless end-to-end test (macOS, uses `say` as the mic) — covers greeting,
barge-in and the `[[voice:x]]` directive round-trip:

```sh
npm run smoke
```

`?nomic` runs a session without microphone capture for preview and development.

Voices are Fish reference IDs in `personas.js` — edit the catalog to recast.

## Notes

- Phone testing needs an HTTPS origin for the mic (e.g. `ngrok http 8787`).
- The browser throttles the continuously scheduled scene in hidden tabs; under
  `prefers-reduced-motion` it falls back to a static wash.
