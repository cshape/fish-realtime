// Fish TTS — /v1/tts/live websocket. Text goes in as sentence chunks, PCM16
// comes out via onAudio. One socket speaks with ONE voice; mid-turn voice
// changes are handled by FishPipeline, which chains sockets.
//
// Extracted from server.js so scripts/ can exercise the pipeline directly.

import { WebSocket } from "ws";
import { encode as mpEncode, decode as mpDecode } from "@msgpack/msgpack";

const FISH_API_KEY = process.env.FISH_API_KEY;
const FISH_MODEL = process.env.FISH_MODEL || "s2.1-pro";
const FISH_LATENCY_MODE = process.env.FISH_LATENCY_MODE || "balanced"; // normal | balanced | low
export const TTS_SAMPLE_RATE = 24000;

const DEBUG = !!process.env.FISH_DEBUG;
const dbg = (...args) => DEBUG && console.log("[fish:dbg]", ...args);

export function openFishSocket(referenceId, { onAudio, onFinish, onError }) {
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
      onAudio(Buffer.from(msg.audio));
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

// One agent turn's TTS, possibly spanning several voices. Each setVoice()
// seals the current Fish socket and opens the next one with the new voice;
// later segments synthesize concurrently but their audio is buffered until
// every earlier segment finishes, so playback order is preserved.
export class FishPipeline {
  #segments = []; // { handle, buffered: [Buffer], gotText, finished, bytes }
  #cb;
  #ended = false;
  #closed = false;

  constructor(referenceId, callbacks) {
    this.#cb = callbacks;
    this.#openSegment(referenceId);
  }

  #openSegment(referenceId) {
    const seg = { handle: null, buffered: [], gotText: false, finished: false, bytes: 0 };
    const idx = this.#segments.push(seg) - 1;
    dbg(`seg${idx} open voice=${referenceId?.slice(0, 8)}`);
    seg.handle = openFishSocket(referenceId, {
      onAudio: (buf) => {
        if (this.#closed) return;
        seg.bytes += buf.length;
        if (idx === this.#frontier()) this.#cb.onAudio(buf);
        else {
          seg.buffered.push(buf);
          dbg(`seg${idx} buffered ${buf.length}B (frontier=${this.#frontier()})`);
        }
      },
      onFinish: () => {
        dbg(`seg${idx} finish (${seg.bytes}B total)`);
        this.#finishSegment(idx);
      },
      onError: (err) => {
        if (this.#closed) return;
        dbg(`seg${idx} error: ${err.message}`);
        // A dead segment must not dam the pipeline behind it.
        this.#finishSegment(idx);
        this.#cb.onError?.(err);
      },
    });
    return seg;
  }

  // Index of the first unfinished segment — the one allowed to play live.
  #frontier() {
    for (let i = 0; i < this.#segments.length; i++) {
      if (!this.#segments[i].finished) return i;
    }
    return this.#segments.length;
  }

  #finishSegment(idx) {
    if (this.#closed || this.#segments[idx].finished) return;
    this.#segments[idx].finished = true;
    // Drain buffered audio of following segments up to the new frontier.
    for (let i = idx + 1; i < this.#segments.length; i++) {
      const seg = this.#segments[i];
      const drained = seg.buffered.reduce((n, b) => n + b.length, 0);
      if (drained) dbg(`seg${i} drained ${drained}B after seg${idx} finish`);
      for (const buf of seg.buffered.splice(0)) this.#cb.onAudio(buf);
      if (!seg.finished) break;
    }
    if (this.#ended && this.#segments.every((s) => s.finished)) this.#cb.onFinish();
  }

  #last() {
    return this.#segments[this.#segments.length - 1];
  }

  pushText(text) {
    if (this.#closed || !text) return;
    const seg = this.#last();
    // Whitespace-only input must not count as content: a segment sealed with
    // nothing but whitespace makes Fish finish with reason=error. Leading
    // whitespace says nothing aloud — hold it until real text shows up.
    if (!seg.gotText) {
      if (!/\S/.test(text)) return;
      seg.gotText = true;
    }
    seg.handle.pushText(text);
  }

  setVoice(referenceId) {
    if (this.#closed) return;
    this.#sealLast();
    this.#openSegment(referenceId);
  }

  endInput() {
    if (this.#closed) return;
    this.#ended = true;
    this.#sealLast();
  }

  // Close the current segment's input. A segment that never received text
  // won't get a Fish "finish" event worth waiting for — drop it directly.
  #sealLast() {
    const seg = this.#last();
    const idx = this.#segments.length - 1;
    if (seg.gotText) {
      dbg(`seg${idx} sealed (endInput)`);
      seg.handle.endInput();
    } else {
      dbg(`seg${idx} dropped (no text)`);
      seg.handle.close();
      this.#finishSegment(idx);
    }
  }

  close() {
    this.#closed = true;
    for (const seg of this.#segments) seg.handle.close();
  }
}
