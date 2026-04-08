import "dotenv/config";
import { startListening, stopListening } from "./ear.js";
import { chat, warmup, getFiller } from "./brain.js";
import { playAudio } from "./voice.js";
import {
  logUser,
  logVoice,
  logError,
  startThinking,
  stopThinking,
} from "./ui.js";

/**
 * Main "Mute-While-Talking" event loop.
 *
 * Flow:
 *  1. Mic is live, streaming to Deepgram.
 *  2. On final transcript → mute mic immediately.
 *  3. Play filler audio ("Let me check...") while LLM thinks.
 *  4. Send text to brain.ts. Listen for tool calls and logTool().
 *  5. On LLM reply → stop thinking spinner.
 *  6. Generate Murf TTS → logVoice(reply) → play audio.
 *  7. Resume mic.
 */
async function handleTranscription(text: string): Promise<void> {
  // Mute mic so speakers don't feed back
  stopListening();

  logUser(text);

  // Play filler audio in the background while the LLM processes
  const filler = getFiller();
  if (filler) {
    playAudio(filler).catch(() => {});
  }

  startThinking("Processing...");

  try {
    const response = await chat(text);
    stopThinking();

    if (response.audio) {
      logVoice(response.text);
      await playAudio(response.audio);
    }
  } catch (err) {
    stopThinking();
    logError(err);
  }

  // Resume listening
  startListening(handleTranscription);
}

// ── Entry point ──────────────────────────────────────────────
// Warmup: prime OpenClaw config + pre-generate filler TTS clip
warmup();

// Start listening
startListening(handleTranscription);
