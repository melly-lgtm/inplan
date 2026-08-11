// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The reopen grace took seven review rounds of seam-patches — lock re-claims, pre-mutation guards,
// guards for the guards — because resume was a RECURSIVE re-entry into waitCycle, so every reload
// walked back through the turn-processing pipeline. These tests pin the restructure that removed
// the disease instead of the symptoms: turn processing runs exactly once per invocation, and a
// reload-resume is a `continue` inside the wait loop.
//
// The discriminating assertion is the agent-event count. Under recursion, a resumed cycle re-ran
// applyGatedEdit and re-appended agent_revised — and on the plugin path, where quarantine does not
// revert the working copy, it re-parked a pending Review proposal too. One reload, duplicated events.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LogEventType, MemoryControlChannel, MemoryDocumentStore, type LogEntry } from "@inplan/core/node";
import { waitCycle, type WaitBackend } from "../src/cli";

const DOC_A = "# Plan\n\nOriginal body.\n\n<!--inplan\n[]\n-->\n";
const DOC_B = "# Plan\n\nAgent-edited body.\n\n<!--inplan\n[]\n-->\n";

// One source for the cadence: the env the wait reads and every timing decision below derive from
// these, so slowing the suite down for a loaded CI is a one-line change.
const DEBOUNCE_MS = 25;
const POLL_MS = 2;

let home: string;
beforeEach(() => {
  // Isolate settings (acceptance defaults to "review" with no settings file) and run the wait fast.
  home = mkdtempSync(join(tmpdir(), "inplan-resume-"));
  process.env.INPLAN_HOME = home;
  process.env.INPLAN_DEBOUNCE_MS = String(DEBOUNCE_MS);
  process.env.INPLAN_POLL_MS = String(POLL_MS);
});
afterEach(() => {
  delete process.env.INPLAN_HOME;
  delete process.env.INPLAN_DEBOUNCE_MS;
  delete process.env.INPLAN_POLL_MS;
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Poll until `cond` holds — the deterministic replacement for "sleep long enough". */
async function waitUntil(cond: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error("waitUntil: condition not reached");
    await sleep(POLL_MS);
  }
}

function harness(initialDoc: string) {
  const channel = new MemoryControlChannel();
  const store = new MemoryDocumentStore(initialDoc);
  const backend: WaitBackend = {
    channel,
    store,
    history: async () => (await channel.readSince(0)).entries,
    logExit: () => {},
  };
  let out = "";
  let err = "";
  const so = vi.spyOn(process.stdout, "write").mockImplementation((c: unknown) => ((out += String(c)), true));
  const se = vi.spyOn(process.stderr, "write").mockImplementation((c: unknown) => ((err += String(c)), true));
  return {
    channel,
    store,
    backend,
    stdout: () => out,
    stderr: () => err,
    lastJson: () => JSON.parse(out.trim().split("\n").pop()!) as { status: string; entries: LogEntry[] },
    restore: () => {
      so.mockRestore();
      se.mockRestore();
    },
  };
}

const countEvents = async (channel: MemoryControlChannel, type: string): Promise<number> =>
  (await channel.readSince(0)).entries.filter((e) => e.type === type).length;

/** Reload mid-wait: window_closed followed by a user action.
 *
 *  Ordering is by OBSERVATION, not by sleeping: the pipeline's agent_revised append proves waitCycle
 *  has long since read its initial history (so cursor 0 covers these appends), which is the only
 *  ordering the test needs. Whether the two appends land in one debounced batch or split across two
 *  is the scheduler's business — the in-batch branch and the grace branch must both resume, and the
 *  assertions below accept either. */
async function reloadThenAct(channel: MemoryControlChannel): Promise<void> {
  await waitUntil(async () => (await countEvents(channel, LogEventType.AgentRevised)) >= 1);
  await channel.append({ actor: "user", type: LogEventType.SessionClosed, payload: { reason: "window_closed" } });
  await channel.append({ actor: "user", type: LogEventType.TurnEnded });
}

describe("waitCycle resume is a loop, not a re-entry", () => {
  it("a reload-resume does not re-run the turn pipeline (exactly one agent_revised)", async () => {
    const h = harness(DOC_A);
    try {
      const run = waitCycle(h.backend, null, new Set());
      await reloadThenAct(h.channel);
      await expect(run).resolves.toBe("ok");

      // The resume continued the SAME invocation: it re-read the post-close user action and
      // reported it as the wake, instead of ending the session. Both resume branches print
      // "resuming the wait" — which branch fired depends on whether the scheduler split the two
      // appends across debounce batches, and the invariant under test is the resume, not the batch.
      expect(h.stderr()).toContain("resuming the wait");
      expect(h.stderr()).not.toContain("did not come back");
      const last = h.lastJson();
      expect(last.status).toBe("your_turn");
      expect(last.entries.some((e) => e.type === LogEventType.TurnEnded)).toBe(true);

      // …and the pipeline ran once. Recursion appended a second agent_revised on every reload.
      expect(await countEvents(h.channel, LogEventType.AgentRevised)).toBe(1);
    } finally {
      h.restore();
    }
  });

  it("a reload never re-parks a pending Review proposal on the PLUGIN path", async () => {
    // The duplication lived on the gate path specifically: quarantine reverts the working FILE to
    // canonical (applyEdit.ts), so a recursed file-path resume saw no change — but with a gate the
    // working copy is the plugin's and is NOT reverted, so recursion re-parked the same proposal
    // and re-appended agent_revision_proposed on every reload.
    const h = harness(DOC_B); // the agent's working copy, differing from the hub canonical
    const gate = { readCanonical: async () => DOC_A, applyRevision: async () => {} };
    try {
      const run = waitCycle(h.backend, null, new Set(), undefined, gate);
      await reloadThenAct(h.channel);
      await expect(run).resolves.toBe("ok");

      expect(await countEvents(h.channel, LogEventType.AgentRevisionProposed)).toBe(1);
      expect(h.lastJson().status).toBe("your_turn");
    } finally {
      h.restore();
    }
  });

  it("a batch-split reload (the close fires alone) resumes via the grace, pipeline still once", async () => {
    // The case the in-batch branch cannot see: the debounce fires between the close and the user's
    // next action, so the batch carries only window_closed. The grace watch must then catch the
    // action and loop back — same invariant, other branch. Forced deterministically by waiting for
    // the grace to begin before appending the action.
    const h = harness(DOC_A);
    try {
      const run = waitCycle(h.backend, null, new Set());
      await waitUntil(async () => (await countEvents(h.channel, LogEventType.AgentRevised)) >= 1);
      await h.channel.append({ actor: "user", type: LogEventType.SessionClosed, payload: { reason: "window_closed" } });
      await waitUntil(async () => h.stderr().includes("Watching for it to come back"));
      await h.channel.append({ actor: "user", type: LogEventType.TurnEnded });

      await expect(run).resolves.toBe("ok");
      expect(h.stderr()).toContain("resuming the wait");
      const last = h.lastJson();
      expect(last.status).toBe("your_turn");
      expect(last.entries.some((e) => e.type === LogEventType.TurnEnded)).toBe(true);
      expect(await countEvents(h.channel, LogEventType.AgentRevised)).toBe(1);
    } finally {
      h.restore();
    }
  }, 10_000); // the grace's read probe re-polls at its own 2s cadence — give the slow path headroom

  it("an explicit completed close still ends the wait (the loop does not swallow terminal batches)", async () => {
    const h = harness(DOC_A);
    try {
      const run = waitCycle(h.backend, null, new Set());
      await waitUntil(async () => (await countEvents(h.channel, LogEventType.AgentRevised)) >= 1);
      await h.channel.append({ actor: "user", type: LogEventType.SessionClosed, payload: { reason: "completed" } });
      await expect(run).resolves.toBe("ok");
      const last = h.lastJson() as unknown as { status: string; reason: string };
      expect(last.status).toBe("closed");
      expect(last.reason).toBe("completed");
    } finally {
      h.restore();
    }
  });
});
