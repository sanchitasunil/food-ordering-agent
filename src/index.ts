import "dotenv/config";
import { startListening, stopListening } from "./ear.js";
import {
  chat,
  synthesizeSpeech,
  warmup,
  ACTIVE_PROVIDER,
  ACTIVE_MODEL,
} from "./brain.js";
import { playAudio, stopPlayback } from "./voice.js";
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
// SoX child processes keep the event loop alive. Without this handler,
// Ctrl+C appears to hang because Node waits for the orphaned SoX to exit.

function shutdown(): void {
  stopPlayback();
  stopListening();
  stopThinking();
  logSystem("Shutting down.");
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ── Pre-generated audio clips ────────────────────────────────────

let fillerAudio: Buffer | null = null;
let fillerLongAudio: Buffer | null = null;

const INTRO_TEXT = "Hi, I'm your food ordering assistant. What are you in the mood for?";
let introAudio: Buffer | null = null;

// ── Conversation turn handler ────────────────────────────────────

async function handleTranscription(text: string): Promise<void> {
  stopListening();
  stopThinking();
  printTurnDivider();
  logUser(text);

  // Play "One moment please" immediately so the user knows we heard them.
  if (fillerAudio) {
    await playAudio(fillerAudio).catch(() => {});
  }

  startThinking("Thinking…");

  // If the LLM takes longer than 5s, play "I'm checking on it" so the
  // user doesn't think the agent froze.
  let longFillerPlayed = false;
  const longFillerTimer = setTimeout(async () => {
    if (fillerLongAudio) {
      longFillerPlayed = true;
      await playAudio(fillerLongAudio).catch(() => {});
      longFillerPlayed = false;
    }
  }, 5000);

  try {
    const response = await chat(text);
    clearTimeout(longFillerTimer);
    if (longFillerPlayed) stopPlayback();
    stopThinking();

    if (response.audio) {
      logVoice(response.text);
      await playAudio(response.audio);
    }
  } catch (err) {
    clearTimeout(longFillerTimer);
    if (longFillerPlayed) stopPlayback();
    stopThinking();
    logError(err);
  }

  startListening(handleTranscription);
  startListeningSpinner("Listening…");
}

// ── Entry point ──────────────────────────────────────────────────

printBanner({
  stt: "deepgram nova-2",
  llmProvider: ACTIVE_PROVIDER,
  llmModel: ACTIVE_MODEL,
  ttsProvider: "murf falcon",
  ttsVoice: "en-IN-anisha",
  skill: "swiggy-food",
});

const finishWarming = startWarmingBanner();

// TTS pregen runs first (~3s). We can't start mic capture yet because
// SoX playback (intro greeting) and SoX capture both need the Windows
// waveaudio device — they can't share it. Mic opens after intro ends.
await Promise.all([
  synthesizeSpeech(INTRO_TEXT).then((buf) => { introAudio = buf; }).catch(() => {}),
  synthesizeSpeech("One moment please.").then((buf) => { fillerAudio = buf; }).catch(() => {}),
  synthesizeSpeech("I'm checking on it, hang tight.").then((buf) => { fillerLongAudio = buf; }).catch(() => {}),
]);

finishWarming();
printTurnDivider();
logAgent(INTRO_TEXT);
logVoice(INTRO_TEXT);

if (introAudio) {
  await playAudio(introAudio).catch(() => {});
}

// Connect mic after playback releases the audio device.
startThinking("Connecting mic…");
startListening(handleTranscription, {
  quiet: true,
  onReady() {
    stopThinking();
    startListeningSpinner("Listening — speak any time…");
  },
});

// Keep the event loop alive indefinitely — without this, Node exits
// after the top-level await chain completes because startListening is
// callback-based and doesn't return a promise.
setInterval(() => {}, 60000);

// Warmup on next tick — must NOT run inside onReady because it blocks
// the event loop during openclaw config loading, which starves SoX
// events and causes Deepgram to time out.
setImmediate(() => { warmup().catch(() => {}); });
