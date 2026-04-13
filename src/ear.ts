import { spawn, type ChildProcess } from "node:child_process";
import WebSocket from "ws";
import { logError, logSystem } from "./ui.js";

type TranscriptionCallback = (text: string) => void;

let soxProcess: ChildProcess | null = null;
let ws: WebSocket | null = null;

/**
 * Tear down any existing SoX process and Deepgram WebSocket.
 */
export function stopListening(): void {
  if (soxProcess) {
    soxProcess.removeAllListeners();
    soxProcess.stdout?.removeAllListeners();
    soxProcess.stderr?.removeAllListeners();
    soxProcess.kill();
    soxProcess = null;
  }
  if (ws) {
    ws.removeAllListeners();
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
    ws = null;
  }
}

function startMicCapture(): ChildProcess {
  return spawn("sox", [
    "-t", "waveaudio", "default",
    "--no-show-progress",
    "--rate", "16000",
    "--channels", "1",
    "--encoding", "signed-integer",
    "--bits", "16",
    "--type", "raw",
    "-",
  ]);
}

/**
 * Open Deepgram WS, spawn SoX, stream mic audio. Calls onReady() when
 * the first audio chunk reaches Deepgram (mic is genuinely hot).
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
    "&endpointing=300&encoding=linear16&sample_rate=16000&channels=1";

  if (!quiet) logSystem("Connecting to Deepgram…");

  ws = new WebSocket(url, {
    headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}` },
  });

  ws.on("open", () => {
    if (!quiet) logSystem("Deepgram connected — starting mic capture…");
    try {
      soxProcess = startMicCapture();

      soxProcess.on("error", (err: Error) => handleRecordingError(err));

      let firstChunk = true;
      soxProcess.stdout!.on("data", (chunk: Buffer) => {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(chunk);
          if (firstChunk) {
            firstChunk = false;
            if (!quiet) logSystem("Mic active — streaming audio to Deepgram.");
            onReady?.();
          }
        }
      });

      soxProcess.stderr!.on("data", (data: Buffer) => {
        const msg = data.toString().trim();
        if (!msg) return;
        if (/error|fail|cannot|denied|not found|ENOENT/i.test(msg)) {
          handleRecordingError(new Error(msg));
        }
      });

      soxProcess.on("close", (code) => {
        if (code && code !== 0) logError(`SoX exited with code ${code}`);
      });
    } catch (err: unknown) {
      handleRecordingError(err);
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

  ws.on("close", (code, reason) => {
    const reasonStr = reason?.toString().trim();
    if (!quiet) {
      logSystem(`Deepgram WS closed (code=${code}${reasonStr ? `, reason=${reasonStr}` : ""}).`);
    }
  });
}

function handleRecordingError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as NodeJS.ErrnoException)?.code;

  if (code === "ENOENT" && /sox/i.test(message)) {
    logError(
      "Microphone access failed. Windows requires SoX. " +
        "Download from SourceForge and add it to your PATH, or run this in WSL.",
    );
  } else {
    logError(`Recording failed [${code ?? "unknown"}]: ${message}`);
  }
  stopListening();
}
