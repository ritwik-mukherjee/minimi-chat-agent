import type { AgentEvent } from "../src/events.ts";
import type { AnswerOutcome, StreamAnswer, StreamArgs, TurnRow } from "../src/types.ts";

export const FIXED_NOW = "2026-11-10T12:00:00Z"; // a Tuesday
export const TEST_ZONE = "Europe/London";

export interface StreamScript {
  events?: AgentEvent[];               // emitted in order
  outcome?: Partial<AnswerOutcome>;    // overrides the default outcome
}

export interface FakeStreamAnswer extends StreamAnswer {
  calls: StreamArgs[];                 // the arguments of every call, in order
}

// A StreamAnswer that emits scripted events, returns a scripted outcome and records its calls.
export function fakeStreamAnswer(script: StreamScript = {}): FakeStreamAnswer {
  const calls: StreamArgs[] = [];
  const fake: StreamAnswer = async (args, emit) => {
    calls.push(args);
    let text = "";
    let msFirstText: number | null = null;
    for (const event of script.events ?? []) {
      emit(event);
      if (event.type === "text") {
        if (msFirstText === null) msFirstText = performance.now() - args.startedAt;
        text += event.delta;
      }
    }
    return {
      ok: true, text, sources: [], searchCount: 0, stopReason: "end_turn", msFirstText,
      ...script.outcome,
    };
  };
  return Object.assign(fake, { calls });
}

let nextId = 1;

// A completed TurnRow. Pass localDate to put it on a given day; createdAtUtc follows it unless given.
export function savedTurn(overrides: Partial<TurnRow> = {}): TurnRow {
  const localDate = overrides.localDate ?? "2026-11-03";
  return {
    id: nextId++,
    conversationId: "conversation-1",
    createdAtUtc: `${localDate}T12:00:00.000Z`,
    timeZone: TEST_ZONE,
    localDate,
    question: "What is the question?",
    answer: "This is the answer.",
    sources: [],
    path: "ordinary",
    recalledIds: [],
    model: "claude-sonnet-5-5",
    routeReason: "ordinary",
    searchCount: 0,
    msFirstEvent: 10,
    msFirstText: 20,
    msTotal: 30,
    stopReason: "end_turn",
    status: "complete",
    ...overrides,
  };
}
