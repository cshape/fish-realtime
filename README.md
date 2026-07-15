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
browser spk <── PCM16 @24k ── server <── Fish TTS         (/v1/tts/live, one WS per voice segment)
```

## The product surface

- **Personas** (`personas.js`) — Guide / Companion / Narrator / Concierge, each
  with its own voice, system prompt, spoken greeting, and scene tint. They map
  to the target markets: companions, accessible/interactive content, customer
  service.
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
