# food-ordering-agent

A voice-driven food ordering CLI that chains real-time speech recognition, an agentic LLM with tool calling, live Swiggy restaurant data, and high-fidelity text-to-speech into a conversational loop. Talk to your terminal, get food delivered.

```
mic  -->  Deepgram STT  -->  OpenClaw Agent  -->  Swiggy MCP  -->  Murf TTS  -->  speakers
          (nova-2)           (Gemini/OpenRouter    (live menu,      (en-IN-anisha,
                              /OpenCode)            cart, orders)    FALCON model)
```

https://github.com/user-attachments/assets/placeholder-demo-video

## What it does

1. Listens to your voice via decibri (native WASAPI/CoreAudio/ALSA) and streams audio to Deepgram Nova-2 for real-time transcription.
2. Sends the transcript to an OpenClaw agent backed by a configurable LLM (Gemini, OpenRouter, or OpenCode).
3. The agent calls Swiggy's live MCP servers to search restaurants, browse menus, manage a cart, and place orders — all via voice.
4. Reads the response back through Murf FALCON TTS with an Indian English voice.
5. Loops. The whole thing feels like talking to a friend who happens to have Swiggy open.

## Quick start

```bash
git clone <repo-url> food-ordering-agent
cd food-ordering-agent
pnpm install
cp .env.example .env   # fill in your API keys (see below)
pnpm start
```

> Try saying: *"I feel like having garlic bread"*

**Heads up:** The first response takes 15-50 seconds (OpenClaw cold-starts the LLM + loads skills). Subsequent responses are much faster (7-20s). The agent uses your **saved Swiggy delivery address**, not live GPS — make sure you have at least one address saved in the Swiggy app.

## Prerequisites

| What | Why | How |
|---|---|---|
| Node.js 22+ | Runtime (ESM-only) | [nodejs.org](https://nodejs.org/) |
| pnpm | Package manager | `npm i -g pnpm` |

Audio capture and playback use [decibri](https://www.npmjs.com/package/decibri), a native addon with pre-built binaries — no external audio tools needed. It uses WASAPI on Windows, CoreAudio on macOS, and ALSA on Linux.

> **Linux only:** if ALSA headers are missing (common on minimal servers/containers), install them:
> ```bash
> sudo apt install libasound2-dev   # Debian/Ubuntu
> ```
> Desktop Linux distros typically have these already.

## API keys

Fill these in your `.env` after copying `.env.example`:

| Key | Where to get it |
|---|---|
| `DEEPGRAM_API_KEY` | [console.deepgram.com](https://console.deepgram.com/) |
| `MURF_API_KEY` | [murf.ai](https://murf.ai/) > API settings |
| `GEMINI_API_KEY` | [aistudio.google.dev/apikey](https://aistudio.google.dev/apikey) |

Optional (for provider failover):

| Key | When you need it |
|---|---|
| `OPENROUTER_API_KEY` | When `LLM_PROVIDER=openrouter` |
| `OPENCODE_API_KEY` | When `LLM_PROVIDER=opencode` — sign up at [opencode.ai](https://opencode.ai/auth) |

### Swiggy auth (one-time)

The agent orders food through Swiggy's MCP servers, which use OAuth. Run once:

```bash
mcporter auth swiggy-food
```

This opens a browser for Swiggy login. On Windows, mcporter has a URL-truncation bug — if the browser shows a `client_id required` error, copy the full URL from the terminal's debug output and paste it manually. See [Troubleshooting](#troubleshooting) for details.

## LLM provider switching

Three LLM backends are preconfigured. Switch between them by editing one line in `.env` — no code changes, no rebuild:

```bash
LLM_PROVIDER=gemini       # Google Gemini 2.5 Flash (default)
LLM_PROVIDER=openrouter   # Google Gemma 4 31B via OpenRouter (free)
LLM_PROVIDER=opencode     # Big Pickle via OpenCode Zen (free)
```

Override the model on any provider:
```bash
LLM_MODEL=opencode/minimax-m2.5-free
```

The startup banner shows which provider and model are active.

## How it works

### Architecture

```
src/
  index.ts    Event loop: mic → transcribe → think → speak → repeat
  ear.ts      decibri mic capture + Deepgram WebSocket streaming
  brain.ts    OpenClaw agent config, LLM routing, Murf TTS synthesis
  voice.ts    decibri speaker playback
  ui.ts       Terminal rendering (chalk + ora + boxen)

workspace/
  IDENTITY.md   System prompt (voice brevity rules, tool sequencing)

skills/swiggy/
  SKILL.md        Tool documentation the LLM reads to learn the CLI
  swiggy-cli.js   CLI wrapper around Swiggy's MCP servers via mcporter

config/
  mcporter.json   Swiggy MCP server registration + OAuth config
```

### Voice loop

```
                    ┌─────────────────────────────────────┐
                    │                                     │
  mic ──► decibri ──► Deepgram WS ──► transcript             │
                                      │                   │
                                      ▼                   │
                               OpenClaw Agent             │
                               (Gemini / etc)             │
                                      │                   │
                            ┌─────────┴─────────┐        │
                            │ tool calls?        │        │
                            │  swiggy-cli.js     │        │
                            │  via mcporter      │        │
                            └─────────┬─────────┘        │
                                      │                   │
                                      ▼                   │
                               Agent reply                │
                                      │                   │
                                      ▼                   │
                               Murf TTS ──► decibri ──► speakers
                                      │                   │
                                      └───────────────────┘
```

### TTS chunking

Murf's FALCON API caps each request at 3000 characters and synthesizes at ~35ms per character. The agent automatically:

1. Splits long replies on sentence boundaries (1500-char chunks)
2. Synthesizes each chunk independently
3. Concatenates the WAV buffers and patches the RIFF headers

Short replies (~100 chars) synthesize in ~2-3 seconds. The system prompt enforces a 400-character default to keep voice responses snappy.

### Terminal UI

The terminal is designed to be legible in demo videos:

```
╭──────────────────────────────────────────────────╮
│                                                  │
│   food-ordering-agent                            │
│   voice → LLM → tools → voice                    │
│                                                  │
│   STT     deepgram nova-2                        │
│   LLM     gemini  ›  google/gemini-2.5-flash     │
│   TTS     murf falcon  ›  en-IN-anisha           │
│   Skill   swiggy-food                            │
│                                                  │
╰──────────────────────────────────────────────────╯
✔ Ready (3.2s)
──────────────────────────────────────────────────────────────
🤖 Agent    Hi, I'm your food ordering assistant. How can I help you today?
🔊 Speaking Hi, I'm your food ordering assistant. How can I help you today?
⚡ System    Speak when you're ready.
──────────────────────────────────────────────────────────────
🎤 You      I feel like having garlic bread.
🔧 Tool     swiggy
🔧 Tool     exec
🤖 Agent    Two places near you: La Pino'z Pizza, about 31 minutes. Pizza Hut, 37 minutes.
            ⏱  LLM 14.2s · 2 tools · TTS 3.1s · 89 chars
🔊 Speaking Two places near you: La Pino'z Pizza, about 31 minutes...
```

Color scheme: blue = user, yellow = agent, green = tools, magenta = TTS, cyan = system.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `decibri` / audio device error | No audio input/output device found | Check OS sound settings. On Linux, ensure ALSA is installed (`sudo apt install libasound2-dev`) |
| No audio output after agent reply | Murf API key missing/invalid, or system volume muted | Check `MURF_API_KEY` in `.env`. Check OS volume mixer |
| Deepgram WS closed (code=1011) | Free Deepgram credits exhausted | Top up at [console.deepgram.com](https://console.deepgram.com) |
| `client_id and redirect_uri are required` during mcporter auth | mcporter URL-truncation bug on Windows | Run `mcporter --log-level debug auth swiggy-food --reset`, copy the full URL from the log output, paste into browser manually |
| Agent says "swiggy command not found" | OpenClaw's executor doesn't have npm globals on PATH | Already fixed — the skill uses `node skills/swiggy/swiggy-cli.js` directly. If you see this, make sure `workspace/skills/swiggy/SKILL.md` matches `skills/swiggy/SKILL.md` |
| First response is slow (~15-50s) | OpenClaw cold-starts on the first real query (loads skills, resolves config, initializes provider) | Subsequent responses are faster (7-20s). The warmup runs in parallel with startup audio but may not finish in time |
| `LLM call timed out after 180s` | Provider is down, misconfigured, or rate-limited | Switch `LLM_PROVIDER` in `.env` to a different backend |
| Agent returns error strings as speech | LLM provider returned an error that OpenClaw surfaced as text | Check the terminal for the actual error message. Usually a billing/quota issue |
| Audio gets cut off at the end | decibri output stream ending early | File an issue — this shouldn't happen with the native audio backend |

## Project structure

```
.env.example          Environment variable template
openclaw.json         OpenClaw config (model, providers, skills, plugin overrides)
package.json          Dependencies (openclaw, deepgram, murf-tts, chalk, ora, boxen, ws)
tsconfig.json         TypeScript config
config/
  mcporter.json       Swiggy MCP server registration
workspace/
  IDENTITY.md         System prompt
  AGENTS.md           OpenClaw agent framework docs
  skills/swiggy/      Workspace copy of the Swiggy skill (synced with skills/)
skills/swiggy/
  SKILL.md            Tool reference the LLM reads
  swiggy-cli.js       CLI wrapper — mcporter calls to Swiggy MCP
  package.json        Skill metadata
src/
  index.ts            Entry point + event loop
  ear.ts              Mic capture + Deepgram STT
  brain.ts            LLM routing + TTS synthesis + chunking
  voice.ts            decibri speaker playback
  ui.ts               Terminal rendering
tests/
  voice-flow-smoke.ts Full pipeline smoke test (text-driven, no mic)
  murf-chunking-smoke.ts  Isolated TTS chunking + WAV concat test
  ui-demo.ts          Visual UI smoke test (no network)
```

## Credits

Built with [OpenClaw](https://openclaw.kr), [Deepgram](https://deepgram.com), [Murf](https://murf.ai), and [Swiggy MCP](https://mcp.swiggy.com).
