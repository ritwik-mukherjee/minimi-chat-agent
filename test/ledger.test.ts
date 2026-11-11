import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openLedger } from "../src/ledger.ts";
import type { Ledger } from "../src/types.ts";

const tempDirs: string[] = [];
after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minimi-ledger-"));
  tempDirs.push(dir);
  return dir;
}

interface NewTurn { conversationId?: string; createdAtUtc?: string; localDate?: string; question?: string }

function pending(ledger: Ledger, turn: NewTurn = {}): number {
  return ledger.insertPending({
    conversationId: turn.conversationId ?? "c1",
    createdAtUtc: turn.createdAtUtc ?? "2026-11-03T12:00:00.000Z",
    timeZone: "Europe/London",
    localDate: turn.localDate ?? "2026-11-03",
    question: turn.question ?? "question",
    path: "ordinary",
    recalledIds: [],
    model: "claude-sonnet-5-5",
    routeReason: "ordinary",
  });
}

function complete(ledger: Ledger, id: number, answer = "answer"): void {
  ledger.complete(id, {
    answer, sources: [{ url: "https://example.com", title: "Example", citedText: "quote" }],
    searchCount: 2, msFirstEvent: 5, msFirstText: 50, msTotal: 80, stopReason: "end_turn",
  });
}

function addComplete(ledger: Ledger, turn: NewTurn = {}, answer = "answer"): number {
  const id = pending(ledger, turn);
  complete(ledger, id, answer);
  return id;
}

test("a turn is pending, then complete", () => {
  const ledger = openLedger(":memory:");
  const id = pending(ledger);
  assert.equal(typeof id, "number");

  assert.equal(ledger.groupedByDate()[0].turns[0].status, "pending");

  complete(ledger, id, "the answer");
  const row = ledger.byDateRange("2026-11-03", "2026-11-03")[0];
  assert.equal(row.id, id);
  assert.equal(row.status, "complete");
  assert.equal(row.answer, "the answer");
  assert.deepEqual(row.sources, [{ url: "https://example.com", title: "Example", citedText: "quote" }]);
  assert.equal(row.searchCount, 2);
  assert.equal(row.msFirstEvent, 5);
  assert.equal(row.msFirstText, 50);
  assert.equal(row.msTotal, 80);
  assert.equal(row.stopReason, "end_turn");
  assert.equal(row.model, "claude-sonnet-5-5");
  assert.equal(row.routeReason, "ordinary");
  assert.equal(row.path, "ordinary");
  assert.deepEqual(row.recalledIds, []);
  assert.equal(row.timeZone, "Europe/London");
  ledger.close();
});

test("a code-written reply is saved with a null model", () => {
  const ledger = openLedger(":memory:");
  const id = ledger.insertPending({
    conversationId: "c1", createdAtUtc: "2026-11-10T12:00:00.000Z", timeZone: "UTC", localDate: "2026-11-10",
    question: "q", path: "recall_miss", recalledIds: [3, 4], model: null, routeReason: "no_record_direct",
  });
  const row = ledger.groupedByDate()[0].turns[0];
  assert.equal(row.id, id);
  assert.equal(row.model, null);
  assert.deepEqual(row.recalledIds, [3, 4]);
  ledger.close();
});

test("pending and failed rows are left out of every recall query but shown in groupedByDate", () => {
  const ledger = openLedger(":memory:");
  const done = addComplete(ledger, { question: "done" });
  const stuck = pending(ledger, { question: "stuck" });
  const failed = pending(ledger, { question: "failed" });
  ledger.fail(failed, { answer: "partial", searchCount: 1, msTotal: 40, stopReason: "error" });

  assert.deepEqual(ledger.byDateRange("2026-11-03", "2026-11-03").map((t) => t.id), [done]);
  assert.deepEqual(ledger.recent(10).map((t) => t.id), [done]);
  assert.deepEqual(ledger.inConversation("c1", 10).map((t) => t.id), [done]);
  assert.equal(ledger.earliestDate(), "2026-11-03");

  const grouped = ledger.groupedByDate();
  assert.equal(grouped.length, 1);
  assert.deepEqual(grouped[0].turns.map((t) => t.id).sort(), [done, stuck, failed].sort());
  const failedRow = grouped[0].turns.find((t) => t.id === failed);
  assert.equal(failedRow?.status, "failed");
  assert.equal(failedRow?.answer, "partial");
  assert.equal(failedRow?.stopReason, "error");
  ledger.close();
});

test("earliestDate ignores pending rows and is null when empty", () => {
  const ledger = openLedger(":memory:");
  assert.equal(ledger.earliestDate(), null);
  pending(ledger, { localDate: "2026-11-01" });
  assert.equal(ledger.earliestDate(), null);
  addComplete(ledger, { localDate: "2026-11-05" });
  addComplete(ledger, { localDate: "2026-11-04" });
  assert.equal(ledger.earliestDate(), "2026-11-04");
  ledger.close();
});

test("byDateRange orders newest first, ties by id descending, and respects the range", () => {
  const ledger = openLedger(":memory:");
  const early = addComplete(ledger, { createdAtUtc: "2026-11-03T08:00:00.000Z" });
  const late = addComplete(ledger, { createdAtUtc: "2026-11-03T18:00:00.000Z" });
  const tieA = addComplete(ledger, { createdAtUtc: "2026-11-03T10:00:00.000Z" });
  const tieB = addComplete(ledger, { createdAtUtc: "2026-11-03T10:00:00.000Z" });
  const nextDay = addComplete(ledger, { localDate: "2026-11-04", createdAtUtc: "2026-11-04T09:00:00.000Z" });
  addComplete(ledger, { localDate: "2026-11-06", createdAtUtc: "2026-11-06T09:00:00.000Z" });

  assert.deepEqual(ledger.byDateRange("2026-11-03", "2026-11-03").map((t) => t.id), [late, tieB, tieA, early]);
  assert.deepEqual(
    ledger.byDateRange("2026-11-03", "2026-11-05").map((t) => t.id),
    [nextDay, late, tieB, tieA, early],
  );
  ledger.close();
});

test("recent returns the newest first and honours the limit", () => {
  const ledger = openLedger(":memory:");
  addComplete(ledger, { localDate: "2026-11-01", createdAtUtc: "2026-11-01T12:00:00.000Z" });
  const second = addComplete(ledger, { localDate: "2026-11-02", createdAtUtc: "2026-11-02T12:00:00.000Z" });
  const third = addComplete(ledger, { localDate: "2026-11-03", createdAtUtc: "2026-11-03T12:00:00.000Z" });
  assert.deepEqual(ledger.recent(2).map((t) => t.id), [third, second]);
  ledger.close();
});

test("inConversation returns the last n of one conversation, oldest first", () => {
  const ledger = openLedger(":memory:");
  const a1 = addComplete(ledger, { conversationId: "a", question: "a1" });
  addComplete(ledger, { conversationId: "b", question: "b1" });
  const a2 = addComplete(ledger, { conversationId: "a", question: "a2" });
  const a3 = addComplete(ledger, { conversationId: "a", question: "a3" });

  assert.deepEqual(ledger.inConversation("a", 10).map((t) => t.id), [a1, a2, a3]);
  assert.deepEqual(ledger.inConversation("a", 2).map((t) => t.id), [a2, a3]);
  assert.deepEqual(ledger.inConversation("nobody", 10), []);
  ledger.close();
});

test("groupedByDate lists the newest date first and the newest turn first", () => {
  const ledger = openLedger(":memory:");
  const oldTurn = addComplete(ledger, { localDate: "2026-11-03", createdAtUtc: "2026-11-03T09:00:00.000Z" });
  const morning = addComplete(ledger, { localDate: "2026-11-10", createdAtUtc: "2026-11-10T09:00:00.000Z" });
  const evening = addComplete(ledger, { localDate: "2026-11-10", createdAtUtc: "2026-11-10T19:00:00.000Z" });

  const grouped = ledger.groupedByDate();
  assert.deepEqual(grouped.map((day) => day.localDate), ["2026-11-10", "2026-11-03"]);
  assert.deepEqual(grouped[0].turns.map((t) => t.id), [evening, morning]);
  assert.deepEqual(grouped[1].turns.map((t) => t.id), [oldTurn]);
  ledger.close();
});

test("a pending row read through groupedByDate has an empty answer, no sources and 0 searches", () => {
  const ledger = openLedger(":memory:");
  pending(ledger);
  const row = ledger.groupedByDate()[0].turns[0];
  assert.equal(row.answer, "");
  assert.deepEqual(row.sources, []);
  assert.equal(row.searchCount, 0);
  assert.equal(row.msTotal, null);
  assert.equal(row.stopReason, null);
  ledger.close();
});

test("clear empties the ledger", () => {
  const ledger = openLedger(":memory:");
  addComplete(ledger);
  pending(ledger);
  ledger.clear();
  assert.deepEqual(ledger.groupedByDate(), []);
  assert.deepEqual(ledger.recent(10), []);
  assert.equal(ledger.earliestDate(), null);
  ledger.close();
});

test("data survives closing and reopening a file", () => {
  const file = path.join(tempDir(), "nested", "turns.db");
  const first = openLedger(file); // also creates the nested folder
  const id = addComplete(first, { question: "kept?" }, "yes");
  first.close();

  const second = openLedger(file);
  const row = second.byDateRange("2026-11-03", "2026-11-03")[0];
  assert.equal(row.id, id);
  assert.equal(row.question, "kept?");
  assert.equal(row.answer, "yes");
  second.close();

  const check = new DatabaseSync(file);
  assert.equal((check.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 1);
  check.close();
});

test("a file with user_version 2 throws, and its version is still 2 afterwards", () => {
  const file = path.join(tempDir(), "future.db");
  const other = new DatabaseSync(file);
  other.exec("PRAGMA user_version = 2");
  other.close();

  assert.throws(() => openLedger(file), (error: Error) => error.message.includes(file));

  const check = new DatabaseSync(file);
  assert.equal((check.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 2);
  const tables = check.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
  assert.equal(tables.length, 0); // nothing was created in someone else's file
  check.close();
});

test("an unversioned file that already has a turns table is not touched", () => {
  const file = path.join(tempDir(), "foreign.db");
  const other = new DatabaseSync(file);
  other.exec("CREATE TABLE turns (x TEXT)");
  other.close();

  assert.throws(() => openLedger(file), (error: Error) => error.message.includes(file));
});
