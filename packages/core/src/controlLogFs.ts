// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Node-only, fs-backed control-log I/O. Imported via `@inplan/core/node`
// (never from the browser-safe package root).

import { appendFileSync, closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
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
 * Incremental read: parse only the bytes appended after `byteOffset` (the log is
 * append-only, so this is O(new) instead of re-reading the whole file each poll).
 * Returns the newly-parsed entries and the advanced byte offset (stopped at the
 * last complete line, so a half-written final line is left for the next read).
 * `reset: true` means the file shrank/was replaced (truncation, compaction) — the
 * caller should drop any cache and re-read from offset 0.
 */
export function readLogIncrement(path: string, byteOffset: number): { entries: LogEntry[]; offset: number; reset: boolean } {
  if (!existsSync(path)) return { entries: [], offset: 0, reset: byteOffset !== 0 };
  const size = statSync(path).size;
  if (size < byteOffset) return { entries: [], offset: 0, reset: true };
  if (size === byteOffset) return { entries: [], offset: byteOffset, reset: false };

  const len = size - byteOffset;
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.allocUnsafe(len);
    const got = readSync(fd, buf, 0, len, byteOffset);
    const chunk = buf.toString("utf8", 0, got);
    const lastNl = chunk.lastIndexOf("\n");
    if (lastNl === -1) return { entries: [], offset: byteOffset, reset: false }; // only a partial line so far
    const complete = chunk.slice(0, lastNl + 1);
    return { entries: parseLog(complete), offset: byteOffset + Buffer.byteLength(complete, "utf8"), reset: false };
  } finally {
    closeSync(fd);
  }
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
