import Decibri from "decibri";

const { DecibriOutput } = Decibri;

let currentSpeaker: InstanceType<typeof DecibriOutput> | null = null;

/**
 * Extract raw PCM data from a WAV buffer, skipping the header.
 * Returns the PCM payload starting after the "data" sub-chunk header.
 */
function extractPcm(buf: Buffer): Buffer {
  if (buf.length < 44) return buf;
  if (buf.toString("ascii", 0, 4) !== "RIFF") return buf;
  for (let i = 12; i < buf.length - 8; i++) {
    if (buf.toString("ascii", i, i + 4) === "data") {
      return buf.subarray(i + 8);
    }
  }
  // Fallback: assume standard 44-byte header
  return buf.subarray(44);
}

/** Play a WAV buffer through the default speaker via decibri. */
export async function playAudio(buffer: Buffer): Promise<void> {
  stopPlayback();

  const pcm = extractPcm(Buffer.from(buffer));
  if (pcm.length === 0) return;

  return new Promise<void>((resolve, reject) => {
    const speaker = new DecibriOutput({
      sampleRate: 24000,
      channels: 1,
      format: "int16",
    });
    currentSpeaker = speaker;

    speaker.on("finish", () => {
      currentSpeaker = null;
      resolve();
    });
    speaker.on("error", (err) => {
      currentSpeaker = null;
      reject(err);
    });

    speaker.end(pcm);
  });
}

export function stopPlayback(): void {
  if (currentSpeaker) {
    currentSpeaker.stop();
    currentSpeaker = null;
  }
}
