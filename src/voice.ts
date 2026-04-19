import Decibri from "decibri";

const { DecibriOutput } = Decibri;

// Two parallel playback channels:
//   - oneShotSpeaker: short clips (intro, fillers) via playAudio()
//   - streamSpeaker:  per-turn streaming TTS queue via createPlaybackStream()
// They're tracked separately so the streaming queue can be created while a
// filler one-shot is still playing without either one stomping the other.
let oneShotSpeaker: InstanceType<typeof DecibriOutput> | null = null;
let streamSpeaker: InstanceType<typeof DecibriOutput> | null = null;

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
  return buf.subarray(44);
}

/** Play a WAV buffer through the default speaker via decibri (one-shot). */
export async function playAudio(buffer: Buffer): Promise<void> {
  if (oneShotSpeaker) {
    oneShotSpeaker.stop();
    oneShotSpeaker = null;
  }

  const pcm = extractPcm(Buffer.from(buffer));
  if (pcm.length === 0) return;

  return new Promise<void>((resolve, reject) => {
    const speaker = new DecibriOutput({
      sampleRate: 24000,
      channels: 1,
      format: "int16",
    });
    oneShotSpeaker = speaker;

    speaker.on("finish", () => {
      if (oneShotSpeaker === speaker) oneShotSpeaker = null;
      resolve();
    });
    speaker.on("error", (err) => {
      if (oneShotSpeaker === speaker) oneShotSpeaker = null;
      reject(err);
    });

    speaker.end(pcm);
  });
}

export interface PlaybackStream {
  /** Push a synthesized WAV buffer onto the queue. Buffered until start(). */
  enqueue(buffer: Buffer): void;
  /** Begin draining queued audio to the speaker. Safe to call before any enqueue. */
  start(): void;
  /** Signal end-of-stream; resolves once all queued audio has finished playing. */
  finish(): Promise<void>;
  /** Discard remaining queued audio and stop playback immediately. */
  stop(): void;
}

/**
 * Streaming playback channel for per-turn TTS.
 *
 * Synthesized chunks arrive in arbitrary timing (Murf round-trips race),
 * so the producer enqueues PCM payloads as they're ready. Playback only
 * starts when the caller calls start() — typically after the filler clip
 * finishes — so the user hears one continuous audio stream rather than
 * the filler being cut off mid-word.
 */
export function createPlaybackStream(): PlaybackStream {
  if (streamSpeaker) {
    streamSpeaker.stop();
    streamSpeaker = null;
  }

  const buffered: Buffer[] = [];
  let speaker: InstanceType<typeof DecibriOutput> | null = null;
  let started = false;
  let finished = false;
  let finishPromise: Promise<void> | null = null;

  const ensureSpeaker = () => {
    if (speaker) return;
    speaker = new DecibriOutput({
      sampleRate: 24000,
      channels: 1,
      format: "int16",
    });
    streamSpeaker = speaker;
    for (const chunk of buffered) speaker.write(chunk);
    buffered.length = 0;
  };

  return {
    enqueue(buffer: Buffer) {
      if (finished) return;
      const pcm = extractPcm(Buffer.from(buffer));
      if (pcm.length === 0) return;
      if (started) {
        ensureSpeaker();
        speaker!.write(pcm);
      } else {
        buffered.push(pcm);
      }
    },
    start() {
      if (started || finished) return;
      started = true;
      if (buffered.length > 0) ensureSpeaker();
    },
    finish(): Promise<void> {
      if (finishPromise) return finishPromise;
      finished = true;
      started = true;
      finishPromise = new Promise<void>((resolve, reject) => {
        if (!speaker) {
          resolve();
          return;
        }
        const sp = speaker;
        sp.on("finish", () => {
          if (streamSpeaker === sp) streamSpeaker = null;
          resolve();
        });
        sp.on("error", (err) => {
          if (streamSpeaker === sp) streamSpeaker = null;
          reject(err);
        });
        sp.end();
      });
      return finishPromise;
    },
    stop() {
      finished = true;
      started = true;
      buffered.length = 0;
      if (speaker) {
        speaker.stop();
        if (streamSpeaker === speaker) streamSpeaker = null;
        speaker = null;
      }
    },
  };
}

export function stopPlayback(): void {
  stopOneShotPlayback();
  if (streamSpeaker) {
    streamSpeaker.stop();
    streamSpeaker = null;
  }
}

/**
 * Stop only the one-shot channel (intro / fillers) without disturbing the
 * streaming channel. Used when a real streamed chunk arrives mid-filler —
 * we want the filler to die but the response audio to keep playing.
 */
export function stopOneShotPlayback(): void {
  if (oneShotSpeaker) {
    oneShotSpeaker.stop();
    oneShotSpeaker = null;
  }
}
