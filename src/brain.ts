import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { getReplyFromConfig } from "openclaw";
import plugin from "openclaw-murf-tts";
import { logTool, logAgent, logSystem, logTimings } from "./ui.js";

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
  plugins: {
    entries: {},
  },
};

export { ACTIVE_PROVIDER, ACTIVE_MODEL };

export interface AgentResponse {
  text: string;
  audio: Buffer | null;
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
  const buffers: Buffer[] = [];

  for (const chunk of chunks) {
    const result = await murfProvider.synthesize({
      text: chunk,
      target: "audio",
      providerConfig: {
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
      },
      providerOverrides: {},
      timeoutMs: MURF_TIMEOUT_MS,
    });

    if (result?.audioBuffer) buffers.push(result.audioBuffer);
  }

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
 */
export async function warmup(): Promise<void> {
  await getReplyFromConfig(
    { Body: "hi", SessionKey: "warmup-discard", CommandSource: "native" as const, Provider: "cli" },
    {},
    CONFIG_OVERRIDE,
  ).catch(() => {});
}

export async function chat(userText: string): Promise<AgentResponse> {
  const ctx = {
    Body: userText,
    SessionKey: SESSION_KEY,
    CommandSource: "native" as const,
    Provider: "cli",
    SenderName: "User",
    Location: BENGALURU,
  };

  let toolCount = 0;
  const llmStart = performance.now();

  // Race the LLM round-trip against a hard timeout. A misconfigured or
  // unreachable provider would otherwise hang chat() forever and lock the
  // user out of the conversation loop. On timeout we throw a clean error
  // that handleTranscription() can surface via logError().
  const llmCall = getReplyFromConfig(ctx, {
    onToolStart(payload: { name?: string; phase?: string }) {
      // The hook fires multiple times per tool (start/update/…). Count and
      // print only at the "start" phase so the badge reflects distinct calls.
      if (payload.name && (payload.phase === "start" || !payload.phase)) {
        logTool(payload.name);
        toolCount++;
      }
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

  const llmMs = performance.now() - llmStart;

  const payload = Array.isArray(result) ? result[0] : result;
  const text = payload?.text ?? "";
  logAgent(text);

  let audio: Buffer | null = null;
  let ttsMs = 0;
  if (text) {
    try {
      const ttsStart = performance.now();
      audio = await synthesizeSpeech(text);
      ttsMs = performance.now() - ttsStart;
    } catch (err) {
      logAgent(`[TTS failed: ${err instanceof Error ? err.message : err}]`);
    }
  }

  logTimings({ llmMs, ttsMs, toolCount, charCount: text.length });

  return { text, audio };
}
