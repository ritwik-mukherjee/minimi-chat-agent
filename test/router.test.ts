import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";
import { route } from "../src/router.ts";
import { savedTurn } from "./fakes.ts";
import type { DateRange, RecallResult } from "../src/types.ts";

const config = loadConfig({});
const day: DateRange = { from: "2026-11-03", to: "2026-11-03", label: "Tuesday 3 November", matchedText: "3 November" };

test("a hit routes to the compare role with 8 searches", () => {
  const recall: RecallResult = { kind: "hit", turns: [savedTurn()], omitted: 0, askedFor: day, topicWords: [] };
  assert.deepEqual(route(recall, config), {
    kind: "model", role: "compare", model: "claude-sonnet-5-5", effort: "low",
    thinking: { type: "adaptive" }, maxTokens: 43008, maxSearches: 8, reason: "compare",
  });
});

test("a near miss routes to the compare role", () => {
  const recall: RecallResult = { kind: "near", turns: [savedTurn()], askedFor: day, used: day, topicWords: ["postgres"] };
  const result = route(recall, config);
  assert.equal(result.kind, "model");
  assert.equal(result.reason, "compare");
});

test("a miss with topic words routes to the default role as no_record", () => {
  const recall: RecallResult = { kind: "miss", askedFor: day, earliest: null, topicWords: ["crm"] };
  assert.deepEqual(route(recall, config), {
    kind: "model", role: "default", model: "claude-sonnet-5-5", effort: "low",
    thinking: { type: "adaptive" }, maxTokens: 32768, maxSearches: 5, reason: "no_record",
  });
});

test("a miss with no topic words routes to code, with no model", () => {
  const recall: RecallResult = { kind: "miss", askedFor: day, earliest: null, topicWords: [] };
  assert.deepEqual(route(recall, config), { kind: "direct", reason: "no_record_direct" });
});

test("no past reference routes to the default role as ordinary", () => {
  assert.deepEqual(route(null, config), {
    kind: "model", role: "default", model: "claude-sonnet-5-5", effort: "low",
    thinking: { type: "adaptive" }, maxTokens: 32768, maxSearches: 5, reason: "ordinary",
  });
});

test("both model variables set to one model give that model on both roles", () => {
  const same = loadConfig({ MODEL_DEFAULT: "claude-opus-5-5", MODEL_COMPARE: "claude-opus-5-5" });
  const recall: RecallResult = { kind: "hit", turns: [savedTurn()], omitted: 0, askedFor: day, topicWords: [] };
  const compare = route(recall, same);
  const ordinary = route(null, same);
  assert.equal(compare.kind === "model" && compare.model, "claude-opus-5-5");
  assert.equal(ordinary.kind === "model" && ordinary.model, "claude-opus-5-5");
});
