// SPDX-License-Identifier: AGPL-3.0-or-later

import { LogEventType } from "@inplan/core/node";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isProcessAlive, runningEditorPid } from "../src/editorProcess";

const DEAD_PID = 2_000_000_000; // far above any real macOS/Linux pid

let dir: string;
let logPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ap-pid-"));
  logPath = join(dir, "doc.log.jsonl");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function writeLog(entries: object[]): void {
  writeFileSync(logPath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

describe("isProcessAlive", () => {
  it("is true for the current process", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });
  it("is false for an unused pid", () => {
    expect(isProcessAlive(DEAD_PID)).toBe(false);
  });
});

describe("runningEditorPid", () => {
  it("returns the pid when the recorded editor is alive", () => {
    writeLog([{ seq: 1, ts: "t", actor: "agent", type: LogEventType.EditorPid, payload: { pid: process.pid } }]);
    expect(runningEditorPid(logPath)).toBe(process.pid);
  });
  it("returns null when the recorded editor is dead", () => {
    writeLog([{ seq: 1, ts: "t", actor: "agent", type: LogEventType.EditorPid, payload: { pid: DEAD_PID } }]);
    expect(runningEditorPid(logPath)).toBeNull();
  });
  it("returns null when there is no editor_pid entry", () => {
    writeLog([{ seq: 1, ts: "t", actor: "user", type: LogEventType.CommentCreated }]);
    expect(runningEditorPid(logPath)).toBeNull();
  });
});
