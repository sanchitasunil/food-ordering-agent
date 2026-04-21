# food-ordering-agent

A voice-first [OpenClaw](https://openclaw.ai/) agent that orders food on Swiggy for you.

This is a showcase of what OpenClaw can do when you point its agent runtime, skill system, and block streaming at a voice loop. OpenClaw is doing the heavy lifting: it picks tools, runs the Swiggy skill that actually places the order, and streams its reply block-by-block into Murf TTS so the speaker starts talking mid-reply. Deepgram Flux handles the mic side, decibri handles native audio in and out. About 700 lines of TypeScript glue ties it all together.

```
┌─────┐     ┌──────────┐     ┌──────────────┐     ┌──────────┐     ┌──────────┐
│     │     │ Deepgram │     │   OpenClaw   │     │   Murf   │     │          │
│ mic │────▶│   Flux   │────▶│   + Swiggy   │────▶│  Falcon  │────▶│ speakers │
│     │     │  (STT)   │     │ (LLM+tools)  │     │  (TTS)   │     │          │
└─────┘     └──────────┘     └──────────────┘     └──────────┘     └──────────┘
     capture     transcribe       reason + act         synthesize       play
```

The interesting part: replies stream sentence-by-sentence. As soon as the LLM emits its first sentence, Murf synthesizes it and the speaker starts playing while the rest of the reply is still being generated. That comes from OpenClaw's block streaming hooks, the same pipeline used by its Telegram, Matrix, and WhatsApp channels, pointed at voice instead of chat.

This README walks you through getting it running end-to-end. Five minutes if you already have Node and a Swiggy account with a saved delivery address.

---

## Before you start

You'll need these installed on your machine:

| Tool | Why | How |
|---|---|---|
| Node.js 22+ | ESM-only project | [nodejs.org](https://nodejs.org/) |
| pnpm | Lockfile is pnpm | `npm i -g pnpm` |
| `mcporter` | OAuth handshake for the Swiggy skill | `npm i -g mcporter` |
| Mic + speakers | Native audio via [decibri](https://www.npmjs.com/package/decibri). WASAPI / CoreAudio / ALSA. No SoX, no FFmpeg | Built in to your OS |
| Swiggy account | The agent uses your saved delivery addresses (not GPS) | Open the Swiggy app, save at least one address |

> **Linux only:** if you're on a minimal distro and `pnpm install` complains about ALSA headers, run `sudo apt install libasound2-dev`. Desktop distros usually have these already.

And three API keys (all free tiers work):

| Key | Where |
|---|---|
| `DEEPGRAM_API_KEY` | [console.deepgram.com](https://console.deepgram.com/). $200 free credit |
| `MURF_API_KEY` | [murf.ai/api](https://murf.ai/api) |
| Any LLM provider key | Pick one of three the code supports: `GEMINI_API_KEY` from [aistudio.google.dev](https://aistudio.google.dev/apikey), `OPENROUTER_API_KEY` from [openrouter.ai](https://openrouter.ai/keys), or `OPENCODE_API_KEY` from [opencode.ai/auth](https://opencode.ai/auth). Set `LLM_PROVIDER` in `.env` to match. |

---

## Step 1: Clone and install

```bash
git clone <repo-url> food-ordering-agent
cd food-ordering-agent
pnpm install
cp .env.example .env
```

Open `.env` and paste in your Deepgram, Murf, and LLM keys. Make sure `LLM_PROVIDER` matches whichever LLM key you filled in (`gemini`, `openrouter`, or `opencode`). If you picked Gemini, the defaults already work.

---

## Step 2: Set up the Murf TTS plugin

The Murf plugin lives in OpenClaw's plugin registry as `murf-tts`. If you were starting from scratch, you'd install it with:

```bash
openclaw plugins install murf-tts
```

Or directly from npm:

```bash
npm install murf-tts
```

(`openclaw` is a peer dependency, so your gateway/workspace provides it.)

In this repo the plugin is already listed as a dependency in [package.json](package.json) and enabled in [openclaw.json](openclaw.json) under `plugins.entries`, so `pnpm install` from Step 1 has already pulled it in. Nothing extra to run.

The only thing the plugin needs from you is the `MURF_API_KEY` you already set in Step 1. If you haven't signed up yet, grab a key at [murf.ai/api](https://murf.ai/api) and drop it in `.env`.

On startup, the plugin reads that key and openclaw routes every TTS call through Murf Falcon using the voice config in [openclaw.json](openclaw.json):

```json
"messages": {
  "tts": {
    "provider": "murf",
    "auto": "off",
    "mode": "final",
    "providers": {
      "murf": {
        "voiceId": "en-IN-anusha",
        "model": "FALCON",
        "locale": "en-IN",
        "style": "Conversational"
      }
    }
  }
}
```

**The important bit: `auto: "off"`.** This is what makes streaming work. With `auto` on, openclaw would synthesize the whole reply in one shot and hand us a single audio file at the end, which means the user waits for the full reply before hearing anything. With it off, we drive synthesis ourselves from `brain.ts`: we subscribe to openclaw's block streaming hooks, call the Murf plugin's `synthesize()` per sentence as the LLM emits it, and play each chunk the moment it's ready. That's the whole reason the agent feels conversational instead of turn-based.

You can change the voice later by editing `voiceId` and `locale` together (they must match; an `en-IN` voice won't render correctly under an `en-US` locale). Browse the voice library in the Murf API docs.

---

## Step 3: Set up the Swiggy skill

The Swiggy skill lives on [ClawHub](https://hub.openclaw.kr), OpenClaw's skill registry. If you were starting from scratch you'd install it with:

```bash
clawhub install swiggy
```

In this repo the [skill](skills/swiggy/) is already vendored and registered in [openclaw.json](openclaw.json) under `agents.defaults.skills`, so there's no install step to run here.

One tweak worth flagging: [skills/swiggy/SKILL.md](skills/swiggy/SKILL.md) has been edited so every command reads `node skills/swiggy/swiggy-cli.js food <cmd>` instead of the upstream `swiggy food <cmd>`. OpenClaw's shell executor doesn't always have npm globals on `PATH`, so the `swiggy` binary installed by `clawhub` isn't reachable from the agent's shell. Same arguments, same behavior, just a direct path to the CLI file. If you swap in a different skill later and see "command not found" in the agent logs, this is usually what's going on.

What the skill does need is access to your Swiggy account, which takes one OAuth handshake.

First, make sure:

- Your Swiggy account has **at least one saved delivery address** in the mobile app. The agent uses saved addresses, not GPS, so without one every order attempt will fail.
- `mcporter` is installed globally (from the prerequisites table above).

Then run the auth flow once:

```bash
mcporter auth swiggy-food
```

This opens a browser, signs you into Swiggy, and saves the token locally. You won't need to redo it unless the token expires.

> **Windows note:** `mcporter`'s OAuth URL gets truncated in the browser launcher on Windows. If the browser complains that `client_id` is required, run `mcporter --log-level debug auth swiggy-food --reset`, copy the full URL out of the debug log, and paste it into your browser manually.

Confirm the skill can actually reach Swiggy:

```bash
node skills/swiggy/swiggy-cli.js food addresses
```

You should see your saved addresses print out. If the list is empty, go save one in the Swiggy app before moving on.

---

## Step 4: Run it

```bash
pnpm start
```

The startup banner appears, the agent greets you with *"Hi, I'm your food ordering assistant. What are you in the mood for?"*, and the mic opens.

> Try saying: *"I feel like having biryani."*

Here's what the first turn looks like:

```ansi
[36m╭──────────────────────────────────────────────────╮[0m
[36m│[0m   [36;1mfood-ordering-agent[0m                            [36m│[0m
[36m│[0m   voice → LLM → tools → voice                    [36m│[0m
[36m│[0m                                                  [36m│[0m
[36m│[0m   STT     deepgram flux                          [36m│[0m
[36m│[0m   LLM     gemini  ›  google/gemini-2.5-flash     [36m│[0m
[36m│[0m   TTS     murf falcon  ›  en-IN-anusha           [36m│[0m
[36m│[0m   Skill   swiggy-food                            [36m│[0m
[36m│[0m                                                  [36m│[0m
[36m│[0m   Press Ctrl+C to exit                           [36m│[0m
[36m╰──────────────────────────────────────────────────╯[0m
[36m✔ Ready (3.2s)[0m
[36m──────────────────────────────────────────────────────────────[0m
[33m🤖 Agent    Hi, I'm your food ordering assistant. What are you in the mood for?[0m
[35m🔊 Speaking Hi, I'm your food ordering assistant. What are you in the mood for?[0m
[36m──────────────────────────────────────────────────────────────[0m
[34m🎤 You      I feel like having biryani.[0m
  [32m🔧 Tool     exec[0m
  [32m🔧 Tool     exec[0m
  [33m🤖 Agent    Two top-rated near you. Meghana Foods, four point five, about thirty seven minutes. Paradise Biryani, four point four, forty two minutes. Which one?[0m
  [35m🔊 Speaking Two top-rated near you. Meghana Foods, four point five, about thirty seven minutes…[0m
```

Color scheme: blue = user, yellow = agent, green = tools, magenta = TTS, cyan = system.

---

## How it works under the hood

Every turn runs through six stages:

| # | Stage | Component | What it does |
|---|---|---|---|
| 1 | Capture | [decibri](https://www.npmjs.com/package/decibri) | 16-bit PCM at 16 kHz from the mic, 100ms frames |
| 2 | Transcribe | [Deepgram Flux](https://flux.deepgram.com/) | Voice-agent STT with model-integrated end-of-turn detection. Streams over `/v2/listen` |
| 3 | Reason | OpenClaw + LLM | Picks tools, drives the Swiggy skill, generates the reply |
| 4 | Act | Swiggy skill | Fetches addresses, searches restaurants, manages the cart, places the order |
| 5 | Speak | Murf Falcon (via openclaw plugin) | Per-sentence TTS streamed on openclaw block hooks |
| 6 | Play | decibri output stream | Audio chunks queue onto a long-lived speaker stream |

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

For tool-heavy turns where the LLM emits the entire reply in one shot after the tool calls resolve, `onPartialReply` provides a token-level fallback. We accumulate text, detect `.!?` sentence boundaries, and dispatch sentences as they complete. Both hooks write into a single `canonicalText` cursor so they never double-speak.

### How latency hides

Three small tricks compound:

- **Pre-baked filler clips.** `assets/intro.wav`, `filler.wav`, `filler-long.wav` are synthesized once with Murf and saved to disk. At runtime they play from a one-shot decibri stream. Zero API latency, audible within ~100ms of the user finishing speaking.
- **Background warmup.** `setImmediate(() => warmup())` at startup runs OpenClaw's expensive cold-start (skill load, plugin init, provider resolution) in parallel with the user hearing the intro.
- **Mic re-arms during playback.** The Deepgram WebSocket handshake runs while the agent is still talking, so the mic is already hot the moment the agent stops.

### How turn-taking works

The agent never talks over itself. A new transcript stops in-flight playback. The system prompt ([workspace/IDENTITY.md](workspace/IDENTITY.md)) drills the LLM on never ending a turn with *"let me check"*. Every promise of action must be performed in the same turn before handing the mic back. Restaurant names and dish names mentioned by the agent get fed into Deepgram's keyterm bias for the next turn ([keyterms.json](keyterms.json) plus per-turn injection), so when the user echoes them back they're recognized correctly.

---

## Customizing

Three things live in `.env`:

```bash
LLM_PROVIDER=gemini       # gemini | openrouter | opencode
LLM_MODEL=                # optional, defaults per provider
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

The voice, voice settings, and TTS provider are in [openclaw.json](openclaw.json) under `messages.tts.providers.murf`. Default is `en-IN-anusha` with the Falcon model. Other Murf voices: change `voiceId` and `locale`. Make sure the locale matches the voice. `en-IN` voices don't always work with `en-US` locale settings.

---

## Honest about latency

The first turn is slow. Cold-starts from openclaw (skill resolution, plugin init), the LLM provider, and Murf all stack up. Expect **15-50 seconds** before you hear the first sentence on turn 1, with most of that being the cold start plus tool-call chains.

Subsequent turns are bounded by **how fast the LLM produces text**, not by audio synthesis. Once the LLM starts emitting the reply, the user hears the first sentence within 1-3 seconds. For tool-heavy turns where the LLM waits for all tool results before producing any text, the first audio is roughly `LLM-time-until-first-sentence + ~1-2s for synth`. Streaming TTS doesn't reduce LLM-or-tool latency. It just removes audio synthesis from the critical path.

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
| Agent reads error strings aloud | LLM provider returned an error that openclaw passed through. Check the terminal, usually billing or quota |
| First turn hangs ~30s with no audio | Openclaw cold-start blocking the event loop. Should resolve itself; if it persists, check that the warmup is firing in [src/index.ts](src/index.ts#L213) |
| Replies mangle restaurant or dish names | Add the term to [keyterms.json](keyterms.json). Deepgram biases recognition toward those terms |

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
  IDENTITY.md             System prompt: voice brevity, tool sequencing, no-promise-then-stop
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

The Swiggy skill is one swap away from anything else on [ClawHub](https://hub.openclaw.kr). The voice loop doesn't care what the agent does. It just turns transcripts into agent calls and replies into audio.

```bash
clawhub install <some-other-skill>
# then edit openclaw.json: agents.defaults.skills += "<that-skill>"
# and rewrite workspace/IDENTITY.md to describe what the agent does now
```

A GitHub PR-merging voice agent. A calendar scheduler. A Notion assistant. Same voice loop, different `skills` entry.

---

## Credits

Built with [OpenClaw](https://openclaw.ai/), [murf-tts](https://clawhub.ai/plugins/murf-tts), [Deepgram Flux](https://flux.deepgram.com/), [Murf](https://murf.ai/api), [Swiggy skill](https://clawhub.ai/regalstreak/swiggy), and [decibri](https://www.npmjs.com/package/decibri).
