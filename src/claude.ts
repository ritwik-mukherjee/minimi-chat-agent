import Anthropic from "@anthropic-ai/sdk";
import type {
  AnswerOutcome, Emit, Source, StopReason, StreamArgs, StreamClient,
} from "./types.ts";
import { problem } from "./events.ts";

const DEFAULT_RETRY_SECONDS = 2;
const MAX_RETRY_SECONDS = 10;

// Everything about one turn's stream, kept across pause_turn continuations.
export interface StreamState {
  searchCount: number;                 // every web_search server_tool_use block, errors included
  queryBuffers: Map<number, string>;   // content-block index -> partial input JSON
  citations: Source[];                 // de-duplicated by URL
  resultSources: Source[];             // from search results, for the fallback
  text: string;
  firstTextAt: number | null;          // performance.now() of the first text_delta
}

export function newStreamState(): StreamState {
  return {
    searchCount: 0, queryBuffers: new Map(), citations: [], resultSources: [], text: "", firstTextAt: null,
  };
}

// A raw stream event or content block, as JSON. The API's shapes vary, so fields are checked where they are read.
type Raw = Record<string, any>;

function addSource(list: Source[], source: Source): void {
  if (source.url !== "" && !list.some((existing) => existing.url === source.url)) list.push(source);
}

// Turns one raw API stream event into browser events and state changes.
export function mapEvents(event: unknown, state: StreamState, emit: Emit): void {
  const e = event as Raw;

  if (e.type === "content_block_start") {
    const block: Raw = e.content_block ?? {};
    if (block.type === "server_tool_use" && block.name === "web_search") {
      state.queryBuffers.set(e.index, "");
    } else if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
      // An error result has an object here instead of a list: no event, and the search still counts.
      for (const result of block.content as Raw[]) {
        addSource(state.resultSources, {
          url: String(result.url ?? ""), title: String(result.title ?? result.url ?? ""), citedText: "",
        });
      }
    }
    return;
  }

  if (e.type === "content_block_delta") {
    const delta: Raw = e.delta ?? {};
    if (delta.type === "input_json_delta" && state.queryBuffers.has(e.index)) {
      state.queryBuffers.set(e.index, state.queryBuffers.get(e.index) + String(delta.partial_json ?? ""));
    } else if (delta.type === "text_delta") {
      if (state.firstTextAt === null) state.firstTextAt = performance.now();
      state.text += delta.text;
      emit({ type: "text", delta: String(delta.text) });
    } else if (delta.type === "citations_delta") {
      const citation: Raw = delta.citation ?? {};
      const url = String(citation.url ?? "");
      addSource(state.citations, {
        url, title: String(citation.title || url), citedText: String(citation.cited_text ?? ""),
      });
    }
    return;
  }

  if (e.type === "content_block_stop" && state.queryBuffers.has(e.index)) {
    const buffered = state.queryBuffers.get(e.index) ?? "";
    state.queryBuffers.delete(e.index);
    state.searchCount += 1;
    const query = parseQuery(buffered);
    if (query !== "") emit({ type: "searching", query });
  }
  // Thinking blocks, message_start, message_delta and message_stop are ignored here:
  // the stop reason and usage are read from finalMessage().
}

function parseQuery(json: string): string {
  try {
    const input = JSON.parse(json) as Raw;
    return typeof input.query === "string" ? input.query : "";
  } catch {
    return "";
  }
}

// What the SDK's final message holds beyond the contract's StreamHandle type.
interface FinalMessage {
  content: unknown[];
  stop_reason: string | null;
  usage?: { server_tool_use?: { web_search_requests?: number } };
}

type SdkMessage = { role: "user" | "assistant"; content: string | unknown[] };

let sharedClient: StreamClient | null = null;

// One client for the whole process, created on first use. The SDK's own retries are off:
// the one retry on a 429 is made here.
function getClient(apiKey: string): StreamClient {
  sharedClient ??= new Anthropic({ apiKey, maxRetries: 0 });
  return sharedClient;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function statusOf(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
}

function retryDelayMs(error: unknown): number {
  const headers = (error as { headers?: { get?: (name: string) => string | null } } | null)?.headers;
  const header = headers?.get?.("retry-after");
  const seconds = header ? Number(header) : NaN; // a missing header must not become 0
  const valid = Number.isFinite(seconds) && seconds >= 0 ? seconds : DEFAULT_RETRY_SECONDS;
  return Math.min(valid, MAX_RETRY_SECONDS) * 1000;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Sends one request and reads its whole stream. Throws on any error.
async function requestOnce(
  client: StreamClient, args: StreamArgs, messages: SdkMessage[], state: StreamState, emit: Emit,
): Promise<FinalMessage> {
  const route = args.route;
  const stream = client.messages.stream({
    model: route.model,
    max_tokens: route.maxTokens,
    system: args.system,
    messages,
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: route.maxSearches }],
    ...(route.effort !== null ? { output_config: { effort: route.effort } } : {}), // field name per Stage 0, Q3a
    ...(route.thinking !== null ? { thinking: route.thinking } : {}),             // literal per Stage 0, Q3b
  }, { signal: args.signal });
  for await (const event of stream) mapEvents(event, state, emit);
  return await stream.finalMessage();
}

// Streams one answer. It never throws: every failure becomes a problem event and an outcome.
export async function streamAnswer(
  args: StreamArgs, emit: Emit,
  deps: { client?: StreamClient; sleep?: (ms: number) => Promise<void> } = {},
): Promise<AnswerOutcome> {
  const state = newStreamState();
  let searchCount = 0; // from usage, summed over the requests of the turn

  function finish(ok: boolean, stopReason: StopReason): AnswerOutcome {
    const sources = state.citations.length > 0 ? state.citations : state.resultSources;
    return {
      ok, text: state.text, sources, searchCount, stopReason,
      msFirstText: state.firstTextAt === null ? null : state.firstTextAt - args.startedAt,
    };
  }

  // Sources go out once, at the end, before any problem event.
  function finishWith(ok: boolean, stopReason: StopReason, problemEvent?: ReturnType<typeof problem>): AnswerOutcome {
    const result = finish(ok, stopReason);
    if (result.sources.length > 0) {
      emit({ type: "sources", sources: result.sources.map(({ url, title }) => ({ url, title })) });
    }
    if (problemEvent) emit(problemEvent);
    return result;
  }

  if (args.apiKey === null) {
    emit(problem("missing_key"));
    return finish(false, "error");
  }

  const client = deps.client ?? getClient(args.apiKey);
  const sleep = deps.sleep ?? defaultSleep;
  const messages: SdkMessage[] = args.messages.map(({ role, content }) => ({ role, content }));
  let continuations = 0;
  let retried = false;

  for (;;) {
    if (args.signal.aborted) return finish(false, "aborted");

    const textBefore = state.text.length;
    let message: FinalMessage;
    try {
      message = await requestOnce(client, args, messages, state, emit);
    } catch (error) {
      if (args.signal.aborted) return finish(false, "aborted");
      const status = statusOf(error);

      // One retry on a 429, as long as this request produced no text.
      if (status === 429 && !retried && state.text.length === textBefore) {
        retried = true;
        await sleep(retryDelayMs(error));
        continue;
      }
      // The API refused to continue a paused turn: end the answer as incomplete.
      if (continuations > 0 && status === 400) {
        return finishWith(true, "pause_limit", problem("incomplete"));
      }
      // Any error after text has started keeps the text.
      if (state.firstTextAt !== null) return finishWith(false, "error", problem("incomplete"));

      if (status === 401 || status === 403) return finishWith(false, "error", problem("invalid_key"));
      if (status === 400 && /web search/i.test(messageOf(error))) {
        return finishWith(false, "error", problem("search_disabled"));
      }
      if (status === 429) return finishWith(false, "error", problem("rate_limited"));
      return finishWith(false, "error", problem("api_error", status));
    }

    searchCount += message.usage?.server_tool_use?.web_search_requests ?? 0;

    switch (message.stop_reason) {
      case "end_turn":
        return finishWith(true, "end_turn");
      case "pause_turn":
        if (continuations < args.pauseTurnLimit) {
          continuations += 1;
          messages.push({ role: "assistant", content: message.content }); // sent back unchanged
          continue;
        }
        return finishWith(true, "pause_limit", problem("incomplete"));
      case "max_tokens":
        return finishWith(true, "max_tokens", problem("incomplete"));
      case "refusal":
        return finishWith(true, "refusal", problem("refused"));
      default:
        return finishWith(false, "error", problem("incomplete"));
    }
  }
}
