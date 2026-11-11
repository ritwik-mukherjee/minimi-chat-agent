import type { Config, DateRange, Ledger, PastRefs, RecallResult, TurnRow } from "./types.ts";
import { addDays, dayLabel } from "./clock.ts";

const COMMON_WORDS = new Set([
  "the", "and", "but", "for", "nor", "yet", "not", "are", "was", "were", "been", "being",
  "has", "have", "had", "does", "did", "doing", "done", "can", "could", "will", "would",
  "shall", "should", "may", "might", "must", "this", "that", "these", "those", "there",
  "here", "what", "which", "who", "whom", "whose", "when", "where", "why", "how", "any",
  "all", "some", "each", "every", "both", "few", "more", "most", "other", "such", "only",
  "own", "same", "than", "too", "very", "just", "also", "into", "onto", "from", "with",
  "without", "about", "above", "below", "over", "under", "after", "between", "through",
  "during", "until", "upon", "off", "out", "our", "ours", "your", "yours", "you", "his",
  "her", "hers", "him", "she", "they", "them", "their", "theirs", "its", "mine", "myself",
  "yourself", "ourselves", "themselves", "itself", "let", "get", "got", "please", "thanks",
  "thank", "hey", "hello", "okay", "something", "anything", "everything", "nothing",
  "thing", "things",
]);

// Words about the conversation itself, not its subject.
const CONVERSATION_WORDS = new Set([
  "ask", "asked", "say", "said", "tell", "told", "question", "answer", "answered",
  "discuss", "discussed", "talk", "talked", "correct", "right", "wrong", "true", "still",
  "change", "changed", "since", "today", "now", "earlier", "before", "then", "again",
]);

const DAY_AND_MONTH_NAMES = new Set([
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "mon", "tue", "wed", "thu", "fri", "sat", "sun",
  "january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
]);

const MIN_WORD_LENGTH = 3;

// Splits text into lower-case words. Used for the message and for saved turns.
function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word !== "");
}

// The subject words of a message: what is left after the date phrase, cue words,
// common words and words about the conversation are removed.
export function topicWords(message: string, refs: PastRefs): string[] {
  let text = message.toLowerCase().replace(/[‘’]/g, "'");
  for (const phrase of refs.matched) {
    text = text.split(phrase.toLowerCase()).join(" ");
  }
  text = text.replace(/'s\b/g, "");

  const kept: string[] = [];
  for (const token of text.split(/[^a-z0-9]+/)) {
    if (token.length < MIN_WORD_LENGTH || /\d/.test(token)) continue;
    if (DAY_AND_MONTH_NAMES.has(token)) continue;
    if (COMMON_WORDS.has(token) || CONVERSATION_WORDS.has(token)) continue;
    if (!kept.includes(token)) kept.push(token);
  }
  return kept;
}

// How many distinct topic words appear, as whole words, in the turn's question or answer.
function sharedCount(turn: TurnRow, topic: string[]): number {
  const present = new Set([...words(turn.question), ...words(turn.answer)]);
  return topic.filter((word) => present.has(word)).length;
}

// Most shared topic words first. The sort is stable, so ties keep the ledger's newest-first order.
function rank(turns: TurnRow[], topic: string[]): TurnRow[] {
  return turns
    .map((turn) => ({ turn, shared: sharedCount(turn, topic) }))
    .sort((a, b) => b.shared - a.shared)
    .map((entry) => entry.turn);
}

function daysBetween(earlier: string, later: string): number {
  return (Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / 86_400_000;
}

// How far a day is from a range: 0 inside it.
function distanceFrom(range: DateRange, day: string): number {
  if (day < range.from) return daysBetween(day, range.from);
  if (day > range.to) return daysBetween(range.to, day);
  return 0;
}

// The date selects turns; topic words only rank them. A turn found by date is never dropped.
export function recall(
  message: string, refs: PastRefs, ledger: Ledger, config: Config, todayLocal: string,
): RecallResult {
  const topic = topicWords(message, refs);

  if (refs.range !== null) {
    const range = refs.range;

    // 1. Date.
    const onTheDay = ledger.byDateRange(range.from, range.to);
    if (onTheDay.length > 0) {
      const ranked = rank(onTheDay, topic);
      return {
        kind: "hit",
        turns: ranked.slice(0, config.recallCap),
        omitted: Math.max(0, ranked.length - config.recallCap),
        askedFor: range,
        topicWords: topic,
      };
    }

    // 2. Near miss: only when the range is empty and the message has a subject.
    if (topic.length > 0) {
      const near = nearMiss(range, topic, ledger, config, todayLocal);
      if (near !== null) return near;
    }
  } else if (refs.cue) {
    // 3. No date: a cue only.
    const undated = undatedHit(topic, ledger, config);
    if (undated !== null) return undated;
  }

  // 4. Miss.
  return { kind: "miss", askedFor: refs.range, earliest: ledger.earliestDate(), topicWords: topic };
}

function nearMiss(
  range: DateRange, topic: string[], ledger: Ledger, config: Config, todayLocal: string,
): RecallResult | null {
  const around = ledger.byDateRange(
    addDays(range.from, -config.nearMissDays), addDays(range.to, config.nearMissDays),
  );
  const sharing = around.filter((turn) => sharedCount(turn, topic) > 0);
  if (sharing.length === 0) return null;

  // The nearest day wins; on equal distance the later day wins.
  let bestDay = sharing[0].localDate;
  for (const turn of sharing) {
    const closer = distanceFrom(range, turn.localDate) < distanceFrom(range, bestDay);
    const tieLater = distanceFrom(range, turn.localDate) === distanceFrom(range, bestDay) && turn.localDate > bestDay;
    if (closer || tieLater) bestDay = turn.localDate;
  }

  const onThatDay = rank(sharing.filter((turn) => turn.localDate === bestDay), topic);
  const used: DateRange = {
    from: bestDay, to: bestDay, label: dayLabel(bestDay, todayLocal), matchedText: "",
  };
  return {
    kind: "near", turns: onThatDay.slice(0, config.recallCap), askedFor: range, used, topicWords: topic,
  };
}

function undatedHit(topic: string[], ledger: Ledger, config: Config): RecallResult | null {
  if (topic.length === 0) {
    const latest = ledger.recent(config.recallCap);
    if (latest.length === 0) return null;
    return { kind: "hit", turns: latest, omitted: 0, askedFor: null, topicWords: topic };
  }

  const sharing = ledger.recent(config.undatedWindow).filter((turn) => sharedCount(turn, topic) > 0);
  if (sharing.length === 0) return null;
  const ranked = rank(sharing, topic);
  return {
    kind: "hit",
    turns: ranked.slice(0, config.recallCap),
    omitted: Math.max(0, ranked.length - config.recallCap),
    askedFor: null,
    topicWords: topic,
  };
}
