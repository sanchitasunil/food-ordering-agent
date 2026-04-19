/**
 * Diagnostic: connect to Deepgram with our exact URL + keyterms, stream a
 * known WAV, log every message. Run: pnpm tsx tests/stt-diagnostic.ts
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import WebSocket from "ws";

const KEYTERMS_FILE = "keyterms.json";
const WAV_FILE = "assets/intro.wav";

const keyterms: string[] = (() => {
  try {
    const parsed = JSON.parse(readFileSync(KEYTERMS_FILE, "utf8"));
    return Array.isArray(parsed.base) ? parsed.base : [];
  } catch {
    return [];
  }
})();

const params = new URLSearchParams();
params.append("model", "flux-general-en");
params.append("encoding", "linear16");
params.append("sample_rate", "16000");
for (const k of keyterms) params.append("keyterm", k);
const url = `wss://api.deepgram.com/v2/listen?${params.toString()}`;

console.log(`URL length: ${url.length}`);
console.log(`Keyterm count: ${keyterms.length}`);
console.log(`URL preview: ${url.slice(0, 200)}…`);

const ws = new WebSocket(url, {
  headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}` },
});

ws.on("open", () => {
  console.log("[WS] open");

  // intro.wav is 24kHz from Murf, but Deepgram is told 16kHz linear16.
  // For a real test we should send 16kHz audio. Let's just send raw bytes
  // after the WAV header (44 bytes) — even mismatched, Deepgram should
  // emit some StartOfTurn or error, not stay silent.
  const wav = readFileSync(WAV_FILE);
  const pcm = wav.slice(44);
  console.log(`[WS] sending ${pcm.length} bytes of PCM in 1600-byte chunks`);

  let offset = 0;
  const interval = setInterval(() => {
    if (offset >= pcm.length) {
      clearInterval(interval);
      console.log("[WS] done sending; waiting 3s for trailing messages…");
      setTimeout(() => {
        ws.close();
        process.exit(0);
      }, 3000);
      return;
    }
    const chunk = pcm.slice(offset, offset + 3200);
    ws.send(chunk);
    offset += 3200;
  }, 100);
});

ws.on("message", (raw: Buffer) => {
  console.log(`[MSG] ${raw.toString().slice(0, 500)}`);
});

ws.on("error", (err: Error) => console.log(`[ERR] ${err.message}`));
ws.on("close", (code: number, reason: Buffer) => {
  console.log(`[CLOSE] code=${code} reason=${reason?.toString()}`);
});
