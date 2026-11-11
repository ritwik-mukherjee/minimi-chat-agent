import { test } from "node:test";
import assert from "node:assert/strict";
import { openLedger } from "../src/ledger.ts";
import { recall, topicWords } from "../src/recall.ts";
import { parsePastReferences } from "../src/dates.ts";
import { loadConfig } from "../src/config.ts";
import { FIXED_NOW, TEST_ZONE } from "./fakes.ts";
import type { Ledger, PastRefs, RecallResult } from "../src/types.ts";

const TODAY = "2026-11-10";
const config = loadConfig({});

const SAMPLE_1 =
  "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?";
const SAMPLE_2 = "What did I ask you on 3 November? Is your answer still correct today?";
const SAMPLE_3 = "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?";

function refsFor(message: string): PastRefs {
  return parsePastReferences(message, new Date(FIXED_NOW), TEST_ZONE);
}

function lookup(ledger: Ledger, message: string): RecallResult {
  return recall(message, refsFor(message), ledger, config, TODAY);
}

let clockTick = 0;

// Saves a completed turn on a local date. Later calls are saved later, so "most recent first" is testable.
function save(ledger: Ledger, localDate: string, question: string, answer = "An answer."): number {
  clockTick += 1;
  const id = ledger.insertPending({
    conversationId: "c1",
    createdAtUtc: `${localDate}T12:${String(Math.floor(clockTick / 60)).padStart(2, "0")}:${String(clockTick % 60).padStart(2, "0")}.000Z`,
    timeZone: TEST_ZONE, localDate, question, path: "ordinary", recalledIds: [],
    model: "claude-sonnet-5-5", routeReason: "ordinary",
  });
  ledger.complete(id, {
    answer, sources: [], searchCount: 0, msFirstEvent: 1, msFirstText: 2, msTotal: 3, stopReason: "end_turn",
  });
  return id;
}

test("topicWords: sample question 1", () => {
  assert.deepEqual(topicWords(SAMPLE_1, refsFor(SAMPLE_1)),
    ["crm", "tools", "person", "sales", "team", "pricing", "shipped", "big"]);
});

test("topicWords: sample question 2 has none", () => {
  assert.deepEqual(topicWords(SAMPLE_2, refsFor(SAMPLE_2)), []);
});

test("topicWords: sample question 3", () => {
  assert.deepEqual(topicWords(SAMPLE_3, refsFor(SAMPLE_3)), ["postgres", "hosting", "pricing"]);
});

test("topicWords: a question about yesterday with a filler word has none", () => {
  const message = "What did I ask you yesterday, please?";
  assert.deepEqual(topicWords(message, refsFor(message)), []);
});

test("topicWords: possessives, curly apostrophes and duplicates", () => {
  const message = "Neon’s pricing, and Neon pricing again?";
  assert.deepEqual(topicWords(message, refsFor(message)), ["neon", "pricing"]);
});

test("date path: one turn that shares no topic word is still a hit", () => {
  const ledger = openLedger(":memory:");
  const id = save(ledger, "2026-11-03", "What is a good pasta recipe?", "Boil water.");
  const result = lookup(ledger, SAMPLE_3);
  assert.equal(result.kind, "hit");
  assert.deepEqual(result.kind === "hit" && result.turns.map((t) => t.id), [id]);
  assert.equal(result.kind === "hit" && result.omitted, 0);
  assert.equal(result.kind === "hit" && result.askedFor?.label, "Tuesday 3 November");
  ledger.close();
});

test("date path: turns on one day are ranked by shared topic words, ties most recent first", () => {
  const ledger = openLedger(":memory:");
  const none = save(ledger, "2026-11-03", "Pasta?", "Boil water.");
  const one = save(ledger, "2026-11-03", "Tell me about Postgres", "It is a database.");
  const three = save(ledger, "2026-11-03", "Postgres hosting pricing", "Several providers.");
  const tieOlder = save(ledger, "2026-11-03", "Which hosting is cheap?", "Many.");
  const tieNewer = save(ledger, "2026-11-03", "More hosting please", "Some.");

  const result = lookup(ledger, SAMPLE_3);
  assert.equal(result.kind, "hit");
  const ids = result.kind === "hit" ? result.turns.map((t) => t.id) : [];
  // three shares 3 words; the 1-word turns tie, newest first; "none" shares none and is last.
  assert.deepEqual(ids, [three, tieNewer, tieOlder, one, none]);
  ledger.close();
});

test("date path: the cap of 5 is reached and the rest are counted", () => {
  const ledger = openLedger(":memory:");
  for (let i = 0; i < 7; i++) save(ledger, "2026-11-03", `Question ${i} about hosting`);
  const result = lookup(ledger, SAMPLE_3);
  assert.equal(result.kind, "hit");
  assert.equal(result.kind === "hit" && result.turns.length, 5);
  assert.equal(result.kind === "hit" && result.omitted, 2);
  ledger.close();
});

test("date path: a topic word found only in a saved answer ranks that turn", () => {
  const ledger = openLedger(":memory:");
  const first = save(ledger, "2026-11-03", "Neon or Supabase?", "Both are Postgres hosts with free tiers.");
  save(ledger, "2026-11-03", "Pasta?", "Boil water.");
  const result = lookup(ledger, SAMPLE_3);
  assert.equal(result.kind, "hit");
  assert.equal(result.kind === "hit" && result.turns[0].id, first);
  ledger.close();
});

test("date path: topic words match whole words only", () => {
  const ledger = openLedger(":memory:");
  const wrong = save(ledger, "2026-11-03", "Tell me about self-hostingly things", "Nothing.");
  const right = save(ledger, "2026-11-03", "Postgres hosting", "Yes.");
  const result = lookup(ledger, "On 3 November I asked about hosting.");
  assert.equal(result.kind === "hit" && result.turns[0].id, right);
  assert.equal(result.kind === "hit" && result.turns[1].id, wrong);
  ledger.close();
});

test("near miss: one day off, only when the date range is empty", () => {
  const ledger = openLedger(":memory:");
  const wednesday = save(ledger, "2026-11-04", "Postgres hosting pricing?", "Neon and Supabase.");
  const result = lookup(ledger, SAMPLE_3);
  assert.equal(result.kind, "near");
  if (result.kind !== "near") return;
  assert.deepEqual(result.turns.map((t) => t.id), [wednesday]);
  assert.equal(result.askedFor.label, "Tuesday 3 November");
  assert.equal(result.used.from, "2026-11-04");
  assert.equal(result.used.to, "2026-11-04");
  assert.equal(result.used.label, "Wednesday 4 November");
  assert.equal(result.used.matchedText, "");

  // With a turn on the asked-for day, the date wins and there is no near miss.
  save(ledger, "2026-11-03", "Something else", "Unrelated.");
  assert.equal(lookup(ledger, SAMPLE_3).kind, "hit");
  ledger.close();
});

test("near miss: a turn that shares no topic word does not count", () => {
  const ledger = openLedger(":memory:");
  save(ledger, "2026-11-04", "Pasta?", "Boil water.");
  const result = lookup(ledger, SAMPLE_3);
  assert.equal(result.kind, "miss");
  ledger.close();
});

test("near miss: the nearest day wins, and the later day on a tie", () => {
  const ledger = openLedger(":memory:");
  save(ledger, "2026-11-01", "Postgres hosting two days before", "Yes.");
  const nearer = save(ledger, "2026-11-05", "Postgres hosting two days after", "Yes.");
  const closest = save(ledger, "2026-11-02", "Postgres hosting one day before", "Yes.");
  let result = lookup(ledger, SAMPLE_3);
  assert.equal(result.kind === "near" && result.turns[0].id, closest);

  // One day before (2 Nov) against one day after (4 Nov): the later day wins.
  const ledger2 = openLedger(":memory:");
  save(ledger2, "2026-11-02", "Postgres hosting before", "Yes.");
  const later = save(ledger2, "2026-11-04", "Postgres hosting after", "Yes.");
  result = lookup(ledger2, SAMPLE_3);
  assert.equal(result.kind === "near" && result.turns[0].id, later);
  assert.equal(result.kind === "near" && result.used.from, "2026-11-04");
  assert.notEqual(nearer, closest);
  ledger.close();
  ledger2.close();
});

test("near miss: only turns from the single nearest day, and nothing beyond 3 days", () => {
  const ledger = openLedger(":memory:");
  save(ledger, "2026-11-06", "Postgres hosting after", "Yes."); // 3 days after
  let result = lookup(ledger, SAMPLE_3);
  assert.equal(result.kind, "near");
  save(ledger, "2026-11-04", "Postgres hosting again", "Yes.");
  result = lookup(ledger, SAMPLE_3);
  assert.equal(result.kind === "near" && result.turns.length, 1);
  assert.equal(result.kind === "near" && result.used.from, "2026-11-04");

  const far = openLedger(":memory:");
  save(far, "2026-11-07", "Postgres hosting too far", "Yes."); // 4 days after
  assert.equal(lookup(far, SAMPLE_3).kind, "miss");
  ledger.close();
  far.close();
});

test("no near miss when the message has no topic words", () => {
  const ledger = openLedger(":memory:");
  save(ledger, "2026-11-04", "Postgres hosting pricing?", "Neon.");
  const result = lookup(ledger, SAMPLE_2);
  assert.equal(result.kind, "miss");
  assert.deepEqual(result.topicWords, []);
  ledger.close();
});

test("undated cue with topic words is matched in the 30 most recent turns", () => {
  const ledger = openLedger(":memory:");
  const target = save(ledger, "2026-11-01", "Neon free tier?", "Neon is a Postgres host.");
  for (let i = 0; i < 29; i++) save(ledger, "2026-11-02", `Filler ${i}`, "Nothing relevant.");
  const message = "Earlier you recommended Neon, we discussed Postgres.";
  // 30 recent turns include the target (it is the 30th).
  let result = lookup(ledger, message);
  assert.equal(result.kind, "hit");
  assert.equal(result.kind === "hit" && result.askedFor, null);
  assert.deepEqual(result.kind === "hit" && result.turns.map((t) => t.id), [target]);

  // One more turn pushes it out of the window.
  save(ledger, "2026-11-02", "Filler 30", "Nothing relevant.");
  result = lookup(ledger, message);
  assert.equal(result.kind, "miss");
  ledger.close();
});

test("undated cue with topic words ranks by shared words and caps at 5", () => {
  const ledger = openLedger(":memory:");
  for (let i = 0; i < 6; i++) save(ledger, "2026-11-02", `Neon question ${i}`, "Short.");
  const best = save(ledger, "2026-11-01", "Neon and Supabase", "Postgres hosts.");
  const result = lookup(ledger, "You recommended Neon and Supabase for Postgres, I think.");
  assert.equal(result.kind, "hit");
  assert.equal(result.kind === "hit" && result.turns[0].id, best);
  assert.equal(result.kind === "hit" && result.turns.length, 5);
  assert.equal(result.kind === "hit" && result.omitted, 2);
  ledger.close();
});

test("undated cue with no topic words returns the 5 most recent", () => {
  const ledger = openLedger(":memory:");
  const ids: number[] = [];
  for (let i = 0; i < 7; i++) ids.push(save(ledger, "2026-11-02", `Question ${i}`));
  const result = lookup(ledger, "What did I ask you before?");
  assert.equal(result.kind, "hit");
  assert.equal(result.kind === "hit" && result.askedFor, null);
  assert.equal(result.kind === "hit" && result.turns.length, 5);
  assert.equal(result.kind === "hit" && result.turns[0].id, ids[6]);
  ledger.close();
});

test("a miss with no saved history", () => {
  const ledger = openLedger(":memory:");
  const result = lookup(ledger, SAMPLE_2);
  assert.deepEqual(result, {
    kind: "miss", askedFor: refsFor(SAMPLE_2).range, earliest: null, topicWords: [],
  });
  const undated = lookup(ledger, "What did I ask you before?");
  assert.deepEqual(undated, { kind: "miss", askedFor: null, earliest: null, topicWords: [] });
  ledger.close();
});

test("a miss with saved history on other days reports the earliest date", () => {
  const ledger = openLedger(":memory:");
  save(ledger, "2026-11-10", "Neon?", "Postgres.");
  const result = lookup(ledger, SAMPLE_1);
  assert.equal(result.kind, "miss");
  assert.equal(result.kind === "miss" && result.earliest, "2026-11-10");
  assert.equal(result.kind === "miss" && result.askedFor?.label, "Monday 9 November");
  assert.deepEqual(result.topicWords, ["crm", "tools", "person", "sales", "team", "pricing", "shipped", "big"]);
  ledger.close();
});

test("a week range finds turns on any day in it", () => {
  const ledger = openLedger(":memory:");
  const id = save(ledger, "2026-11-05", "Anything", "Something.");
  const result = lookup(ledger, "What did I ask you last week?");
  assert.equal(result.kind === "hit" && result.turns[0].id, id);
  ledger.close();
});
