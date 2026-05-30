// SPDX-License-Identifier: AGPL-3.0-or-later

import { appendLog, LogEventType } from "@agent-planner/core/node";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { waitForActions } from "../src/wait";

let dir: string;
let logPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ap-wait-"));
  logPath = join(dir, "doc.log.jsonl");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("waitForActions", () => {
  it("resolves after a user action and batches surrounding entries", async () => {
    // An agent-only entry should not, on its own, wake the agent.
    appendLog(logPath, { actor: "agent", type: LogEventType.AgentRevised });

    const pending = waitForActions({ logPath, cursor: 0, debounceMs: 40, pollMs: 5 });
    setTimeout(() => appendLog(logPath, { actor: "user", type: LogEventType.CommentCreated, payload: { id: "cmt-abc123" } }), 15);

    const result = await pending;
    expect(result.entries.map((e) => e.type)).toContain(LogEventType.CommentCreated);
    expect(result.cursor).toBeGreaterThanOrEqual(2);
  });

  it("exits editorGone when a once-alive editor process dies (no zombie)", async () => {
    // A short-lived child stands in for the editor process.
    const child = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 150)"]);
    await new Promise((r) => setTimeout(r, 10)); // let it start
    appendLog(logPath, { actor: "agent", type: LogEventType.EditorPid, payload: { pid: child.pid } });

    const result = await waitForActions({ logPath, cursor: 0, debounceMs: 40, pollMs: 10, watchEditor: true });
    expect(result.editorGone).toBe(true);
  });

  it("does not declare editorGone if the editor was never seen alive", async () => {
    // A dead pid recorded before we start: must not misfire (we never saw it alive).
    appendLog(logPath, { actor: "agent", type: LogEventType.EditorPid, payload: { pid: 2_000_000_000 } });
    const ac = new AbortController();
    const pending = waitForActions({ logPath, cursor: 0, debounceMs: 40, pollMs: 10, watchEditor: true, signal: ac.signal });
    setTimeout(() => ac.abort(), 60); // it should still be blocking; we abort to end the test
    await expect(pending).rejects.toThrow(/aborted/);
  });

  it("steps down (superseded) when the wait-lock token changes", async () => {
    const lockPath = join(dir, "doc.waitlock");
    writeFileSync(lockPath, "waiter-A"); // we own it
    const pending = waitForActions({ logPath, cursor: 0, debounceMs: 40, pollMs: 5, watchEditor: false, lockPath, lockToken: "waiter-A" });
    setTimeout(() => writeFileSync(lockPath, "waiter-B"), 15); // a newer waiter claims it
    const result = await pending;
    expect(result.superseded).toBe(true);
  });

  it("keeps waiting while it still holds the lock", async () => {
    const lockPath = join(dir, "doc.waitlock");
    writeFileSync(lockPath, "waiter-A");
    const ac = new AbortController();
    const pending = waitForActions({ logPath, cursor: 0, debounceMs: 40, pollMs: 5, watchEditor: false, lockPath, lockToken: "waiter-A", signal: ac.signal });
    setTimeout(() => ac.abort(), 40); // never superseded → still blocking → abort to end
    await expect(pending).rejects.toThrow(/aborted/);
  });

  it("can be aborted", async () => {
    const ac = new AbortController();
    const pending = waitForActions({ logPath, cursor: 0, debounceMs: 40, pollMs: 5, signal: ac.signal });
    setTimeout(() => ac.abort(), 10);
    await expect(pending).rejects.toThrow(/aborted/);
  });
});
