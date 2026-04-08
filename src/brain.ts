import { resolve } from "node:path";
import { getReplyFromConfig } from "openclaw";
import plugin from "openclaw-murf-tts";
import { logTool, logAgent } from "./ui.js";

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

// Config override — merged on top of OpenClaw's base config to force Google Gemini
const CONFIG_OVERRIDE = {
  agents: {
    defaults: {
      model: {
        primary: "google/gemini-2.5-flash",
      },
      workspace: resolve("workspace"),
    },
  },
  models: {
    providers: {
      google: {
        api: "google-generative-ai",
        apiKey: process.env.GEMINI_API_KEY,
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

export interface AgentResponse {
  text: string;
  audio: Buffer | null;
}

/**
 * Synthesise speech using the Murf plugin's provider.
 */
async function synthesizeSpeech(text: string): Promise<Buffer | null> {
  if (!murfProvider?.synthesize) {
    logAgent("[TTS skipped: Murf provider not registered]");
    return null;
  }
  if (!text.trim()) return null;

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

// Pre-synthesised filler clips — generated once at warmup, replayed instantly
let fillerAudio: Buffer | null = null;

/**
 * Warm up: prime the OpenClaw config + pre-generate a filler TTS clip.
 * Call once at startup so the first real request isn't cold.
 */
export async function warmup(): Promise<void> {
  // Prime OpenClaw config by sending a no-op context (loads config, model list, etc.)
  getReplyFromConfig(
    { Body: "ping", SessionKey: "warmup", CommandSource: "native" as const, Provider: "cli" },
    {},
    CONFIG_OVERRIDE,
  ).catch(() => {}); // fire-and-forget

  // Pre-generate a filler clip
  try {
    fillerAudio = await synthesizeSpeech("Let me check on that for you.");
  } catch {
    // non-fatal
  }
}

/**
 * Return the pre-recorded filler audio buffer (or null if warmup hasn't finished).
 */
export function getFiller(): Buffer | null {
  return fillerAudio;
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

  // getReplyFromConfig can return a single payload, an array, or undefined
  const payload = Array.isArray(result) ? result[0] : result;
  const text = payload?.text ?? "";
  logAgent(text);

  // Synthesise speech via the Murf OpenClaw plugin
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
