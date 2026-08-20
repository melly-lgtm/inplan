// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `inplan open <path>` on a not-yet-existing path creates an empty plan doc and opens the
// editor — the agent's "open first, fill in live" entry point (no separate write step). This
// guards the integration: ensureDocFile must run for `open` even though every *other* command
// bails out with "file not found" on a missing path. (ensureDocFile itself is unit-tested in
// ensureDoc.test.ts; here we exercise the real `open` command end-to-end.)

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scrubAgentEnv } from "../src/cli";

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
  // scrubAgentEnv removes EVERY marker isKnownAgentEnv recognises, so an agent shell (Claude Code,
  // Codex, Pi, or an INPLAN_AGENT opt-in) can't route the subprocess to the rendezvous pending-exit
  // (exit 7) instead — which used to fail the suite when run from an agent.
  env = { ...scrubAgentEnv(process.env), INPLAN_HOME: home, INPLAN_SIDECAR_DIR: join(home, "sidecars"), INPLAN_APP_CMD: FAKE_EDITOR, CI: "1" };
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return cond();
}

const waitForFile = (path: string, timeoutMs: number): Promise<boolean> => waitFor(() => existsSync(path), timeoutMs);

/** The named sidecar file under this run's single control dir (`$INPLAN_SIDECAR_DIR/<key>/<name>`), else null. */
function sidecarPath(name: string): string | null {
  const root = join(home, "sidecars");
  if (!existsSync(root)) return null;
  for (const key of readdirSync(root)) {
    const candidate = join(root, key, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const waitForSidecar = (name: string, timeoutMs: number): Promise<boolean> => waitFor(() => sidecarPath(name) !== null, timeoutMs);

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

  it("SIGTERM before the first human action never clobbers the file to the empty canonical (#95)", async () => {
    // The live incident: `open` on a fresh path seeded an EMPTY canonical; the agent filled the
    // file; a relaunched waiter parked the fill as a review proposal and reverted the working
    // file to the empty canonical; SIGTERM landed before any human action — the doc was 0 bytes
    // on disk, recoverable only from the proposed sidecar. The original bytes must survive.
    const file = join(home, "clobber.plan.md");
    const plan = `# The plan\n\n${"A paragraph of real content that must survive.\n".repeat(40)}`;

    // 1. `open` a fresh path: creates the empty doc, seeds the empty canonical, blocks in waitCycle.
    const first = spawn(process.execPath, [CLI, "open", file], { env });
    try {
      expect(await waitForSidecar("canonical.md", 10_000)).toBe(true);
      expect(readFileSync(sidecarPath("canonical.md")!, "utf8")).toBe(""); // the incident's shape: canonical is authoritative-empty

      // 2. The agent fills the doc in place (open-then-fill) while the session is up.
      writeFileSync(file, plan);
    } finally {
      first.kill("SIGTERM"); // the incident's first waiter death
    }
    // JOIN the first process before relaunching: both runs key the SAME sidecar dir (waitlock,
    // log.jsonl), so overlapping teardown would make the lifecycle timing-dependent — and a park
    // the dying first run manages to squeeze in must be counted as PRE-EXISTING, not mistaken
    // for the second run's.
    expect(await waitFor(() => first.exitCode !== null || first.signalCode !== null, 5000)).toBe(true);
    const parkCount = (): number => {
      const log = sidecarPath("log.jsonl");
      return log === null ? 0 : (readFileSync(log, "utf8").match(/agent_revision_proposed/g) ?? []).length;
    };
    const parksBefore = parkCount();

    // 3. A relaunched waiter processes the turn: default Review mode parks the fill as a proposal.
    //    A NEW `agent_revision_proposed` (count increase) means the park — and any revert — has
    //    already run in the second process; a leftover first-run event can never satisfy this.
    const second = spawn(process.execPath, [CLI, "open", file], { env });
    try {
      expect(await waitFor(() => parkCount() > parksBefore, 10_000)).toBe(true);
    } finally {
      second.kill("SIGTERM"); // before any human action — the incident's second waiter death
    }
    expect(await waitFor(() => second.exitCode !== null || second.signalCode !== null, 5000)).toBe(true);

    // 4. The park is real (the proposal sidecar holds the text) AND the working file kept its bytes.
    expect(readFileSync(sidecarPath("proposed.md")!, "utf8")).toBe(plan);
    expect(readFileSync(file, "utf8")).toBe(plan); // never materialized emptier content than it read
  }, 30_000);

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
