# AI Food Ordering Agent

Voice-driven food ordering CLI. Speaks into your mic, streams real-time STT via **Deepgram Nova-2**, routes intent through an **OpenClaw** agentic LLM with a **Swiggy ClawHub** skill, and reads back results using **Murf** high-fidelity TTS.

```
You (mic) ➜ Deepgram STT ➜ OpenClaw Agent ➜ Swiggy Tool ➜ Murf TTS ➜ Speakers
```

## Prerequisites

| Requirement | Why | Install |
|---|---|---|
| **Node.js 22+** | Runtime. ESM-only codebase. | [nodejs.org](https://nodejs.org/) |
| **pnpm** | Package manager. | `npm i -g pnpm` |
| **SoX (Sound eXchange)** | `node-record-lpcm16` shells out to `sox` for mic capture. **Without it, recording will fail on Windows with `spawn sox ENOENT`.** | [SourceForge download](https://sourceforge.net/projects/sox/). After install, add the SoX directory to your system `PATH`. Verify: `sox --version`. On macOS: `brew install sox`. On Ubuntu: `apt install sox`. |

## Setup

### 1. Clone & install

```bash
git clone <repo-url> food-ordering-agent
cd food-ordering-agent
pnpm install
```

### 2. Configure environment variables

```bash
cp .env.example .env
```

Open `.env` and fill in your keys:

| Variable | Where to get it |
|---|---|
| `DEEPGRAM_API_KEY` | [console.deepgram.com](https://console.deepgram.com/) — create a project, generate an API key with STT permissions. |
| `MURF_API_KEY` | [murf.ai](https://murf.ai/) — sign up, go to API settings, copy your key. |
| `GEMINI_API_KEY` | Required by OpenClaw's underlying LLM router. Get it from [aistudio.google.dev/apikey](https://aistudio.google.dev/apikey). |
| `SWIGGY_API_KEY` | Only if Swiggy ClawHub requires auth. Check ClawHub docs for your skill config. |

### 3. Verify SoX (Windows users)

```bash
sox --version
```

If this prints a version string, you're good. If it says `'sox' is not recognized`, SoX is not in your PATH. Fix that before running the agent.

## Running the Agent

```bash
pnpm start
```

This runs `tsx src/index.ts`. The agent will:

1. Open your microphone and begin streaming audio to Deepgram.
2. Wait for you to speak. Try something like:

   > "I'm starving, find me a masala dosa nearby."

3. Mute the mic, send your transcript to the OpenClaw agent.
4. The agent calls the Swiggy tool (searches Bengaluru by default), reads back the top 2 options, and asks clarifying questions (spice level, restaurant preference).
5. Speak the response through your speakers via Murf TTS.
6. Un-mute the mic and loop.

Press `Ctrl+C` to exit.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Error: spawn sox ENOENT` | SoX is not installed or not in PATH. | Install SoX and add its directory to your system PATH. Restart your terminal after updating PATH. |
| `Microphone access failed. Windows requires SoX...` | Same root cause — the agent caught it gracefully. | Same fix as above. |
| No audio output / silence after agent reply | Murf API key is missing or invalid, or system volume is muted. | Verify `MURF_API_KEY` in `.env`. Check your OS volume mixer — make sure Node.js / your terminal is not muted. |
| Deepgram returns empty transcripts | API key invalid or mic not capturing audio. | Test your mic in another app. Verify `DEEPGRAM_API_KEY`. Check your firewall isn't blocking WebSocket connections to `api.deepgram.com`. |
| Swiggy API returning empty results | Coordinates may be wrong, or the skill isn't registered. | The agent defaults to Bengaluru (12.9716, 77.5946). If you need a different city, update the coordinates in `src/brain.ts`. |
| `ERR_MODULE_NOT_FOUND` | Dependencies not installed. | Run `pnpm install`. |

## Architecture

```
├── openclaw.json           # OpenClaw config (model, provider, skill dirs)
├── workspace/
│   └── IDENTITY.md         # System prompt (injected by OpenClaw)
├── skills/
│   └── swiggy/
│       └── SKILL.md        # Swiggy food search skill definition
└── src/
    ├── index.ts            # Mute-while-talking event loop orchestrator
    ├── ear.ts              # Mic capture (node-record-lpcm16) + Deepgram STT streaming
    ├── brain.ts            # OpenClaw getReplyFromConfig + Murf TTS synthesis
    ├── voice.ts            # Plays audio via PowerShell (no native addons)
    └── ui.ts               # All terminal output (chalk + ora). Color scheme:
                            #   Blue = user, Yellow = agent, Green = tool, Purple = TTS
```

## License

Private.
