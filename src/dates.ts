import type { DateRange, PastRefs } from "./types.ts";
import { addDays, dayLabel, localDate, weekdayIndex } from "./clock.ts";

// Past-tense cues that point at an earlier conversation without naming a date.
const CUES = [
  "I asked", "did I ask", "I told you", "you said", "you told me", "you answered",
  "you recommended", "you suggested", "we discussed", "we talked", "we shortlisted",
  "we looked at", "last time",
];

const WEEKDAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

const MONTH_NUMBERS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
  august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

const WEEKDAY_PATTERN = WEEKDAY_NAMES.join("|");
const MONTH_PATTERN = Object.keys(MONTH_NUMBERS).sort((a, b) => b.length - a.length).join("|");
const NUMBER_WORD_PATTERN = Object.keys(NUMBER_WORDS).join("|");

// Phrase patterns, one per row of the rules table in the design doc.
const TODAY_RE = /\b(?:earlier today|this morning|this afternoon)\b/gi;
const YESTERDAY_RE = /\byesterday\b/gi;
const WEEKDAY_RE = new RegExp(`\\b(?:on|last)\\s+(${WEEKDAY_PATTERN})\\b`, "gi");
const DAY_MONTH_RE = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_PATTERN})\\b\\.?(?:,?\\s+(\\d{4})\\b)?`, "gi");
const MONTH_DAY_RE = new RegExp(`\\b(${MONTH_PATTERN})\\b\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4})\\b)?`, "gi");
const ISO_DATE_RE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
const LAST_WEEK_RE = /\blast week\b/gi;
const DAYS_AGO_RE = new RegExp(`\\b(?:(\\d{1,2})|(${NUMBER_WORD_PATTERN}))\\s+days?\\s+ago\\b`, "gi");
const COUPLE_OF_DAYS_RE = /\ba couple of days ago\b/gi;
const WEEK_AGO_RE = /\ba week ago\b/gi;

const CUE_PATTERNS = CUES.map((cue) => new RegExp(`\\b${cue.replace(/ /g, "\\s+")}\\b`, "i"));

interface Candidate { index: number; range: DateRange }

// True when year, month and day make a real calendar date (rejects 31 November).
function isRealDate(year: number, month: number, day: number): boolean {
  const check = new Date(Date.UTC(year, month - 1, day));
  return check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day;
}

function toIso(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function singleDay(date: string, label: string, matchedText: string): DateRange {
  return { from: date, to: date, label, matchedText };
}

// A day and month with an optional year. Without a year it is the most recent such date not after today.
function explicitDate(
  year: number | null, month: number, day: number, today: string, matchedText: string,
): DateRange | null {
  let resolvedYear = year ?? Number(today.slice(0, 4));
  if (!isRealDate(resolvedYear, month, day)) return null;
  let date = toIso(resolvedYear, month, day);
  if (year === null && date > today) {
    resolvedYear -= 1;
    if (!isRealDate(resolvedYear, month, day)) return null;
    date = toIso(resolvedYear, month, day);
  }
  if (date > today) return null; // dates after today are not parsed
  return singleDay(date, dayLabel(date, today), matchedText);
}

// Finds the first match of `pattern` for which `build` gives a range.
function findFirst(
  text: string, pattern: RegExp, build: (match: RegExpMatchArray) => DateRange | null,
): Candidate | null {
  for (const match of text.matchAll(pattern)) {
    const range = build(match);
    if (range) return { index: match.index ?? 0, range };
  }
  return null;
}

function daysAgo(days: number, today: string, matchedText: string): DateRange {
  const date = addDays(today, -days);
  return singleDay(date, dayLabel(date, today), matchedText);
}

function findCandidates(text: string, today: string): Candidate[] {
  const found: (Candidate | null)[] = [
    findFirst(text, TODAY_RE, (m) =>
      singleDay(today, `today, ${dayLabel(today, today)}`, m[0])),

    findFirst(text, YESTERDAY_RE, (m) => {
      const date = addDays(today, -1);
      return singleDay(date, `yesterday, ${dayLabel(date, today)}`, m[0]);
    }),

    // "on Monday" or "last Monday": the most recent such weekday strictly before today.
    findFirst(text, WEEKDAY_RE, (m) => {
      const target = WEEKDAY_NAMES.indexOf(m[1].toLowerCase());
      let back = (weekdayIndex(today) - target + 7) % 7;
      if (back === 0) back = 7;
      return daysAgo(back, today, m[0]);
    }),

    findFirst(text, DAY_MONTH_RE, (m) =>
      explicitDate(m[3] ? Number(m[3]) : null, MONTH_NUMBERS[m[2].toLowerCase()], Number(m[1]), today, m[0])),

    findFirst(text, MONTH_DAY_RE, (m) =>
      explicitDate(m[3] ? Number(m[3]) : null, MONTH_NUMBERS[m[1].toLowerCase()], Number(m[2]), today, m[0])),

    findFirst(text, ISO_DATE_RE, (m) =>
      explicitDate(Number(m[1]), Number(m[2]), Number(m[3]), today, m[0])),

    // The previous calendar week, Monday to Sunday.
    findFirst(text, LAST_WEEK_RE, (m) => {
      const sinceMonday = (weekdayIndex(today) + 6) % 7;
      const from = addDays(today, -sinceMonday - 7);
      return { from, to: addDays(from, 6), label: `the week of ${dayLabel(from, today)}`, matchedText: m[0] };
    }),

    findFirst(text, DAYS_AGO_RE, (m) => {
      const days = m[1] ? Number(m[1]) : NUMBER_WORDS[m[2].toLowerCase()];
      return days >= 1 && days <= 30 ? daysAgo(days, today, m[0]) : null;
    }),

    findFirst(text, COUPLE_OF_DAYS_RE, (m) => daysAgo(2, today, m[0])),
    findFirst(text, WEEK_AGO_RE, (m) => daysAgo(7, today, m[0])),
  ];
  return found.filter((candidate) => candidate !== null);
}

// Finds at most one date range (the first phrase in the message wins) and any past-tense cues.
export function parsePastReferences(text: string, now: Date, timeZone: string): PastRefs {
  const today = localDate(now, timeZone);
  const candidates = findCandidates(text, today).sort((a, b) => a.index - b.index);
  const matched = candidates.map((candidate) => candidate.range.matchedText);

  let cue = false;
  for (const pattern of CUE_PATTERNS) {
    const match = pattern.exec(text);
    if (match) {
      cue = true;
      matched.push(match[0]);
    }
  }

  return { range: candidates[0]?.range ?? null, cue, matched };
}
