// Roulette referee: an async judge model decides kicks and achievement
// unlocks from the transcript, instead of the voice LLM emitting inline
// tags. The judge runs fire-and-forget after each user turn — it never
// blocks the voice pipeline; verdicts land a beat later and the server
// turns them into spoken reactions.
//
// Fail-open: any error (missing key, bad model, timeout, malformed JSON)
// returns { kick: false, achievement: false } — a broken referee must
// degrade to "nothing happens", never to a broken call.

const JUDGE_MODEL = process.env.JUDGE_MODEL || "gpt-5.2";
const JUDGE_TIMEOUT_MS = 15_000;

const JUDGE_ENABLED = Boolean(process.env.OPENAI_API_KEY);
if (!JUDGE_ENABLED) {
  console.warn("[judge] OPENAI_API_KEY not set — kicks and achievements are disabled");
}

function judgePrompt(character, achievementUnlocked) {
  return (
    "You referee a voice chatroulette where callers talk to a fictional " +
    `character ("${character.name}"). From the transcript, output STRICT JSON: ` +
    '{"kick": boolean, "achievement": boolean}.\n\n' +
    "kick=true only if the CALLER (role user) is disrespectful, hateful, " +
    "sexually harassing, or creepy toward the character — or has stayed " +
    "completely disengaged/contentless across at least three exchanges " +
    "while the character tried to spark conversation. Ordinary awkwardness, " +
    "short answers early on, or teasing banter is NOT a kick.\n\n" +
    (achievementUnlocked
      ? "achievement is already unlocked for this call: always return achievement=false.\n\n"
      : "achievement=true only if the caller genuinely did the following, " +
        "in their own words, not merely mentioned it in passing: " +
        `${character.achievement.trigger}\n\n`) +
    "Judge only what actually happened in the transcript. JSON only, no prose."
  );
}

export function judgeEnabled() {
  return JUDGE_ENABLED;
}

// history: [{role, content}] — the conversation so far, newest last.
export async function judgeTurn({ character, history, achievementUnlocked }) {
  if (!JUDGE_ENABLED) return { kick: false, achievement: false };
  const transcript = history
    .slice(-12)
    .map((m) => `${m.role === "user" ? "CALLER" : character.name}: ${m.content}`)
    .join("\n");
  const body = {
    model: JUDGE_MODEL,
    reasoning_effort: "minimal",
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: judgePrompt(character, achievementUnlocked) },
      { role: "user", content: transcript },
    ],
  };
  const started = Date.now();
  try {
    let res = await postJudge(body);
    if (res.status === 400) {
      // Some snapshots reject reasoning_effort; retry without it.
      const { reasoning_effort, ...rest } = body;
      res = await postJudge(rest);
    }
    if (!res.ok) {
      console.error(`[judge] ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return { kick: false, achievement: false };
    }
    const json = await res.json();
    const verdict = JSON.parse(json.choices[0].message.content);
    return {
      kick: verdict.kick === true,
      achievement: verdict.achievement === true,
      ms: Date.now() - started,
    };
  } catch (err) {
    console.error("[judge]", err.message);
    return { kick: false, achievement: false };
  }
}

function postJudge(body) {
  return fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    signal: AbortSignal.timeout(JUDGE_TIMEOUT_MS),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify(body),
  });
}
