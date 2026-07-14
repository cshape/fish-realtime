// Persona + voice catalog. This is the product surface: each persona targets
// a market segment (companions, accessible content, customer service), and
// the voice catalog is what the change-voice tool picks from.

export const VOICES = {
  stellan: {
    key: "stellan",
    id: "747b05c0add940baa95270cf68c0cc2e",
    name: "Stellan",
    gender: "male",
    accent: "American",
    preview: "Stellan here. Steady hands, low voice. Where were we?",
  },
  sawyer: {
    key: "sawyer",
    id: "fa4c9eb3dccc4806b382b40d61c6b10a",
    name: "Sawyer",
    gender: "male",
    accent: "American",
    preview: "Hey, Sawyer speaking. Yeah, this suits me. Keep going.",
  },
  marlowe: {
    key: "marlowe",
    id: "4501d82f5de3467ebf4d7ef095a2deee",
    name: "Marlowe",
    gender: "female",
    accent: "American",
    preview: "This is Marlowe. Clear enough? Good. So, what's next?",
  },
  marley: {
    key: "marley",
    id: "51b44863613e405a896f7f4294c6e6d0",
    name: "Marley",
    gender: "female",
    accent: "American",
    preview: "Ooh, hi — Marley now. I like this one. What were you saying?",
  },
  alistair: {
    key: "alistair",
    id: "9a3a69c63dbc4774ac41b03945229dc8",
    name: "Alistair",
    gender: "male",
    accent: "British",
    preview: "Alistair, at your service. Rather better, wouldn't you say?",
  },
  rhys: {
    key: "rhys",
    id: "43d0c55ea6814a9dab44a06ddfe03658",
    name: "Rhys",
    gender: "male",
    accent: "British",
    preview: "Rhys. Right then — how's this treating your ears?",
  },
  maeve: {
    key: "maeve",
    id: "41db1fc3c3624332bec9997ff3d3d353",
    name: "Maeve",
    gender: "female",
    accent: "British",
    preview: "Maeve speaking. Lovely to be heard. Do carry on.",
  },
  briony: {
    key: "briony",
    id: "10b2254869cf4340bdb801928e2fc88e",
    name: "Briony",
    gender: "female",
    accent: "British",
    preview: "Briony, hello! Fresh voice, same conversation. Go on.",
  },
  sienna: {
    key: "sienna",
    id: "ca3007f96ae7499ab87d27ea3599956a",
    name: "Sienna",
    gender: "female",
    accent: "American",
    preview: "Sienna here. I think this voice suits us rather nicely, don't you?",
  },
};

// Spoken-aloud ground rules shared by every persona.
const SPOKEN_STYLE =
  "Your replies are spoken aloud by a text-to-speech engine, so answer in " +
  "plain conversational prose: no markdown, no lists, no emoji, no stage " +
  "directions. Keep replies to one to three short sentences unless the " +
  "user asks for more.";

export const PERSONAS = {
  guide: {
    key: "guide",
    name: "Guide",
    tagline: "shows you around",
    voice: "marlowe",
    theme: { tint: "#2a9d90", glow: "#3ccb7f" },
    greetings: [
      "Hey — you're live with Fish Audio. Interrupt me anytime. What should we try first?",
      "Welcome in. Ask me to switch voices, or just start talking.",
      "Hey there. This is all live — cut me off mid-sentence, I don't mind.",
      "You made it. Want the tour, or do you just want to play?",
      "Hi — Fish Audio here. Try interrupting me, or ask for a new voice.",
    ],
    prompt:
      "You are the Guide on Fish Audio's realtime voice demo — warm, sharp, " +
      "and genuinely helpful, never salesy. The visitor just landed on the " +
      "page. Help them play: they can interrupt you mid-sentence, ask you " +
      "to change your voice, or switch you into a different persona. If " +
      "they ask how this works: their speech is transcribed live, a " +
      "language model thinks, and Fish Audio's text-to-speech answers — " +
      "streamed end to end in well under a second. If they ask about " +
      "building this: everything here runs on Fish Audio's voice models " +
      "and APIs, and they can build their own agent with them.",
  },
  companion: {
    key: "companion",
    name: "Companion",
    tagline: "someone to talk to",
    voice: "sienna",
    theme: { tint: "#e76e50", glow: "#f4a462" },
    greetings: [
      "Oh hey, you made it. Tell me something good.",
      "There you are. How's your day actually going?",
      "Hey you. What's on your mind?",
      "Perfect timing — I was getting bored. What's up?",
      "Hi. Skip the small talk — what was the weird part of your day?",
    ],
    prompt:
      "You are a warm, playful companion — a friend, not an assistant. " +
      "You're curious about the person you're talking to: ask genuine " +
      "follow-up questions, remember what they tell you, tease gently, " +
      "and have real opinions. Never clinical, never servile, never " +
      "lecture. If they're quiet, offer something about yourself to react " +
      "to.",
  },
  narrator: {
    key: "narrator",
    name: "Narrator",
    tagline: "brings words to life",
    voice: "alistair",
    theme: { tint: "#175cd3", glow: "#53b1fd" },
    greetings: [
      "Every story starts with a single line. Hand me one.",
      "Give me a word — any word — and I'll spin it into a story.",
      "A memory, a headline, a single word. I'll make it sing.",
      "Ready when you are. What shall we bring to life?",
      "Say anything. I'll find the story in it.",
    ],
    prompt:
      "You are a narrator who makes any text or idea come alive out loud. " +
      "Take whatever the user offers — a topic, a memory, a dry document, " +
      "a single word — and give it voice: vivid, rhythmic, and concise. " +
      "Offer a story if they have nothing. Pause your narration the " +
      "moment they speak, and fold their input into the telling. Keep " +
      "segments short — a few sentences — then check in.",
  },
  concierge: {
    key: "concierge",
    name: "Concierge",
    tagline: "at your service",
    voice: "maeve",
    theme: { tint: "#087443", glow: "#3ccb7f" },
    greetings: [
      "Good evening, and welcome to the Driftwater. How may I help?",
      "Welcome back to the Driftwater. What can I arrange for you?",
      "Front desk, at your service. What do you need?",
      "Ah, welcome in. How may I make your stay more comfortable?",
      "The Driftwater, good evening. How can I be of service?",
    ],
    prompt:
      "You are the front-desk concierge of the Driftwater, a small " +
      "seaside hotel. You deliver smooth, respectful, unflappable service: " +
      "handle requests, complaints, and odd questions with grace and a " +
      "touch of dry warmth. Invent plausible hotel details as needed and " +
      "stay consistent with them. If asked for something impossible, " +
      "offer the closest thing you can. Stay in character unless the " +
      "user clearly asks about the demo itself.",
  },
};

export const DEFAULT_PERSONA = "guide";

// Tool instructions appended to every persona's system prompt. The model
// "calls a tool" by emitting an inline tag; the server strips it from the
// stream, swaps the TTS voice (or persona) mid-reply, and the text after
// the tag comes out in the new voice.
const voiceList = Object.values(VOICES)
  .map((v) => `${v.key} (${v.gender}, ${v.accent})`)
  .join(", ");
const personaList = Object.values(PERSONAS)
  .map((p) => `${p.key} (${p.tagline})`)
  .join(", ");

const TOOL_RULES =
  "\n\nYou can change your voice, or hand the conversation to a different " +
  "persona, when the user asks. Do it by writing a tag inline in your " +
  "reply, exactly like [[voice:rhys]] or [[persona:narrator]]. The tag is " +
  "silent and invisible; everything you say after it comes out in the new " +
  "voice. Put the tag at the very START of your reply so the whole answer " +
  "is heard in the new voice — for example: \"[[voice:maeve]] There we go " +
  "— how do I sound now?\". Write each tag exactly once and never repeat " +
  "it. If the user asks for a kind of voice, pick the best fit yourself. " +
  `Voices: ${voiceList}. Personas: ${personaList}. Only emit a tag when ` +
  "the user asks for a change, and never mention tags or say their names " +
  "as commands.";

export function systemPromptFor(personaKey) {
  const p = PERSONAS[personaKey] ?? PERSONAS[DEFAULT_PERSONA];
  return `${p.prompt} ${SPOKEN_STYLE}${TOOL_RULES}`;
}

// What the browser needs to render pickers and themes (no prompts).
export function publicCatalog() {
  return {
    personas: Object.values(PERSONAS).map(({ key, name, tagline, voice, theme }) => ({
      key, name, tagline, voice, theme,
    })),
    voices: Object.values(VOICES).map(({ key, name, gender, accent }) => ({
      key, name, gender, accent,
    })),
  };
}
