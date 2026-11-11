import type { Clock } from "./types.ts";

// The only place that reads the wall clock. Everything else gets a Clock.
export function systemClock(): Clock {
  return { now: () => new Date() };
}

export function fixedClock(iso: string): Clock {
  const fixed = new Date(iso);
  if (Number.isNaN(fixed.getTime())) throw new Error(`Invalid ISO date: ${iso}`);
  return { now: () => new Date(fixed.getTime()) };
}

export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

// The calendar date of an instant in a time zone, as YYYY-MM-DD.
export function localDate(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(instant);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

// A local date is treated as a UTC midnight, so weekday and day arithmetic ignore time zones.
function toUtc(date: string): Date {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

export function addDays(date: string, days: number): string {
  const moved = toUtc(date);
  moved.setUTCDate(moved.getUTCDate() + days);
  return moved.toISOString().slice(0, 10);
}

// 0 is Sunday, 1 is Monday, and so on.
export function weekdayIndex(date: string): number {
  return toUtc(date).getUTCDay();
}

function longName(date: string, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat("en-GB", { ...options, timeZone: "UTC" }).format(toUtc(date));
}

function dayAndMonth(date: string): string {
  const weekday = longName(date, { weekday: "long" });
  const day = longName(date, { day: "numeric" });
  const month = longName(date, { month: "long" });
  return `${weekday} ${day} ${month}`;
}

// "Tuesday 3 November", with the year added when it differs from today's.
export function dayLabel(date: string, todayLocal: string): string {
  const year = date.slice(0, 4);
  return year === todayLocal.slice(0, 4) ? dayAndMonth(date) : `${dayAndMonth(date)} ${year}`;
}

// "Tuesday 3 November 2026", always with the year, for the data blocks in prompts.
export function fullDayLabel(date: string): string {
  return `${dayAndMonth(date)} ${date.slice(0, 4)}`;
}
