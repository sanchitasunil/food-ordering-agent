import "dotenv/config";
import { startListening, stopListening } from "./ear.js";
import { chat, warmup, synthesizeSpeech } from "./brain.js";
import { playAudio, stopPlayback } from "./voice.js";
import {
  logUser,
  logVoice,
  logError,
  logSystem,
  startThinking,
  stopThinking,
} from "./ui.js";

// Pre-generated filler clip — synthesised once at startup
let fillerAudio: Buffer | null = null;

async function handleTranscription(text: string): Promise<void> {
  stopListening();
  logUser(text);
  startThinking("Processing...");

  // Schedule filler to play only if LLM takes longer than 2s
  let fillerPlaying = false;
  const fillerTimer = setTimeout(async () => {
    if (fillerAudio) {
      fillerPlaying = true;
      await playAudio(fillerAudio).catch(() => {});
      fillerPlaying = false;
    }
  }, 2000);

  try {
    const response = await chat(text);

    // Cancel or stop filler — response is ready
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
}

// ── Entry point ──────────────────────────────────────────────
logSystem("Starting up...");

// Warm up OpenClaw + pre-generate filler audio in parallel
await Promise.all([
  warmup(),
  synthesizeSpeech("Let me check on that for you.").then((buf) => {
    fillerAudio = buf;
  }).catch(() => {}),
]);

logSystem("Ready — listening for your voice.");
startListening(handleTranscription);
