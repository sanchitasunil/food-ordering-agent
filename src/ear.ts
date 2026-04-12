import { spawn, type ChildProcess } from "node:child_process";
import WebSocket from "ws";
import { logError, logSystem } from "./ui.js";

type TranscriptionCallback = (text: string) => void;

let soxProcess: ChildProcess | null = null;
let ws: WebSocket | null = null;

/**
 * Tear down any existing SoX process and Deepgram WebSocket. Safe to call
 * at any time — idempotent, removes all listeners before killing so we
 * don't leak EventEmitter handles across start/stop cycles.
 */
export function stopListening(): void {
  if (soxProcess) {
    // Remove all listeners BEFORE kill so the error/close events from the
    // dying process don't trigger handleRecordingError() or accumulate.
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

/** SoX capture: waveaudio works on Windows; raw PCM to stdout for Deepgram. */
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
 * Begin streaming mic audio to Deepgram via a raw WebSocket.
 * Calls `onTranscription` with the final transcript of each utterance.
 *
 * Always call stopListening() before calling this again — otherwise the
 * previous SoX/WS pair is leaked and you'll hit MaxListeners.
 */
export function startListening(onTranscription: TranscriptionCallback): void {
  // Defensive: tear down any lingering session before opening a new one.
  stopListening();

  if (!process.env.DEEPGRAM_API_KEY) {
    logError("DEEPGRAM_API_KEY is not set. Add it to your .env file.");
    return;
  }

  const url =
    "wss://api.deepgram.com/v1/listen?" +
    "model=nova-2&language=en&smart_format=true&interim_results=true" +
    "&endpointing=300&encoding=linear16&sample_rate=16000&channels=1";

  logSystem("Connecting to Deepgram…");

  ws = new WebSocket(url, {
    headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}` },
  });

  ws.on("open", () => {
    logSystem("Deepgram connected — starting mic capture…");
    try {
      soxProcess = startMicCapture();

      soxProcess.on("error", (err: Error) => {
        handleRecordingError(err);
      });

      let audioBytesSent = 0;
      soxProcess.stdout!.on("data", (chunk: Buffer) => {
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(chunk);
          audioBytesSent += chunk.length;
          // Log once after the first chunk so we know audio is flowing.
          if (audioBytesSent === chunk.length) {
            logSystem("Mic active — streaming audio to Deepgram.");
          }
        }
      });

      // SoX writes informational messages to stderr (e.g. "processing...")
      // that are NOT errors. Only escalate to handleRecordingError if the
      // message looks like an actual failure. Otherwise the mic gets killed
      // on the first benign stderr line.
      soxProcess.stderr!.on("data", (data: Buffer) => {
        const msg = data.toString().trim();
        if (!msg) return;
        const isRealError =
          /error|fail|cannot|denied|not found|ENOENT/i.test(msg);
        if (isRealError) handleRecordingError(new Error(msg));
      });

      soxProcess.on("close", (code) => {
        if (code && code !== 0) {
          logError(`SoX exited with code ${code}`);
        }
      });
    } catch (err: unknown) {
      handleRecordingError(err);
    }
  });

  ws.on("message", (raw: Buffer) => {
    try {
      const data = JSON.parse(raw.toString());

      // Deepgram sends error frames before closing — surface them.
      if (data.type === "Error" || data.error) {
        logError(
          `Deepgram: ${data.message || data.error || JSON.stringify(data).slice(0, 200)}`,
        );
        return;
      }

      const transcript: string =
        data.channel?.alternatives?.[0]?.transcript ?? "";
      if (transcript.trim().length > 0 && data.is_final) {
        onTranscription(transcript.trim());
      }
    } catch {
      // Deepgram may send non-JSON control frames
    }
  });

  ws.on("error", (err: Error) => {
    logError(`Deepgram WS error: ${err.message}`);
  });

  ws.on("close", (code, reason) => {
    const reasonStr = reason?.toString().trim();
    logSystem(
      `Deepgram WS closed (code=${code}${reasonStr ? `, reason=${reasonStr}` : ""}).`,
    );
    if (code === 1011) {
      logError(
        "Deepgram closed with 1011 (internal error). This usually means " +
          "your free credits are exhausted or the API key lacks streaming scope. " +
          "Check your balance at https://console.deepgram.com and top up if needed.",
      );
    }
  });
}

/** Missing SoX on Windows surfaces as ENOENT; user gets install instructions. */
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
