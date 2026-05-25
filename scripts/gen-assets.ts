/**
 * One-shot script: synthesizes the three pre-baked audio clips that the agent
 * plays without hitting the Murf API at runtime.
 *
 *   npx tsx scripts/gen-assets.ts
 */

import "dotenv/config";
import { writeFileSync, mkdirSync, existsSync, symlinkSync } from "node:fs";
import { resolve } from "node:path";
import plugin from "openclaw-murf-tts";

let murfProvider: any;
plugin.register({ registerSpeechProvider(p: any) { murfProvider = p; } } as any);

const PROVIDER_CONFIG = {
  apiKey: process.env.MURF_API_KEY,
  voiceId: "en-IN-anisha",
  model: "FALCON",
  format: "WAV",
  sampleRate: 24000,
  locale: "en-IN",
  style: "Conversational",
  rate: 0,
  pitch: 0,
  region: "global",
};

const CLIPS: { file: string; text: string }[] = [
  {
    file: "intro.wav",
    text: "Hi, I'm your food ordering assistant. What are you in the mood for?",
  },
  {
    file: "filler.wav",
    text: "One moment please.",
  },
  {
    file: "filler-long.wav",
    text: "I'm checking on that for you.",
  },
];

async function synth(text: string): Promise<Buffer> {
  const result = await murfProvider.synthesize({
    text,
    target: "audio",
    providerConfig: PROVIDER_CONFIG,
    providerOverrides: {},
    timeoutMs: 30000,
  });
  if (!result?.audioBuffer) throw new Error(`No audio returned for: "${text}"`);
  return Buffer.isBuffer(result.audioBuffer)
    ? result.audioBuffer
    : Buffer.from(result.audioBuffer);
}

// OpenClaw resolves `read` tool paths relative to the workspace directory.
// Create workspace/skills → skills symlink so the agent can read CLI files.
const skillsLink = resolve("workspace", "skills");
if (!existsSync(skillsLink)) {
  try {
    symlinkSync(resolve("skills"), skillsLink, "junction");
    console.log("gen-assets: created workspace/skills → skills junction.");
  } catch {
    // Non-fatal — exec tool calls still work, only `read` on CLI files fails.
  }
}

if (!process.env.MURF_API_KEY) {
  console.log("gen-assets: MURF_API_KEY not set — skipping. Run `pnpm gen-assets` after adding it to .env.");
  process.exit(0);
}

const assetsDir = resolve("assets");
mkdirSync(assetsDir, { recursive: true });

console.log("Synthesizing clips with Murf Falcon / en-IN-anisha…\n");

for (const clip of CLIPS) {
  process.stdout.write(`  ${clip.file} — "${clip.text}" … `);
  const audio = await synth(clip.text);
  const outPath = resolve(assetsDir, clip.file);
  writeFileSync(outPath, audio);
  console.log(`${audio.length} bytes`);
}

console.log("\nDone. assets/ is ready.");
