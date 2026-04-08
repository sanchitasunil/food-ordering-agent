import { execFile } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

/**
 * Fix a WAV buffer whose RIFF/data chunk sizes may be incorrect
 * (common with streaming TTS APIs that don't know the final size upfront).
 */
function repairWavHeader(buf: Buffer): Buffer {
  if (buf.length < 44) return buf;
  if (buf.toString("ascii", 0, 4) !== "RIFF") return buf;
  if (buf.toString("ascii", 8, 12) !== "WAVE") return buf;

  buf.writeUInt32LE(buf.length - 8, 4);

  for (let i = 12; i < buf.length - 8; i++) {
    if (buf.toString("ascii", i, i + 4) === "data") {
      buf.writeUInt32LE(buf.length - i - 8, i + 4);
      break;
    }
  }

  return buf;
}

/**
 * Plays a WAV audio buffer through system speakers using SoX.
 * SoX is already required for mic capture, so no extra dependency.
 * Resolves when playback finishes.
 */
export async function playAudio(buffer: Buffer): Promise<void> {
  const fixed = repairWavHeader(Buffer.from(buffer));
  const tmpPath = join(tmpdir(), `openclaw-tts-${randomBytes(4).toString("hex")}.wav`);
  await writeFile(tmpPath, fixed);

  try {
    await new Promise<void>((resolve, reject) => {
      execFile(
        "sox",
        [tmpPath, "-t", "waveaudio", "default"],
        (err) => (err ? reject(err) : resolve()),
      );
    });
  } finally {
    await unlink(tmpPath).catch(() => {});
  }
}
