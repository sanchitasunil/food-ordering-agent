import { spawn, type ChildProcess } from "node:child_process";
import WebSocket from "ws";
import { logError } from "./ui.js";

type TranscriptionCallback = (text: string) => void;

let soxProcess: ChildProcess | null = null;
let ws: WebSocket | null = null;

/**
 * Spawn SoX directly with waveaudio input (Windows-compatible).
 */
function startMicCapture(): ChildProcess {
  return spawn("sox", [
    "-t", "waveaudio", "default",   // Windows audio input
    "--no-show-progress",
    "--rate", "16000",
    "--channels", "1",
    "--encoding", "signed-integer",
    "--bits", "16",
    "--type", "raw",
    "-",                             // pipe to stdout
  ]);
}

/**
 * Begin streaming mic audio to Deepgram via a raw WebSocket.
 * Calls `onTranscription` with the final transcript of each utterance.
 */
export function startListening(onTranscription: TranscriptionCallback): void {
  if (!process.env.DEEPGRAM_API_KEY) {
    logError("DEEPGRAM_API_KEY is not set. Add it to your .env file.");
    return;
  }

  const url =
    "wss://api.deepgram.com/v1/listen?" +
    "model=nova-2&language=en&smart_format=true&interim_results=true" +
    "&endpointing=300&encoding=linear16&sample_rate=16000&channels=1";

  ws = new WebSocket(url, {
    headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}` },
  });

  ws.on("open", () => {
    try {
      soxProcess = startMicCapture();

      soxProcess.on("error", (err: Error) => {
        handleRecordingError(err);
      });

      soxProcess.stdout!.on("data", (chunk: Buffer) => {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(chunk);
        }
      });

      soxProcess.stderr!.on("data", (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg) handleRecordingError(new Error(msg));
      });
    } catch (err: unknown) {
      handleRecordingError(err);
    }
  });

  ws.on("message", (raw: Buffer) => {
    try {
      const data = JSON.parse(raw.toString());
      const transcript: string =
        data.channel?.alternatives?.[0]?.transcript ?? "";
      if (transcript.trim().length > 0 && data.is_final) {
        onTranscription(transcript.trim());
      }
    } catch {
      // ignore non-JSON control frames
    }
  });

  ws.on("error", (err: Error) => {
    logError(err);
  });
}

/**
 * Stop mic capture and close the Deepgram WebSocket.
 */
export function stopListening(): void {
  if (soxProcess) {
    soxProcess.kill();
    soxProcess = null;
  }
  if (ws) {
    ws.close();
    ws = null;
  }
}

/**
 * Graceful handler for native audio capture failures (e.g. missing SoX on Windows).
 */
function handleRecordingError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as NodeJS.ErrnoException)?.code;

  if (code === "ENOENT" && /sox/i.test(message)) {
    logError(
      "Microphone access failed. Windows requires SoX. " +
        "Download from SourceForge and add it to your PATH, or run this in WSL."
    );
  } else {
    logError(`Recording failed [${code ?? "unknown"}]: ${message}`);
  }
  stopListening();
}
