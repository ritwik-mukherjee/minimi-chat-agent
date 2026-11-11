import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import type { Config, HandleTurn, Ledger } from "./types.ts";
import { encode, problem } from "./events.ts";
import { fullDayLabel, systemClock } from "./clock.ts";
import { loadConfig } from "./config.ts";
import { openLedger } from "./ledger.ts";
import { streamAnswer } from "./claude.ts";
import { handleTurn } from "./turn.ts";

const MAX_BODY_BYTES = 16 * 1024;
const MAX_MESSAGE_LENGTH = 4000;
const MAX_TIME_ZONE_LENGTH = 64;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PUBLIC_DIR = path.join(import.meta.dirname, "..", "public");

// The only files the server will send: URL path -> file in public/ and content type.
const STATIC_FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/character.js": { file: "character.js", type: "text/javascript; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
};

interface ServerDeps { config: Config; ledger: Ledger; handleTurn: HandleTurn }

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

// Reads the request body as text. Returns null when it is larger than the limit.
function readBody(req: http.IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) tooLarge = true;
      else chunks.push(chunk);
    });
    req.on("end", () => resolve(tooLarge ? null : Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

interface ChatBody { message: string; conversationId: string; timeZone: string }

// Returns the body, or the name of the first invalid field.
function validateChatBody(raw: string): ChatBody | string {
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return "body";
    body = parsed as Record<string, unknown>;
  } catch {
    return "body";
  }
  const { message, conversationId, timeZone } = body;
  if (typeof message !== "string" || message.trim().length < 1 || message.trim().length > MAX_MESSAGE_LENGTH) {
    return "message";
  }
  if (typeof conversationId !== "string" || !UUID_PATTERN.test(conversationId)) return "conversationId";
  if (typeof timeZone !== "string" || timeZone.length > MAX_TIME_ZONE_LENGTH) return "timeZone";
  return { message: message.trim(), conversationId, timeZone };
}

export function createServer({ config, ledger, handleTurn }: ServerDeps): http.Server {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      console.error(`Request failed: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) sendJson(res, 500, { error: "server error" });
      else res.end();
    });
  });

  // The port is read from the listening server on each request, never from config,
  // so the checks stay correct when a test listens on port 0.
  function allowed(req: http.IncomingMessage): boolean {
    const address = server.address();
    if (address === null || typeof address === "string") return false;
    const hosts = [`localhost:${address.port}`, `127.0.0.1:${address.port}`];
    if (!hosts.includes(req.headers.host ?? "")) return false;
    const origin = req.headers.origin;
    return origin === undefined || hosts.map((host) => `http://${host}`).includes(origin);
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!allowed(req)) return sendJson(res, 403, { error: "forbidden" });

    const pathname = (req.url ?? "/").split("?")[0];
    const method = req.method ?? "GET";

    if (method === "GET" && pathname in STATIC_FILES) return sendStatic(res, STATIC_FILES[pathname]);
    if (method === "POST" && pathname === "/api/chat") return chat(req, res);

    if (method === "GET" && pathname === "/api/turns") {
      const days = ledger.groupedByDate().map((day) => ({
        localDate: day.localDate,
        label: fullDayLabel(day.localDate),
        turns: day.turns.map((turn) => ({
          id: turn.id, question: turn.question, answer: turn.answer, sources: turn.sources,
          status: turn.status, model: turn.model, createdAtUtc: turn.createdAtUtc,
        })),
      }));
      return sendJson(res, 200, { days });
    }
    if (method === "DELETE" && pathname === "/api/turns") {
      ledger.clear();
      res.writeHead(204);
      return void res.end();
    }
    if (method === "GET" && pathname === "/api/status") {
      return sendJson(res, 200, { apiKey: config.apiKey !== null, models: config.models });
    }
    return sendJson(res, 404, { error: "not found" });
  }

  function sendStatic(res: http.ServerResponse, entry: { file: string; type: string }): void {
    fs.readFile(path.join(PUBLIC_DIR, entry.file), (error, content) => {
      if (error) return sendJson(res, 404, { error: "not found" }); // for example character.js before it exists
      res.writeHead(200, { "Content-Type": entry.type, "Cache-Control": "no-cache" });
      res.end(content);
    });
  }

  async function chat(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
      return sendJson(res, 415, { error: "content type must be application/json" });
    }
    const raw = await readBody(req);
    if (raw === null) return sendJson(res, 413, { error: "body is too large" });
    const body = validateChatBody(raw);
    if (typeof body === "string") return sendJson(res, 400, { error: `${body} is invalid` });

    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" });

    // Abort the turn when the browser goes away. This listens to res, not req:
    // req closes as soon as the body has been read, which would abort every turn.
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });

    const write = (event: Parameters<typeof encode>[0]) => {
      if (!res.writableEnded && !res.destroyed) res.write(encode(event));
    };
    try {
      await handleTurn({ ...body, signal: controller.signal }, write);
    } catch (error) {
      console.error(`Turn failed: ${error instanceof Error ? error.message : String(error)}`);
      write(problem("api_error"));
    }
    res.end();
  }

  return server;
}

// When run directly: load config, open the ledger, listen on loopback only.
function main(): void {
  let config: Config;
  let ledger: Ledger;
  try {
    config = loadConfig();
    ledger = openLedger(config.dbPath);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  const clock = systemClock();
  const server = createServer({
    config, ledger,
    handleTurn: (request, emit) => handleTurn(request, { clock, ledger, config, streamAnswer }, emit),
  });

  server.on("error", (error) => {
    console.error(`Could not listen on port ${config.port}: ${error.message}. Set PORT in .env to use another port.`);
    process.exit(1);
  });
  server.listen(config.port, "127.0.0.1", () => {
    console.log(`minimi chat agent: http://localhost:${config.port}`);
    console.log(
      config.apiKey === null
        ? "ANTHROPIC_API_KEY is not set. Add it to .env and restart `npm run dev`."
        : "ANTHROPIC_API_KEY is set.",
    );
  });
}

// A plain path comparison: the project folder's name contains a space, so URLs would not match.
if (import.meta.filename === process.argv[1]) main();
