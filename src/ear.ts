import Decibri from "decibri";
import WebSocket from "ws";
import { logError, logSystem } from "./ui.js";

type TranscriptionCallback = (text: string) => void;

let mic: InstanceType<typeof Decibri> | null = null;
let ws: WebSocket | null = null;

/**
 * Tear down any existing mic capture and Deepgram WebSocket.
 */
export function stopListening(): void {
  if (mic) {
    mic.removeAllListeners();
    mic.stop();
    mic = null;
  }
  if (ws) {
    ws.removeAllListeners();
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
    ws = null;
  }
}

/**
 * Open Deepgram WS, start decibri mic capture, stream audio. Calls
 * onReady() when the first audio chunk reaches Deepgram (mic is genuinely hot).
 */
export function startListening(
  onTranscription: TranscriptionCallback,
  opts?: { quiet?: boolean; onReady?: () => void },
): void {
  stopListening();

  if (!process.env.DEEPGRAM_API_KEY) {
    logError("DEEPGRAM_API_KEY is not set. Add it to your .env file.");
    return;
  }

  const quiet = opts?.quiet ?? false;
  const onReady = opts?.onReady;

  const url =
    "wss://api.deepgram.com/v1/listen?" +
    "model=nova-2&language=en&smart_format=true&interim_results=true" +
    "&endpointing=200&encoding=linear16&sample_rate=16000&channels=1";

  if (!quiet) logSystem("Connecting to Deepgram…");

  ws = new WebSocket(url, {
    headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}` },
  });

  ws.on("open", () => {
    if (!quiet) logSystem("Deepgram connected — starting mic capture…");
    try {
      mic = new Decibri({
        sampleRate: 16000,
        channels: 1,
        format: "int16",
        framesPerBuffer: 1600,
      });

      let firstChunk = true;
      mic.on("data", (chunk: Buffer) => {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(chunk);
          if (firstChunk) {
            firstChunk = false;
            if (!quiet) logSystem("Mic active — streaming audio to Deepgram.");
            onReady?.();
          }
        }
      });

      mic.on("error", (err: Error) => {
        logError(`Mic capture error: ${err.message}`);
        stopListening();
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logError(`Mic init failed: ${message}`);
      stopListening();
    }
  });

  ws.on("message", (raw: Buffer) => {
    try {
      const data = JSON.parse(raw.toString());
      if (data.type === "Error" || data.error) {
        logError(`Deepgram: ${data.message || data.error || JSON.stringify(data).slice(0, 200)}`);
        return;
      }
      const transcript: string = data.channel?.alternatives?.[0]?.transcript ?? "";
      if (transcript.trim().length > 0 && data.is_final) {
        onTranscription(transcript.trim());
      }
    } catch {
      // non-JSON control frames
    }
  });

  ws.on("error", (err: Error) => logError(`Deepgram WS error: ${err.message}`));

  ws.on("close", (code: number, reason: Buffer) => {
    const reasonStr = reason?.toString().trim();
    if (!quiet) {
      logSystem(`Deepgram WS closed (code=${code}${reasonStr ? `, reason=${reasonStr}` : ""}).`);
    }
  });
}
