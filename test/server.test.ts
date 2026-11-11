import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createServer } from "../src/server.ts";
import { loadConfig } from "../src/config.ts";
import { openLedger } from "../src/ledger.ts";
import type { AgentEvent } from "../src/events.ts";
import type { HandleTurn, TurnRequest } from "../src/types.ts";

const CONVERSATION_ID = "123e4567-e89b-42d3-a456-426614174000";

const ledger = openLedger(":memory:");
const config = loadConfig({ ANTHROPIC_API_KEY: "test-key" });

// What the fake handleTurn saw, and what it does next.
const received: TurnRequest[] = [];
let behaviour: HandleTurn = async (_request, emit) => {
  emit({ type: "text", delta: "Hello" });
  emit({ type: "done", turnId: 1, model: null, searchCount: 0, msFirstEvent: 1, msFirstText: 2, msTotal: 3 });
};
const fakeHandleTurn: HandleTurn = (request, emit) => {
  received.push(request);
  return behaviour(request, emit);
};

const server = createServer({ config, ledger, handleTurn: fakeHandleTurn });
let port = 0;

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  ledger.close();
});

interface Reply { status: number; headers: http.IncomingHttpHeaders; body: string }

// A raw request: node's fetch would normalise paths like /../ and refuse to set Host.
function request(options: {
  method?: string; path: string; headers?: Record<string, string>; body?: string;
}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port, method: options.method ?? "GET", path: options.path,
      headers: { Host: `127.0.0.1:${port}`, ...options.headers },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(options.body);
  });
}

function postChat(body: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  return request({
    method: "POST", path: "/api/chat",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const validBody = { message: "What is Neon?", conversationId: CONVERSATION_ID, timeZone: "Europe/London" };

test("GET / returns the HTML page", async () => {
  const reply = await request({ path: "/" });
  assert.equal(reply.status, 200);
  assert.match(reply.headers["content-type"] ?? "", /text\/html/);
  assert.match(reply.body, /<script type="module" src="\/app\.js">/);
});

test("the other page files are served with their content types", async () => {
  const js = await request({ path: "/app.js" });
  assert.equal(js.status, 200);
  assert.match(js.headers["content-type"] ?? "", /javascript/);
  const css = await request({ path: "/style.css" });
  assert.equal(css.status, 200);
  assert.match(css.headers["content-type"] ?? "", /text\/css/);
});

test("a mapped file that does not exist yet returns 404", async () => {
  // character.js is built in phase 6; until then (or if deleted) the page must still work.
  const reply = await request({ path: "/character.js" });
  assert.ok(reply.status === 404 || reply.status === 200);
});

test("GET /../package.json gets a 404", async () => {
  const reply = await request({ path: "/../package.json" });
  assert.equal(reply.status, 404);
  assert.doesNotMatch(reply.body, /minimi-chat-agent/);
  for (const path of ["/%2e%2e/package.json", "/public/app.js", "/package.json", "/src/server.ts"]) {
    assert.equal((await request({ path })).status, 404, path);
  }
});

test("a wrong Host gets a 403", async () => {
  for (const host of ["evil.example", "evil.example:" + port, "localhost:1", `127.0.0.1.evil.example:${port}`]) {
    const reply = await request({ path: "/api/status", headers: { Host: host } });
    assert.equal(reply.status, 403, host);
  }
  const ok = await request({ path: "/api/status", headers: { Host: `localhost:${port}` } });
  assert.equal(ok.status, 200);
});

test("a foreign Origin gets a 403, the server's own origin is fine", async () => {
  const foreign = await request({ path: "/api/turns", headers: { Origin: "https://evil.example" } });
  assert.equal(foreign.status, 403);
  const wrongPort = await request({ path: "/api/turns", headers: { Origin: "http://localhost:1" } });
  assert.equal(wrongPort.status, 403);
  const own = await request({ path: "/api/turns", headers: { Origin: `http://localhost:${port}` } });
  assert.equal(own.status, 200);
  const sameIp = await request({ path: "/api/turns", headers: { Origin: `http://127.0.0.1:${port}` } });
  assert.equal(sameIp.status, 200);
});

test("a text/plain POST gets a 415", async () => {
  const reply = await request({
    method: "POST", path: "/api/chat", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(validBody),
  });
  assert.equal(reply.status, 415);
});

test("a body over 16 KB gets a 413", async () => {
  const reply = await postChat({ ...validBody, message: "x".repeat(20000) });
  assert.equal(reply.status, 413);
});

test("invalid fields get a 400 naming the field", async () => {
  const cases: [unknown, string][] = [
    [{ message: "hi", timeZone: "UTC" }, "conversationId"],
    [{ ...validBody, conversationId: "not-a-uuid" }, "conversationId"],
    [{ ...validBody, message: "   " }, "message"],
    [{ ...validBody, message: 42 }, "message"],
    [{ ...validBody, message: "x".repeat(4001) }, "message"],
    [{ ...validBody, timeZone: 5 }, "timeZone"],
    [{ ...validBody, timeZone: "x".repeat(65) }, "timeZone"],
    ["not json", "body"],
    ["[]", "body"],
  ];
  for (const [body, field] of cases) {
    const reply = await postChat(body);
    assert.equal(reply.status, 400, field);
    assert.deepEqual(JSON.parse(reply.body), { error: `${field} is invalid` });
  }
});

test("a valid POST receives the fake's events as data frames", async () => {
  received.length = 0;
  const reply = await postChat({ ...validBody, message: "  What is Neon?  " });
  assert.equal(reply.status, 200);
  assert.match(reply.headers["content-type"] ?? "", /^text\/event-stream; charset=utf-8/);
  assert.equal(reply.headers["cache-control"], "no-cache");

  const frames = reply.body.split("\n\n").filter((frame) => frame !== "");
  assert.ok(frames.every((frame) => frame.startsWith("data: ")));
  const events = frames.map((frame) => JSON.parse(frame.slice("data: ".length)) as AgentEvent);
  assert.deepEqual(events.map((event) => event.type), ["text", "done"]);
  assert.equal(events[0].type === "text" && events[0].delta, "Hello");

  assert.equal(received.length, 1);
  assert.equal(received[0].message, "What is Neon?"); // trimmed
  assert.equal(received[0].conversationId, CONVERSATION_ID);
  assert.equal(received[0].timeZone, "Europe/London");
  assert.equal(received[0].signal.aborted, false);
});

test("a content type with a charset is accepted", async () => {
  const reply = await postChat(validBody, { "Content-Type": "application/json; charset=utf-8" });
  assert.equal(reply.status, 200);
});

test("closing the client connection aborts the fake's signal", async () => {
  let signalSeen: AbortSignal | null = null;
  const aborted = new Promise<void>((resolve) => {
    behaviour = (request, emit) => {
      signalSeen = request.signal;
      emit({ type: "text", delta: "first" });
      return new Promise<void>((done) => {
        request.signal.addEventListener("abort", () => { resolve(); done(); });
      });
    };
  });

  await new Promise<void>((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port, method: "POST", path: "/api/chat",
      headers: { Host: `127.0.0.1:${port}`, "Content-Type": "application/json" },
    }, (res) => {
      res.once("data", () => {
        // The turn is running and has sent its first event: now the browser goes away.
        assert.equal(signalSeen?.aborted, false, "the turn is not aborted by the request body closing");
        req.destroy();
        resolve();
      });
    });
    req.on("error", () => {}); // the destroy raises a socket error on this side
    req.on("timeout", () => reject(new Error("timeout")));
    req.end(JSON.stringify(validBody));
  });

  await Promise.race([
    aborted,
    new Promise((_, reject) => setTimeout(() => reject(new Error("signal was not aborted")), 3000)),
  ]);
  assert.equal(signalSeen!.aborted, true);

  behaviour = async (_request, emit) => emit({ type: "text", delta: "Hello" }); // restore a simple behaviour
});

test("a handleTurn that throws ends the stream with a problem event", async () => {
  behaviour = async () => { throw new Error("database is locked"); };
  const original = console.error;
  console.error = () => {};
  try {
    const reply = await postChat(validBody);
    assert.equal(reply.status, 200);
    const events = reply.body.split("\n\n").filter((f) => f !== "").map((f) => JSON.parse(f.slice(6)) as AgentEvent);
    assert.equal(events.at(-1)?.type, "problem");
  } finally {
    console.error = original;
    behaviour = async (_request, emit) => emit({ type: "text", delta: "Hello" });
  }
});

test("GET /api/status", async () => {
  const reply = await request({ path: "/api/status" });
  assert.equal(reply.status, 200);
  assert.deepEqual(JSON.parse(reply.body), {
    apiKey: true, models: { default: "claude-sonnet-5-5", compare: "claude-sonnet-5-5" },
  });
  assert.doesNotMatch(reply.body, /test-key/);
});

test("GET /api/status reports a missing key", async () => {
  const keyless = createServer({ config: loadConfig({}), ledger, handleTurn: fakeHandleTurn });
  await new Promise<void>((resolve) => keyless.listen(0, "127.0.0.1", resolve));
  const keylessPort = (keyless.address() as AddressInfo).port;
  const body = await new Promise<string>((resolve) => {
    http.get({ host: "127.0.0.1", port: keylessPort, path: "/api/status", headers: { Host: `127.0.0.1:${keylessPort}` } }, (res) => {
      let text = "";
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve(text));
    });
  });
  assert.equal(JSON.parse(body).apiKey, false);
  await new Promise<void>((resolve) => keyless.close(() => resolve()));
});

test("GET /api/turns groups saved turns by date, and DELETE clears them", async () => {
  const id = ledger.insertPending({
    conversationId: "c", createdAtUtc: "2026-11-03T12:00:00.000Z", timeZone: "UTC", localDate: "2026-11-03",
    question: "Saved question", path: "ordinary", recalledIds: [], model: "claude-sonnet-5-5", routeReason: "ordinary",
  });
  ledger.complete(id, {
    answer: "Saved answer", sources: [{ url: "https://example.com", title: "Example", citedText: "q" }],
    searchCount: 1, msFirstEvent: 1, msFirstText: 2, msTotal: 3, stopReason: "end_turn",
  });

  const listed = JSON.parse((await request({ path: "/api/turns" })).body);
  assert.equal(listed.days.length, 1);
  assert.equal(listed.days[0].localDate, "2026-11-03");
  assert.equal(listed.days[0].label, "Tuesday 3 November 2026");
  assert.deepEqual(Object.keys(listed.days[0].turns[0]).sort(),
    ["answer", "createdAtUtc", "id", "model", "question", "sources", "status"]);
  assert.equal(listed.days[0].turns[0].status, "complete");

  const cleared = await request({ method: "DELETE", path: "/api/turns" });
  assert.equal(cleared.status, 204);
  const after = JSON.parse((await request({ path: "/api/turns" })).body);
  assert.deepEqual(after, { days: [] });
});

test("unknown routes and methods get a 404", async () => {
  assert.equal((await request({ path: "/api/nothing" })).status, 404);
  assert.equal((await request({ method: "POST", path: "/api/turns" })).status, 404);
});
