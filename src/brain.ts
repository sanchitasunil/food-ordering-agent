import { resolve } from "node:path";
import { getReplyFromConfig } from "openclaw";
import plugin from "openclaw-murf-tts";
import { logTool, logAgent, logSystem } from "./ui.js";

// Point OpenClaw at our local config before it tries to load from ~/.openclaw/
process.env.OPENCLAW_CONFIG_PATH ??= resolve("openclaw.json");

// Extract the Murf speech provider from the plugin by capturing it via register()
let murfProvider: any;
plugin.register({
  registerSpeechProvider(p: any) { murfProvider = p; },
} as any);

// Stable session key so conversation history persists within one run
const SESSION_KEY = "food-agent-local";

// Bengaluru default geolocation context for the Swiggy skill
const BENGALURU = { lat: 12.9716, lng: 77.5946 };

// ── LLM provider switching ───────────────────────────────────────
//
// Set LLM_PROVIDER in .env to switch when one provider hits rate limits.
// Three independent provider/model combinations are kept ready so you
// can rotate without touching code:
//
//   - "gemini"      → Google Gemini 2.5 Flash, direct API (default)
//                     uses GEMINI_API_KEY
//
//   - "openrouter"  → MiniMax M2.5 via OpenRouter gateway
//                     uses OPENROUTER_API_KEY. Picked because MiniMax
//                     is stable, supports tool calling (required for the
//                     Swiggy skill), and is essentially free at OR pricing.
//
//   - "opencode-go" → A free model via opencode-go gateway
//                     uses OPENCODE_GO_API_KEY + OPENCODE_GO_BASE_URL.
//                     ⚠️ TODO: confirm exact base URL and model id with the
//                     opencode-go service. Placeholder is a guess.
//
// Optionally pin a specific model on the active provider with LLM_MODEL.
//
const PROVIDER_DEFAULT_MODELS: Record<string, string> = {
  gemini: "google/gemini-2.5-flash",
  openrouter: "openrouter/minimax/minimax-m2.5",
  "opencode-go": "opencode-go/free-model", // TODO: replace with real free model id
};

const ACTIVE_PROVIDER = (process.env.LLM_PROVIDER || "gemini").toLowerCase();
if (!(ACTIVE_PROVIDER in PROVIDER_DEFAULT_MODELS)) {
  throw new Error(
    `Unknown LLM_PROVIDER '${ACTIVE_PROVIDER}'. Use one of: ${Object.keys(PROVIDER_DEFAULT_MODELS).join(", ")}`,
  );
}
const ACTIVE_MODEL = process.env.LLM_MODEL || PROVIDER_DEFAULT_MODELS[ACTIVE_PROVIDER];

// All three provider configs are kept loaded so switching is purely a
// LLM_PROVIDER env-var change — no code edit, no rebuild.
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
      "opencode-go": {
        apiKey: process.env.OPENCODE_GO_API_KEY,
        baseUrl: process.env.OPENCODE_GO_BASE_URL,
      },
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

/**
 * Synthesise speech using the Murf plugin's provider.
 */
export async function synthesizeSpeech(text: string): Promise<Buffer | null> {
  if (!murfProvider?.synthesize || !text.trim()) return null;

  const result = await murfProvider.synthesize({
    text,
    target: "audio",
    providerConfig: {
      apiKey: process.env.MURF_API_KEY,
      voiceId: "en-US-natalie",
      model: "FALCON",
      format: "WAV",
      sampleRate: 24000,
      locale: "en-US",
      style: "Conversational",
      rate: 0,
      pitch: 0,
      region: "global",
    },
    providerOverrides: {},
    timeoutMs: 15000,
  });

  return result?.audioBuffer ?? null;
}

/**
 * Warm up: prime the OpenClaw config so the first real request isn't cold.
 */
export async function warmup(): Promise<void> {
  logSystem(`LLM: ${ACTIVE_PROVIDER} (${ACTIVE_MODEL})`);
  await getReplyFromConfig(
    { Body: "ping", SessionKey: "warmup", CommandSource: "native" as const, Provider: "cli" },
    {},
    CONFIG_OVERRIDE,
  ).catch(() => {});
}

/**
 * Send a user utterance to the OpenClaw agent and return the text reply
 * plus Murf TTS audio.
 */
export async function chat(userText: string): Promise<AgentResponse> {
  const ctx = {
    Body: userText,
    SessionKey: SESSION_KEY,
    CommandSource: "native" as const,
    Provider: "cli",
    SenderName: "User",
    Location: BENGALURU,
  };

  const result = await getReplyFromConfig(ctx, {
    onToolStart(payload: { name?: string; phase?: string }) {
      if (payload.name) logTool(payload.name);
    },
  }, CONFIG_OVERRIDE);

  const payload = Array.isArray(result) ? result[0] : result;
  const text = payload?.text ?? "";
  logAgent(text);

  let audio: Buffer | null = null;
  if (text) {
    try {
      audio = await synthesizeSpeech(text);
    } catch (err) {
      logAgent(`[TTS failed: ${err instanceof Error ? err.message : err}]`);
    }
  }

  return { text, audio };
}
