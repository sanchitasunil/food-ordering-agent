/**
 * Isolated test for the Murf chunking + WAV concat fix in src/brain.ts.
 * Hits Murf only — does not start OpenClaw, does not call any LLM, does
 * not load swiggy. This lets us verify the chunking math without burning
 * Gemini quota or waiting on the slow warmup path.
 *
 * Run: pnpm tsx tests/murf-chunking-smoke.ts
 */

import "dotenv/config";
import { writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { synthesizeSpeech } from "../src/brain.js";

interface Case {
  name: string;
  text: string;
  expectChunks: "1" | "≥2";
}

const sentence =
  "This is a deliberately long passage designed to verify that the brain " +
  "layer correctly chunks text on sentence boundaries, synthesizes each " +
  "chunk through Murf separately, and stitches the resulting WAV buffers " +
  "into a single playable file. ";

const cases: Case[] = [
  {
    name: "short",
    text: "Hello, this is a short Murf test.",
    expectChunks: "1",
  },
  {
    name: "near-budget",
    // ~1428 chars — just under the 1500-char per-chunk budget so we
    // exercise the single-chunk path at the largest realistic size.
    text: sentence.repeat(6),
    expectChunks: "1",
  },
  {
    name: "long",
    // ~3808 chars → forces ≥3 chunks at the 1500 budget. This is the
    // case the old single-shot synthesizeSpeech could not handle at all
    // (it would have hit Murf's 3000-char server cap and thrown HTTP 400).
    text: sentence.repeat(16),
    expectChunks: "≥2",
  },
];

function findDataChunkSize(buf: Buffer): number {
  for (let i = 12; i < buf.length - 8; i++) {
    if (buf.toString("ascii", i, i + 4) === "data") {
      return buf.readUInt32LE(i + 4);
    }
  }
  return -1;
}

async function runCase(c: Case): Promise<void> {
  console.log(`\n── ${c.name} (${c.text.length} chars, expect ${c.expectChunks} chunks) ──`);
  const start = performance.now();
  let buf: Buffer | null = null;
  let err: string | undefined;
  try {
    buf = await synthesizeSpeech(c.text);
  } catch (e) {
    err = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }
  const ms = performance.now() - start;

  if (!buf) {
    console.log(`  FAIL after ${ms.toFixed(0)}ms`);
    if (err) console.log(`  error: ${err}`);
    return;
  }

  const valid =
    buf.length > 44 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WAVE";
  const dataSize = findDataChunkSize(buf);
  const riffSize = buf.length >= 8 ? buf.readUInt32LE(4) : -1;
  const expectedRiffSize = buf.length - 8;

  console.log(`  PASS in ${ms.toFixed(0)}ms`);
  console.log(`    bytes:    ${buf.length}`);
  console.log(`    RIFF:     ${valid ? "ok" : "BAD"}`);
  console.log(
    `    riff hdr: claims ${riffSize} bytes, expected ${expectedRiffSize} (${riffSize === expectedRiffSize ? "ok" : "MISMATCH"})`,
  );
  console.log(
    `    data hdr: claims ${dataSize} bytes (PCM payload should be ${buf.length - 44}-ish at 44-byte header)`,
  );

  const outName = `test-output-murf-${c.name}.wav`;
  await writeFile(outName, buf);
  console.log(`    saved to ${outName}`);
}

async function main(): Promise<void> {
  console.log("Murf chunking + WAV concat — isolated smoke test");
  console.log("(Bypasses OpenClaw / LLM / swiggy. Only Murf is exercised.)");

  for (const c of cases) {
    await runCase(c);
  }

  console.log("\nDone. Play the test-output-murf-*.wav files to verify audibly.");
}

main().catch((err) => {
  console.error("Harness crashed:", err);
  process.exit(1);
});
