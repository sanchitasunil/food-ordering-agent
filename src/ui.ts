import chalk from "chalk";
import ora, { type Ora } from "ora";

let spinner: Ora | null = null;

export function logUser(text: string): void {
  process.stdout.write(chalk.blue(`🎤 You: ${text}\n`));
}

export function logAgent(text: string): void {
  process.stdout.write(chalk.yellow(`🤖 Agent: ${text}\n`));
}

export function logTool(toolName: string): void {
  process.stdout.write(chalk.green(`🔧 [Tool] ${toolName}\n`));
}

export function logVoice(text: string): void {
  process.stdout.write(chalk.magenta(`🔊 Speaking: ${text}\n`));
}

export function logError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(chalk.red(`❌ Error: ${message}\n`));
}

export function startThinking(msg = "Processing..."): void {
  spinner = ora({ text: chalk.yellow(msg), color: "yellow" }).start();
}

export function stopThinking(): void {
  if (spinner) {
    spinner.stop();
    spinner = null;
  }
}
