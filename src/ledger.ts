import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import type { Ledger, Source, TurnRow } from "./types.ts";

const SCHEMA_VERSION = 1;

const CREATE_SCHEMA = `
CREATE TABLE turns (
  id              INTEGER PRIMARY KEY,
  conversation_id TEXT    NOT NULL,
  created_at_utc  TEXT    NOT NULL,
  time_zone       TEXT    NOT NULL,
  local_date      TEXT    NOT NULL,
  question        TEXT    NOT NULL,
  answer          TEXT    NOT NULL DEFAULT '',
  sources         TEXT    NOT NULL DEFAULT '[]',
  path            TEXT    NOT NULL,
  recalled_ids    TEXT    NOT NULL DEFAULT '[]',
  model           TEXT,
  route_reason    TEXT    NOT NULL,
  search_count    INTEGER NOT NULL DEFAULT 0,
  ms_first_event  INTEGER,
  ms_first_text   INTEGER,
  ms_total        INTEGER,
  stop_reason     TEXT,
  status          TEXT    NOT NULL DEFAULT 'pending'
);
CREATE INDEX turns_local_date ON turns (local_date);
`;

// A row as SQLite returns it, with snake_case column names.
type DbRow = Record<string, unknown>;

function toTurnRow(row: DbRow): TurnRow {
  return {
    id: Number(row.id),
    conversationId: row.conversation_id as string,
    createdAtUtc: row.created_at_utc as string,
    timeZone: row.time_zone as string,
    localDate: row.local_date as string,
    question: row.question as string,
    answer: row.answer as string,
    sources: JSON.parse(row.sources as string) as Source[],
    path: row.path as TurnRow["path"],
    recalledIds: JSON.parse(row.recalled_ids as string) as number[],
    model: row.model as string | null,
    routeReason: row.route_reason as TurnRow["routeReason"],
    searchCount: Number(row.search_count),
    msFirstEvent: row.ms_first_event as number | null,
    msFirstText: row.ms_first_text as number | null,
    msTotal: row.ms_total as number | null,
    stopReason: row.stop_reason as TurnRow["stopReason"],
    status: row.status as TurnRow["status"],
  };
}

// Opens or creates the turns database. This is the only module that uses node:sqlite.
export function openLedger(file: string): Ledger {
  const inMemory = file === ":memory:";
  if (!inMemory) fs.mkdirSync(path.dirname(file), { recursive: true });

  const db = new DatabaseSync(file);
  if (!inMemory) db.exec("PRAGMA journal_mode = WAL");

  // Read the version before creating anything, and never overwrite another version.
  const version = Number((db.prepare("PRAGMA user_version").get() as DbRow).user_version);
  const hasTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'turns'").get() !== undefined;
  if (version === 0 && !hasTable) {
    db.exec(CREATE_SCHEMA);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  } else if (version !== SCHEMA_VERSION) {
    db.close();
    throw new Error(
      `${file} has schema version ${version}, but this app needs version ${SCHEMA_VERSION}. Move or delete that file and start again.`,
    );
  }

  const insertPending = db.prepare(
    `INSERT INTO turns (conversation_id, created_at_utc, time_zone, local_date, question, path, recalled_ids, model, route_reason, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
  );
  const complete = db.prepare(
    `UPDATE turns SET answer = ?, sources = ?, search_count = ?, ms_first_event = ?, ms_first_text = ?,
       ms_total = ?, stop_reason = ?, status = 'complete' WHERE id = ?`,
  );
  const fail = db.prepare(
    `UPDATE turns SET answer = ?, search_count = ?, ms_total = ?, stop_reason = ?, status = 'failed' WHERE id = ?`,
  );
  const byDateRange = db.prepare(
    `SELECT * FROM turns WHERE status = 'complete' AND local_date BETWEEN ? AND ?
     ORDER BY created_at_utc DESC, id DESC`,
  );
  const recent = db.prepare(
    `SELECT * FROM turns WHERE status = 'complete' ORDER BY created_at_utc DESC, id DESC LIMIT ?`,
  );
  const inConversation = db.prepare(
    `SELECT * FROM turns WHERE status = 'complete' AND conversation_id = ? ORDER BY id DESC LIMIT ?`,
  );
  const earliestDate = db.prepare(`SELECT MIN(local_date) AS earliest FROM turns WHERE status = 'complete'`);
  const everything = db.prepare(`SELECT * FROM turns ORDER BY local_date DESC, created_at_utc DESC, id DESC`);

  return {
    insertPending(t) {
      const result = insertPending.run(
        t.conversationId, t.createdAtUtc, t.timeZone, t.localDate, t.question, t.path,
        JSON.stringify(t.recalledIds), t.model, t.routeReason,
      );
      return Number(result.lastInsertRowid); // the driver may return a bigint
    },

    complete(id, r) {
      complete.run(
        r.answer, JSON.stringify(r.sources), r.searchCount, r.msFirstEvent, r.msFirstText,
        r.msTotal, r.stopReason, id,
      );
    },

    fail(id, r) {
      fail.run(r.answer, r.searchCount, r.msTotal, r.stopReason, id);
    },

    byDateRange(from, to) {
      return byDateRange.all(from, to).map(toTurnRow);
    },

    recent(n) {
      return recent.all(n).map(toTurnRow);
    },

    inConversation(conversationId, n) {
      return inConversation.all(conversationId, n).map(toTurnRow).reverse();
    },

    earliestDate() {
      return ((earliestDate.get() as DbRow).earliest as string | null) ?? null;
    },

    groupedByDate() {
      const days: { localDate: string; turns: TurnRow[] }[] = [];
      for (const row of everything.all().map(toTurnRow)) {
        const last = days[days.length - 1];
        if (last && last.localDate === row.localDate) last.turns.push(row);
        else days.push({ localDate: row.localDate, turns: [row] });
      }
      return days;
    },

    clear() {
      db.exec("DELETE FROM turns");
    },

    close() {
      db.close();
    },
  };
}
