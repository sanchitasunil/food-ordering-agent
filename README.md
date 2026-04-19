# food-ordering-agent

Talk to your terminal, get food delivered.

This is a voice-driven Swiggy ordering agent that you run locally. It listens through your mic, thinks with an LLM, calls Swiggy's live MCP servers to search restaurants and place real orders, and speaks the reply back through Murf — all in one continuous conversation. The whole thing fits in about 700 lines of TypeScript on top of OpenClaw.

```
mic → Deepgram Flux → OpenClaw + Swiggy skill → Murf Falcon → speakers
       (STT)          (LLM + tools, streaming)   (TTS, per-sentence)
```

The interesting part: replies stream sentence-by-sentence. As soon as the LLM emits its first sentence, Murf synthesizes it and the speaker starts playing — while the rest of the reply is still being generated. That comes from openclaw's block streaming hooks, the same pipeline used by its Telegram, Matrix, and WhatsApp channels — pointed at voice instead of chat.

> Try it yourself in 5 minutes. The [Quick start](#quick-start) below assumes you have Node 22+ and a Swiggy account with a saved delivery address.

---

## What you'll need

| Tool | Why | How |
|---|---|---|
| Node.js 22+ | ESM-only project | [nodejs.org](https://nodejs.org/) |
| pnpm | Lockfile is pnpm | `npm i -g pnpm` |
| `mcporter` | OAuth for Swiggy MCP | `npm i -g mcporter` |
| Mic + speakers | Native audio via [decibri](https://www.npmjs.com/package/decibri). WASAPI / CoreAudio / ALSA — no SoX, no FFmpeg | Built in to your OS |
| Swiggy account | The agent uses your saved delivery addresses (not GPS) | Open the Swiggy app, save at least one address |

> **Linux only:** if you're on a minimal distro and `pnpm install` complains about ALSA headers, run `sudo apt install libasound2-dev`. Desktop distros usually have these already.

API keys (all free tiers):

| Key | Where |
|---|---|
| `DEEPGRAM_API_KEY` | [console.deepgram.com](https://console.deepgram.com/) — $200 free credit |
| `MURF_API_KEY` | [murf.ai](https://murf.ai/) → API settings |
| `GEMINI_API_KEY` | [aistudio.google.dev/apikey](https://aistudio.google.dev/apikey) |

---

## Quick start

```bash
git clone <repo-url> food-ordering-agent
cd food-ordering-agent
pnpm install

cp .env.example .env       # fill in the three keys

mcporter auth swiggy-food  # one-time OAuth — opens browser

pnpm start
```

That's it. The startup banner appears, you hear *"Hi, I'm your food ordering assistant. What are you in the mood for?"*, and the mic opens.

> Try saying: *"I feel like having biryani."*

> **Windows note:** `mcporter`'s OAuth URL gets truncated in the browser launcher. If you see `client_id required`, run `mcporter --log-level debug auth swiggy-food --reset`, copy the full URL from the debug log, paste it into your browser manually. Once authenticated, you won't need to redo this.

---

## What's actually happening

Every turn runs through six stages:

| # | Stage | Component | What it does |
|---|---|---|---|
| 1 | Capture | [decibri](https://www.npmjs.com/package/decibri) | 16-bit PCM at 16 kHz from the mic, 100ms frames |
| 2 | Transcribe | [Deepgram Flux](https://developers.deepgram.com/docs/flux) | Voice-agent STT with model-integrated end-of-turn detection. Streams over `/v2/listen` |
| 3 | Reason | OpenClaw + LLM | Picks tools, drives the Swiggy skill, generates the reply |
| 4 | Act | Swiggy skill (via `mcporter`) | OAuth'd MCP calls — search, menus, cart, place order |
| 5 | Speak | Murf Falcon (via openclaw plugin) | Per-sentence TTS streamed on openclaw block hooks |
| 6 | Play | decibri output stream | Audio chunks queue onto a long-lived speaker stream |

Most of the system is **already wired up** for you in this repo. The Swiggy skill is vendored under [skills/swiggy/](skills/swiggy/), the Murf plugin is in `package.json` and configured in [openclaw.json](openclaw.json), and the system prompt for the agent's voice is in [workspace/IDENTITY.md](workspace/IDENTITY.md). You're not assembling this from scratch — you're running it.

The orchestration code is small enough to read in a sitting:

```
src/
  index.ts   ~250 LOC  Event loop. mic → transcribe → think → speak → repeat
  ear.ts     ~160 LOC  decibri mic capture + Deepgram WS + per-turn keyterm biasing
  brain.ts   ~570 LOC  OpenClaw chat() wrapper + streaming TTS + WAV chunk concat
  voice.ts   ~140 LOC  Two-channel speaker output (one-shot fillers + streaming queue)
  ui.ts      ~150 LOC  chalk + ora + boxen terminal rendering
```

### How streaming works

The conversational feel comes from never waiting for the full reply before speaking. Three pieces:

1. **Openclaw streams blocks.** With `disableBlockStreaming: false` and the coalescer's `minChars` lowered to 1 ([brain.ts CONFIG_OVERRIDE](src/brain.ts#L83)), `onBlockReply` fires for each sentence-sized chunk the LLM emits.
2. **Per-block synthesis with Murf.** Each block kicks off `murfProvider.synthesize()` immediately. Several Murf round-trips race in parallel; a Promise chain serializes the listener callback so audio still arrives in reply order.
3. **Long-lived playback queue.** [voice.ts](src/voice.ts) opens one `DecibriOutput` per turn. As synthesized chunks arrive, they're written straight into it. PortAudio plays them gaplessly.

For tool-heavy turns where Gemini emits the entire reply in one shot post-tool-calls, `onPartialReply` provides a token-level fallback — we accumulate text, detect `.!?` sentence boundaries, and dispatch sentences as they complete. Both hooks write into a single `canonicalText` cursor so they never double-speak.

### How latency hides

Three small tricks compound:

- **Pre-baked filler clips.** `assets/intro.wav`, `filler.wav`, `filler-long.wav` are synthesized once with Murf and saved to disk. At runtime they play from a one-shot decibri stream — zero API latency, audible within ~100ms of the user finishing speaking.
- **Background warmup.** `setImmediate(() => warmup())` at startup runs OpenClaw's expensive cold-start (skill load, plugin init, provider resolution) in parallel with the user hearing the intro.
- **Mic re-arms during playback.** The Deepgram WebSocket handshake runs while the agent is still talking, so the mic is already hot the moment the agent stops.

### How turn-taking works

The agent never talks over itself. A new transcript stops in-flight playback. The system prompt ([workspace/IDENTITY.md](workspace/IDENTITY.md)) drills the LLM on never ending a turn with *"let me check"* — every promise of action must be performed in the same turn before handing the mic back. Restaurant names and dish names mentioned by the agent get fed into Deepgram's keyterm bias for the next turn ([keyterms.json](keyterms.json) plus per-turn injection), so when the user echoes them back they're recognized correctly.

---

## Configure

Three things live in `.env`:

```bash
LLM_PROVIDER=gemini       # gemini | openrouter | opencode
LLM_MODEL=                # optional — defaults per provider
DEEPGRAM_API_KEY=...
MURF_API_KEY=...
GEMINI_API_KEY=...        # plus the others if you switch providers
```

Switch LLMs without touching code or restarting the build:

| `LLM_PROVIDER` | Default model | Get a key |
|---|---|---|
| `gemini` | `google/gemini-2.5-flash` | [aistudio.google.dev](https://aistudio.google.dev/apikey) |
| `openrouter` | `google/gemma-4-31b-it:free` | [openrouter.ai](https://openrouter.ai/keys) |
| `opencode` | `opencode/big-pickle` (free) | [opencode.ai/auth](https://opencode.ai/auth) |

Override the model on any provider with `LLM_MODEL=opencode/minimax-m2.5-free` etc. The startup banner shows which combination is active.

The voice, voice settings, and TTS provider are in [openclaw.json](openclaw.json) under `messages.tts.providers.murf`. Default is `en-IN-anusha` with the Falcon model. Other Murf voices: change `voiceId` and `locale`. Make sure the locale matches the voice — `en-IN` voices don't always work with `en-US` locale settings.

---

## What you'll see

```
╭──────────────────────────────────────────────────╮
│   food-ordering-agent                            │
│   voice → LLM → tools → voice                    │
│                                                  │
│   STT     deepgram flux                          │
│   LLM     gemini  ›  google/gemini-2.5-flash     │
│   TTS     murf falcon  ›  en-IN-anusha           │
│   Skill   swiggy-food                            │
│                                                  │
│   Press Ctrl+C to exit                           │
╰──────────────────────────────────────────────────╯
✔ Ready (3.2s)
──────────────────────────────────────────────────────────────
🤖 Agent    Hi, I'm your food ordering assistant. What are you in the mood for?
🔊 Speaking Hi, I'm your food ordering assistant. What are you in the mood for?
──────────────────────────────────────────────────────────────
🎤 You      I feel like having biryani.
  🔧 Tool     exec
  🔧 Tool     exec
  🤖 Agent    Two top-rated near you. Meghana Foods, four point five, about thirty seven minutes. Paradise Biryani, four point four, forty two minutes. Which one?
  🔊 Speaking Two top-rated near you. Meghana Foods, four point five, about thirty seven minutes…
```

Color scheme: blue = user, yellow = agent, green = tools, magenta = TTS, cyan = system.

---

## Honest about latency

The first turn is slow. Cold-starts from openclaw (skill resolution, plugin init), the LLM provider, and Murf all stack up. Expect **15-50 seconds** before you hear the first sentence on turn 1, with most of that being the cold start plus tool-call chains.

Subsequent turns are bounded by **how fast the LLM produces text**, not by audio synthesis. Once Gemini starts emitting the reply, the user hears the first sentence within 1-3 seconds. For tool-heavy turns where the LLM waits for all tool results before producing any text, the first audio is roughly `LLM-time-until-first-sentence + ~1-2s for synth`. Streaming TTS doesn't reduce LLM-or-tool latency — it just removes audio synthesis from the critical path.

If you want sub-second voice agents, the right architecture is a realtime model (Gemini Live, OpenAI Realtime) — that's a different project. This one is about showing how far the conventional STT → LLM → TTS pipeline can go when streaming is set up properly.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `command not found: mcporter` | `npm i -g mcporter` |
| `client_id and redirect_uri are required` during `mcporter auth` (Windows) | URL truncation bug. `mcporter --log-level debug auth swiggy-food --reset`, copy the full URL from the debug log, paste manually |
| Browser doesn't open during `mcporter auth` | Copy the URL printed in the terminal and open it manually |
| Agent says *"please add a delivery address"* | No saved addresses in your Swiggy account. Open the Swiggy app, save one, retry |
| Audio device error on startup | Check OS sound settings. On minimal Linux distros, `sudo apt install libasound2-dev` and reinstall |
| No audio output after agent reply | Check `MURF_API_KEY` and your OS volume. Plugin synth failures print to terminal |
| `Deepgram WS closed (code=1011)` | Free Deepgram credits exhausted. Top up at [console.deepgram.com](https://console.deepgram.com) |
| `LLM call timed out after 180s` | Provider down or rate-limited. Try a different `LLM_PROVIDER` in `.env` |
| Agent reads error strings aloud | LLM provider returned an error that openclaw passed through. Check the terminal — usually billing or quota |
| First turn hangs ~30s with no audio | Openclaw cold-start blocking the event loop. Should resolve itself; if it persists, check that the warmup is firing in [src/index.ts](src/index.ts#L213) |
| Replies mangle restaurant or dish names | Add the term to [keyterms.json](keyterms.json) — Deepgram biases recognition toward those terms |

---

## Project structure

```
.env.example              Environment variable template
openclaw.json             OpenClaw config (Murf plugin, voice, skills)
keyterms.json             Deepgram STT bias terms (Indian-English food vocab)
package.json              openclaw, openclaw-murf-tts, deepgram, decibri, ws…
config/
  mcporter.json           Swiggy MCP server registration + OAuth
workspace/
  IDENTITY.md             System prompt — voice brevity, tool sequencing, no-promise-then-stop
  AGENTS.md               OpenClaw agent reference (auto-loaded)
  skills/swiggy/          Workspace mirror of skills/swiggy
skills/swiggy/
  SKILL.md                Tool reference the LLM reads to learn the CLI
  swiggy-cli.js           CLI wrapper around Swiggy's MCP via mcporter
src/
  index.ts                Entry point + event loop
  ear.ts                  Mic capture + Deepgram Flux WebSocket
  brain.ts                LLM routing + per-block streaming TTS
  voice.ts                One-shot + streaming speaker channels
  ui.ts                   Terminal rendering
assets/
  intro.wav               Pre-baked Murf clips for zero-latency openings
  filler.wav
  filler-long.wav
tests/
  voice-flow-smoke.ts     Full pipeline smoke test (text-driven, no mic)
  murf-chunking-smoke.ts  Isolated TTS chunking + WAV concat test
  ui-demo.ts              Terminal UI smoke test (no network)
  stt-diagnostic.ts       Deepgram-only smoke test
```

---

## Make it your own

The Swiggy skill is one swap away from anything else on [ClawHub](https://hub.openclaw.kr). The voice loop doesn't care what the agent does — it just turns transcripts into agent calls and replies into audio.

```bash
clawhub install <some-other-skill>
# then edit openclaw.json: agents.defaults.skills += "<that-skill>"
# and rewrite workspace/IDENTITY.md to describe what the agent does now
```

A GitHub PR-merging voice agent. A calendar scheduler. A Notion assistant. Same voice loop, different `skills` entry.

---

## Credits

Built with [OpenClaw](https://openclaw.kr), [openclaw-murf-tts](https://www.npmjs.com/package/openclaw-murf-tts), [Deepgram Flux](https://developers.deepgram.com/docs/flux), [Murf](https://murf.ai), [Swiggy MCP](https://mcp.swiggy.com), and [decibri](https://www.npmjs.com/package/decibri).
