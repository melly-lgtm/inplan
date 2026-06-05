// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `inplan message <file> "text"` — the agent relays a human-facing note that the
// editor surfaces in its status bar. It appends an agent-authored agent_message
// event (payload { text }) to the control log; it is informational, not a wake signal.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LogEventType, readLog } from "@inplan/core/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { docPaths } from "../src/paths";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

let home: string;
let file: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "inplan-msg-"));
  file = join(home, "plan.md");
  writeFileSync(file, "# Plan\n\nbody\n");
  // Set it on THIS process too so the in-test docPaths() resolves the same log the CLI wrote.
  process.env.INPLAN_SIDECAR_DIR = join(home, "sidecars");
  env = { ...process.env, INPLAN_HOME: home };
});
afterEach(() => {
  delete process.env.INPLAN_SIDECAR_DIR;
  rmSync(home, { recursive: true, force: true });
});

function run(...args: string[]) {
  const r = spawnSync(process.execPath, [CLI, ...args], { env, encoding: "utf8" });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

describe("inplan message", () => {
  it("appends an agent-authored agent_message event with the text", () => {
    const r = run("message", file, "Updated the datastore section per your answer");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ status: "messaged" });

    const entries = readLog(docPaths(file).logPath);
    const msg = entries.find((e) => e.type === LogEventType.AgentMessage);
    expect(msg?.actor).toBe("agent");
    expect((msg?.payload as { text?: string } | undefined)?.text).toBe("Updated the datastore section per your answer");
  });

  it("rejects an empty message", () => {
    expect(run("message", file, "   ").code).toBe(1);
    expect(run("message", file).code).toBe(1);
  });
});
