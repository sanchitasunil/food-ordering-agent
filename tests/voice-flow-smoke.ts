/**
 * Voice flow smoke test — exercises the brain pipeline (OpenClaw + Swiggy
 * skill + Murf TTS) end-to-end with text input, since the real voice loop
 * needs a microphone we can't drive from a script. Also pings Deepgram's
 * WebSocket to verify auth + reachability without sending audio.
 *
 * Usage: pnpm tsx tests/voice-flow-smoke.ts
 *
 * Saves Murf audio output to test-output-*.wav files at repo root so you
 * can play them back manually to verify the speaker leg.
 */

import "dotenv/config";
import { writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import WebSocket from "ws";
import { getReplyFromConfig } from "openclaw";
import {
  warmup,
  synthesizeSpeech,
  CONFIG_OVERRIDE,
  ACTIVE_PROVIDER,
  ACTIVE_MODEL,
} from "../src/brain.js";

const BENGALURU = { lat: 12.9716, lng: 77.5946 };

/**
 * Heuristic: detect responses that "look successful" (non-empty text + valid
 * audio) but actually carry an error string. Without this, the harness will
 * happily report PASS when the LLM call failed and we just TTS'd the error.
 */
function looksLikeErrorResponse(text: string): boolean {
  const t = text.toLowerCase();
  return (
    t.includes("http 4") ||
    t.includes("http 5") ||
    t.includes("not a valid model") ||
    t.includes("invalid api key") ||
    t.startsWith("error:") ||
    t.includes("rawerror=")
  );
}

interface ToolEvent {
  name: string;
  startedAtMs: number;
}

interface RunResult {
  prompt: string;
  ok: boolean;
  text: string;
  audio: Buffer | null;
  audioBytes: number | null;
  audioRiffValid: boolean;
  textLooksLikeError: boolean;
  agentMs: number;
  ttsMs: number;
  totalMs: number;
  toolEvents: ToolEvent[];
  error?: string;
}

async function runOne(sessionKey: string, prompt: string): Promise<RunResult> {
  const start = performance.now();
  const toolEvents: ToolEvent[] = [];

  let text = "";
  let agentMs = 0;
  let ttsMs = 0;
  let audio: Buffer | null = null;

  try {
    const ctx = {
      Body: prompt,
      SessionKey: sessionKey,
      CommandSource: "native" as const,
      Provider: "cli",
      SenderName: "User",
      Location: BENGALURU,
    };

    const agentStart = performance.now();
    const result = await getReplyFromConfig(
      ctx,
      {
        onToolStart(payload: any) {
          if (payload?.name) {
            toolEvents.push({
              name: payload.name,
              startedAtMs: performance.now() - start,
            });
          }
          // Debug: dump full hook payload once per tool
          console.log(
            `    [hook onToolStart] ${JSON.stringify(payload).slice(0, 300)}`,
          );
        },
      },
      CONFIG_OVERRIDE,
    );
    agentMs = performance.now() - agentStart;

    const payload = Array.isArray(result) ? result[0] : result;
    text = payload?.text ?? "";

    // Debug: if text is empty, dump everything we can see about the result
    // so we can diagnose whether openclaw returned undefined, an empty
    // string, or text in a different field. Defensive against undefined.
    if (!text) {
      const resultType =
        result === undefined
          ? "undefined"
          : result === null
            ? "null"
            : Array.isArray(result)
              ? `array(len=${result.length})`
              : typeof result === "object"
                ? `object(keys=[${Object.keys(result).join(",")}])`
                : typeof result;
      console.log(`    [debug] empty text. result type: ${resultType}`);
      try {
        const raw = JSON.stringify(result, null, 2);
        if (raw === undefined) {
          console.log(`    [debug] JSON.stringify(result) -> undefined`);
        } else {
          console.log(
            `    [debug] raw result (first 1500 chars):\n${raw.slice(0, 1500)}`,
          );
        }
      } catch (e) {
        console.log(
          `    [debug] could not stringify result: ${e instanceof Error ? e.message : e}`,
        );
      }
      const payloadType =
        payload === undefined
          ? "undefined"
          : payload === null
            ? "null"
            : typeof payload === "object"
              ? `object(keys=[${Object.keys(payload).join(",")}])`
              : typeof payload;
      console.log(`    [debug] payload type: ${payloadType}`);
    }

    if (text) {
      const ttsStart = performance.now();
      audio = await synthesizeSpeech(text);
      ttsMs = performance.now() - ttsStart;
    }

    const audioBytes = audio ? audio.length : null;
    const audioRiffValid =
      audio != null &&
      audio.length > 44 &&
      audio.toString("ascii", 0, 4) === "RIFF" &&
      audio.toString("ascii", 8, 12) === "WAVE";
    const textLooksLikeError = looksLikeErrorResponse(text);

    return {
      prompt,
      // ok must be REAL: non-empty text, valid audio, AND text doesn't look
      // like an error string (e.g. "HTTP 400: ... not a valid model id").
      ok:
        text.length > 0 && audio != null && audioRiffValid && !textLooksLikeError,
      text,
      audio,
      audioBytes,
      audioRiffValid,
      textLooksLikeError,
      agentMs,
      ttsMs,
      totalMs: agentMs + ttsMs,
      toolEvents,
    };
  } catch (err) {
    return {
      prompt,
      ok: false,
      text,
      audio,
      audioBytes: audio ? audio.length : null,
      audioRiffValid: false,
      textLooksLikeError: looksLikeErrorResponse(text),
      agentMs,
      ttsMs,
      totalMs: performance.now() - start,
      toolEvents,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

interface DeepgramResult {
  ok: boolean;
  ms: number;
  error?: string;
}

async function smokeTestDeepgram(): Promise<DeepgramResult> {
  const url =
    "wss://api.deepgram.com/v1/listen?" +
    "model=nova-2&language=en&smart_format=true" +
    "&encoding=linear16&sample_rate=16000&channels=1";

  return new Promise((resolveResult) => {
    const start = performance.now();
    let resolved = false;
    const finish = (result: DeepgramResult) => {
      if (resolved) return;
      resolved = true;
      resolveResult(result);
    };

    try {
      const ws = new WebSocket(url, {
        headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}` },
      });

      ws.on("open", () => {
        const ms = performance.now() - start;
        ws.close();
        finish({ ok: true, ms });
      });
      ws.on("error", (err: Error) => {
        finish({
          ok: false,
          ms: performance.now() - start,
          error: err.message,
        });
      });
      ws.on("unexpected-response", (_req, res) => {
        finish({
          ok: false,
          ms: performance.now() - start,
          error: `HTTP ${res.statusCode}: ${res.statusMessage}`,
        });
      });
      setTimeout(
        () =>
          finish({
            ok: false,
            ms: performance.now() - start,
            error: "timeout after 10s",
          }),
        10000,
      );
    } catch (err) {
      finish({
        ok: false,
        ms: performance.now() - start,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

function hr(label: string): void {
  console.log(`\n=== ${label} ===`);
}

async function main(): Promise<void> {
  console.log("Voice flow smoke test — Deepgram + OpenClaw + Swiggy + Murf");
  console.log("(Mic capture and speaker playback are NOT tested — see report.)");
  console.log(`Active LLM: ${ACTIVE_PROVIDER} → ${ACTIVE_MODEL}`);

  // ── 1. Deepgram WS auth/reachability ──────────────────────────
  hr("[1/5] Deepgram WS auth + reachability");
  const dg = await smokeTestDeepgram();
  if (dg.ok) {
    console.log(`  ok=true (open in ${dg.ms.toFixed(0)}ms)`);
  } else {
    console.log(`  ok=false (after ${dg.ms.toFixed(0)}ms): ${dg.error}`);
  }

  // ── 2. OpenClaw warmup ────────────────────────────────────────
  hr("[2/5] OpenClaw warmup");
  const warmStart = performance.now();
  await warmup();
  const warmMs = performance.now() - warmStart;
  console.log(`  warmup: ${warmMs.toFixed(0)}ms`);

  // ── 3. Standalone Murf TTS ────────────────────────────────────
  hr("[3/5] Standalone Murf TTS");
  const tStart = performance.now();
  const tBuf = await synthesizeSpeech("Hello, this is a Murf TTS smoke test.");
  const tMs = performance.now() - tStart;
  if (tBuf) {
    const valid =
      tBuf.length > 44 &&
      tBuf.toString("ascii", 0, 4) === "RIFF" &&
      tBuf.toString("ascii", 8, 12) === "WAVE";
    console.log(
      `  ok=true (${tBuf.length} bytes, RIFF/WAVE=${valid}, ${tMs.toFixed(0)}ms)`,
    );
    await writeFile("test-output-tts.wav", tBuf);
    console.log(`  → saved to test-output-tts.wav`);
  } else {
    console.log(`  ok=false (no audio after ${tMs.toFixed(0)}ms)`);
  }

  // ── 4. Brain pipeline: simple prompt (1 tool call expected) ───
  hr("[4/5] Brain pipeline — simple prompt");
  const simple = await runOne(
    "voice-test-simple",
    "What delivery addresses do I have saved on Swiggy?",
  );
  reportRun(simple);
  if (simple.audio && simple.audioRiffValid) {
    await writeFile("test-output-simple.wav", simple.audio);
    console.log(`  → saved reply audio to test-output-simple.wav`);
  }

  // ── 5. Brain pipeline: realistic chained prompt ───────────────
  hr("[5/5] Brain pipeline — realistic chained prompt");
  const chained = await runOne(
    "voice-test-chained",
    "Find me biryani restaurants near home and tell me the top two.",
  );
  reportRun(chained);
  if (chained.audio && chained.audioRiffValid) {
    await writeFile("test-output-chained.wav", chained.audio);
    console.log(`  → saved reply audio to test-output-chained.wav`);
  }

  // ── Summary ───────────────────────────────────────────────────
  hr("Summary");
  console.log(`Deepgram WS:        ${dg.ok ? "PASS" : "FAIL"} (${dg.ms.toFixed(0)}ms)`);
  console.log(`OpenClaw warmup:    ${warmMs.toFixed(0)}ms`);
  console.log(`Standalone Murf:    ${tBuf ? "PASS" : "FAIL"} (${tMs.toFixed(0)}ms)`);
  console.log(
    `Simple chat:        ${simple.ok ? "PASS" : "FAIL"} (agent ${simple.agentMs.toFixed(0)}ms + tts ${simple.ttsMs.toFixed(0)}ms = ${simple.totalMs.toFixed(0)}ms, ${simple.toolEvents.length} tool calls)`,
  );
  console.log(
    `Chained chat:       ${chained.ok ? "PASS" : "FAIL"} (agent ${chained.agentMs.toFixed(0)}ms + tts ${chained.ttsMs.toFixed(0)}ms = ${chained.totalMs.toFixed(0)}ms, ${chained.toolEvents.length} tool calls)`,
  );
}

function reportRun(r: RunResult): void {
  console.log(`  prompt: ${JSON.stringify(r.prompt)}`);
  console.log(`  ok: ${r.ok}`);
  console.log(`  agent (LLM + tool calls): ${r.agentMs.toFixed(0)}ms`);
  console.log(`  tts (Murf):               ${r.ttsMs.toFixed(0)}ms`);
  console.log(`  total:                    ${r.totalMs.toFixed(0)}ms`);
  if (r.toolEvents.length > 0) {
    console.log(`  tool sequence:`);
    for (const t of r.toolEvents) {
      console.log(`    - ${t.name} @ +${t.startedAtMs.toFixed(0)}ms`);
    }
  } else {
    console.log(`  tool sequence: (none — pure LLM reply)`);
  }
  console.log(
    `  audio: ${r.audioBytes ?? "null"} bytes, RIFF/WAVE=${r.audioRiffValid}`,
  );
  if (r.textLooksLikeError) {
    console.log(`  ⚠️  text looks like an error string — counted as FAIL`);
  }
  const snippet = r.text.length > 300 ? r.text.slice(0, 300) + "…" : r.text;
  console.log(`  text: ${snippet}`);
  if (r.error) console.log(`  ERROR: ${r.error}`);
}

main().catch((err) => {
  console.error("Test harness crashed:", err);
  process.exit(1);
});
