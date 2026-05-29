// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendLog, LogEventType, parseLog, readLog, readLogSince, serializeLogEntry } from "../src/node";

let dir: string;
let logPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ap-log-"));
  logPath = join(dir, "doc.log.jsonl");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("control log", () => {
  it("assigns increasing seq numbers and persists entries", () => {
    const a = appendLog(logPath, { actor: "agent", type: LogEventType.EditorPid, payload: { pid: 123 } });
    const b = appendLog(logPath, { actor: "user", type: LogEventType.CommentCreated, payload: { id: "cmt-abc123" } });
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);

    const all = readLog(logPath);
    expect(all).toHaveLength(2);
    expect(all[1]!.type).toBe(LogEventType.CommentCreated);
    expect(all[0]!.ts).toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it("reads only entries past the cursor and reports the new cursor", () => {
    appendLog(logPath, { actor: "user", type: LogEventType.CommentCreated });
    appendLog(logPath, { actor: "user", type: LogEventType.TurnEnded });
    const since = readLogSince(logPath, 1);
    expect(since.entries.map((e) => e.seq)).toEqual([2]);
    expect(since.cursor).toBe(2);
  });

  it("returns empty for a missing log file", () => {
    expect(readLog(join(dir, "nope.jsonl"))).toEqual([]);
    expect(readLogSince(join(dir, "nope.jsonl"), 0)).toEqual({ entries: [], cursor: 0 });
  });

  it("serializes and parses round-trip", () => {
    const entry = { seq: 7, ts: "2026-05-29T00:00:00Z", actor: "agent" as const, type: "x", payload: { a: 1 } };
    expect(parseLog(serializeLogEntry(entry))).toEqual([entry]);
  });
});
