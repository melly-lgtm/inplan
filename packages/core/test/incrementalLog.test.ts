// SPDX-License-Identifier: AGPL-3.0-or-later

import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendLog, FsControlChannel, LogEventType, readLogIncrement } from "../src/node";

let dir: string;
let logPath: string;
const line = (seq: number) => JSON.stringify({ seq, ts: "t", actor: "user", type: "turn_ended" }) + "\n";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "inplan-inc-"));
  logPath = join(dir, "log.jsonl");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("readLogIncrement", () => {
  it("reads only the bytes appended since the last offset", () => {
    writeFileSync(logPath, line(1) + line(2));
    const a = readLogIncrement(logPath, 0);
    expect(a.entries.map((e) => e.seq)).toEqual([1, 2]);
    expect(a.reset).toBe(false);

    appendFileSync(logPath, line(3));
    const b = readLogIncrement(logPath, a.offset);
    expect(b.entries.map((e) => e.seq)).toEqual([3]); // only the new line
    expect(b.offset).toBe(a.offset + Buffer.byteLength(line(3)));

    // No growth → nothing new.
    expect(readLogIncrement(logPath, b.offset).entries).toEqual([]);
  });

  it("leaves a half-written final line for the next read", () => {
    writeFileSync(logPath, line(1) + '{"seq":2,"ts":"t","actor":"user"'); // line 2 not terminated
    const a = readLogIncrement(logPath, 0);
    expect(a.entries.map((e) => e.seq)).toEqual([1]); // partial line 2 not yet parsed
    appendFileSync(logPath, ',"type":"turn_ended"}\n'); // complete it
    const b = readLogIncrement(logPath, a.offset);
    expect(b.entries.map((e) => e.seq)).toEqual([2]);
  });

  it("signals reset when the file shrinks (truncation / replacement)", () => {
    writeFileSync(logPath, line(1) + line(2) + line(3));
    const a = readLogIncrement(logPath, 0);
    writeFileSync(logPath, line(1)); // replaced with a shorter file
    const b = readLogIncrement(logPath, a.offset);
    expect(b.reset).toBe(true);
  });
});

describe("FsControlChannel incremental reads", () => {
  it("sees appends made by another writer (re-stats to current size each call)", async () => {
    const ch = new FsControlChannel({ logPath, cursorPath: join(dir, "cursor"), waitLockPath: join(dir, "lock") });
    await ch.append({ actor: "user", type: LogEventType.TurnEnded });
    expect((await ch.readSince(0)).entries.map((e) => e.seq)).toEqual([1]);

    // Simulate the editor (a different process) appending directly to the log.
    appendLog(logPath, { actor: "agent", type: LogEventType.AgentRevised });
    const r = await ch.readSince(1);
    expect(r.entries.map((e) => e.seq)).toEqual([2]);
    expect(r.cursor).toBe(2);
  });

  it("recovers if the log is replaced under it (reset + reparse)", async () => {
    const ch = new FsControlChannel({ logPath, cursorPath: join(dir, "cursor"), waitLockPath: join(dir, "lock") });
    await ch.append({ actor: "user", type: LogEventType.TurnEnded });
    await ch.append({ actor: "user", type: LogEventType.TurnEnded });
    await ch.readSince(0); // advance internal offset
    writeFileSync(logPath, line(1)); // shorter replacement
    const r = await ch.readSince(0);
    expect(r.entries.map((e) => e.seq)).toEqual([1]);
  });
});
