/**
 * Visual smoke test for src/ui.ts. Runs through every UI primitive
 * (banner, dividers, log lines, timings, spinners) without touching
 * Deepgram, OpenClaw, Murf, or any network. Pure terminal rendering.
 *
 * Run: pnpm tsx tests/ui-demo.ts
 */

import {
  printBanner,
  printTurnDivider,
  startWarmingBanner,
  logSystem,
  logUser,
  logAgent,
  logTool,
  logVoice,
  logError,
  logTimings,
  startThinking,
  stopThinking,
  startListeningSpinner,
} from "../src/ui.js";

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  // 1. Startup banner
  printBanner({
    stt: "deepgram nova-2",
    llmProvider: "gemini",
    llmModel: "google/gemini-2.5-flash",
    ttsProvider: "murf falcon",
    ttsVoice: "en-IN-anisha",
    skill: "swiggy-food",
  });

  // 2. Warmup spinner → ready transition
  const finishWarming = startWarmingBanner();
  await sleep(800);
  finishWarming();

  logSystem("Ready. Speak when you are.");

  // 3. Listening spinner
  startListeningSpinner("Listening…");
  await sleep(700);
  stopThinking();

  // 4. Conversation turn 1 — simple query, single tool, fast LLM
  printTurnDivider();
  logUser("What addresses do I have saved?");
  startThinking("Thinking…");
  await sleep(600);
  stopThinking();
  logTool("get_addresses");
  logAgent(
    "You have one saved address in Electronic City. Should I use it?",
  );
  logVoice("You have one saved address in Electronic City. Should I use it?");
  logTimings({
    llmMs: 1240,
    ttsMs: 2380,
    toolCount: 1,
    charCount: 64,
  });

  // 5. Conversation turn 2 — chained query, multiple tools, longer LLM
  await sleep(300);
  printTurnDivider();
  logUser("Find me biryani near home and tell me the top two.");
  startThinking("Thinking…");
  await sleep(700);
  stopThinking();
  logTool("get_addresses");
  logTool("search_restaurants");
  logAgent(
    "Two open near you: Meghana Foods, biryani, about 33 minutes. Paradise Biryani, also biryani, 33 minutes.",
  );
  logVoice(
    "Two open near you: Meghana Foods, biryani, about 33 minutes. Paradise Biryani, also biryani, 33 minutes.",
  );
  logTimings({
    llmMs: 3470,
    ttsMs: 4910,
    toolCount: 2,
    charCount: 105,
  });

  // 6. Error path
  await sleep(300);
  printTurnDivider();
  logUser("Order pizza from Mars");
  logError(new Error("No restaurants found for that query."));

  // 7. Back to listening
  await sleep(300);
  printTurnDivider();
  startListeningSpinner("Listening…");
  await sleep(700);
  stopThinking();

  console.log("\n(end of UI demo)\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
