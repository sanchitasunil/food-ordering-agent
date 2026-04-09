import { spawn, type ChildProcess } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

let currentProcess: ChildProcess | null = null;

/**
 * Fix a WAV buffer whose RIFF/data chunk sizes may be incorrect
 * (common with streaming TTS APIs that don't know the final size upfront).
 * Also appends ~200ms of silence to prevent SoX clipping the tail.
 */
function repairWav(buf: Buffer): Buffer {
  if (buf.length < 44) return buf;
  if (buf.toString("ascii", 0, 4) !== "RIFF") return buf;
  if (buf.toString("ascii", 8, 12) !== "WAVE") return buf;

  // Pad ~150ms silence at start + ~200ms at end to prevent SoX clipping
  const leadSilence = Buffer.alloc(7200);  // 24000 Hz × 2 bytes × 0.15s
  const tailSilence = Buffer.alloc(9600);  // 24000 Hz × 2 bytes × 0.2s

  // Split header (first 44 bytes) from audio data
  const header = buf.subarray(0, 44);
  const audioData = buf.subarray(44);
  const padded = Buffer.concat([header, leadSilence, audioData, tailSilence]);

  // Patch RIFF chunk size
  padded.writeUInt32LE(padded.length - 8, 4);

  // Patch data sub-chunk size
  for (let i = 12; i < padded.length - 8; i++) {
    if (padded.toString("ascii", i, i + 4) === "data") {
      padded.writeUInt32LE(padded.length - i - 8, i + 4);
      break;
    }
  }

  return padded;
}

/**
 * Plays a WAV audio buffer through system speakers using SoX.
 * Resolves when playback finishes.
 */
export async function playAudio(buffer: Buffer): Promise<void> {
  const fixed = repairWav(Buffer.from(buffer));
  const tmpPath = join(tmpdir(), `openclaw-tts-${randomBytes(4).toString("hex")}.wav`);
  await writeFile(tmpPath, fixed);

  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn("sox", [tmpPath, "-t", "waveaudio", "default"], {
        stdio: "ignore",
      });
      currentProcess = proc;

      proc.on("close", () => {
        currentProcess = null;
        resolve();
      });
      proc.on("error", (err) => {
        currentProcess = null;
        reject(err);
      });
    });
  } finally {
    await unlink(tmpPath).catch(() => {});
  }
}

/**
 * Kill any in-progress playback immediately.
 */
export function stopPlayback(): void {
  if (currentProcess) {
    currentProcess.kill();
    currentProcess = null;
  }
}
