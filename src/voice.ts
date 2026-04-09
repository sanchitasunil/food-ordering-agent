import { spawn, type ChildProcess } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

let currentProcess: ChildProcess | null = null;

/** Fix RIFF sizes for streaming TTS; pad silence so SoX does not clip start/end. */
function repairWav(buf: Buffer): Buffer {
  if (buf.length < 44) return buf;
  if (buf.toString("ascii", 0, 4) !== "RIFF") return buf;
  if (buf.toString("ascii", 8, 12) !== "WAVE") return buf;

  const leadSilence = Buffer.alloc(7200); // 24kHz × 2 bytes × 0.15s
  const tailSilence = Buffer.alloc(9600); // 24kHz × 2 bytes × 0.2s

  const header = buf.subarray(0, 44);
  const audioData = buf.subarray(44);
  const padded = Buffer.concat([header, leadSilence, audioData, tailSilence]);

  padded.writeUInt32LE(padded.length - 8, 4);

  for (let i = 12; i < padded.length - 8; i++) {
    if (padded.toString("ascii", i, i + 4) === "data") {
      padded.writeUInt32LE(padded.length - i - 8, i + 4);
      break;
    }
  }

  return padded;
}

/** WAV → temp file → SoX to default output; resolves when playback ends. */
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

export function stopPlayback(): void {
  if (currentProcess) {
    currentProcess.kill();
    currentProcess = null;
  }
}
