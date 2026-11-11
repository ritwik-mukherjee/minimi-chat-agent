import type { AgentEvent } from "./events.ts";

export interface Config {
  apiKey: string | null;                         // ANTHROPIC_API_KEY; null when unset or empty
  models: { default: string; compare: string };  // MODEL_DEFAULT, MODEL_COMPARE
  effort: { default: string | null; compare: string | null };   // from MODEL_SETTINGS (file 9); null = omit
  thinking: { default: Record<string, unknown> | null;
              compare: Record<string, unknown> | null };       // from MODEL_SETTINGS; null = omit
  maxTokens: { default: number; compare: number }; // constants from Stage 0 (Q3c)
  searchCap: { default: number; compare: number }; // 5 and 8
  recallCap: number;        // 5
  nearMissDays: number;     // 3
  undatedWindow: number;    // 30
  historyTurns: number;     // 10
  pauseTurnLimit: number;   // 1 (Stage 0, Q3d)
  port: number;             // PORT, default 3000
  dbPath: string;           // DB_PATH, default "data/turns.db"
}

export interface Clock { now(): Date }

export interface DateRange {
  from: string;          // "YYYY-MM-DD", local, inclusive
  to: string;            // "YYYY-MM-DD", local, inclusive
  label: string;         // rules-table label: "Tuesday 3 November", "yesterday, Monday 9 November",
                         // "the week of Monday 2 November"; used in status text and code-written replies
  matchedText: string;   // the words in the message that matched
}

export interface PastRefs { range: DateRange | null; cue: boolean; matched: string[] }

export interface Source { url: string; title: string; citedText: string }

export type TurnPath = "ordinary" | "recall_hit" | "recall_near" | "recall_miss";
export type RouteReason = "ordinary" | "compare" | "no_record" | "no_record_direct";
export type StopReason =
  "end_turn" | "direct" | "pause_limit" | "max_tokens" | "refusal" | "error" | "aborted";

export interface TurnRow {
  id: number; conversationId: string; createdAtUtc: string; timeZone: string;
  localDate: string; question: string; answer: string; sources: Source[];
  path: TurnPath; recalledIds: number[]; model: string | null; routeReason: RouteReason;
  searchCount: number;
  msFirstEvent: number | null;  // ms from turn start to the first event sent to the browser
  msFirstText: number | null;   // ms from turn start to the first `text` event
  msTotal: number | null;       // ms from turn start to just before `done`
  stopReason: StopReason | null;
  status: "pending" | "complete" | "failed";
}

export interface Ledger {
  insertPending(t: Pick<TurnRow, "conversationId" | "createdAtUtc" | "timeZone" |
    "localDate" | "question" | "path" | "recalledIds" | "model" | "routeReason">): number;
  complete(id: number, r: Pick<TurnRow, "answer" | "sources" | "searchCount" |
    "msFirstEvent" | "msFirstText" | "msTotal" | "stopReason">): void;
  fail(id: number, r: Pick<TurnRow, "answer" | "searchCount" | "msTotal" | "stopReason">): void;
  byDateRange(from: string, to: string): TurnRow[];  // complete only; newest created_at_utc first, ties by id descending
  recent(n: number): TurnRow[];                       // complete only; newest first
  inConversation(conversationId: string, n: number): TurnRow[]; // complete only; last n, oldest first
  earliestDate(): string | null;                      // complete only
  groupedByDate(): { localDate: string; turns: TurnRow[] }[]; // all statuses; newest date first, newest turn first
  clear(): void;
  close(): void;
}

export type RecallResult =
  | { kind: "hit"; turns: TurnRow[]; omitted: number; askedFor: DateRange | null; topicWords: string[] }
  | { kind: "near"; turns: TurnRow[]; askedFor: DateRange; used: DateRange; topicWords: string[] }
  | { kind: "miss"; askedFor: DateRange | null; earliest: string | null; topicWords: string[] };

export type Route =
  | { kind: "model"; role: "default" | "compare"; model: string;
      effort: string | null; thinking: Record<string, unknown> | null;
      maxTokens: number; maxSearches: number; reason: "ordinary" | "compare" | "no_record" }
  | { kind: "direct"; reason: "no_record_direct" };

export interface ChatMessage { role: "user" | "assistant"; content: string }

export interface AnswerOutcome {
  // ok is true for stop reasons end_turn, direct, pause_limit, max_tokens and refusal,
  // and false only for error and aborted. streamAnswer sets it; handleTurn saves the
  // row as complete when true and failed when false, and never reinterprets it.
  ok: boolean;
  text: string; sources: Source[]; searchCount: number;
  stopReason: StopReason;
  msFirstText: number | null;   // ms from args.startedAt to the first `text` event
}

export type Emit = (event: AgentEvent) => void;

// The subset of the SDK client that claude.ts uses. Tests pass a fake with this shape.
export interface StreamHandle extends AsyncIterable<unknown> {   // yields raw SDK stream events
  finalMessage(): Promise<{ content: unknown[]; stop_reason: string | null }>;
}
export interface StreamClient {
  messages: { stream(params: unknown, options: { signal: AbortSignal }): StreamHandle };
}

export interface StreamArgs {
  apiKey: string | null;
  route: Extract<Route, { kind: "model" }>;
  system: string;
  messages: ChatMessage[];
  pauseTurnLimit: number;
  startedAt: number;        // performance.now() at the start of the turn
  signal: AbortSignal;
}
export type StreamAnswer = (args: StreamArgs, emit: Emit) => Promise<AnswerOutcome>;

export interface TurnRequest {
  message: string; conversationId: string; timeZone: string; signal: AbortSignal;
}
export interface TurnDeps { clock: Clock; ledger: Ledger; config: Config; streamAnswer: StreamAnswer }
export type HandleTurn = (request: TurnRequest, emit: Emit) => Promise<void>; // handleTurn bound to its deps
