import type {
  AnswerOutcome, Emit, RecallResult, TurnDeps, TurnPath, TurnRequest,
} from "./types.ts";
import type { AgentEvent } from "./events.ts";
import { dayLabel, isValidTimeZone, localDate } from "./clock.ts";
import { displayName } from "./events.ts";
import { parsePastReferences } from "./dates.ts";
import { recall } from "./recall.ts";
import { route } from "./router.ts";
import { buildMessages, directNoRecordReply, SYSTEM_PROMPT } from "./prompt.ts";

const EXCERPT_LENGTH = 200;

// One turn, top to bottom: understand, recall, route, answer, save.
export async function handleTurn(request: TurnRequest, deps: TurnDeps, emit: Emit): Promise<void> {
  const { clock, ledger, config, streamAnswer } = deps;

  // Start. The first event sent to the browser fixes msFirstEvent.
  const startedAt = performance.now();
  let msFirstEvent: number | null = null;
  const send: Emit = (event) => {
    if (msFirstEvent === null) msFirstEvent = performance.now() - startedAt;
    emit(event);
  };
  const timeZone = isValidTimeZone(request.timeZone) ? request.timeZone : "UTC";
  const now = clock.now();
  const today = localDate(now, timeZone);

  // 1. Understand: does the message refer to the past?
  const refs = parsePastReferences(request.message, now, timeZone);

  // 2. Recall: only when it does.
  let recalled: RecallResult | null = null;
  if (refs.range !== null || refs.cue) {
    recalled = recall(request.message, refs, ledger, config, today);
    send(recallEvent(recalled, today));
  }

  // 3. Route: from the recall result alone.
  const chosen = route(recalled, config);
  send({
    type: "routed",
    model: chosen.kind === "model" ? chosen.model : null,
    displayName: chosen.kind === "model" ? displayName(chosen.model) : null,
    reason: chosen.reason,
  });

  // The row is written before the answer, so a crash leaves a visible incomplete turn.
  const turnId = ledger.insertPending({
    conversationId: request.conversationId,
    createdAtUtc: now.toISOString(),
    timeZone,
    localDate: today,
    question: request.message,
    path: pathOf(recalled),
    recalledIds: recalled !== null && recalled.kind !== "miss" ? recalled.turns.map((turn) => turn.id) : [],
    model: chosen.kind === "model" ? chosen.model : null,
    routeReason: chosen.reason,
  });

  // 4. Answer.
  let outcome: AnswerOutcome;
  if (chosen.kind === "direct") {
    if (recalled === null || recalled.kind !== "miss") throw new Error("A direct route needs a miss.");
    const reply = directNoRecordReply(recalled, today);
    send({ type: "text", delta: reply });
    outcome = {
      ok: true, text: reply, sources: [], searchCount: 0,
      stopReason: "direct", msFirstText: performance.now() - startedAt,
    };
  } else {
    const history = ledger.inConversation(request.conversationId, config.historyTurns);
    const messages = buildMessages({ today, timeZone, history, recall: recalled, message: request.message });
    outcome = await streamAnswer({
      apiKey: config.apiKey,
      route: chosen,
      system: SYSTEM_PROMPT,
      messages,
      pauseTurnLimit: config.pauseTurnLimit,
      startedAt,
      signal: request.signal,
    }, send);
  }

  // 5. Save. `ok` is decided by streamAnswer and is not reinterpreted here.
  const msTotal = Math.round(performance.now() - startedAt);
  if (outcome.ok) {
    ledger.complete(turnId, {
      answer: outcome.text, sources: outcome.sources, searchCount: outcome.searchCount,
      msFirstEvent: roundOrNull(msFirstEvent), msFirstText: roundOrNull(outcome.msFirstText),
      msTotal, stopReason: outcome.stopReason,
    });
  } else {
    ledger.fail(turnId, {
      answer: outcome.text, searchCount: outcome.searchCount, msTotal, stopReason: outcome.stopReason,
    });
  }

  // Finish: nobody is listening after a disconnect.
  if (!request.signal.aborted) {
    send({
      type: "done", turnId, model: chosen.kind === "model" ? chosen.model : null,
      searchCount: outcome.searchCount, msFirstEvent: roundOrNull(msFirstEvent),
      msFirstText: roundOrNull(outcome.msFirstText), msTotal,
    });
  }
}

function roundOrNull(ms: number | null): number | null {
  return ms === null ? null : Math.round(ms);
}

function pathOf(recalled: RecallResult | null): TurnPath {
  if (recalled === null) return "ordinary";
  if (recalled.kind === "hit") return "recall_hit";
  return recalled.kind === "near" ? "recall_near" : "recall_miss";
}

// The event the browser shows before any model call starts.
function recallEvent(result: RecallResult, today: string): AgentEvent {
  if (result.kind === "miss") {
    return {
      type: "no_record",
      askedFor: result.askedFor?.label ?? null,
      earliest: result.earliest === null ? null : dayLabel(result.earliest, today),
    };
  }
  return {
    type: "recalled",
    kind: result.kind,
    askedFor: result.askedFor?.label ?? null,
    used: result.kind === "near" ? result.used.label : (result.askedFor?.label ?? null),
    turns: result.turns.map((turn) => ({
      id: turn.id,
      label: dayLabel(turn.localDate, today),
      question: turn.question,
      answerExcerpt: turn.answer.slice(0, EXCERPT_LENGTH),
    })),
    omitted: result.kind === "hit" ? result.omitted : 0,
  };
}
