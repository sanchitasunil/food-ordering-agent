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
 *
 * If `micArmed` is provided, the WS connects immediately but mic capture
 * is deferred until the promise resolves — lets callers overlap the WS
 * handshake with TTS playback so the user can speak the instant TTS ends.
 */
export function startListening(
  onTranscription: TranscriptionCallback,
  opts?: {
    quiet?: boolean;
    onReady?: () => void;
    keyterms?: string[];
    micArmed?: Promise<void>;
  },
): void {
  stopListening();

  if (!process.env.DEEPGRAM_API_KEY) {
    logError("DEEPGRAM_API_KEY is not set. Add it to your .env file.");
    return;
  }

  const quiet = opts?.quiet ?? false;
  const onReady = opts?.onReady;
  const keyterms = opts?.keyterms ?? [];
  const micArmed = opts?.micArmed ?? Promise.resolve();

  // Flux is Deepgram's voice-agent model with model-integrated end-of-turn
  // detection and ultra-low latency. Flux uses the /v2/listen endpoint
  // (NOT /v1/listen — that returns 400) and emits TurnInfo messages with
  // event="EndOfTurn" instead of Nova's is_final/speech_final fields.
  // Keyterms bias recognition; without them Flux mangles domain words like
  // "biryani" into English-sounding nonsense ("baby on you").
  // Spaces in multi-word keyterms must be form-encoded as `+`, not `%20`,
  // or Deepgram silently closes the WS. URLSearchParams handles this.
  const params = new URLSearchParams();
  params.append("model", "flux-general-en");
  params.append("encoding", "linear16");
  params.append("sample_rate", "16000");
  for (const k of keyterms) params.append("keyterm", k);
  const url = `wss://api.deepgram.com/v2/listen?${params.toString()}`;

  if (!quiet) logSystem("Connecting to Deepgram…");

  ws = new WebSocket(url, {
    headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}` },
  });

  // Track the WS instance this handler was created for, so a stale "open"
  // event fired after stopListening() doesn't init a mic on a dead socket.
  const wsForOpen = ws;
  ws.on("open", () => {
    if (!quiet) logSystem("Deepgram connected — waiting for mic to arm…");
    micArmed.then(() => {
      if (ws !== wsForOpen) return; // we were torn down before the mic was armed
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
  });

  ws.on("message", (raw: Buffer) => {
    try {
      const data = JSON.parse(raw.toString());
      if (data.type === "Error" || data.error) {
        logError(`Deepgram: ${data.message || data.error || JSON.stringify(data).slice(0, 200)}`);
        return;
      }
      // Flux emits TurnInfo messages with an `event` field.
      // EndOfTurn fires when the model is confident the user's turn is over.
      // EagerEndOfTurn / TurnResumed are optimization hooks we don't use yet.
      if (data.type === "TurnInfo") {
        if (data.event === "EndOfTurn") {
          const transcript: string = data.transcript ?? "";
          if (transcript.trim().length > 0) {
            onTranscription(transcript.trim());
          }
        }
        return;
      }
      // Connected is the normal handshake ack; silently ignore.
      if (data.type === "Connected") return;
      // Surface anything else — warnings, metadata, etc. Helps diagnose
      // silent failures (e.g. unsupported params).
      logError(`Deepgram unexpected: ${JSON.stringify(data).slice(0, 300)}`);
    } catch {
      // non-JSON control frames
    }
  });

  ws.on("error", (err: Error) => logError(`Deepgram WS error: ${err.message}`));

  ws.on("close", (code: number, reason: Buffer) => {
    const reasonStr = reason?.toString().trim();
    // Always surface non-clean closes — quiet mode shouldn't hide a silent
    // disconnect, since that's indistinguishable from a working but mute mic.
    if (code !== 1000) {
      logError(`Deepgram WS closed (code=${code}${reasonStr ? `, reason=${reasonStr}` : ""}).`);
    } else if (!quiet) {
      logSystem(`Deepgram WS closed (code=${code}${reasonStr ? `, reason=${reasonStr}` : ""}).`);
    }
  });
}
