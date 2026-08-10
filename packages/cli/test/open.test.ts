// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `inplan open <path>` on a not-yet-existing path creates an empty plan doc and opens the
// editor — the agent's "open first, fill in live" entry point (no separate write step). This
// guards the integration: ensureDocFile must run for `open` even though every *other* command
// bails out with "file not found" on a missing path. (ensureDocFile itself is unit-tested in
// ensureDoc.test.ts; here we exercise the real `open` command end-to-end.)

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
// A throwaway "editor" that just stays alive: open() records its pid and blocks in waitCycle, so
// the process doesn't exit on us mid-assertion. It self-exits quickly so nothing leaks if we miss the kill.
const FAKE_EDITOR = `${process.execPath} -e "setTimeout(()=>{},4000)"`;

let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "inplan-open-"));
  // Hermetic auth env: these spawns assert the non-interactive "not logged in" path, so pin an
  // unattended environment regardless of who runs the suite. CI=1 (loginOptOut) forces that path;
  // scrubbing CLAUDECODE/CLAUDE_CODE_* stops an agent shell (e.g. Claude Code) from routing to the
  // rendezvous pending-exit (exit 7) instead — which used to fail the suite when run from an agent.
  env = { ...process.env, INPLAN_HOME: home, INPLAN_SIDECAR_DIR: join(home, "sidecars"), INPLAN_APP_CMD: FAKE_EDITOR, CI: "1" };
  for (const k of Object.keys(env)) if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) delete env[k];
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return existsSync(path);
}

describe("inplan open", () => {
  it("creates an empty doc for a fresh path (open-then-fill), not 'file not found'", async () => {
    const file = join(home, "nested", "fresh.plan.md");
    expect(existsSync(file)).toBe(false);

    let stderr = "";
    const child = spawn(process.execPath, [CLI, "open", file], { env });
    child.stderr.on("data", (d) => (stderr += String(d)));
    try {
      const created = await waitForFile(file, 5000);
      expect(created).toBe(true); // the guard no longer rejects `open` on a missing path
      expect(readFileSync(file, "utf8")).toBe(""); // an empty doc, ready to fill in
      expect(stderr).not.toMatch(/file not found/i);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("still rejects a missing path for non-open commands (e.g. wait)", () => {
    const file = join(home, "does-not-exist.plan.md");
    const r = spawnSync(process.execPath, [CLI, "wait", file], { env, encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/file not found/i);
    expect(existsSync(file)).toBe(false); // wait never creates the file
  });

  it("deprecates `open --remote` and runs it as `wait --remote`", () => {
    // A cloud doc has no local editor to launch — the only thing `open` adds locally — so
    // `open --remote` is a deprecated alias for `wait --remote`. With no stored credentials in
    // this non-interactive spawn it falls straight through to the wait path's auth guard (never
    // opening a browser), which proves the forward happened.
    const r = spawnSync(process.execPath, [CLI, "open", "--remote", "doc-abc"], { env, encoding: "utf8" });
    expect(r.stderr).toMatch(/`open --remote` is deprecated/i);
    expect(r.stderr).toMatch(/use `wait --remote`/i);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not logged in/i);
  });
});
