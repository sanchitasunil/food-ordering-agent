import { resolve } from "node:path";
import { getReplyFromConfig } from "openclaw";
import plugin from "openclaw-murf-tts";
import { logTool, logAgent, logSystem } from "./ui.js";

// Local openclaw.json instead of ~/.openclaw/
process.env.OPENCLAW_CONFIG_PATH ??= resolve("openclaw.json");

// openclaw-murf-tts exposes the synthesizer only through plugin.register()
let murfProvider: any;
plugin.register({
  registerSpeechProvider(p: any) { murfProvider = p; },
} as any);

const SESSION_KEY = "food-agent-local";
const BENGALURU = { lat: 12.9716, lng: 77.5946 };

// LLM_PROVIDER: gemini | openrouter | opencode. Optional LLM_MODEL overrides the
// default for the active provider. Keys: GEMINI_API_KEY, OPENROUTER_API_KEY,
// OPENCODE_API_KEY (opencode = SST opencode.ai Zen gateway; "Big Pickle" is the
// free-tier model — `opencode-go/*` ids are the paid Go tier and not used here).
const PROVIDER_DEFAULT_MODELS: Record<string, string> = {
  gemini: "google/gemini-2.5-flash",
  openrouter: "openrouter/google/gemini-3.0-preview",
  opencode: "opencode/big-pickle",
};

const ACTIVE_PROVIDER = (process.env.LLM_PROVIDER || "gemini").toLowerCase();
if (!(ACTIVE_PROVIDER in PROVIDER_DEFAULT_MODELS)) {
  throw new Error(
    `Unknown LLM_PROVIDER '${ACTIVE_PROVIDER}'. Use one of: ${Object.keys(PROVIDER_DEFAULT_MODELS).join(", ")}`,
  );
}
const ACTIVE_MODEL = process.env.LLM_MODEL || PROVIDER_DEFAULT_MODELS[ACTIVE_PROVIDER];

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
      opencode: {
        apiKey: process.env.OPENCODE_API_KEY,
        // Only set baseUrl if explicitly overridden — otherwise let the
        // openclaw provider plugin use its default (https://opencode.ai/zen/v1).
        ...(process.env.OPENCODE_BASE_URL && { baseUrl: process.env.OPENCODE_BASE_URL }),
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

export async function warmup(): Promise<void> {
  logSystem(`LLM: ${ACTIVE_PROVIDER} (${ACTIVE_MODEL})`);
  await getReplyFromConfig(
    { Body: "ping", SessionKey: "warmup", CommandSource: "native" as const, Provider: "cli" },
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
