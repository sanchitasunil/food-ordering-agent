const fs = require("fs");
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  Header, Footer, AlignmentType, LevelFormat, HeadingLevel,
  BorderStyle, WidthType, ShadingType, PageNumber, PageBreak,
  TabStopType, TabStopPosition,
} = require("docx");

// ── Color palette ──────────────────────────────────────────────
const MAGENTA   = "9B2D8F";
const DARK_GREY = "333333";
const MID_GREY  = "666666";
const LIGHT_BG  = "F5F0F7";
const ACCENT_BG = "EDE5F3";
const WHITE     = "FFFFFF";
const BORDER_CLR = "CCCCCC";

// ── Page geometry (US Letter) ──────────────────────────────────
const PAGE_W   = 12240;
const PAGE_H   = 15840;
const MARGIN   = 1440;
const CONTENT_W = PAGE_W - MARGIN * 2; // 9360

// ── Numbering ──────────────────────────────────────────────────
const numberingConfig = [
  {
    reference: "bullets",
    levels: [{
      level: 0, format: LevelFormat.BULLET, text: "\u2022",
      alignment: AlignmentType.LEFT,
      style: { paragraph: { indent: { left: 720, hanging: 360 } } },
    }],
  },
  {
    reference: "numbers",
    levels: [{
      level: 0, format: LevelFormat.DECIMAL, text: "%1.",
      alignment: AlignmentType.LEFT,
      style: { paragraph: { indent: { left: 720, hanging: 360 } } },
    }],
  },
];

// ── Helpers ─────────────────────────────────────────────────────
const border = { style: BorderStyle.SINGLE, size: 1, color: BORDER_CLR };
const borders = { top: border, bottom: border, left: border, right: border };
const noBorders = {
  top: { style: BorderStyle.NONE, size: 0 },
  bottom: { style: BorderStyle.NONE, size: 0 },
  left: { style: BorderStyle.NONE, size: 0 },
  right: { style: BorderStyle.NONE, size: 0 },
};
const cellMargins = { top: 80, bottom: 80, left: 120, right: 120 };

function spacer(pts = 200) {
  return new Paragraph({ spacing: { after: pts }, children: [] });
}

function heading1(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 360, after: 200 },
    children: [new TextRun({ text, bold: true, font: "Arial", size: 36, color: MAGENTA })],
  });
}

function heading2(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 280, after: 160 },
    children: [new TextRun({ text, bold: true, font: "Arial", size: 28, color: DARK_GREY })],
  });
}

function heading3(text) {
  return new Paragraph({
    spacing: { before: 200, after: 120 },
    children: [new TextRun({ text, bold: true, font: "Arial", size: 24, color: MID_GREY })],
  });
}

function body(text, opts = {}) {
  return new Paragraph({
    spacing: { after: 160, line: 320 },
    children: [new TextRun({ text, font: "Arial", size: 22, color: DARK_GREY, ...opts })],
  });
}

function bodyRuns(runs) {
  return new Paragraph({
    spacing: { after: 160, line: 320 },
    children: runs.map(r => new TextRun({ font: "Arial", size: 22, color: DARK_GREY, ...r })),
  });
}

function bullet(text) {
  return new Paragraph({
    numbering: { reference: "bullets", level: 0 },
    spacing: { after: 80, line: 300 },
    children: [new TextRun({ text, font: "Arial", size: 22, color: DARK_GREY })],
  });
}

function bulletRuns(runs) {
  return new Paragraph({
    numbering: { reference: "bullets", level: 0 },
    spacing: { after: 80, line: 300 },
    children: runs.map(r => new TextRun({ font: "Arial", size: 22, color: DARK_GREY, ...r })),
  });
}

function numbered(text, ref = "numbers") {
  return new Paragraph({
    numbering: { reference: ref, level: 0 },
    spacing: { after: 80, line: 300 },
    children: [new TextRun({ text, font: "Arial", size: 22, color: DARK_GREY })],
  });
}

function codeBlock(lines) {
  return lines.map(line =>
    new Paragraph({
      spacing: { after: 40 },
      indent: { left: 360 },
      children: [new TextRun({ text: line, font: "Consolas", size: 20, color: "2D2D2D" })],
    })
  );
}

function scriptDirection(text) {
  return new Paragraph({
    spacing: { after: 120, line: 300 },
    indent: { left: 360 },
    children: [new TextRun({ text: `[${text}]`, font: "Arial", size: 20, color: MAGENTA, italics: true })],
  });
}

function timestamp(time) {
  return new Paragraph({
    spacing: { before: 240, after: 80 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 2, color: MAGENTA, space: 4 } },
    children: [new TextRun({ text: time, font: "Arial", size: 20, bold: true, color: MAGENTA })],
  });
}

function narration(text) {
  return new Paragraph({
    spacing: { after: 160, line: 340 },
    children: [new TextRun({ text, font: "Arial", size: 22, color: DARK_GREY })],
  });
}

// Two-column info row (no borders)
function infoRow(label, value, colWidths = [2400, 6960]) {
  return new Table({
    width: { size: CONTENT_W, type: WidthType.DXA },
    columnWidths: colWidths,
    rows: [new TableRow({
      children: [
        new TableCell({
          borders: noBorders, width: { size: colWidths[0], type: WidthType.DXA },
          margins: cellMargins,
          children: [new Paragraph({ children: [new TextRun({ text: label, font: "Arial", size: 20, bold: true, color: MID_GREY })] })],
        }),
        new TableCell({
          borders: noBorders, width: { size: colWidths[1], type: WidthType.DXA },
          margins: cellMargins,
          children: [new Paragraph({ children: [new TextRun({ text: value, font: "Arial", size: 20, color: DARK_GREY })] })],
        }),
      ],
    })],
  });
}

// ── Document content ───────────────────────────────────────────

const children = [];

// ─── TITLE PAGE ────────────────────────────────────────────────
children.push(spacer(1600));
children.push(new Paragraph({
  alignment: AlignmentType.CENTER,
  spacing: { after: 120 },
  children: [new TextRun({ text: "VIDEO TUTORIAL SCRIPT", font: "Arial", size: 20, bold: true, color: MAGENTA, characterSpacing: 200 })],
}));
children.push(new Paragraph({
  alignment: AlignmentType.CENTER,
  spacing: { after: 200 },
  children: [new TextRun({ text: "Build a Voice-Powered Food Ordering Agent", font: "Arial", size: 48, bold: true, color: DARK_GREY })],
}));
children.push(new Paragraph({
  alignment: AlignmentType.CENTER,
  spacing: { after: 100 },
  children: [new TextRun({ text: "Real-Time STT + Agentic LLM + Live Swiggy Data + TTS", font: "Arial", size: 24, color: MID_GREY })],
}));
children.push(new Paragraph({
  alignment: AlignmentType.CENTER,
  spacing: { after: 600 },
  children: [new TextRun({ text: "A complete Node.js CLI project tutorial", font: "Arial", size: 22, color: MID_GREY, italics: true })],
}));

children.push(spacer(400));
children.push(infoRow("Duration:", "~20\u201325 minutes"));
children.push(infoRow("Format:", "Screen recording + voiceover"));
children.push(infoRow("Audience:", "Developers (any level)"));
children.push(infoRow("Stack:", "Node 22, TypeScript, Deepgram, OpenClaw, Murf, Swiggy MCP"));
children.push(infoRow("Repo:", "github.com/[your-handle]/food-ordering-agent"));

children.push(new Paragraph({ children: [new PageBreak()] }));

// ─── TABLE OF CONTENTS (manual) ───────────────────────────────
children.push(heading1("Contents"));
children.push(spacer(100));

const tocEntries = [
  ["0:00", "Cold Open \u2014 The Demo"],
  ["1:30", "What We\u2019re Building (Architecture)"],
  ["3:30", "Project Setup & API Keys"],
  ["6:00", "Module 1 \u2014 Terminal UI (ui.ts)"],
  ["8:00", "Module 2 \u2014 Microphone + Deepgram STT (ear.ts)"],
  ["10:30", "Module 3 \u2014 The Agentic Brain (brain.ts)"],
  ["14:00", "Module 4 \u2014 TTS Playback (voice.ts)"],
  ["15:30", "Module 5 \u2014 The Event Loop (index.ts)"],
  ["17:30", "The Swiggy Skill & System Prompt"],
  ["19:30", "Live Demo \u2014 Ordering Food by Voice"],
  ["22:00", "What To Build Next + Wrap-Up"],
];

for (const [ts, title] of tocEntries) {
  children.push(new Paragraph({
    spacing: { after: 80 },
    tabStops: [{ type: TabStopType.RIGHT, position: TabStopPosition.MAX }],
    children: [
      new TextRun({ text: title, font: "Arial", size: 22, color: DARK_GREY }),
      new TextRun({ text: `\t${ts}`, font: "Arial", size: 22, color: MAGENTA }),
    ],
  }));
}

children.push(new Paragraph({ children: [new PageBreak()] }));

// ─── SECTION 1: COLD OPEN ─────────────────────────────────────
children.push(timestamp("0:00 \u2014 COLD OPEN: THE DEMO"));
children.push(scriptDirection("Screen: terminal running the agent. Cursor blinking. No intro slate \u2014 jump straight into action."));
children.push(spacer(60));
children.push(narration("We\u2019re going to start with the finished product. No preamble. Watch this."));
children.push(spacer(60));
children.push(scriptDirection("Speak into mic: \u201CI feel like having garlic bread.\u201D"));
children.push(scriptDirection("Terminal shows: transcription in blue, tool calls in green, agent reply in yellow, TTS playback in magenta."));
children.push(spacer(60));
children.push(narration("I just talked to my terminal. It understood me in real time, searched actual restaurants on Swiggy, found garlic bread near me, and read the results back \u2014 out loud."));
children.push(spacer(60));
children.push(narration("No mock data. No simulated API. That\u2019s a live Swiggy query against real restaurants in Bengaluru. And the voice you heard? That\u2019s Murf\u2019s FALCON model synthesizing speech on the fly."));
children.push(spacer(60));
children.push(narration("In this video, I\u2019ll show you how to build this from scratch. We\u2019re chaining four systems together \u2014 speech-to-text, an agentic LLM with tool calling, a live food delivery API, and text-to-speech \u2014 all inside a single Node.js CLI script."));
children.push(spacer(60));
children.push(narration("It\u2019s about 500 lines of TypeScript spread across five files. Let\u2019s break it down."));

children.push(new Paragraph({ children: [new PageBreak()] }));

// ─── SECTION 2: ARCHITECTURE ──────────────────────────────────
children.push(timestamp("1:30 \u2014 WHAT WE\u2019RE BUILDING"));
children.push(scriptDirection("Screen: show the architecture diagram (ASCII pipeline from README, or a clean graphic)."));
children.push(spacer(60));
children.push(narration("Here\u2019s the whole system in one line:"));
children.push(spacer(60));
children.push(bodyRuns([
  { text: "Microphone \u2192 Deepgram STT \u2192 OpenClaw Agent \u2192 Swiggy MCP \u2192 Murf TTS \u2192 Speakers", bold: true },
]));
children.push(spacer(60));
children.push(narration("Five stages. Each one does one thing well. Let me walk through them."));
children.push(spacer(100));

children.push(heading3("Stage 1: The Ear"));
children.push(narration("We capture raw audio from your microphone using decibri \u2014 a native audio addon that talks directly to WASAPI on Windows, CoreAudio on Mac, or ALSA on Linux. No SoX, no ffmpeg, no external binaries. We stream those PCM chunks over a WebSocket to Deepgram\u2019s Nova-2 model, which transcribes in real time. When Deepgram marks a transcript as final, we pass it forward."));

children.push(heading3("Stage 2: The Brain"));
children.push(narration("The transcript hits OpenClaw \u2014 an agentic LLM framework. Think of it as a lightweight orchestrator that takes a user message, routes it to a model like Gemini 2.5 Flash, and lets that model call tools. The key tool here is the Swiggy skill, which searches restaurants, browses menus, manages a cart, and places orders \u2014 all through Swiggy\u2019s live MCP servers."));

children.push(heading3("Stage 3: The Mouth"));
children.push(narration("Once the agent has a text response, we hand it to Murf\u2019s FALCON TTS engine. It synthesizes a WAV buffer with an Indian English voice. We play that buffer through the system speakers using decibri\u2019s output API. Then we loop back to listening."));

children.push(spacer(100));
children.push(narration("That\u2019s it. Five files, one event loop, real food delivery. Let me show you the code."));

children.push(new Paragraph({ children: [new PageBreak()] }));

// ─── SECTION 3: SETUP ────────────────────────────────────────
children.push(timestamp("3:30 \u2014 PROJECT SETUP & API KEYS"));
children.push(scriptDirection("Screen: VS Code or editor showing the project root. Terminal split below."));
children.push(spacer(60));
children.push(narration("Let\u2019s start with project setup. You\u2019ll need Node 22 or later and pnpm."));
children.push(spacer(60));
children.push(heading3("Clone and install"));
children.push(...codeBlock([
  "git clone <repo-url> food-ordering-agent",
  "cd food-ordering-agent",
  "pnpm install",
]));
children.push(spacer(60));
children.push(narration("Now copy the environment template:"));
children.push(...codeBlock(["cp .env.example .env"]));
children.push(spacer(100));

children.push(heading3("API Keys \u2014 What You Need"));
children.push(narration("You need three API keys. Let me walk through each one."));
children.push(spacer(60));

// API key table
const apiHeaders = ["Service", "Key Name", "Where to Get It"];
const apiRows = [
  ["Deepgram (STT)", "DEEPGRAM_API_KEY", "console.deepgram.com \u2014 free tier gives $200 credit"],
  ["Murf (TTS)", "MURF_API_KEY", "murf.ai \u2192 API settings \u2014 free trial available"],
  ["Gemini (LLM)", "GEMINI_API_KEY", "aistudio.google.dev/apikey \u2014 free tier is generous"],
];

const headerCells = apiHeaders.map((h, i) => {
  const widths = [2200, 3000, 4160];
  return new TableCell({
    borders, width: { size: widths[i], type: WidthType.DXA },
    shading: { fill: MAGENTA, type: ShadingType.CLEAR },
    margins: cellMargins,
    children: [new Paragraph({ children: [new TextRun({ text: h, font: "Arial", size: 20, bold: true, color: WHITE })] })],
  });
});

const dataRows = apiRows.map(row => {
  const widths = [2200, 3000, 4160];
  return new TableRow({
    children: row.map((cell, i) => new TableCell({
      borders, width: { size: widths[i], type: WidthType.DXA },
      margins: cellMargins,
      children: [new Paragraph({ children: [new TextRun({ text: cell, font: "Arial", size: 20, color: DARK_GREY })] })],
    })),
  });
});

children.push(new Table({
  width: { size: CONTENT_W, type: WidthType.DXA },
  columnWidths: [2200, 3000, 4160],
  rows: [new TableRow({ children: headerCells }), ...dataRows],
}));

children.push(spacer(100));
children.push(narration("Paste all three into your .env file. That\u2019s it for keys."));
children.push(spacer(60));

children.push(heading3("Swiggy Authentication"));
children.push(narration("Swiggy uses OAuth through mcporter. Run this once:"));
children.push(...codeBlock(["mcporter auth swiggy-food"]));
children.push(narration("It opens a browser window. Log into your Swiggy account, authorize the app, and you\u2019re set. One thing \u2014 make sure you have at least one delivery address saved in the Swiggy app. The agent uses your saved addresses, not GPS."));

children.push(spacer(60));
children.push(scriptDirection("Tip: On Windows, mcporter has a URL-truncation bug. If the browser shows a \u201Cclient_id required\u201D error, copy the full URL from the terminal output and paste it manually."));

children.push(new Paragraph({ children: [new PageBreak()] }));

// ─── SECTION 4: UI MODULE ─────────────────────────────────────
children.push(timestamp("6:00 \u2014 MODULE 1: TERMINAL UI (ui.ts)"));
children.push(scriptDirection("Screen: open src/ui.ts in editor. Highlight the color constants at the top."));
children.push(spacer(60));
children.push(narration("Let\u2019s start with the UI, because it\u2019s the layer everything else talks through. This project has a hard rule: no raw console.log calls anywhere. Every line of terminal output goes through ui.ts."));
children.push(spacer(60));
children.push(narration("Why? Because this is a demo project. The terminal IS the interface. And we want it to look good in screen recordings and videos \u2014 exactly like this one."));
children.push(spacer(100));

children.push(heading3("The Color Scheme"));
children.push(narration("Four role colors, strictly enforced:"));
children.push(spacer(60));
children.push(bulletRuns([{ text: "Blue", bold: true }, { text: " \u2014 user voice (what you said)" }]));
children.push(bulletRuns([{ text: "Yellow", bold: true }, { text: " \u2014 agent reasoning (what the LLM replied)" }]));
children.push(bulletRuns([{ text: "Green", bold: true }, { text: " \u2014 tool execution (Swiggy API calls)" }]));
children.push(bulletRuns([{ text: "Magenta", bold: true }, { text: " \u2014 TTS output (what\u2019s being spoken)" }]));
children.push(spacer(60));
children.push(narration("System messages use cyan, dim, so they never collide with the main four."));
children.push(spacer(100));

children.push(heading3("Key Functions"));
children.push(narration("The module exports labeled log functions \u2014 logUser, logAgent, logTool, logVoice, logSystem, logError. Each one prints a fixed-width prefix with an emoji icon so columns align in transcripts."));
children.push(spacer(60));
children.push(narration("There\u2019s also a spinner system built on ora. startThinking shows a yellow dots animation while the LLM is working. startListeningSpinner shows blue dots while the mic is active. Only one spinner can exist at a time \u2014 starting a new one automatically stops the old one."));
children.push(spacer(60));
children.push(narration("And then there\u2019s the startup banner. It uses boxen to draw a rounded box showing which STT, LLM, TTS, and skill are active. It\u2019s the first thing you see when you run the project."));

children.push(new Paragraph({ children: [new PageBreak()] }));

// ─── SECTION 5: EAR MODULE ────────────────────────────────────
children.push(timestamp("8:00 \u2014 MODULE 2: MICROPHONE + DEEPGRAM STT (ear.ts)"));
children.push(scriptDirection("Screen: open src/ear.ts. Highlight the startListening function."));
children.push(spacer(60));
children.push(narration("ear.ts handles two things: capturing audio from your microphone, and streaming it to Deepgram for transcription."));
children.push(spacer(100));

children.push(heading3("Mic Capture with decibri"));
children.push(narration("We use decibri, a native Node addon that talks directly to your OS audio system. No SoX, no external binaries. It captures 16-bit PCM at 16kHz in 1600-frame chunks \u2014 that\u2019s 100 milliseconds of audio per chunk. Each chunk fires a data event, and we forward it straight to the Deepgram WebSocket."));
children.push(spacer(100));

children.push(heading3("Deepgram WebSocket"));
children.push(narration("We open a WebSocket connection to Deepgram\u2019s streaming API with specific parameters: Nova-2 model, English language, smart formatting, and interim results enabled. The critical parameter is endpointing at 200 milliseconds \u2014 that\u2019s how long Deepgram waits after you stop talking before it marks a transcript as final."));
children.push(spacer(60));
children.push(narration("When a message comes back from the WebSocket, we parse it, check if is_final is true, and if there\u2019s a non-empty transcript, we fire the callback. That callback is what triggers the brain."));
children.push(spacer(100));

children.push(heading3("Lifecycle"));
children.push(narration("Notice the pattern here: startListening creates both the WebSocket and the mic, and stopListening tears both down. We call stopListening at the start of every new conversation turn \u2014 we don\u2019t want the mic picking up the agent\u2019s own TTS output. After the agent finishes speaking, we restart listening."));

children.push(new Paragraph({ children: [new PageBreak()] }));

// ─── SECTION 6: BRAIN MODULE ──────────────────────────────────
children.push(timestamp("10:30 \u2014 MODULE 3: THE AGENTIC BRAIN (brain.ts)"));
children.push(scriptDirection("Screen: open src/brain.ts. This is the longest module. Scroll through slowly."));
children.push(spacer(60));
children.push(narration("This is the core. brain.ts does three things: configures the LLM agent, handles TTS synthesis, and manages timeouts. Let\u2019s take them one at a time."));
children.push(spacer(100));

children.push(heading3("LLM Configuration"));
children.push(narration("At the top, we build a CONFIG_OVERRIDE object that tells OpenClaw everything it needs: which model to use, where the workspace is, which skills to load, and how to configure TTS. The model defaults to Gemini 2.5 Flash, but you can switch to OpenRouter or OpenCode by changing one line in your .env file."));
children.push(spacer(60));
children.push(narration("The provider switching is interesting \u2014 we define a PROVIDER_DEFAULT_MODELS map with three entries: gemini, openrouter, and opencode. Each maps to a default model string. The LLM_PROVIDER env var picks the provider, and LLM_MODEL optionally overrides the model. No code changes, no rebuild. Just edit .env and restart."));
children.push(spacer(100));

children.push(heading3("The chat() Function"));
children.push(narration("When the user speaks, handleTranscription in index.ts calls chat() with the transcript text. Here\u2019s what happens inside:"));
children.push(spacer(60));
children.push(numbered("We build a context object with the user\u2019s message, a session key, and Bengaluru coordinates for location context."));
children.push(numbered("We call OpenClaw\u2019s getReplyFromConfig, which sends the message to the LLM, executes any tool calls the model makes, and returns the final response."));
children.push(numbered("We race that call against a 180-second timeout. This is critical \u2014 a misconfigured provider would otherwise hang forever and lock the user out of the conversation loop."));
children.push(numbered("We extract the text response, check if OpenClaw attached TTS audio natively, and if not, fall back to manual synthesis."));
children.push(spacer(60));
children.push(narration("See that onToolStart callback? Every time the LLM calls a tool, we fire logTool so you see those green lines in the terminal. It makes the agent\u2019s reasoning visible."));
children.push(spacer(100));

children.push(heading3("TTS Chunking \u2014 The Tricky Part"));
children.push(scriptDirection("Highlight the chunkTextForTts function."));
children.push(spacer(60));
children.push(narration("Murf\u2019s FALCON API has a 3000-character limit per request. If the agent writes a long reply, we can\u2019t just send it all at once. So we split it."));
children.push(spacer(60));
children.push(narration("chunkTextForTts splits text into 1500-character chunks, preferring sentence boundaries. If a single sentence is longer than the budget, it falls back to word boundaries. If a single word is longer \u2014 which happens with URLs or raw JSON \u2014 it does a hard cut. Each chunk gets synthesized in parallel, then we concatenate the WAV buffers and patch the RIFF headers so the result plays as one continuous audio clip."));
children.push(spacer(60));
children.push(narration("The WAV patching is necessary because Murf\u2019s streaming endpoint writes sentinel sizes in the headers \u2014 it doesn\u2019t know the final length upfront. We fix those after the fact so any audio player can read the file correctly."));

children.push(new Paragraph({ children: [new PageBreak()] }));

// ─── SECTION 7: VOICE MODULE ──────────────────────────────────
children.push(timestamp("14:00 \u2014 MODULE 4: TTS PLAYBACK (voice.ts)"));
children.push(scriptDirection("Screen: open src/voice.ts. It\u2019s the shortest module."));
children.push(spacer(60));
children.push(narration("voice.ts is refreshingly simple. Two exports: playAudio and stopPlayback."));
children.push(spacer(60));
children.push(narration("playAudio takes a WAV buffer, strips the RIFF header to get raw PCM data, opens a decibri output stream at 24kHz mono 16-bit, and writes the PCM into it. The stream fires a finish event when playback completes, and we resolve the promise."));
children.push(spacer(60));
children.push(narration("stopPlayback kills any in-progress audio. We call it at the start of every new conversation turn so the agent doesn\u2019t talk over itself."));
children.push(spacer(60));
children.push(narration("That\u2019s it. 57 lines. The native audio addon does all the heavy lifting."));

children.push(new Paragraph({ children: [new PageBreak()] }));

// ─── SECTION 8: INDEX MODULE ──────────────────────────────────
children.push(timestamp("15:30 \u2014 MODULE 5: THE EVENT LOOP (index.ts)"));
children.push(scriptDirection("Screen: open src/index.ts. This is where everything connects."));
children.push(spacer(60));
children.push(narration("index.ts is the orchestrator. It\u2019s about 145 lines and it ties all four modules together. Let\u2019s walk through the startup sequence."));
children.push(spacer(100));

children.push(heading3("Startup"));
children.push(numbered("Print the startup banner showing active STT, LLM, TTS, and skill."));
children.push(numbered("Kick off OpenClaw warmup in the background using setImmediate. This is the expensive cold start \u2014 loading skills, resolving config, initializing the provider. We do it early so the first real chat call is faster."));
children.push(numbered("Play the intro audio clip. This is a pre-baked WAV loaded from disk \u2014 no Murf API call needed, so it\u2019s available instantly."));
children.push(numbered("Connect the microphone and start streaming to Deepgram."));
children.push(spacer(100));

children.push(heading3("The Conversation Turn"));
children.push(narration("When Deepgram finalizes a transcript, handleTranscription fires. Here\u2019s the sequence:"));
children.push(spacer(60));
children.push(numbered("Stop listening. We don\u2019t want to pick up background noise or the agent\u2019s own voice."));
children.push(numbered("Play a filler clip \u2014 \u201COne moment please\u201D \u2014 so the user knows we heard them."));
children.push(numbered("Start the thinking spinner."));
children.push(numbered("If the LLM takes more than 5 seconds, play a longer filler: \u201CI\u2019m checking on it.\u201D This is a small UX touch that makes a big difference \u2014 otherwise the user thinks the agent froze."));
children.push(numbered("When chat() resolves, stop the spinner, play the TTS audio, then restart listening."));
children.push(spacer(60));
children.push(narration("The keepalive at the bottom \u2014 setInterval with an empty callback \u2014 just prevents Node from exiting since everything is event-driven. Ctrl+C triggers a graceful shutdown that tears down the mic, speaker, and spinners."));

children.push(new Paragraph({ children: [new PageBreak()] }));

// ─── SECTION 9: SWIGGY SKILL ─────────────────────────────────
children.push(timestamp("17:30 \u2014 THE SWIGGY SKILL & SYSTEM PROMPT"));
children.push(scriptDirection("Screen: open skills/swiggy/SKILL.md and workspace/IDENTITY.md side by side."));
children.push(spacer(60));
children.push(narration("Now let\u2019s talk about what makes this agent actually useful \u2014 the Swiggy skill and the system prompt."));
children.push(spacer(100));

children.push(heading3("The Skill Definition"));
children.push(narration("OpenClaw skills are just Markdown files with structured sections. The LLM reads this file to learn what tools are available and how to use them. Our Swiggy skill defines commands for searching restaurants, browsing menus, managing a cart, and placing orders \u2014 all through a CLI wrapper that calls Swiggy\u2019s MCP servers via mcporter."));
children.push(spacer(60));
children.push(narration("The critical design choice here is the address-first workflow. Almost every Swiggy command requires an addressId \u2014 a real ID from the user\u2019s saved Swiggy delivery addresses. There\u2019s no free-form location parameter. The skill explicitly tells the LLM: \u201Cfetch addresses first, then use the ID for everything else.\u201D"));
children.push(spacer(100));

children.push(heading3("The System Prompt"));
children.push(narration("IDENTITY.md is where we shape the agent\u2019s voice personality. Three key rules:"));
children.push(spacer(60));
children.push(bulletRuns([{ text: "Voice brevity.", bold: true }, { text: " Every reply gets spoken aloud at ~35ms per character. A 400-character reply takes 14 seconds to synthesize. The system prompt enforces a 400-character default with specific patterns \u2014 only name the top 2 restaurants, don\u2019t read raw IDs, use short address labels." }]));
children.push(bulletRuns([{ text: "Tool sequencing.", bold: true }, { text: " The prompt tells the LLM to chain multiple tool calls in a single turn. Don\u2019t stop to announce what you\u2019re about to do \u2014 just do it and report the results." }]));
children.push(bulletRuns([{ text: "Safety.", bold: true }, { text: " Never auto-order. Always show a cart preview and get explicit confirmation before placing an order. Cash on delivery only, orders capped at 1000 rupees." }]));
children.push(spacer(60));
children.push(narration("This is the part most tutorials skip \u2014 the prompt engineering that makes an agentic system feel natural rather than robotic. The LLM has the capability to call tools. The system prompt shapes when and how it uses them."));

children.push(new Paragraph({ children: [new PageBreak()] }));

// ─── SECTION 10: LIVE DEMO ───────────────────────────────────
children.push(timestamp("19:30 \u2014 LIVE DEMO: ORDERING FOOD BY VOICE"));
children.push(scriptDirection("Screen: full terminal, no editor. Run the agent fresh."));
children.push(spacer(60));
children.push(narration("Let\u2019s run it for real. I\u2019ll walk through a complete order."));
children.push(spacer(60));
children.push(...codeBlock(["pnpm start"]));
children.push(spacer(60));
children.push(scriptDirection("Wait for the banner and \u201CReady\u201D message. Agent speaks intro greeting."));
children.push(spacer(60));
children.push(narration("The banner shows us: Deepgram Nova-2 for STT, Gemini 2.5 Flash for the LLM, Murf FALCON for TTS, and the Swiggy skill loaded. Let\u2019s order something."));
children.push(spacer(100));

children.push(heading3("Turn 1: Search"));
children.push(scriptDirection("Speak: \u201CI feel like having garlic bread.\u201D"));
children.push(narration("Watch the terminal. Blue line \u2014 that\u2019s our transcription. Green lines \u2014 the agent is calling the Swiggy tool. It fetched my address and searched for garlic bread in a single turn. Yellow line \u2014 the agent\u2019s reply with the top two restaurants. Magenta line \u2014 speaking that reply out loud."));
children.push(spacer(100));

children.push(heading3("Turn 2: Pick a Restaurant"));
children.push(scriptDirection("Speak: \u201CLet\u2019s go with La Pino\u2019z.\u201D"));
children.push(narration("Now it\u2019s browsing La Pino\u2019z\u2019s menu, searching for garlic bread specifically. It finds the item, tells me the price, and asks if I want to add it to my cart."));
children.push(spacer(100));

children.push(heading3("Turn 3: Add to Cart and Order"));
children.push(scriptDirection("Speak: \u201CYes, add it.\u201D"));
children.push(scriptDirection("Agent adds to cart, shows preview, asks for confirmation."));
children.push(scriptDirection("Speak: \u201CConfirm the order.\u201D"));
children.push(narration("And there it is. Order placed. Cash on delivery. The whole interaction took about two minutes \u2014 entirely by voice."));

children.push(new Paragraph({ children: [new PageBreak()] }));

// ─── SECTION 11: WRAP-UP ─────────────────────────────────────
children.push(timestamp("22:00 \u2014 WHAT TO BUILD NEXT + WRAP-UP"));
children.push(scriptDirection("Screen: slide or graphic showing extension ideas. Or just the terminal with the agent running."));
children.push(spacer(60));
children.push(narration("So that\u2019s the core project. Here\u2019s what you could build on top of it:"));
children.push(spacer(60));

children.push(bulletRuns([{ text: "Swap the LLM.", bold: true }, { text: " Change LLM_PROVIDER in .env to openrouter or opencode. No code changes. Try Gemma 4, Claude, GPT \u2014 see how tool-calling quality varies across models." }]));
children.push(bulletRuns([{ text: "Add new skills.", bold: true }, { text: " The skill system is just Markdown files. You could add a Zomato skill, an Uber Eats skill, or even a skill that checks your fridge inventory before suggesting what to order." }]));
children.push(bulletRuns([{ text: "Build a web UI.", bold: true }, { text: " Replace the terminal with a browser interface. The core brain.ts and voice.ts modules are transport-agnostic \u2014 they work with any audio source and sink." }]));
children.push(bulletRuns([{ text: "Add memory.", bold: true }, { text: " The agent forgets between sessions. Wire up a simple JSON file or a vector store so it remembers your favorite restaurants and usual orders." }]));

children.push(spacer(100));
children.push(narration("The repo link is in the description. Clone it, drop in your API keys, and you\u2019ll have a talking food ordering agent running on your machine in under five minutes."));
children.push(spacer(60));
children.push(narration("If you build something cool on top of this, tag me. I want to see it."));
children.push(spacer(60));
children.push(narration("Thanks for watching."));
children.push(spacer(100));
children.push(scriptDirection("End card: repo URL, social links, subscribe CTA."));

children.push(new Paragraph({ children: [new PageBreak()] }));

// ─── APPENDIX: QUICK REFERENCE ───────────────────────────────
children.push(heading1("Appendix: Quick Reference Card"));
children.push(spacer(100));

children.push(heading2("File Map"));
const fileMapRows = [
  ["src/index.ts", "Event loop orchestrator \u2014 startup, conversation turns, shutdown"],
  ["src/ear.ts", "decibri mic capture + Deepgram WebSocket STT streaming"],
  ["src/brain.ts", "OpenClaw agent config, LLM routing, TTS synthesis + chunking"],
  ["src/voice.ts", "decibri speaker playback (WAV \u2192 PCM \u2192 speakers)"],
  ["src/ui.ts", "Terminal rendering (chalk + ora + boxen), color scheme"],
  ["workspace/IDENTITY.md", "System prompt \u2014 voice brevity rules, tool sequencing"],
  ["skills/swiggy/SKILL.md", "Swiggy tool reference the LLM reads to learn commands"],
  ["openclaw.json", "OpenClaw gateway config \u2014 model, providers, skills, TTS"],
  [".env", "API keys + LLM provider selection"],
];

const fmHeaderRow = new TableRow({
  children: [
    new TableCell({
      borders, width: { size: 3600, type: WidthType.DXA },
      shading: { fill: MAGENTA, type: ShadingType.CLEAR },
      margins: cellMargins,
      children: [new Paragraph({ children: [new TextRun({ text: "File", font: "Arial", size: 20, bold: true, color: WHITE })] })],
    }),
    new TableCell({
      borders, width: { size: 5760, type: WidthType.DXA },
      shading: { fill: MAGENTA, type: ShadingType.CLEAR },
      margins: cellMargins,
      children: [new Paragraph({ children: [new TextRun({ text: "Purpose", font: "Arial", size: 20, bold: true, color: WHITE })] })],
    }),
  ],
});

const fmDataRows = fileMapRows.map(([file, purpose]) => new TableRow({
  children: [
    new TableCell({
      borders, width: { size: 3600, type: WidthType.DXA },
      margins: cellMargins,
      children: [new Paragraph({ children: [new TextRun({ text: file, font: "Consolas", size: 18, color: DARK_GREY })] })],
    }),
    new TableCell({
      borders, width: { size: 5760, type: WidthType.DXA },
      margins: cellMargins,
      children: [new Paragraph({ children: [new TextRun({ text: purpose, font: "Arial", size: 20, color: DARK_GREY })] })],
    }),
  ],
}));

children.push(new Table({
  width: { size: CONTENT_W, type: WidthType.DXA },
  columnWidths: [3600, 5760],
  rows: [fmHeaderRow, ...fmDataRows],
}));

children.push(spacer(200));
children.push(heading2("Key Commands"));
children.push(...codeBlock([
  "pnpm install              # Install dependencies",
  "cp .env.example .env      # Create env file",
  "mcporter auth swiggy-food # One-time Swiggy OAuth",
  "pnpm start                # Run the agent",
]));

children.push(spacer(200));
children.push(heading2("LLM Provider Switching"));
children.push(...codeBlock([
  "LLM_PROVIDER=gemini       # Google Gemini 2.5 Flash (default)",
  "LLM_PROVIDER=openrouter   # Gemma 4 via OpenRouter (free)",
  "LLM_PROVIDER=opencode     # Big Pickle via OpenCode Zen (free)",
]));

// ── Build the document ─────────────────────────────────────────
const doc = new Document({
  styles: {
    default: {
      document: { run: { font: "Arial", size: 22 } },
    },
    paragraphStyles: [
      {
        id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 36, bold: true, font: "Arial", color: MAGENTA },
        paragraph: { spacing: { before: 360, after: 200 }, outlineLevel: 0 },
      },
      {
        id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true,
        run: { size: 28, bold: true, font: "Arial", color: DARK_GREY },
        paragraph: { spacing: { before: 280, after: 160 }, outlineLevel: 1 },
      },
    ],
  },
  numbering: { config: numberingConfig },
  sections: [{
    properties: {
      page: {
        size: { width: PAGE_W, height: PAGE_H },
        margin: { top: MARGIN, right: MARGIN, bottom: MARGIN, left: MARGIN },
      },
    },
    headers: {
      default: new Header({
        children: [new Paragraph({
          alignment: AlignmentType.RIGHT,
          children: [new TextRun({ text: "Food Ordering Agent \u2014 Video Tutorial Script", font: "Arial", size: 16, color: MID_GREY, italics: true })],
        })],
      }),
    },
    footers: {
      default: new Footer({
        children: [new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [
            new TextRun({ text: "Page ", font: "Arial", size: 16, color: MID_GREY }),
            new TextRun({ children: [PageNumber.CURRENT], font: "Arial", size: 16, color: MID_GREY }),
          ],
        })],
      }),
    },
    children,
  }],
});

// ── Write to disk ──────────────────────────────────────────────
Packer.toBuffer(doc).then(buffer => {
  const outPath = process.argv[2] || "tutorial-script.docx";
  fs.writeFileSync(outPath, buffer);
  console.log(`Written to ${outPath} (${(buffer.length / 1024).toFixed(0)} KB)`);
});
