import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { getReplyFromConfig } from "openclaw";
import plugin from "openclaw-murf-tts";
import { logTool, logAgent } from "./ui.js";

// Local openclaw.json instead of ~/.openclaw/
process.env.OPENCLAW_CONFIG_PATH ??= resolve("openclaw.json");

// ── Suppress noisy openclaw stderr ───────────────────────────────
// Openclaw prints "Config warnings", "diagnostic", and ANSI-colored
// "[agent]" lines to stderr on every LLM call. These pollute the
// terminal and confuse users. Intercept stderr.write and silently
// drop lines that match known noise patterns.
const _origStderrWrite = process.stderr.write.bind(process.stderr);
const NOISE_PATTERNS = [
  /Config warnings/,
  /plugin not found/,
  /\[diagnostic\]/,
  /lane wait exceeded/,
  /\[agent\]/,
  /embedded run agent end/,
  /embedded run failover/,
  /stale config entry/,
];
process.stderr.write = function (chunk: any, ...args: any[]): boolean {
  const str = typeof chunk === "string" ? chunk : chunk?.toString?.() ?? "";
  if (NOISE_PATTERNS.some((p) => p.test(str))) return true; // swallow
  return (_origStderrWrite as any)(chunk, ...args);
} as any;

// openclaw-murf-tts exposes the synthesizer only through plugin.register()
let murfProvider: any;
plugin.register({
  registerSpeechProvider(p: any) { murfProvider = p; },
} as any);

// Unique session key per process so stale conversation history from a
// previous run can't poison the current one (we got burned by the agent
// remembering a failed `swiggy` command and refusing to retry).
const SESSION_KEY = `food-agent-${Date.now()}`;
const BENGALURU = { lat: 12.9716, lng: 77.5946 };

// LLM_PROVIDER: gemini | openrouter | opencode. Optional LLM_MODEL overrides
// the default for the active provider. Keys: GEMINI_API_KEY, OPENROUTER_API_KEY,
// OPENCODE_API_KEY (opencode = SST opencode.ai Zen gateway).
//
// Per node_modules/openclaw/docs/providers/opencode.md the supported Zen models
// are e.g. opencode/claude-opus-4-6, opencode/gpt-5.4, opencode/gemini-3-pro.
// Earlier we tried `opencode/big-pickle` (sourced from a third-party catalog
// mirror) and it hung the warmup indefinitely — that model id is not routable
// through openclaw's opencode provider. Default to gemini-3-pro since Gemini
// is the family we already know works for tool calling here.
const PROVIDER_DEFAULT_MODELS: Record<string, string> = {
  gemini: "google/gemini-2.5-flash",
  openrouter: "openrouter/google/gemma-4-31b-it:free",
  opencode: "opencode/big-pickle",
};

const ACTIVE_PROVIDER = (process.env.LLM_PROVIDER || "gemini").toLowerCase();
if (!(ACTIVE_PROVIDER in PROVIDER_DEFAULT_MODELS)) {
  throw new Error(
    `Unknown LLM_PROVIDER '${ACTIVE_PROVIDER}'. Use one of: ${Object.keys(PROVIDER_DEFAULT_MODELS).join(", ")}`,
  );
}
const ACTIVE_MODEL = process.env.LLM_MODEL || PROVIDER_DEFAULT_MODELS[ACTIVE_PROVIDER];

// Hard ceiling for the warmup() ping. If the LLM provider is misconfigured,
// the underlying call hangs indefinitely (we got bitten by this with an
// unroutable opencode model id). Bound the wait so future hangs fail loud.
const WARMUP_TIMEOUT_MS = 60000;

// Hard ceiling for a single chat() turn's LLM-side work. Generous enough
// for legitimate multi-tool chains (Gemini cold-start + 2-3 mcporter tool
// calls can run 30s+) but bounded so a hung provider becomes recoverable
// instead of locking the user out of the conversation.
// First call is the cold start (openclaw loads skills, resolves config,
// searches plugins, then makes the LLM API call). 90s wasn't enough —
// bumped to 180s for the cold start. Subsequent calls are much faster
// (typically 7-20s) and still bounded by this ceiling.
const CHAT_LLM_TIMEOUT_MS = 180000;

export const CONFIG_OVERRIDE = {
  agents: {
    defaults: {
      model: { primary: ACTIVE_MODEL },
      workspace: resolve("workspace"),
      skipBootstrap: true,
      // Block streaming is off by default in openclaw (see reply.js: the
      // resolver falls through to "off" unless either disableBlockStreaming
      // is false at call time OR this default is "on"). Flip it on here AND
      // at the call site for belt-and-suspenders.
      blockStreamingDefault: "on",
      // The coalescer default of minChars=800 / maxChars=1200 is tuned for
      // long-form chat replies — it buffers short replies into one big
      // chunk, defeating streaming for our typical 150–300 char voice
      // responses. Drive the thresholds way down and flush on every enqueue
      // so each sentence-ish segment the model emits fires onBlockReply
      // immediately.
      blockStreamingChunk: {
        minChars: 1,
        maxChars: 200,
        breakPreference: "sentence",
      },
      blockStreamingCoalesce: {
        minChars: 1,
        maxChars: 200,
        idleMs: 0,
        flushOnEnqueue: true,
      },
    },
  },
  models: {
    providers: {
      google: {
        api: "google-generative-ai",
        apiKey: process.env.GEMINI_API_KEY,
      },
      openrouter: {
        apiKey: process.env.OPENROUTER_API_KEY,
      },
      // Per openclaw's opencode provider docs, the apiKey is read directly
      // from process.env.OPENCODE_API_KEY — there is no inline apiKey field
      // in the providers config. Leaving the entry empty here so openclaw's
      // built-in provider takes the env var path.
      opencode: {},
      "opencode-go": {},
    },
  },
  skills: {
    load: {
      extraDirs: [resolve("skills")],
    },
  },
  messages: {
    tts: {
      // Auto-TTS is OFF on purpose: openclaw's built-in pipeline only fires
      // once at end-of-reply (mode: "final"), which would force users to wait
      // for the full LLM response before hearing anything. We drive Murf
      // ourselves from openclaw's onBlockReply streaming hook instead — same
      // plugin, same provider config, just synthesized per-block so playback
      // can start while later blocks are still arriving.
      provider: "murf",
      auto: "off",
      mode: "final",
      providers: {
        murf: {
          voiceId: "en-IN-anusha",
          model: "FALCON",
          format: "WAV",
          sampleRate: 24000,
          locale: "en-IN",
          style: "Conversational",
          rate: 0,
          pitch: 0,
          region: "global",
        },
      },
    },
  },
  plugins: {
    entries: {
      "murf-tts": { enabled: true },
    },
  },
};

export { ACTIVE_PROVIDER, ACTIVE_MODEL };

export interface AgentResponse {
  text: string;
  /**
   * Full-response audio. Populated only on the non-streaming path (no
   * onAudioChunk callback) or as a fallback when the streaming path
   * produced no chunks. Null when audio was streamed incrementally —
   * the caller will have already received those chunks via onAudioChunk.
   */
  audio: Buffer | null;
}

export interface ChatStreamOptions {
  /**
   * Fires for each synthesized block as it becomes available, in reply
   * order. Caller is responsible for queueing them onto a playback stream.
   * When provided, AgentResponse.audio will normally be null (unless no
   * blocks streamed and the fallback path ran).
   */
  onAudioChunk?: (audio: Buffer) => void;
}

// Murf's actual server-side cap for FALCON + en-US-natalie is 3000 chars per
// request — it returns HTTP 400 ("Text passed is N characters long. Max length
// allowed is 3000") above that. We budget well under to leave room for the
// plugin's stripControlChars pass AND to keep per-chunk synthesis time bounded:
// Murf's wall-clock synthesis rate is ~50 ms/char observed, so 1500 chars
// works out to ~75 s per chunk in the worst case.
const MURF_MAX_TEXT_LENGTH = 1500;

// 30s wasn't enough for ~2400-char chunks (timed out 3× → 91s total fail).
// At ~50 ms/char, 1500 chars needs ~75s to complete; 120s gives ~1.6× headroom.
// Note: this is per-chunk wall-clock budget. The plugin's own retry logic
// (3 attempts with backoff) still applies on top.
const MURF_TIMEOUT_MS = 120000;

/**
 * Split text into chunks no longer than `maxLen`, preferring sentence
 * boundaries, then word boundaries, then a hard cut as last resort.
 * Safe for empty/short inputs (returns the original as a single chunk).
 */
function chunkTextForTts(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  // Match `<stuff>[.!?]+<trailing space>` first; the trailing alternation
  // catches the final fragment that has no terminal punctuation.
  const sentences = text.match(/[^.!?]+[.!?]+\s*|[^.!?]+$/g) ?? [text];
  const chunks: string[] = [];
  let current = "";

  const flushCurrent = () => {
    const trimmed = current.trim();
    if (trimmed) chunks.push(trimmed);
    current = "";
  };

  for (const sentence of sentences) {
    if (!sentence.trim()) continue;

    if (current.length + sentence.length <= maxLen) {
      current += sentence;
      continue;
    }

    // Sentence doesn't fit in `current` — flush and start over.
    flushCurrent();

    if (sentence.length <= maxLen) {
      current = sentence;
      continue;
    }

    // A single sentence is longer than the budget — split on word boundaries.
    const words = sentence.split(/(\s+)/); // keep spaces
    let segment = "";
    for (const word of words) {
      if (segment.length + word.length <= maxLen) {
        segment += word;
      } else {
        if (segment.trim()) chunks.push(segment.trim());
        // Pathological: single token longer than budget — hard-cut it.
        if (word.length > maxLen) {
          for (let k = 0; k < word.length; k += maxLen) {
            chunks.push(word.slice(k, k + maxLen));
          }
          segment = "";
        } else {
          segment = word;
        }
      }
    }
    if (segment.trim()) chunks.push(segment.trim());
  }
  flushCurrent();

  return chunks;
}

/**
 * Locate the byte offset of the audio payload inside a PCM WAV buffer by
 * finding the "data" sub-chunk header. Returns -1 if not a parseable WAV.
 */
function findWavDataOffset(buf: Buffer): number {
  if (buf.length < 44) return -1;
  if (buf.toString("ascii", 0, 4) !== "RIFF") return -1;
  if (buf.toString("ascii", 8, 12) !== "WAVE") return -1;
  for (let i = 12; i < buf.length - 8; i++) {
    if (buf.toString("ascii", i, i + 4) === "data") {
      return i + 8; // skip "data" tag (4) + size field (4)
    }
  }
  return -1;
}

/**
 * Concatenate multiple PCM WAV buffers into one playable WAV. Keeps the
 * first buffer's header, strips headers from chunks 2..N, and concatenates
 * just the audio payloads. Header sizes are patched by patchWavSizes() —
 * this function is purely structural.
 */
function concatWavBuffers(buffers: Buffer[]): Buffer {
  if (buffers.length === 0) return Buffer.alloc(0);
  if (buffers.length === 1) return buffers[0];

  const firstDataOffset = findWavDataOffset(buffers[0]);
  if (firstDataOffset < 0) {
    // Not a parseable WAV — fall back to dumb concat (won't play correctly
    // but at least returns something for the caller to inspect).
    return Buffer.concat(buffers);
  }

  const header = buffers[0].subarray(0, firstDataOffset);
  const audioParts: Buffer[] = [buffers[0].subarray(firstDataOffset)];

  for (let i = 1; i < buffers.length; i++) {
    const chunkOffset = findWavDataOffset(buffers[i]);
    audioParts.push(
      chunkOffset < 0 ? buffers[i] : buffers[i].subarray(chunkOffset),
    );
  }

  return Buffer.concat([header, ...audioParts]);
}

/**
 * Patch the RIFF chunk size and "data" sub-chunk size of a WAV buffer to
 * match its actual byte length. Murf's streaming endpoint emits sentinel
 * sizes (INT32_MAX) because it doesn't know the final length upfront, so
 * any consumer that trusts those fields gets garbage. Returns a copy —
 * never mutates the input.
 */
function patchWavSizes(buf: Buffer): Buffer {
  if (buf.length < 44) return buf;
  if (buf.toString("ascii", 0, 4) !== "RIFF") return buf;
  if (buf.toString("ascii", 8, 12) !== "WAVE") return buf;

  const out = Buffer.from(buf);
  out.writeUInt32LE(out.length - 8, 4);
  for (let i = 12; i < out.length - 8; i++) {
    if (out.toString("ascii", i, i + 4) === "data") {
      out.writeUInt32LE(out.length - i - 8, i + 4);
      break;
    }
  }
  return out;
}

export async function synthesizeSpeech(text: string): Promise<Buffer | null> {
  if (!murfProvider?.synthesize || !text.trim()) return null;

  const chunks = chunkTextForTts(text, MURF_MAX_TEXT_LENGTH);

  const providerConfig = {
    apiKey: process.env.MURF_API_KEY,
    voiceId: "en-IN-anusha",
    model: "FALCON",
    format: "WAV",
    sampleRate: 24000,
    locale: "en-IN",
    style: "Conversational",
    rate: 0,
    pitch: 0,
    region: "global",
  };

  // Synthesize all chunks in parallel for lower wall-clock latency.
  const results = await Promise.all(
    chunks.map((chunk) =>
      murfProvider.synthesize({
        text: chunk,
        target: "audio",
        providerConfig,
        providerOverrides: {},
        timeoutMs: MURF_TIMEOUT_MS,
      }),
    ),
  );

  const buffers = results
    .map((r: any) => r?.audioBuffer)
    .filter(Boolean) as Buffer[];

  if (buffers.length === 0) return null;
  return patchWavSizes(concatWavBuffers(buffers));
}

/**
 * Lightweight warmup — force openclaw to load its config, resolve skill
 * definitions, and initialize the provider. This is the expensive cold-
 * start work that makes the first real chat() call take 40-60s if done
 * lazily. We send a one-word "hi" through a throwaway session and swallow
 * the response (we don't care what the LLM says, we just want openclaw's
 * internals initialized). Errors are silently swallowed — the first real
 * chat() will surface them with a proper error message.
 *
 * The resulting promise is cached so repeat callers share one cold-start
 * and so chat() can await it on the first turn — otherwise the first real
 * LLM call races openclaw's still-initializing shared state and ends up
 * paying the cold-start twice.
 */
let warmupPromise: Promise<void> | null = null;

export function warmup(): Promise<void> {
  if (warmupPromise) return warmupPromise;
  const p: Promise<void> = getReplyFromConfig(
    { Body: "hi", SessionKey: "warmup-discard", CommandSource: "native" as const, Provider: "cli" },
    {},
    CONFIG_OVERRIDE,
  ).then(() => undefined, () => undefined);
  warmupPromise = p;
  return p;
}

export async function chat(
  userText: string,
  streamOpts?: ChatStreamOptions,
): Promise<AgentResponse> {
  // Make sure openclaw's cold-start is finished before we submit the
  // real query. On turn 2+ this resolves instantly; on turn 1 it keeps
  // us from racing an in-flight warmup inside openclaw's shared state.
  if (warmupPromise) await warmupPromise;

  const ctx = {
    Body: userText,
    SessionKey: SESSION_KEY,
    CommandSource: "native" as const,
    Provider: "cli",
    SenderName: "User",
    Location: BENGALURU,
  };

  const onAudioChunk = streamOpts?.onAudioChunk;
  const streamingEnabled = Boolean(onAudioChunk);

  let blockEverFired = false;

  // ── Unified text + dispatch state ───────────────────────────────
  // Both onBlockReply and onPartialReply write into a single canonical text
  // accumulator. spokenLen tracks how far into canonicalText we've already
  // dispatched to Murf. This way the two hooks never double-speak: each new
  // chunk is the slice from spokenLen to "what we know about the reply now".
  //
  // Why two hooks at all? Empirically (turn 1 of the prior run) onBlockReply
  // can fire late or only once for short tool-driven turns where Gemini emits
  // the whole reply post-tools. onPartialReply gives us token-level streaming
  // for those cases. When blocks ARE granular, we let blocks dispatch and
  // partials become text-tracking-only (so we don't double-dispatch overlapping
  // content from two interleaved sources).
  let canonicalText = "";
  let spokenLen = 0;
  let lastPartialText = ""; // for delta-vs-accumulated detection on partials

  // Per-chunk synthesis chains in reply order even though Murf round-trips
  // race. Each new chunk kicks off synthesis right away (parallel network),
  // but the emit step awaits the prior chunk's synthesis — so playback
  // receives them in order.
  let emitChain: Promise<void> = Promise.resolve();
  let streamedAnyAudio = false;

  const dispatchChunk = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (!streamingEnabled) return;
    const synthP = synthesizeSpeech(trimmed).catch(() => null);
    emitChain = emitChain.then(async () => {
      const audio = await synthP;
      if (audio) {
        streamedAnyAudio = true;
        onAudioChunk!(audio);
      }
    });
  };

  // Sentence-boundary detection for the partial-driven path. Strict trailing
  // whitespace requirement so a punctuation char that just happens to be the
  // current end-of-stream isn't mistakenly flushed mid-sentence.
  const SENTENCE_END = /[.!?]+\s+/g;
  const flushSentencesFromCanonical = () => {
    const tail = canonicalText.slice(spokenLen);
    SENTENCE_END.lastIndex = 0;
    let m: RegExpExecArray | null;
    let lastIdx = 0;
    while ((m = SENTENCE_END.exec(tail)) !== null) {
      const endIdx = m.index + m[0].length;
      const sentence = tail.slice(lastIdx, endIdx);
      dispatchChunk(sentence);
      lastIdx = endIdx;
    }
    spokenLen += lastIdx;
  };

  // Race the LLM round-trip against a hard timeout. A misconfigured or
  // unreachable provider would otherwise hang chat() forever and lock the
  // user out of the conversation loop. On timeout we throw a clean error
  // that handleTranscription() can surface via logError().
  const llmCall = getReplyFromConfig(ctx, {
    // Force block streaming ON. Without this, reply.ts's resolver falls
    // through to "off" for any channel that doesn't explicitly enable it —
    // and our "cli" provider doesn't. Pass `false` (not `true`): the option
    // name is "disable", so false means don't-disable.
    disableBlockStreaming: false,
    onToolStart(payload: { name?: string; phase?: string }) {
      // The hook fires multiple times per tool (start/update/…). Log only
      // at the "start" phase so each tool prints once.
      if (payload.name && (payload.phase === "start" || !payload.phase)) {
        logTool(payload.name);
      }
    },
    onBlockReply(payload: any) {
      // Skip openclaw's internal-only blocks: reasoning/thinking traces and
      // compaction status notices aren't user-facing speech.
      if (payload?.isReasoning || payload?.isCompactionNotice) return;
      const text: string = (payload?.text ?? "").trim();
      if (!text) return;

      blockEverFired = true;

      // Merge block text into the canonical accumulator. Three cases:
      //   - block already covered: skip
      //   - block extends what we have (startsWith canonical): replace
      //   - block adds new content: append with a space joiner
      let updated = false;
      if (canonicalText && canonicalText.includes(text)) {
        // already accounted for (e.g. partials got there first)
      } else if (canonicalText && text.startsWith(canonicalText)) {
        canonicalText = text;
        updated = true;
      } else {
        const joiner = canonicalText && !canonicalText.endsWith(" ") ? " " : "";
        canonicalText = canonicalText + joiner + text;
        updated = true;
      }

      // Dispatch the new portion immediately. Block boundaries are openclaw's
      // own "this is a coherent reply unit" signal, so we don't gate on
      // sentence punctuation here.
      if (updated) {
        const newPortion = canonicalText.slice(spokenLen);
        if (newPortion.trim()) {
          dispatchChunk(newPortion);
          spokenLen = canonicalText.length;
        }
      }
    },
    onPartialReply(payload: any) {
      const incoming: string = payload?.text ?? "";
      if (!incoming) return;

      // Detect delta-vs-accumulated form. openclaw's `textForTyping` wraps
      // signalTextDelta — name suggests delta — but providers vary. The
      // prefix check covers both shapes.
      let delta: string;
      if (incoming.startsWith(lastPartialText)) {
        delta = incoming.slice(lastPartialText.length);
        lastPartialText = incoming;
      } else {
        delta = incoming;
        lastPartialText = lastPartialText + incoming;
      }
      if (!delta) return;

      // If blocks are doing the dispatch, partials only update the canonical
      // text accumulator (so the final text reflects everything the model
      // emitted). Otherwise partials drive sentence-boundary dispatch.
      if (blockEverFired) {
        if (!canonicalText.includes(delta)) canonicalText += delta;
        return;
      }

      canonicalText += delta;
      flushSentencesFromCanonical();
    },
  }, CONFIG_OVERRIDE);

  let llmTimeoutHandle: NodeJS.Timeout | undefined;
  const llmTimeoutPromise = new Promise<never>((_, reject) => {
    llmTimeoutHandle = setTimeout(
      () =>
        reject(
          new Error(
            `LLM call timed out after ${(CHAT_LLM_TIMEOUT_MS / 1000).toFixed(0)}s ` +
              `(provider=${ACTIVE_PROVIDER} model=${ACTIVE_MODEL}). ` +
              `Either the provider is misconfigured or the request is genuinely too slow — ` +
              `try a different LLM_PROVIDER in .env.`,
          ),
        ),
      CHAT_LLM_TIMEOUT_MS,
    );
  });

  let result: unknown;
  try {
    result = await Promise.race([llmCall, llmTimeoutPromise]);
  } finally {
    if (llmTimeoutHandle) clearTimeout(llmTimeoutHandle);
  }

  const payload = Array.isArray(result) ? result[0] : result;
  // openclaw drops payload.text from the final result when block streaming
  // actually streamed (see agent-runner: shouldDropFinalPayloads). So
  // canonicalText (built from the streaming hooks) is the source of truth
  // when streaming worked; fall back to payload.text only when nothing
  // streamed.
  const payloadText: string = payload?.text ?? "";

  // Flush any remaining canonical text as a final chunk. This catches the
  // last partial-driven sentence (which has no trailing whitespace yet) plus
  // any tail content blocks failed to dispatch. After this spokenLen catches
  // up to canonicalText.length.
  if (streamingEnabled && spokenLen < canonicalText.length) {
    const tail = canonicalText.slice(spokenLen).trim();
    if (tail) dispatchChunk(tail);
    spokenLen = canonicalText.length;
  }

  // If neither streaming hook ever emitted text but openclaw still has a
  // payload.text, treat the payload as the canonical reply. Catches
  // configs that suppress both block and partial streaming.
  if (!canonicalText && payloadText) canonicalText = payloadText;

  const text = canonicalText.trim();
  logAgent(text);

  // Streaming path: drain the per-chunk emit chain so the caller has
  // received every chunk before we hand back. If at least one chunk made it
  // through, audio: null tells the caller "I already streamed it."
  if (streamingEnabled) {
    await emitChain;
    if (streamedAnyAudio) return { text, audio: null };
    // Fall through to the batch path below — neither hook produced audio
    // (very rare; protects against total streaming pipeline failure).
  }

  // Batch path. Auto-TTS is off in CONFIG_OVERRIDE so payload.mediaUrl will
  // normally be empty; we synthesize manually here. Kept as a non-streaming
  // fallback / compat path.
  let audio: Buffer | null = null;
  const mediaPath: string | undefined = payload?.mediaUrl;
  if (mediaPath) {
    try {
      audio = readFileSync(mediaPath);
    } catch (err) {
      logAgent(`[native TTS file read failed: ${err instanceof Error ? err.message : err}]`);
    }
  }
  if (!audio && text) {
    try {
      audio = await synthesizeSpeech(text);
    } catch (err) {
      logAgent(`[TTS fallback failed: ${err instanceof Error ? err.message : err}]`);
    }
  }

  return { text, audio };
}
