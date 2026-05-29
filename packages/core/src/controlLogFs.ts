// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Node-only, fs-backed control-log I/O. Imported via `@agent-planner/core/node`
// (never from the browser-safe package root).

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { parseLog, serializeLogEntry, type LogEntry, type NewLogEntry } from "./controlLog";

/** Read all entries from a control-log file (empty if it does not exist). */
export function readLog(path: string): LogEntry[] {
  if (!existsSync(path)) return [];
  return parseLog(readFileSync(path, "utf8"));
}

/** Entries with `seq` greater than `cursor`, plus the new cursor (last seq). */
export function readLogSince(path: string, cursor: number): { entries: LogEntry[]; cursor: number } {
  const all = readLog(path);
  const entries = all.filter((e) => e.seq > cursor);
  const next = all.length ? all[all.length - 1]!.seq : cursor;
  return { entries, cursor: next };
}

/**
 * Append an entry to the control-log file, assigning the next `seq` and a
 * timestamp if absent. Returns the full entry that was written.
 */
export function appendLog(path: string, entry: NewLogEntry): LogEntry {
  const existing = readLog(path);
  const seq = existing.length ? existing[existing.length - 1]!.seq + 1 : 1;
  const full: LogEntry = {
    seq,
    ts: entry.ts ?? new Date().toISOString(),
    actor: entry.actor,
    type: entry.type,
    ...(entry.payload !== undefined ? { payload: entry.payload } : {}),
  };
  appendFileSync(path, serializeLogEntry(full) + "\n");
  return full;
}
