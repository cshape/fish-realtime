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

## LiveKit mode (`/lk`)

The same demo served over WebRTC via [LiveKit Agents](https://docs.livekit.io/agents/),
with every model running through LiveKit Inference — no Deepgram/LLM keys needed
for this mode:

- STT `deepgram/flux-general-en` (same EOT settings as fish mode)
- LLM `google/gemma-4-31b-it`
- TTS `fishaudio/s2.1-pro` with the same voice reference ids from `personas.js`

Set `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET`; `server.js`
then spawns the agent worker (`lk-agent.js`) alongside itself and `/lk` goes
live. Persona is chosen at join (dispatch metadata); switching personas
mid-session starts a fresh room.

Latency parity: fish mode reports voice→voice as last-audible-mic-chunk →
first-audio-on-the-wire, measured in `server.js`. LiveKit mode reports the
matching span — `EOUMetrics.lastSpeakingTimeMs` → the agent-state transition
to `speaking` (first audio published to the room) — measured in `lk-agent.js`
and delivered to the same latency pill over the room's data channel. Both
spans include STT finalization, LLM TTFT, and TTS TTFB, and both exclude the
final downstream hop to the browser.
