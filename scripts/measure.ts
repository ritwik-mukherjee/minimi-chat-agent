// Measures real turns with the key in .env and prints a Markdown table of medians.
// Run with: npm run measure. It uses a temporary database, never data/turns.db.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { streamAnswer } from "../src/claude.ts";
import { systemClock } from "../src/clock.ts";
import { loadConfig } from "../src/config.ts";
import { openLedger } from "../src/ledger.ts";
import { handleTurn } from "../src/turn.ts";
import type { AgentEvent } from "../src/events.ts";

const REPEATS = 3;
const NEON = "What does Neon's free tier include?";
const SUPABASE = "What is the current price of Supabase Pro?";
const THANKS = "thanks";
const RECALL = "What did I ask you earlier today? Is it still correct?";

const config = loadConfig();
if (config.apiKey === null) {
  console.error("ANTHROPIC_API_KEY is not set. Add it to .env and run `npm run measure` again.");
  process.exit(1);
}

interface Sample { model: string; firstEvent: number | null; firstText: number | null; total: number; searches: number }

// Runs the given messages in one conversation on a fresh temporary database,
// and returns the sample of the last turn.
async function runConversation(messages: string[]): Promise<Sample> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minimi-measure-"));
  const ledger = openLedger(path.join(dir, "turns.db"));
  const conversationId = crypto.randomUUID();
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  let last: Sample | null = null;
  try {
    for (const message of messages) {
      let done: Extract<AgentEvent, { type: "done" }> | null = null;
      await handleTurn(
        { message, conversationId, timeZone, signal: new AbortController().signal },
        { clock: systemClock(), ledger, config, streamAnswer },
        (event) => { if (event.type === "done") done = event; },
      );
      if (done === null) throw new Error("The turn ended without a done event.");
      const finished: Extract<AgentEvent, { type: "done" }> = done;
      last = {
        model: finished.model ?? "none", firstEvent: finished.msFirstEvent, firstText: finished.msFirstText,
        total: finished.msTotal, searches: finished.searchCount,
      };
    }
  } finally {
    ledger.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return last!;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

const cases: { name: string; messages: string[] }[] = [
  { name: "Ordinary: Neon free tier", messages: [NEON] },
  { name: "Ordinary: Supabase Pro price", messages: [SUPABASE] },
  { name: "No search: thanks", messages: [THANKS] },
  { name: "Recall: earlier today (after the Neon turn)", messages: [NEON, RECALL] },
];

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const rows: string[] = [];
for (const testCase of cases) {
  const samples: Sample[] = [];
  for (let i = 0; i < REPEATS; i++) samples.push(await runConversation(testCase.messages));
  const firstTexts = samples.flatMap((s) => (s.firstText === null ? [] : [s.firstText]));
  rows.push(
    `| ${testCase.name} | ${samples[0].model} | ${median(samples.map((s) => s.firstEvent ?? 0))} ms | ` +
    `${firstTexts.length > 0 ? seconds(median(firstTexts)) : "none"} | ${seconds(median(samples.map((s) => s.total)))} | ` +
    `${median(samples.map((s) => s.searches))} |`,
  );
  console.error(`done: ${testCase.name}`);
}

console.log(`Median of ${REPEATS} runs per case, ${systemClock().now().toISOString().slice(0, 10)}.\n`);
console.log("| Case | Model | First event | First text | Total | Searches |");
console.log("| --- | --- | --- | --- | --- | --- |");
console.log(rows.join("\n"));
