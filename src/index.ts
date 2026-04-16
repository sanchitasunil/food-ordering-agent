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

  startListening(handleTranscription, { quiet: true });
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

// Kick off OpenClaw warmup in background — the expensive cold-start
// (config load, skill resolution, plugin init) happens here instead
// of on the first chat() call. Using setImmediate so the event loop
// stays free for mic setup and intro playback.
setImmediate(() => { warmup().catch(() => {}); });

finishWarming();
printTurnDivider();
logAgent(INTRO_TEXT);
logVoice(INTRO_TEXT);

// decibri uses WASAPI, not SoX — playback and capture can run on
// separate devices simultaneously. No need to wait for intro to end.
if (introAudio) {
  playAudio(introAudio).catch(() => {});
}

// Connect mic immediately (decibri doesn't conflict with playback).
startThinking("Connecting mic…");
startListening(handleTranscription, {
  quiet: true,
  onReady() {
    stopThinking();
    startListeningSpinner("Listening — speak any time…");
  },
});

// Keep the event loop alive indefinitely.
setInterval(() => {}, 60000);
