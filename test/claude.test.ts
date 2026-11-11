import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mapEvents, newStreamState, streamAnswer } from "../src/claude.ts";
import { loadConfig } from "../src/config.ts";
import { route } from "../src/router.ts";
import type { AgentEvent } from "../src/events.ts";
import type { StreamArgs, StreamClient, StreamHandle } from "../src/types.ts";

interface Fixture { events: unknown[]; finalMessage: { content: unknown[]; stop_reason: string | null; usage?: unknown } }

function loadFixture(name: string): Fixture {
  return JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")) as Fixture;
}

const ordinary = loadFixture("ordinary_two_searches");
const paused = loadFixture("pause_turn");
const searchError = loadFixture("search_error");

// A server error as the SDK raises it: an Error with a status and headers.
function apiError(status: number, message = "error", headers: Record<string, string> = {}): Error {
  return Object.assign(new Error(message), { status, headers: new Headers(headers) });
}

function textEvents(...parts: string[]): unknown[] {
  return parts.map((text) => ({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }));
}

function finalMessage(stopReason: string | null, searches = 0, content: unknown[] = []) {
  return { content, stop_reason: stopReason, usage: { server_tool_use: { web_search_requests: searches } } };
}

// One scripted request: events to yield, then either a final message or an error.
interface Plan {
  events?: unknown[];
  message?: ReturnType<typeof finalMessage> | Fixture["finalMessage"];
  errorAtStart?: Error;       // thrown before any event
  errorAfterEvents?: Error;   // thrown after the events
}

function fakeClient(...plans: Plan[]): StreamClient & { requests: any[] } {
  const requests: any[] = [];
  return {
    requests,
    messages: {
      stream(params: unknown): StreamHandle {
        requests.push(structuredClone(params));
        const plan = plans[requests.length - 1];
        if (!plan) throw new Error("unexpected extra request");
        return {
          async *[Symbol.asyncIterator]() {
            if (plan.errorAtStart) throw plan.errorAtStart;
            for (const event of plan.events ?? []) yield event;
            if (plan.errorAfterEvents) throw plan.errorAfterEvents;
          },
          async finalMessage() {
            if (!plan.message) throw new Error("no final message scripted");
            return plan.message;
          },
        };
      },
    },
  };
}

function makeArgs(overrides: Partial<StreamArgs> = {}): StreamArgs {
  const chosen = route(null, loadConfig({}));
  if (chosen.kind !== "model") throw new Error("expected a model route");
  return {
    apiKey: "test-key", route: chosen, system: "system text",
    messages: [{ role: "user", content: "hello" }],
    pauseTurnLimit: 1, startedAt: performance.now(), signal: new AbortController().signal,
    ...overrides,
  };
}

function run(client: StreamClient, args = makeArgs()) {
  const events: AgentEvent[] = [];
  const sleeps: number[] = [];
  const promise = streamAnswer(args, (event) => events.push(event), {
    client, sleep: async (ms) => { sleeps.push(ms); },
  });
  return promise.then((outcome) => ({ outcome, events, sleeps }));
}

function problems(events: AgentEvent[]) {
  return events.flatMap((event) => (event.type === "problem" ? [event.code] : []));
}

// ---- Fixture replays through mapEvents ----

function replay(fixture: Fixture) {
  const state = newStreamState();
  const events: AgentEvent[] = [];
  for (const event of fixture.events) mapEvents(event, state, (e) => events.push(e));
  return { state, events };
}

test("replay: searching events come in order with their queries", () => {
  const { events } = replay(ordinary);
  const searches = events.flatMap((e) => (e.type === "searching" ? [e.query] : []));
  assert.deepEqual(searches, ["Neon Postgres free plan limits pricing", "Supabase free plan limits pricing"]);
  // Both searches are announced before any text.
  const firstText = events.findIndex((e) => e.type === "text");
  assert.ok(events.slice(0, firstText).filter((e) => e.type === "searching").length === 2);
});

test("replay: the text deltas join into the answer", () => {
  const { state, events } = replay(ordinary);
  const joined = events.flatMap((e) => (e.type === "text" ? [e.delta] : [])).join("");
  assert.equal(joined, state.text);
  assert.ok(joined.length > 200);
  assert.notEqual(state.firstTextAt, null);
  assert.equal(events.filter((e) => e.type === "text").length, 192);
});

test("replay: citations become sources, de-duplicated by URL", () => {
  const { state } = replay(ordinary);
  const urls = state.citations.map((c) => c.url);
  assert.equal(new Set(urls).size, urls.length);
  assert.ok(urls.length > 0 && urls.length < 15); // 15 citation deltas, fewer distinct URLs
  assert.ok(state.citations.every((c) => c.title !== "" && c.citedText !== ""));
  assert.ok(urls.includes("https://neon.com/faqs/free-plan-limits-and-quotas"));
});

test("replay: with no citations the search-result URLs are the fallback", () => {
  const withoutCitations: Fixture = {
    ...ordinary,
    events: ordinary.events.filter((e) => (e as any).delta?.type !== "citations_delta"),
  };
  const { state } = replay(withoutCitations);
  assert.equal(state.citations.length, 0);
  assert.ok(state.resultSources.length > 0);
  assert.ok(state.resultSources.every((s) => s.url.startsWith("http") && s.citedText === ""));
});

test("replay: a search error counts as an attempt and emits no event of its own", () => {
  const { state, events } = replay(searchError);
  assert.equal(state.searchCount, 2); // two attempts; usage counts the one that ran
  assert.equal(events.filter((e) => e.type === "searching").length, 2);
  assert.ok(events.every((e) => e.type === "searching" || e.type === "text"));
});

test("mapEvents ignores thinking blocks and unknown events", () => {
  const state = newStreamState();
  const events: AgentEvent[] = [];
  const emit = (e: AgentEvent) => events.push(e);
  mapEvents({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }, state, emit);
  mapEvents({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } }, state, emit);
  mapEvents({ type: "content_block_stop", index: 0 }, state, emit);
  mapEvents({ type: "message_start", message: {} }, state, emit);
  mapEvents({ type: "ping" }, state, emit);
  assert.deepEqual(events, []);
  assert.equal(state.searchCount, 0);
});

test("mapEvents: a citation with no title uses its URL", () => {
  const state = newStreamState();
  mapEvents({
    type: "content_block_delta", index: 3,
    delta: { type: "citations_delta", citation: { type: "web_search_result_location", url: "https://a.example", cited_text: "x" } },
  }, state, () => {});
  assert.deepEqual(state.citations, [{ url: "https://a.example", title: "https://a.example", citedText: "x" }]);
});

// ---- Fake-client tests ----

test("an ordinary turn: events, text, sources and the usage search count", async () => {
  const client = fakeClient({ events: ordinary.events, message: ordinary.finalMessage });
  const { outcome, events } = await run(client);

  assert.equal(outcome.ok, true);
  assert.equal(outcome.stopReason, "end_turn");
  assert.equal(outcome.searchCount, 2);
  assert.ok(outcome.text.length > 200);
  assert.notEqual(outcome.msFirstText, null);
  assert.equal(events.filter((e) => e.type === "searching").length, 2);

  const last = events[events.length - 1];
  assert.equal(last.type, "sources");
  assert.equal(events.filter((e) => e.type === "sources").length, 1);
  assert.deepEqual(problems(events), []);
});

test("the request has one tool, the route's cap, effort and adaptive thinking", async () => {
  const client = fakeClient({ events: textEvents("Hi"), message: finalMessage("end_turn") });
  await run(client);
  const request = client.requests[0];
  assert.equal(request.model, "claude-sonnet-5-5");
  assert.equal(request.max_tokens, 32768);
  assert.equal(request.system, "system text");
  assert.deepEqual(request.messages, [{ role: "user", content: "hello" }]);
  assert.deepEqual(request.tools, [{ type: "web_search_20250305", name: "web_search", max_uses: 5 }]);
  assert.deepEqual(request.output_config, { effort: "low" });
  assert.deepEqual(request.thinking, { type: "adaptive" });
});

test("a model with no measured settings is sent no effort and no thinking", async () => {
  const chosen = route(null, loadConfig({ MODEL_DEFAULT: "some-other-model" }));
  if (chosen.kind !== "model") throw new Error("expected a model route");
  const client = fakeClient({ events: textEvents("Hi"), message: finalMessage("end_turn") });
  await run(client, makeArgs({ route: chosen }));
  assert.equal("output_config" in client.requests[0], false);
  assert.equal("thinking" in client.requests[0], false);
});

test("one pause_turn then end_turn: two requests, same max_uses, paused content appended", async () => {
  const pausedContent = [{ type: "server_tool_use", id: "s1", name: "web_search", input: { query: "q" } }];
  const client = fakeClient(
    { events: paused.events, message: finalMessage("pause_turn", 2, pausedContent) },
    { events: textEvents("Done."), message: finalMessage("end_turn", 1) },
  );
  const { outcome, events } = await run(client);

  assert.equal(client.requests.length, 2);
  assert.equal(client.requests[0].tools[0].max_uses, 5);
  assert.equal(client.requests[1].tools[0].max_uses, 5);
  assert.deepEqual(client.requests[1].messages, [
    { role: "user", content: "hello" },
    { role: "assistant", content: pausedContent },
  ]);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.stopReason, "end_turn");
  assert.equal(outcome.searchCount, 3); // usage summed over both requests
  assert.equal(outcome.text, "Done.");
  assert.deepEqual(problems(events), []);
});

test("a second pause gives incomplete, ok true, stop reason pause_limit", async () => {
  const client = fakeClient(
    { events: textEvents("Part one. "), message: finalMessage("pause_turn", 1) },
    { events: textEvents("Part two."), message: finalMessage("pause_turn", 1) },
  );
  const { outcome, events } = await run(client);
  assert.equal(client.requests.length, 2);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.stopReason, "pause_limit");
  assert.equal(outcome.text, "Part one. Part two.");
  assert.deepEqual(problems(events), ["incomplete"]);
});

test("a 400 on the continuation gives the same result, keeping the text so far", async () => {
  const client = fakeClient(
    { events: textEvents("So far."), message: finalMessage("pause_turn", 1) },
    { errorAtStart: apiError(400, "This model does not support assistant message prefill.") },
  );
  const { outcome, events } = await run(client);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.stopReason, "pause_limit");
  assert.equal(outcome.text, "So far.");
  assert.deepEqual(problems(events), ["incomplete"]);
});

test("a max_tokens stop gives incomplete, ok true, text kept", async () => {
  const client = fakeClient({ events: textEvents("Cut of"), message: finalMessage("max_tokens") });
  const { outcome, events } = await run(client);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.stopReason, "max_tokens");
  assert.equal(outcome.text, "Cut of");
  assert.deepEqual(problems(events), ["incomplete"]);
});

test("a refusal stop gives refused, ok true", async () => {
  const client = fakeClient({ message: finalMessage("refusal") });
  const { outcome, events } = await run(client);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.stopReason, "refusal");
  assert.deepEqual(problems(events), ["refused"]);
});

test("any other stop reason gives incomplete, ok false", async () => {
  const client = fakeClient({ message: finalMessage(null) });
  const { outcome, events } = await run(client);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.stopReason, "error");
  assert.deepEqual(problems(events), ["incomplete"]);
});

test("a 401 and a 403 each give invalid_key, ok false", async () => {
  for (const status of [401, 403]) {
    const client = fakeClient({ errorAtStart: apiError(status) });
    const { outcome, events } = await run(client);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.stopReason, "error");
    assert.deepEqual(problems(events), ["invalid_key"]);
    assert.equal(client.requests.length, 1);
  }
});

test("a 400 about web search gives search_disabled; other 400s give api_error", async () => {
  let client = fakeClient({ errorAtStart: apiError(400, "400 Web search is not enabled for your organization.") });
  let result = await run(client);
  assert.deepEqual(problems(result.events), ["search_disabled"]);
  assert.equal(result.outcome.ok, false);

  client = fakeClient({ errorAtStart: apiError(400, "max_tokens is too large") });
  result = await run(client);
  assert.deepEqual(problems(result.events), ["api_error"]);
  const problem = result.events.find((e) => e.type === "problem");
  assert.match(problem?.type === "problem" ? problem.message : "", /status 400/);
});

test("429 with retry-after 3 then success makes one retry after a 3000 ms wait", async () => {
  const client = fakeClient(
    { errorAtStart: apiError(429, "rate limited", { "retry-after": "3" }) },
    { events: textEvents("OK"), message: finalMessage("end_turn") },
  );
  const { outcome, events, sleeps } = await run(client);
  assert.deepEqual(sleeps, [3000]);
  assert.equal(client.requests.length, 2);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.text, "OK");
  assert.deepEqual(problems(events), []);
});

test("429 without a usable retry-after waits 2 seconds, and never more than 10", async () => {
  let client = fakeClient({ errorAtStart: apiError(429) }, { events: textEvents("OK"), message: finalMessage("end_turn") });
  assert.deepEqual((await run(client)).sleeps, [2000]);
  client = fakeClient({ errorAtStart: apiError(429, "x", { "retry-after": "soon" }) }, { events: textEvents("OK"), message: finalMessage("end_turn") });
  assert.deepEqual((await run(client)).sleeps, [2000]);
  client = fakeClient({ errorAtStart: apiError(429, "x", { "retry-after": "60" }) }, { events: textEvents("OK"), message: finalMessage("end_turn") });
  assert.deepEqual((await run(client)).sleeps, [10000]);
});

test("429 twice gives rate_limited after one retry", async () => {
  const client = fakeClient({ errorAtStart: apiError(429) }, { errorAtStart: apiError(429) });
  const { outcome, events, sleeps } = await run(client);
  assert.equal(client.requests.length, 2);
  assert.equal(sleeps.length, 1);
  assert.equal(outcome.ok, false);
  assert.deepEqual(problems(events), ["rate_limited"]);
});

test("any other error gives api_error with the status, or network error with none", async () => {
  let result = await run(fakeClient({ errorAtStart: apiError(500) }));
  let problem = result.events.find((e) => e.type === "problem");
  assert.equal(problem?.type === "problem" && problem.code, "api_error");
  assert.match(problem?.type === "problem" ? problem.message : "", /status 500/);
  assert.equal(result.outcome.ok, false);

  result = await run(fakeClient({ errorAtStart: new Error("socket hang up") }));
  problem = result.events.find((e) => e.type === "problem");
  assert.match(problem?.type === "problem" ? problem.message : "", /network error/);
});

test("an error after text keeps the text and gives incomplete, ok false", async () => {
  const client = fakeClient({ events: textEvents("Half an ans"), errorAfterEvents: apiError(500) });
  const { outcome, events } = await run(client);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.stopReason, "error");
  assert.equal(outcome.text, "Half an ans");
  assert.deepEqual(problems(events), ["incomplete"]);
});

test("an aborted signal gives ok false, stop reason aborted, and no events", async () => {
  const controller = new AbortController();
  controller.abort();
  const client = fakeClient({ errorAtStart: apiError(500) });
  const { outcome, events } = await run(client, makeArgs({ signal: controller.signal }));
  assert.equal(outcome.ok, false);
  assert.equal(outcome.stopReason, "aborted");
  assert.deepEqual(events, []);
});

test("an abort during the request gives aborted and no problem event", async () => {
  const controller = new AbortController();
  const client = fakeClient({ events: textEvents("A"), errorAfterEvents: Object.assign(new Error("aborted"), {}) });
  const args = makeArgs({ signal: controller.signal });
  const events: AgentEvent[] = [];
  const outcome = await streamAnswer(args, (event) => {
    events.push(event);
    controller.abort(); // the browser goes away after the first text
  }, { client, sleep: async () => {} });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.stopReason, "aborted");
  assert.deepEqual(problems(events), []);
});

test("an abort during the 429 wait gives aborted", async () => {
  const controller = new AbortController();
  const client = fakeClient({ errorAtStart: apiError(429) }, { events: textEvents("never"), message: finalMessage("end_turn") });
  const outcome = await streamAnswer(makeArgs({ signal: controller.signal }), () => {}, {
    client, sleep: async () => { controller.abort(); },
  });
  assert.equal(outcome.stopReason, "aborted");
  assert.equal(client.requests.length, 1);
});

test("a null key makes no request and gives missing_key", async () => {
  const client = fakeClient({ events: textEvents("never"), message: finalMessage("end_turn") });
  const { outcome, events } = await run(client, makeArgs({ apiKey: null }));
  assert.equal(client.requests.length, 0);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.stopReason, "error");
  assert.deepEqual(problems(events), ["missing_key"]);
});

test("with no client given, a null key still makes no call", async () => {
  const events: AgentEvent[] = [];
  const outcome = await streamAnswer(makeArgs({ apiKey: null }), (e) => events.push(e));
  assert.equal(outcome.ok, false);
  assert.deepEqual(problems(events), ["missing_key"]);
});

test("the search-error fixture: usage says 1 search ran although 2 were attempted", async () => {
  const client = fakeClient({ events: searchError.events, message: searchError.finalMessage });
  const { outcome } = await run(client);
  assert.equal(outcome.searchCount, 1);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.stopReason, "end_turn");
});

test("with no citations, sources fall back to the search results", async () => {
  const events = ordinary.events.filter((e) => (e as any).delta?.type !== "citations_delta");
  const client = fakeClient({ events, message: ordinary.finalMessage });
  const result = await run(client);
  assert.ok(result.outcome.sources.length > 0);
  assert.ok(result.outcome.sources.every((s) => s.citedText === ""));
  const sourcesEvent = result.events.find((e) => e.type === "sources");
  assert.equal(sourcesEvent?.type === "sources" && sourcesEvent.sources.length, result.outcome.sources.length);
});
