// SPDX-License-Identifier: AGPL-3.0-or-later

import { appendLog, LogEventType } from "@agent-planner/core";
import { mkdtempSync, rmSync } from "node:fs";
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

  it("can be aborted", async () => {
    const ac = new AbortController();
    const pending = waitForActions({ logPath, cursor: 0, debounceMs: 40, pollMs: 5, signal: ac.signal });
    setTimeout(() => ac.abort(), 10);
    await expect(pending).rejects.toThrow(/aborted/);
  });
});
