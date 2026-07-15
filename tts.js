// Fish TTS — /v1/tts/live websocket. Text goes in as sentence chunks, PCM16
// comes out via onAudio. One socket per agent turn, one voice per turn.
//
// Extracted from server.js so the pipeline can be exercised without it.

import { WebSocket } from "ws";
import { encode as mpEncode, decode as mpDecode } from "@msgpack/msgpack";
import { AUDIO_CONFIG } from "./public/config.js";

const FISH_API_KEY = process.env.FISH_API_KEY;
export const FISH_MODEL = process.env.FISH_MODEL || "s2.1-pro";
export const FISH_LATENCY_MODE = process.env.FISH_LATENCY_MODE || "balanced"; // normal | balanced | low
export const TTS_SAMPLE_RATE = AUDIO_CONFIG.outputSampleRate;

const DEBUG = !!process.env.FISH_DEBUG;
const dbg = (...args) => DEBUG && console.log("[fish:dbg]", ...args);

function openFishSocket(referenceId, { onAudio, onFinish, onError }) {
  const ws = new WebSocket("wss://api.fish.audio/v1/tts/live", {
    headers: {
      Authorization: `Bearer ${FISH_API_KEY}`,
      model: FISH_MODEL,
    },
  });

  let open = false;
  let closed = false;
  const queue = []; // events buffered until the socket opens

  const send = (event) => {
    if (closed) return;
    if (!open) {
      queue.push(event);
      return;
    }
    ws.send(mpEncode(event));
  };

  ws.on("open", () => {
    open = true;
    ws.send(
      mpEncode({
        event: "start",
        request: {
          text: "",
          chunk_length: 200,
          min_chunk_length: 20,
          format: "pcm",
          sample_rate: TTS_SAMPLE_RATE,
          references: [],
          reference_id: referenceId || null,
          normalize: true,
          latency: FISH_LATENCY_MODE,
          temperature: 0.7,
          top_p: 0.7,
        },
      }),
    );
    for (const e of queue.splice(0)) ws.send(mpEncode(e));
  });

  ws.on("message", (data) => {
    let msg;
    try {
      msg = mpDecode(data);
    } catch {
      return;
    }
    if (msg.event === "audio" && msg.audio?.length) {
      const a = msg.audio; // Uint8Array view over the WS frame; never reused
      onAudio(Buffer.from(a.buffer, a.byteOffset, a.byteLength));
    } else if (msg.event === "finish") {
      closed = true;
      ws.close();
      if (msg.reason === "error") onError(new Error("Fish TTS reported an error"));
      else onFinish();
    } else if (msg.event === "log") {
      dbg("log:", msg.message);
    }
  });

  ws.on("error", (err) => {
    if (!closed) onError(err);
    closed = true;
  });

  return {
    pushText(text) {
      if (text) send({ event: "text", text });
    },
    // All text sent — synthesize the trailing buffer, then end the stream.
    endInput() {
      send({ event: "flush" });
      send({ event: "stop" });
    },
    close() {
      closed = true;
      try {
        ws.close();
      } catch {}
    },
  };
}

// One agent turn's TTS. Thin wrapper over the socket that adds the two
// behaviors the raw stream can't express:
//  - whitespace-only input never reaches Fish (a stream sealed with nothing
//    but whitespace makes Fish finish with reason=error), and
//  - a turn whose text was all whitespace still fires onFinish.
export class FishPipeline {
  #handle;
  #cb;
  #gotText = false;
  #closed = false;

  constructor(referenceId, callbacks) {
    this.#cb = callbacks;
    this.#handle = openFishSocket(referenceId, {
      onAudio: (buf) => {
        if (!this.#closed) this.#cb.onAudio(buf);
      },
      onFinish: () => {
        if (!this.#closed) this.#cb.onFinish();
      },
      onError: (err) => {
        if (this.#closed) return;
        dbg(`pipeline error: ${err.message}`);
        this.#cb.onError?.(err);
        this.#cb.onFinish();
      },
    });
  }

  pushText(text) {
    if (this.#closed || !text) return;
    // Leading whitespace says nothing aloud — hold it until real text.
    if (!this.#gotText) {
      if (!/\S/.test(text)) return;
      this.#gotText = true;
    }
    this.#handle.pushText(text);
  }

  endInput() {
    if (this.#closed) return;
    if (this.#gotText) {
      this.#handle.endInput();
    } else {
      // Never received text: Fish won't send a "finish" worth waiting for.
      dbg("pipeline dropped (no text)");
      this.#handle.close();
      this.#cb.onFinish();
    }
  }

  close() {
    this.#closed = true;
    this.#handle.close();
  }
}
