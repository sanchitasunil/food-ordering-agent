import chalk from "chalk";
import ora, { type Ora } from "ora";
import boxen from "boxen";

// ── Project color scheme (CLAUDE.md hard rule) ───────────────────
//
//   user voice → BLUE
//   agent      → YELLOW
//   tools      → GREEN
//   TTS        → MAGENTA / PURPLE
//
// System chrome (banner, dividers, timings) uses CYAN + DIM so it
// never collides with the four role colors above.

let spinner: Ora | null = null;

// ── Banner ───────────────────────────────────────────────────────

export interface BannerInfo {
  stt: string;
  llmProvider: string;
  llmModel: string;
  ttsProvider: string;
  ttsVoice: string;
  skill: string;
}

/**
 * Print the startup banner. Called once from index.ts after warmup.
 * boxen handles emoji-aware width and ANSI-stripping for us.
 */
export function printBanner(info: BannerInfo): void {
  const label = (s: string) => chalk.dim(s.padEnd(8));
  const lines = [
    chalk.bold.magentaBright("food-ordering-agent"),
    chalk.dim("voice → LLM → tools → voice"),
    "",
    label("STT")    + chalk.cyan(info.stt),
    label("LLM")    + chalk.yellow(info.llmProvider) + chalk.dim("  ›  ") + chalk.cyan(info.llmModel),
    label("TTS")    + chalk.magenta(info.ttsProvider) + chalk.dim("  ›  ") + chalk.magentaBright(info.ttsVoice),
    label("Skill")  + chalk.green(info.skill),
    "",
    chalk.dim("Press Ctrl+C to exit"),
  ];

  const rendered = boxen(lines.join("\n"), {
    padding: { top: 1, bottom: 1, left: 3, right: 3 },
    margin: { top: 1, bottom: 0, left: 0, right: 0 },
    borderStyle: "round",
    borderColor: "magenta",
  });

  process.stdout.write(rendered + "\n");
}

// ── Status banner during warmup ──────────────────────────────────

/**
 * One-shot status banner used while OpenClaw warms up. Returns a stop()
 * fn so the caller can replace it with the ready banner once warmup ends.
 */
export function startWarmingBanner(): () => void {
  const startedAt = Date.now();
  const sp = ora({
    text: chalk.cyan("Warming up OpenClaw + Murf…"),
    color: "cyan",
    spinner: "dots",
  }).start();
  return () => {
    const ms = Date.now() - startedAt;
    sp.succeed(chalk.green(`Ready ${chalk.dim(`(${(ms / 1000).toFixed(1)}s)`)}`));
  };
}

// ── Conversation turn divider ────────────────────────────────────

/**
 * Print a horizontal rule between conversation turns. Sized to ~70
 * cells so it looks intentional in 80-column terminals and not silly
 * in wider ones.
 */
export function printTurnDivider(): void {
  const width = Math.min(process.stdout.columns ?? 80, 80) - 2;
  process.stdout.write(chalk.dim("─".repeat(width)) + "\n");
}

// ── Role-coded log lines ─────────────────────────────────────────
//
// Each line uses a fixed-width labeled prefix so the columns align in
// transcripts. The actual user/agent/voice/tool text wraps inline.
//

const LABEL_WIDTH = 12;

function labeled(icon: string, label: string, color: (s: string) => string): string {
  // pad on the right so the body always starts at the same column
  const tag = `${icon} ${label}`;
  const padding = Math.max(0, LABEL_WIDTH - tag.length);
  return color(tag) + " ".repeat(padding);
}

export function logUser(text: string): void {
  process.stdout.write(labeled("🎤", "You", chalk.bold.blue) + chalk.blue(text) + "\n");
}

export function logAgent(text: string): void {
  if (!text) return;
  process.stdout.write(labeled("🤖", "Agent", chalk.bold.yellow) + chalk.yellow(text) + "\n");
}

export function logTool(toolName: string): void {
  process.stdout.write(labeled("🔧", "Tool", chalk.bold.green) + chalk.green(toolName) + "\n");
}

export function logVoice(text: string): void {
  // Truncate the body if it's very long — the audio is the source of
  // truth, the printed transcript is just a preview for the dev viewer.
  const preview = text.length > 200 ? text.slice(0, 197) + "…" : text;
  process.stdout.write(
    labeled("🔊", "Speaking", chalk.bold.magenta) + chalk.magenta(preview) + "\n",
  );
}

export function logSystem(text: string): void {
  process.stdout.write(labeled("⚡", "System", chalk.bold.cyan) + chalk.cyan(text) + "\n");
}

export function logError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(
    labeled("❌", "Error", chalk.bold.red) + chalk.red(message) + "\n",
  );
}

// ── Timing badges ────────────────────────────────────────────────

export interface TurnTimings {
  /** Wall-clock ms spent in OpenClaw / LLM / tool calls. */
  llmMs: number;
  /** Wall-clock ms spent in Murf TTS synthesis. */
  ttsMs: number;
  /** Number of distinct tool start events observed. */
  toolCount: number;
  /** Length of the agent's text response, for char/sec sanity. */
  charCount: number;
}

/**
 * Print a compact one-line timing badge after each turn. Format:
 *
 *   ⏱  LLM 2.4s · 3 tools · TTS 11.2s · 213 chars
 *
 * All numbers in cyan (system info), labels dim, separators dim.
 */
export function logTimings(t: TurnTimings): void {
  const parts: string[] = [
    chalk.dim("LLM ") + chalk.cyan(`${(t.llmMs / 1000).toFixed(1)}s`),
    chalk.cyan(`${t.toolCount}`) + chalk.dim(t.toolCount === 1 ? " tool" : " tools"),
    chalk.dim("TTS ") + chalk.cyan(`${(t.ttsMs / 1000).toFixed(1)}s`),
    chalk.cyan(`${t.charCount}`) + chalk.dim(" chars"),
  ];
  const body = parts.join(chalk.dim(" · "));
  process.stdout.write(
    " ".repeat(LABEL_WIDTH) + chalk.dim("⏱  ") + body + "\n",
  );
}

// ── Spinner ──────────────────────────────────────────────────────

/**
 * Stop any in-progress spinner. Idempotent.
 */
export function stopThinking(): void {
  if (spinner) {
    spinner.stop();
    spinner = null;
  }
}

/**
 * Start a yellow "thinking" spinner — used while the LLM is reasoning.
 * Replaces any existing spinner.
 */
export function startThinking(msg = "Thinking…"): void {
  stopThinking();
  spinner = ora({
    text: chalk.yellow(msg),
    color: "yellow",
    spinner: "dots",
    indent: 2,
  }).start();
}

/**
 * Start a blue "listening" spinner — used while the mic is active and
 * Deepgram is streaming. Replaces any existing spinner.
 */
export function startListeningSpinner(msg = "Listening…"): void {
  stopThinking();
  spinner = ora({
    text: chalk.blue(msg),
    color: "blue",
    spinner: "dots",
    indent: 2,
  }).start();
}
