import type { RouteReason } from "./types.ts";

export type ProblemCode = "missing_key" | "invalid_key" | "search_disabled" |
  "rate_limited" | "api_error" | "incomplete" | "refused";

export type AgentEvent =
  | { type: "recalled"; kind: "hit" | "near"; askedFor: string | null; used: string | null;
      turns: { id: number; label: string; question: string; answerExcerpt: string }[];
      omitted: number }
  | { type: "no_record"; askedFor: string | null; earliest: string | null }
  | { type: "routed"; model: string | null; displayName: string | null; reason: RouteReason }
  | { type: "searching"; query: string }
  | { type: "text"; delta: string }
  | { type: "sources"; sources: { url: string; title: string }[] }
  | { type: "problem"; code: ProblemCode; message: string; fix: string }
  | { type: "done"; turnId: number; model: string | null; searchCount: number;
      msFirstEvent: number | null; msFirstText: number | null; msTotal: number };

type ProblemEvent = Extract<AgentEvent, { type: "problem" }>;

// Messages and fixes, defined once. api_error is built in problem() because its text carries the status.
const PROBLEM_TEXT: Record<Exclude<ProblemCode, "api_error">, { message: string; fix: string }> = {
  missing_key: {
    message: "ANTHROPIC_API_KEY is not set.",
    fix: "Add it to .env and restart `npm run dev`.",
  },
  invalid_key: {
    message: "The Claude API rejected the key.",
    fix: "Check ANTHROPIC_API_KEY in .env.",
  },
  search_disabled: {
    message: "Web search is turned off for this key's organisation.",
    fix: "Enable web search in the Claude Console, then try again.",
  },
  rate_limited: {
    message: "The Claude API is rate-limiting this key.",
    fix: "Wait a minute and try again.",
  },
  incomplete: {
    message: "The answer stopped before it finished.",
    fix: "Ask again, or ask about fewer items.",
  },
  refused: {
    message: "The model declined to answer this.",
    fix: "",
  },
};

// Builds a problem event. `status` is only used by api_error: a number for an HTTP status, null or undefined for a network error.
export function problem(code: ProblemCode, status?: number | null): ProblemEvent {
  if (code === "api_error") {
    const detail = typeof status === "number" ? `status ${status}` : "network error";
    return { type: "problem", code, message: `The Claude API returned an error (${detail}).`, fix: "Try again." };
  }
  return { type: "problem", code, ...PROBLEM_TEXT[code] };
}

const DISPLAY_NAMES: Record<string, string> = {
  "claude-sonnet-5-5": "Sonnet 5.5",
  "claude-opus-5-5": "Opus 5.5",
};

export function displayName(modelId: string): string {
  return DISPLAY_NAMES[modelId] ?? modelId;
}

// One Server-Sent Event: a data line followed by a blank line.
export function encode(event: AgentEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}
