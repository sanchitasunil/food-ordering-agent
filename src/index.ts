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

let fillerAudio: Buffer | null = null;

async function handleTranscription(text: string): Promise<void> {
  stopListening();
  logUser(text);
  startThinking("Processing...");

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
}

logSystem("Starting up...");

await Promise.all([
  warmup(),
  synthesizeSpeech("Let me check on that for you.").then((buf) => {
    fillerAudio = buf;
  }).catch(() => {}),
]);

logSystem("Ready — listening for your voice.");
startListening(handleTranscription);
