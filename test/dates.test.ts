import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePastReferences } from "../src/dates.ts";
import {
  addDays, dayLabel, fixedClock, fullDayLabel, isValidTimeZone, localDate, weekdayIndex,
} from "../src/clock.ts";
import { FIXED_NOW, TEST_ZONE } from "./fakes.ts";

interface Row {
  text: string;
  now?: string;
  zone?: string;
  from: string | null;   // null means no range
  to?: string;           // defaults to from
  label?: string;
  cue?: boolean;
}

const ROWS: Row[] = [
  // Today
  { text: "What did I ask you earlier today?", from: "2026-11-10", label: "today, Tuesday 10 November", cue: true },
  { text: "Something I saw this morning", from: "2026-11-10", label: "today, Tuesday 10 November" },
  { text: "That thing from this afternoon", from: "2026-11-10", label: "today, Tuesday 10 November" },
  // Yesterday
  { text: "What did I ask you yesterday?", from: "2026-11-09", label: "yesterday, Monday 9 November", cue: true },
  // Weekdays
  { text: "On Monday we shortlisted 5 CRM tools", from: "2026-11-09", label: "Monday 9 November", cue: true },
  { text: "Last Tuesday I asked you about Postgres hosting.", from: "2026-11-03", label: "Tuesday 3 November", cue: true },
  { text: "last tuesday", now: "2026-11-12T12:00:00Z", from: "2026-11-10", label: "Tuesday 10 November" },
  { text: "on Tuesday", from: "2026-11-03", label: "Tuesday 3 November" },
  // Dates
  { text: "3 November", from: "2026-11-03", label: "Tuesday 3 November" },
  { text: "3rd November", from: "2026-11-03", label: "Tuesday 3 November" },
  { text: "November 3", from: "2026-11-03", label: "Tuesday 3 November" },
  { text: "Nov 3", from: "2026-11-03", label: "Tuesday 3 November" },
  { text: "3 Nov", from: "2026-11-03", label: "Tuesday 3 November" },
  { text: "2026-11-03", from: "2026-11-03", label: "Tuesday 3 November" },
  { text: "3 November 2025", from: "2025-11-03", label: "Monday 3 November 2025" },
  { text: "November 3, 2025", from: "2025-11-03", label: "Monday 3 November 2025" },
  { text: "10 November", from: "2026-11-10", label: "Tuesday 10 November" },
  { text: "12 November", from: "2025-11-12", label: "Wednesday 12 November 2025" }, // no year: the most recent one
  { text: "25 December", from: "2025-12-25", label: "Thursday 25 December 2025" },
  { text: "3 December", now: "2027-01-10T12:00:00Z", from: "2026-12-03", label: "Thursday 3 December 2026" },
  { text: "What did I ask you on 3 November? Is your answer still correct today?", from: "2026-11-03", label: "Tuesday 3 November", cue: true },
  // Weeks and days ago
  { text: "last week", from: "2026-11-02", to: "2026-11-08", label: "the week of Monday 2 November" },
  { text: "3 days ago", from: "2026-11-07", label: "Saturday 7 November" },
  { text: "two days ago", from: "2026-11-08", label: "Sunday 8 November" },
  { text: "a couple of days ago", from: "2026-11-08", label: "Sunday 8 November" },
  { text: "a week ago", from: "2026-11-03", label: "Tuesday 3 November" },
  { text: "30 days ago", from: "2026-10-11", label: "Sunday 11 October" },
  // Not parsed, by design
  { text: "book it for Monday", from: null },
  { text: "next Monday", from: null },
  { text: "3/11", from: null },
  { text: "the other day", from: null },
  { text: "last month", from: null },
  { text: "12 November 2026", from: null },     // after today
  { text: "31 November", from: null },          // not a real date
  { text: "31 days ago", from: null },          // N is 1 to 30
  { text: "2027-01-01", from: null },           // after today
  { text: "What is the capital of France?", from: null },
  // Cues with no date
  { text: "What did I ask you before?", from: null, cue: true },
  { text: "We discussed hosting. You recommended Neon.", from: null, cue: true },
  // Two phrases: the first one wins
  { text: "Yesterday or last Tuesday, I forget", from: "2026-11-09", label: "yesterday, Monday 9 November" },
  { text: "On Monday, not 3 November", from: "2026-11-09", label: "Monday 9 November", cue: false },
  { text: "3 November, not yesterday", from: "2026-11-03", label: "Tuesday 3 November" },
  // Time zones: in Auckland it is already 11 November
  { text: "yesterday", zone: "Pacific/Auckland", from: "2026-11-10", label: "yesterday, Tuesday 10 November" },
];

for (const row of ROWS) {
  const zone = row.zone ?? TEST_ZONE;
  test(`"${row.text}" at ${row.now ?? FIXED_NOW} in ${zone}`, () => {
    const refs = parsePastReferences(row.text, new Date(row.now ?? FIXED_NOW), zone);
    if (row.from === null) {
      assert.equal(refs.range, null);
    } else {
      assert.ok(refs.range, "expected a range");
      assert.equal(refs.range.from, row.from);
      assert.equal(refs.range.to, row.to ?? row.from);
      assert.equal(refs.range.label, row.label);
    }
    assert.equal(refs.cue, row.cue ?? false);
  });
}

test("the matched text lists the date phrase and the cues", () => {
  const refs = parsePastReferences(
    "Last Tuesday I asked you about Postgres hosting.", new Date(FIXED_NOW), TEST_ZONE,
  );
  assert.deepEqual(refs.matched, ["Last Tuesday", "I asked"]);
  assert.equal(refs.range?.matchedText, "Last Tuesday");
});

test("localDate follows the time zone", () => {
  const instant = new Date(FIXED_NOW);
  assert.equal(localDate(instant, "Europe/London"), "2026-11-10");
  assert.equal(localDate(instant, "UTC"), "2026-11-10");
  assert.equal(localDate(instant, "Pacific/Auckland"), "2026-11-11");
  assert.equal(localDate(new Date("2026-11-10T23:30:00Z"), "America/Los_Angeles"), "2026-11-10");
  assert.equal(localDate(new Date("2026-11-10T03:30:00Z"), "America/Los_Angeles"), "2026-11-09");
});

test("isValidTimeZone", () => {
  assert.equal(isValidTimeZone("Europe/London"), true);
  assert.equal(isValidTimeZone("UTC"), true);
  assert.equal(isValidTimeZone("Mars/Olympus"), false);
  assert.equal(isValidTimeZone(""), false);
});

test("dayLabel adds the year only when it differs from today's", () => {
  assert.equal(dayLabel("2026-11-03", "2026-11-10"), "Tuesday 3 November");
  assert.equal(dayLabel("2025-11-03", "2026-11-10"), "Monday 3 November 2025");
});

test("fullDayLabel always has the year", () => {
  assert.equal(fullDayLabel("2026-11-03"), "Tuesday 3 November 2026");
  assert.equal(fullDayLabel("2026-11-10"), "Tuesday 10 November 2026");
});

test("addDays and weekdayIndex", () => {
  assert.equal(addDays("2026-11-10", -7), "2026-11-03");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(weekdayIndex("2026-11-10"), 2); // Tuesday
  assert.equal(weekdayIndex("2026-11-08"), 0); // Sunday
});

test("fixedClock returns its instant and rejects an invalid string", () => {
  assert.equal(fixedClock(FIXED_NOW).now().toISOString(), "2026-11-10T12:00:00.000Z");
  assert.throws(() => fixedClock("not a date"));
});
