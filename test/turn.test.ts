import { test } from "node:test";
import assert from "node:assert/strict";
import { handleTurn } from "../src/turn.ts";
import { streamAnswer as realStreamAnswer } from "../src/claude.ts";
import { fixedClock } from "../src/clock.ts";
import { loadConfig } from "../src/config.ts";
import { openLedger } from "../src/ledger.ts";
import { fakeStreamAnswer, FIXED_NOW, TEST_ZONE } from "./fakes.ts";
import type { StreamScript } from "./fakes.ts";
import type { AgentEvent } from "../src/events.ts";
import type { Config, Ledger, StreamAnswer } from "../src/types.ts";

const SAMPLE_1 =
  "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?";
const SAMPLE_2 = "What did I ask you on 3 November? Is your answer still correct today?";
const SAMPLE_3 = "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?";

const ANSWER_SCRIPT: StreamScript = {
  events: [
    { type: "text", delta: "Here is the answer." },
    { type: "sources", sources: [{ url: "https://example.com", title: "Example" }] },
  ],
  outcome: { sources: [{ url: "https://example.com", title: "Example", citedText: "quote" }], searchCount: 2 },
};

interface Setup {
  ledger: Ledger;
  config: Config;
  fake: ReturnType<typeof fakeStreamAnswer>;
}

function setup(script: StreamScript = ANSWER_SCRIPT, configEnv: Record<string, string> = { ANTHROPIC_API_KEY: "test-key" }): Setup {
  return { ledger: openLedger(":memory:"), config: loadConfig(configEnv), fake: fakeStreamAnswer(script) };
}

interface RunOptions {
  conversationId?: string;
  timeZone?: string;
  signal?: AbortSignal;
  streamAnswer?: StreamAnswer;
  now?: string;
}

async function run(s: Setup, message: string, options: RunOptions = {}) {
  const events: AgentEvent[] = [];
  await handleTurn(
    {
      message,
      conversationId: options.conversationId ?? "conversation-1",
      timeZone: options.timeZone ?? TEST_ZONE,
      signal: options.signal ?? new AbortController().signal,
    },
    { clock: fixedClock(options.now ?? FIXED_NOW), ledger: s.ledger, config: s.config, streamAnswer: options.streamAnswer ?? s.fake },
    (event) => events.push(event),
  );
  return events;
}

const types = (events: AgentEvent[]) => events.map((event) => event.type);
const finalUserMessage = (s: Setup) => {
  const messages = s.fake.calls[0].messages;
  return messages[messages.length - 1].content;
};
const newestRow = (s: Setup) => s.ledger.groupedByDate()[0].turns[0];

let tick = 0;

// Saves a completed turn on a local date, as an earlier session would have.
function saveTurn(ledger: Ledger, localDate: string, question: string, answer: string): number {
  tick += 1;
  const id = ledger.insertPending({
    conversationId: "earlier", createdAtUtc: `${localDate}T09:${String(tick).padStart(2, "0")}:00.000Z`,
    timeZone: TEST_ZONE, localDate, question, path: "ordinary", recalledIds: [],
    model: "claude-sonnet-5-5", routeReason: "ordinary",
  });
  ledger.complete(id, {
    answer, sources: [{ url: "https://old.example", title: "Old source", citedText: "old quote" }],
    searchCount: 1, msFirstEvent: 1, msFirstText: 2, msTotal: 3, stopReason: "end_turn",
  });
  return id;
}

test("1. sample question 3 with a saved record (CUJ 3)", async () => {
  const s = setup();
  const saved = saveTurn(s.ledger, "2026-11-03", "Compare Postgres hosting prices", "Neon is free, Supabase is $25.");

  let eventsAtCall = -1;
  const inner = s.fake;
  const watching: StreamAnswer = (args, emit) => { eventsAtCall = events.length; return inner(args, emit); };
  const events: AgentEvent[] = [];
  await handleTurn(
    { message: SAMPLE_3, conversationId: "c1", timeZone: TEST_ZONE, signal: new AbortController().signal },
    { clock: fixedClock(FIXED_NOW), ledger: s.ledger, config: s.config, streamAnswer: watching },
    (event) => events.push(event),
  );

  assert.deepEqual(types(events), ["recalled", "routed", "text", "sources", "done"]);
  assert.equal(eventsAtCall, 2, "recalled and routed are sent before streamAnswer is called");

  const recalled = events[0];
  assert.equal(recalled.type === "recalled" && recalled.kind, "hit");
  assert.equal(recalled.type === "recalled" && recalled.askedFor, "Tuesday 3 November");
  assert.equal(recalled.type === "recalled" && recalled.turns[0].id, saved);
  assert.equal(recalled.type === "recalled" && recalled.turns[0].label, "Tuesday 3 November");

  const routed = events[1];
  assert.deepEqual(routed, { type: "routed", model: "claude-sonnet-5-5", displayName: "Sonnet 5.5", reason: "compare" });

  assert.equal(s.fake.calls.length, 1);
  assert.equal(s.fake.calls[0].route.maxSearches, 8);
  assert.equal(s.fake.calls[0].route.model, "claude-sonnet-5-5");
  assert.equal(s.fake.calls[0].apiKey, "test-key");
  assert.equal(s.fake.calls[0].pauseTurnLimit, 1);
  assert.match(finalUserMessage(s), /<saved_turns asked_for="Tuesday 3 November 2026"/);
  assert.match(finalUserMessage(s), /Neon is free, Supabase is \$25\./);

  const row = newestRow(s);
  assert.equal(row.path, "recall_hit");
  assert.deepEqual(row.recalledIds, [saved]);
  assert.equal(row.routeReason, "compare");
  assert.equal(row.status, "complete");
  assert.equal(row.answer, "Here is the answer.");
  assert.equal(row.searchCount, 2);
  assert.equal(row.localDate, "2026-11-10");
  assert.equal(row.question, SAMPLE_3);
});

test("2. sample question 3 with nothing saved", async () => {
  const s = setup();
  const events = await run(s, SAMPLE_3);
  assert.deepEqual(types(events).slice(0, 2), ["no_record", "routed"]);
  assert.deepEqual(events[0], { type: "no_record", askedFor: "Tuesday 3 November", earliest: null });
  assert.deepEqual(events[1], { type: "routed", model: "claude-sonnet-5-5", displayName: "Sonnet 5.5", reason: "no_record" });
  assert.equal(s.fake.calls[0].route.maxSearches, 5);
  assert.match(finalUserMessage(s), /<no_saved_turns>No saved turns on Tuesday 3 November 2026\. No turns are saved yet\./);
  assert.equal(newestRow(s).path, "recall_miss");
});

test("3. sample question 1 with a Monday turn listing five CRM tools", async () => {
  const s = setup();
  saveTurn(s.ledger, "2026-11-09", "Shortlist five CRM tools for a sales team", "HubSpot, Salesforce, Pipedrive, Zoho, Attio.");
  const events = await run(s, SAMPLE_1);
  assert.deepEqual(types(events).slice(0, 2), ["recalled", "routed"]);
  const routed = events[1];
  assert.equal(routed.type === "routed" && routed.reason, "compare");
  assert.equal(routed.type === "routed" && routed.displayName, "Sonnet 5.5");
  assert.match(finalUserMessage(s), /HubSpot, Salesforce, Pipedrive, Zoho, Attio\./);
  assert.match(finalUserMessage(s), /asked_for="Monday 9 November 2026"/);
});

test("4. sample question 1 on an empty ledger (CUJ 5)", async () => {
  const s = setup();
  const events = await run(s, SAMPLE_1);
  assert.deepEqual(types(events).slice(0, 2), ["no_record", "routed"]);
  assert.deepEqual(events[0], { type: "no_record", askedFor: "Monday 9 November", earliest: null });
  const routed = events[1];
  assert.equal(routed.type === "routed" && routed.reason, "no_record");
  assert.equal(routed.type === "routed" && routed.model, "claude-sonnet-5-5");
  assert.match(finalUserMessage(s), /<no_saved_turns>No saved turns on Monday 9 November 2026\./);
});

test("5. sample question 2 with two turns on 3 November (CUJ 4)", async () => {
  const s = setup();
  const first = saveTurn(s.ledger, "2026-11-03", "What does Neon's free tier include?", "100 projects.");
  const second = saveTurn(s.ledger, "2026-11-03", "How much is Cloudflare R2?", "$0.015 per GB.");
  const events = await run(s, SAMPLE_2);
  const recalled = events[0];
  assert.equal(recalled.type === "recalled" && recalled.turns.length, 2);
  assert.deepEqual(
    recalled.type === "recalled" && recalled.turns.map((turn) => turn.id).sort(),
    [first, second].sort(),
  );
  const routed = events[1];
  assert.equal(routed.type === "routed" && routed.reason, "compare");
  assert.equal(s.fake.calls[0].route.maxSearches, 8);
  assert.match(finalUserMessage(s), /100 projects\./);
  assert.match(finalUserMessage(s), /\$0\.015 per GB\./);
});

test("6. sample question 2 on an empty ledger writes the reply in code (CUJ 6)", async () => {
  const s = setup();
  const events = await run(s, SAMPLE_2);

  assert.equal(s.fake.calls.length, 0, "streamAnswer is never called");
  assert.deepEqual(types(events), ["no_record", "routed", "text", "done"]);
  assert.deepEqual(events[1], { type: "routed", model: null, displayName: null, reason: "no_record_direct" });
  const text = events[2];
  assert.equal(
    text.type === "text" && text.delta,
    "Nothing is saved for Tuesday 3 November, so there is no earlier answer to re-check. This is the first conversation I have on file.",
  );
  const done = events[3];
  assert.equal(done.type === "done" && done.model, null);
  assert.equal(done.type === "done" && done.searchCount, 0);

  const row = newestRow(s);
  assert.equal(row.model, null);
  assert.equal(row.routeReason, "no_record_direct");
  assert.equal(row.stopReason, "direct");
  assert.equal(row.status, "complete");
  assert.equal(row.answer, text.type === "text" ? text.delta : "");
  assert.equal(row.searchCount, 0);
});

test("6b. the direct reply says when other days are saved", async () => {
  const s = setup();
  saveTurn(s.ledger, "2026-11-10", "Anything", "Something.");
  const events = await run(s, SAMPLE_2);
  const text = events.find((event) => event.type === "text");
  assert.equal(
    text?.type === "text" && text.delta,
    "Nothing is saved for Tuesday 3 November, so there is no earlier answer to re-check. Saved history begins Tuesday 10 November.",
  );
  const noRecord = events[0];
  assert.equal(noRecord.type === "no_record" && noRecord.earliest, "Tuesday 10 November");
});

test("7. a near miss: the final message contains both dates (CUJ 7)", async () => {
  const s = setup();
  saveTurn(s.ledger, "2026-11-04", "Which Postgres hosting is cheapest?", "Neon.");
  const events = await run(s, "Last Tuesday I asked you about Postgres hosting.");
  const recalled = events[0];
  assert.equal(recalled.type === "recalled" && recalled.kind, "near");
  assert.equal(recalled.type === "recalled" && recalled.askedFor, "Tuesday 3 November");
  assert.equal(recalled.type === "recalled" && recalled.used, "Wednesday 4 November");
  assert.match(finalUserMessage(s), /asked_for="Tuesday 3 November 2026"/);
  assert.match(finalUserMessage(s), /near_miss="true"/);
  assert.match(finalUserMessage(s), /used="Wednesday 4 November 2026"/);
  assert.equal(newestRow(s).path, "recall_near");
});

test("8. 'earlier today' recalls a turn saved earlier on the fixed day (CUJ 8)", async () => {
  const s = setup({ events: [{ type: "text", delta: "Neon and Supabase are popular." }] });
  await run(s, "What are the best Postgres hosting options?", { conversationId: "sitting" });
  const events = await run(s, "What did I ask you earlier today? Is it still correct?", { conversationId: "sitting" });

  const recalled = events[0];
  assert.equal(recalled.type, "recalled");
  assert.equal(recalled.type === "recalled" && recalled.askedFor, "today, Tuesday 10 November");
  assert.equal(recalled.type === "recalled" && recalled.turns.length, 1);
  assert.equal(recalled.type === "recalled" && recalled.turns[0].question, "What are the best Postgres hosting options?");
  const routed = events[1];
  assert.equal(routed.type === "routed" && routed.reason, "compare");
  // The first turn is also in the chat history, so the model sees it twice: once as chat, once as saved record.
  assert.equal(s.fake.calls[1].messages.length, 3);
});

test("9. 'thanks' has no recall events and routes as ordinary", async () => {
  const s = setup({ events: [{ type: "text", delta: "You're welcome." }] });
  const events = await run(s, "thanks");
  assert.deepEqual(types(events), ["routed", "text", "done"]);
  const routed = events[0];
  assert.equal(routed.type === "routed" && routed.reason, "ordinary");
  assert.equal(s.fake.calls[0].route.maxSearches, 5);
  const row = newestRow(s);
  assert.equal(row.path, "ordinary");
  assert.deepEqual(row.recalledIds, []);
  assert.equal(row.searchCount, 0);
  assert.match(finalUserMessage(s), /^Today is Tuesday 10 November 2026 \(time zone Europe\/London\)\.\n\nthanks$/);
});

test("9b. history of the same conversation is sent, oldest first, and other conversations are not", async () => {
  const s = setup({ events: [{ type: "text", delta: "Reply." }] });
  await run(s, "first question", { conversationId: "a" });
  await run(s, "unrelated question", { conversationId: "b" });
  await run(s, "second question", { conversationId: "a" });
  const messages = s.fake.calls[2].messages;
  assert.deepEqual(messages.slice(0, 2), [
    { role: "user", content: "first question" },
    { role: "assistant", content: "Reply." },
  ]);
  assert.equal(messages.length, 3);
});

test("10. streamAnswer returns ok false with stop reason error: row failed, done still sent", async () => {
  const s = setup({
    events: [{ type: "text", delta: "Half" }, { type: "problem", code: "incomplete", message: "m", fix: "f" }],
    outcome: { ok: false, stopReason: "error" },
  });
  const events = await run(s, "What is Neon?");
  assert.equal(types(events).at(-1), "done");
  const row = newestRow(s);
  assert.equal(row.status, "failed");
  assert.equal(row.stopReason, "error");
  assert.equal(row.answer, "Half");
  // A failed row is never a baseline for recall.
  assert.deepEqual(s.ledger.recent(10), []);
});

test("11. streamAnswer returns ok true with stop reason pause_limit: row complete with that reason", async () => {
  const s = setup({
    events: [{ type: "text", delta: "Partial" }],
    outcome: { ok: true, stopReason: "pause_limit" },
  });
  await run(s, "What is Neon?");
  const row = newestRow(s);
  assert.equal(row.status, "complete");
  assert.equal(row.stopReason, "pause_limit");
});

test("12. an aborted signal: the row is failed and no done is emitted", async () => {
  const s = setup({ outcome: { ok: false, stopReason: "aborted" } });
  const controller = new AbortController();
  controller.abort();
  const events = await run(s, "What is Neon?", { signal: controller.signal });
  assert.equal(types(events).includes("done"), false);
  const row = newestRow(s);
  assert.equal(row.status, "failed");
  assert.equal(row.stopReason, "aborted");
});

test("13. an invalid time zone runs as UTC and is saved as UTC", async () => {
  const s = setup();
  const events = await run(s, "What is Neon?", { timeZone: "Mars/Olympus" });
  assert.equal(types(events).at(-1), "done");
  assert.equal(newestRow(s).timeZone, "UTC");
  assert.match(finalUserMessage(s), /time zone UTC\)/);
});

test("13b. the time zone decides the local date of the turn", async () => {
  const s = setup();
  await run(s, "What is Neon?", { timeZone: "Pacific/Auckland" });
  assert.equal(newestRow(s).localDate, "2026-11-11");
  assert.match(finalUserMessage(s), /^Today is Wednesday 11 November 2026 \(time zone Pacific\/Auckland\)\./);
});

test("14. the real streamAnswer with no key: missing_key, no client call, row failed, done sent", async () => {
  const s = setup(ANSWER_SCRIPT, {});
  assert.equal(s.config.apiKey, null);
  const events = await run(s, "What is Neon?", { streamAnswer: realStreamAnswer });
  assert.deepEqual(types(events), ["routed", "problem", "done"]);
  const problem = events[1];
  assert.equal(problem.type === "problem" && problem.code, "missing_key");
  const row = newestRow(s);
  assert.equal(row.status, "failed");
  assert.equal(row.stopReason, "error");
});

test("15. timings are ordered: first event, first text, total", async () => {
  const s = setup({ events: [{ type: "text", delta: "Hello" }] });
  await run(s, "What is Neon?");
  const row = newestRow(s);
  assert.notEqual(row.msFirstEvent, null);
  assert.notEqual(row.msFirstText, null);
  assert.notEqual(row.msTotal, null);
  assert.ok(row.msFirstEvent! <= row.msFirstText!);
  assert.ok(row.msFirstText! <= row.msTotal!);
});

test("15b. on the direct path all three timings are set", async () => {
  const s = setup();
  const events = await run(s, SAMPLE_2);
  const row = newestRow(s);
  assert.notEqual(row.msFirstEvent, null);
  assert.notEqual(row.msFirstText, null);
  assert.notEqual(row.msTotal, null);
  assert.ok(row.msFirstEvent! <= row.msFirstText!);
  assert.ok(row.msFirstText! <= row.msTotal!);
  const done = events.at(-1);
  assert.equal(done?.type === "done" && done.msTotal, row.msTotal);
});

test("a pending row exists while the answer is being made", async () => {
  const s = setup();
  let statusDuringAnswer = "";
  const watching: StreamAnswer = async (args, emit) => {
    statusDuringAnswer = s.ledger.groupedByDate()[0].turns[0].status;
    return s.fake(args, emit);
  };
  await run(s, "What is Neon?", { streamAnswer: watching });
  assert.equal(statusDuringAnswer, "pending");
});
