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
- **The page** (`public/`) — Fish Audio's design language (Onest, warm gray
  scale, light/dark) over an audio-reactive ink-in-water canvas: the agent's
  voice blooms from the orb, the user's voice sends out rings, the tint
  crossfades per persona. Zero chrome, mobile-first.
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
barge-in, the `[[voice:x]]` directive round-trip, and UI voice switching:

```sh
npm run smoke
```

`?nomic` runs a session without microphone capture (preview/dev: you hear the
agent and can drive personas/voices from the UI).

Voices are Fish reference IDs in `personas.js` — edit the catalog to recast.

## Notes

- Phone testing needs an HTTPS origin for the mic (e.g. `ngrok http 8787`).
- The scene pauses in hidden tabs (RAF) and falls back to a static wash under
  `prefers-reduced-motion`.
