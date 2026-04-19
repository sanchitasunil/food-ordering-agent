import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { startListening, stopListening } from "./ear.js";
import {
  chat,
  warmup,
  ACTIVE_PROVIDER,
  ACTIVE_MODEL,
} from "./brain.js";
import { playAudio, stopPlayback, stopOneShotPlayback, createPlaybackStream } from "./voice.js";
import {
  logUser,
  logAgent,
  logVoice,
  logError,
  logSystem,
  startThinking,
  stopThinking,
  startListeningSpinner,
  startWarmingBanner,
  printBanner,
  printTurnDivider,
} from "./ui.js";

// ── Graceful shutdown ────────────────────────────────────────────

function shutdown(): void {
  stopPlayback();
  stopListening();
  stopThinking();
  logSystem("Shutting down.");
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ── Pre-baked audio clips ────────────────────────────────────────
// Loaded from disk at startup — no Murf API call needed, so they're
// available instantly even before the plugin initializes.

const INTRO_TEXT = "Hi, I'm your food ordering assistant. What are you in the mood for?";

function loadAsset(name: string): Buffer | null {
  try {
    return readFileSync(resolve("assets", name));
  } catch {
    return null;
  }
}

const introAudio = loadAsset("intro.wav");
const fillerAudio = loadAsset("filler.wav");
const fillerLongAudio = loadAsset("filler-long.wav");

// ── STT keyterm biasing ──────────────────────────────────────────
// Base vocab lives in keyterms.json so non-engineers can tune it
// without touching code. Per turn we also pull capitalized tokens
// out of the agent's last response (likely restaurant/dish names
// the user is about to echo back) and merge them in.

const BASE_KEYTERMS: string[] = (() => {
  try {
    const raw = readFileSync(resolve("keyterms.json"), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.base) ? parsed.base : [];
  } catch {
    return [];
  }
})();

const KEYTERM_STOPWORDS = new Set([
  "I", "I'm", "Hi", "Hello", "The", "A", "An", "Yes", "No", "Sure",
  "Okay", "What", "Which", "Where", "When", "How", "Why", "Would",
  "Could", "Should", "Here", "There", "These", "Those", "Some", "Any",
  "And", "Or", "But", "So", "Then", "Now", "Found", "Got", "Have",
  "You", "Your", "It", "They", "We", "Me", "My", "Our",
]);

function extractContextualKeyterms(text: string): string[] {
  const tokens = text
    .replace(/[.,!?;:()"']/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && /^[A-Z]/.test(w) && !KEYTERM_STOPWORDS.has(w));
  return [...new Set(tokens)];
}

// Flux caps keyterms per connection — keep the merged list bounded.
const MAX_KEYTERMS = 100;
function mergeKeyterms(...lists: string[][]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const k of list) {
      const key = k.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        out.push(k);
        if (out.length >= MAX_KEYTERMS) return out;
      }
    }
  }
  return out;
}

// ── Conversation turn handler ────────────────────────────────────

async function handleTranscription(text: string): Promise<void> {
  stopListening();
  stopThinking();
  printTurnDivider();
  logUser(text);

  // Streaming TTS playback queue for this turn. Chunks synthesized by
  // brain.chat() (one per openclaw block) are enqueued here as they arrive,
  // but actual playback doesn't start until the filler clip finishes — so
  // the user hears one continuous stream instead of the filler getting cut
  // off mid-word.
  const playback = createPlaybackStream();

  // Declare filler bookkeeping up front so the chat() callback can cancel
  // the long filler the moment the first real chunk arrives.
  let longFillerPlayed = false;
  let firstChunkSeen = false;
  let longFillerTimer: NodeJS.Timeout | undefined;

  // Kick the LLM off in parallel with the filler audio below. Before
  // this, we awaited the filler first, which wasted ~1-2s of LLM time
  // every turn.
  const chatPromise = chat(text, {
    onAudioChunk: (audio) => {
      if (!firstChunkSeen) {
        firstChunkSeen = true;
        // Real audio is incoming — kill the pending or in-flight long filler
        // so it doesn't collide with the streaming channel on the speaker.
        if (longFillerTimer) clearTimeout(longFillerTimer);
        if (longFillerPlayed) stopOneShotPlayback();
      }
      playback.enqueue(audio);
    },
  });
  // Attach a no-op handler so an early rejection doesn't trigger an
  // unhandled-rejection warning while the filler plays. The real error
  // surfaces via `await chatPromise` below.
  chatPromise.catch(() => {});

  // Play "One moment please" so the user knows we heard them.
  const shortFillerDone: Promise<void> = fillerAudio
    ? playAudio(fillerAudio).catch(() => {})
    : Promise.resolve();

  // If chat takes longer than 5s, queue "I'm checking on it". The
  // inner await keeps it from overlapping with the short filler.
  longFillerTimer = setTimeout(async () => {
    await shortFillerDone;
    // Streaming chunks may have already started arriving by now — if so,
    // skip the long filler entirely so it doesn't talk over the response.
    if (firstChunkSeen || !fillerLongAudio) return;
    longFillerPlayed = true;
    await playAudio(fillerLongAudio).catch(() => {});
    longFillerPlayed = false;
  }, 5000);

  // Wait for the short filler to finish before the streamed response
  // starts playing — otherwise the first synthesized chunk would race the
  // filler on the speaker. Once filler is done, start() drains any chunks
  // already queued and lets new ones play as they arrive.
  await shortFillerDone;
  playback.start();

  startThinking("Thinking…");

  try {
    const response = await chatPromise;
    clearTimeout(longFillerTimer);
    // Kill only the filler channel here — the streaming channel may have
    // already started playing the response audio.
    if (longFillerPlayed) stopOneShotPlayback();
    stopThinking();

    const nextKeyterms = mergeKeyterms(
      extractContextualKeyterms(response.text ?? ""),
      BASE_KEYTERMS,
    );

    // If brain.chat() streamed audio incrementally, response.audio is null
    // and the chunks are already in the playback queue. The only thing left
    // is to signal end-of-stream and wait for the speaker to drain. If the
    // streaming path produced nothing (rare fallback), response.audio holds
    // the batch-synthesized buffer — enqueue and drain through the same path.
    if (response.audio) playback.enqueue(response.audio);

    if (response.text) logVoice(response.text);

    // Open the Deepgram WS now so the handshake overlaps with TTS
    // playback. Mic stays dark until armMic() is called after playback
    // ends — otherwise the mic would capture the agent's own voice.
    let armMic!: () => void;
    const micArmed = new Promise<void>((r) => { armMic = r; });
    startListening(handleTranscription, {
      quiet: true,
      keyterms: nextKeyterms,
      micArmed,
      onReady() { startListeningSpinner("Listening — speak…"); },
    });

    await playback.finish();
    armMic();
  } catch (err) {
    clearTimeout(longFillerTimer);
    if (longFillerPlayed) stopPlayback();
    playback.stop();
    stopThinking();
    logError(err);
    startListening(handleTranscription, {
      quiet: true,
      keyterms: BASE_KEYTERMS,
      onReady() { startListeningSpinner("Listening — speak…"); },
    });
  }
}

// ── Entry point ──────────────────────────────────────────────────

printBanner({
  stt: "deepgram flux",
  llmProvider: ACTIVE_PROVIDER,
  llmModel: ACTIVE_MODEL,
  ttsProvider: "murf falcon",
  ttsVoice: "en-IN-anusha",
  skill: "swiggy-food",
});

const finishWarming = startWarmingBanner();

// Kick off OpenClaw warmup in background — the expensive cold-start
// (config load, skill resolution, plugin init) happens here instead
// of on the first chat() call. Using setImmediate so the event loop
// stays free for mic setup and intro playback.
setImmediate(() => { warmup().catch(() => {}); });

finishWarming();
printTurnDivider();
logAgent(INTRO_TEXT);
logVoice(INTRO_TEXT);

// Kick off intro playback in parallel with WS handshake + warmup. Mic
// init is deferred until intro finishes so the user's mic doesn't capture
// the agent's own voice and so the "Listening" cue appears right when the
// intro ends.
const introPlayback = introAudio
  ? playAudio(introAudio).catch(() => {})
  : Promise.resolve();

let armMic!: () => void;
const micArmed = new Promise<void>((r) => { armMic = r; });

startThinking("Connecting…");
startListening(handleTranscription, {
  quiet: true,
  keyterms: mergeKeyterms(extractContextualKeyterms(INTRO_TEXT), BASE_KEYTERMS),
  micArmed,
  onReady() {
    stopThinking();
    startListeningSpinner("Listening — speak any time…");
  },
});

introPlayback.then(() => armMic());

// Keep the event loop alive indefinitely.
setInterval(() => {}, 60000);
