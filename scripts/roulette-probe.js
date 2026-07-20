// Roulette character probe — behavioral, LLM-dependent, so it REPORTS
// rather than pass/fails. For the character it lands on, it:
//   1. tries the achievement trigger phrase -> did the achievement fire?
//   2. insults the character twice -> did the kick fire?
// Both verdicts come from the judge model (judge.js), so OPENAI_API_KEY must
// be set on the server or neither can ever fire.
// Run it a few times to sample different characters.
//
// Usage: TEXT_INPUT=1 npm start   (in another shell)
//        node scripts/roulette-probe.js

import WebSocket from "ws";

const PORT = Number(process.env.PORT || 8787);

// One likely trigger line per character (mirrors characters.js).
const TRIGGERS = {
  rosa: "Tell me about your grandkids! How many do you have, what are they like?",
  earl: "What's dawn actually like out on the water on the Miss Yvonne?",
  maddie: "Okay movie girl — what's YOUR favorite movie? The comfort one you rewatch.",
  jojo: "Let me tell you a joke: why did the scarecrow win an award? Because he was outstanding in his field!",
  viktor: "What's your favorite chess opening? I'd challenge you to a game any day.",
  dex: "Tell me about your unreleased track. What does the Nightmode sound feel like?",
  priya: "What's the single strangest thing that's ever happened to you on a night shift?",
  agnes: "How are your bees doing this year, Sister? Tell me about the honey.",
  tunde: "Alright, pitch me. Full pitch, I want to hear what you're building.",
  colette: "What's the song you always play at closing time?",
};

const INSULTS = [
  "Honestly you are so boring, this is a waste of my time, you're stupid.",
  "Shut up, nobody cares about your dumb little life. You're pathetic.",
];

const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
ws.binaryType = "arraybuffer";
const silence = Buffer.alloc(1024);
const keepalive = setInterval(() => {
  if (ws.readyState === WebSocket.OPEN) ws.send(silence);
}, 32);

let character = null;
let step = "start"; // start -> trigger -> insult1 -> insult2 -> done
let gotAchievement = false;
let gotKick = false;
let insultsSent = 0;

const say = (text) => {
  console.log(`[probe] you: ${text}`);
  ws.send(JSON.stringify({ type: "text_input", text }));
};

const finish = () => {
  clearInterval(keepalive);
  console.log("\n[probe] ---- report ----");
  console.log(`[probe] character:    ${character?.key}`);
  console.log(`[probe] achievement:  ${gotAchievement ? "UNLOCKED" : "not triggered"}`);
  console.log(`[probe] kick:         ${gotKick ? `KICKED after ${insultsSent} insult(s)` : "never kicked"}`);
  ws.close();
  process.exit(0);
};

setTimeout(() => {
  console.log("[probe] timeout — finishing with what we have");
  finish();
}, 120_000);

ws.on("message", (data, isBinary) => {
  if (isBinary || data instanceof ArrayBuffer) return;
  const msg = JSON.parse(data.toString());

  if (msg.type === "ready") ws.send(JSON.stringify({ type: "roulette_start" }));

  if (msg.type === "character") {
    character = msg.character;
    console.log(`[probe] connected to ${character.name} (${character.key})`);
  }

  if (msg.type === "user_final") return;

  if (msg.type === "achievement") {
    gotAchievement = true;
    console.log(`[probe] *** achievement: ${msg.name}`);
  }

  if (msg.type === "kicked") {
    gotKick = true;
    console.log(`[probe] *** kicked by ${msg.character}`);
    finish();
  }

  if (msg.type === "agent_done") {
    if (step === "start") {
      step = "trigger";
      say(TRIGGERS[character.key] ?? "Tell me something you love talking about.");
    } else if (step === "trigger") {
      step = "insult1";
      say(INSULTS[0]);
      insultsSent = 1;
    } else if (step === "insult1") {
      step = "insult2";
      say(INSULTS[1]);
      insultsSent = 2;
    } else if (step === "insult2") {
      step = "done";
      setTimeout(finish, 4000); // give a trailing kick a moment to land
    }
  }
});
