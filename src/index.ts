import "dotenv/config";
import { startListening, stopListening } from "./ear.js";
import {
  chat,
  synthesizeSpeech,
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

// Pre-generated filler clip — synthesised once at startup
let fillerAudio: Buffer | null = null;

// Pre-generated greeting clip — synthesised once at startup, played after
// warmup so the user hears the agent introduce itself before the mic opens.
const INTRO_TEXT = "Hi, I'm your food ordering assistant. How can I help you today?";
let introAudio: Buffer | null = null;

async function handleTranscription(text: string): Promise<void> {
  stopListening();
  stopThinking(); // tear down the listening spinner
  printTurnDivider();
  logUser(text);
  startThinking("Thinking…");

  let fillerPlaying = false;
  // Pre-warmed TTS if chat() is still in flight after 2s (cleared when reply returns)
  const fillerTimer = setTimeout(async () => {
    if (fillerAudio) {
      fillerPlaying = true;
      await playAudio(fillerAudio).catch(() => {});
      fillerPlaying = false;
    }
  }, 2000);

  try {
    const response = await chat(text);

    clearTimeout(fillerTimer);
    if (fillerPlaying) stopPlayback();

    stopThinking();

    if (response.audio) {
      logVoice(response.text);
      await playAudio(response.audio);
    }
  } catch (err) {
    clearTimeout(fillerTimer);
    if (fillerPlaying) stopPlayback();
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

// Pre-generate the intro and filler audio clips in parallel. NO LLM warmup —
// that was sending "ping" through the full agent loop (skill loading, LLM
// reasoning, sometimes even tool calls) and taking 30-60s before the user
// could do anything. Instead we let the first real chat() be the cold start.
// The user hears Anisha's greeting within seconds and starts talking; the
// first response is slightly slower but they're not staring at a dead spinner.
const TTS_PREGEN_TIMEOUT_MS = 15000;

const fillerWithTimeout: Promise<void> = Promise.race([
  synthesizeSpeech("Hmm, one moment please!").then((buf) => {
    fillerAudio = buf;
  }),
  new Promise<void>((resolve) => setTimeout(resolve, TTS_PREGEN_TIMEOUT_MS)),
]).catch(() => {});

const introWithTimeout: Promise<void> = Promise.race([
  synthesizeSpeech(INTRO_TEXT).then((buf) => {
    introAudio = buf;
  }),
  new Promise<void>((resolve) => setTimeout(resolve, TTS_PREGEN_TIMEOUT_MS)),
]).catch(() => {});

await Promise.all([fillerWithTimeout, introWithTimeout]);

finishWarming();
if (!fillerAudio) {
  logSystem("(Filler audio unavailable — long replies will start without a stall message.)");
}

// Play the intro greeting before opening the mic, so the user hears the
// agent before they can speak over it. The intro text is rendered with
// the same Agent + Speaking lines as a normal turn so the demo viewer
// sees the full UI vocabulary right away.
printTurnDivider();
logAgent(INTRO_TEXT);
logVoice(INTRO_TEXT);
if (introAudio) {
  await playAudio(introAudio).catch(() => {});
} else {
  logSystem("(Greeting audio unavailable — continuing in text-only mode.)");
}

logSystem("Ready. Speak when you are.");
startListening(handleTranscription);
startListeningSpinner("Listening…");
