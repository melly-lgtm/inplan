// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Live fill: the agent's edits DURING a blocked wait. `inplan open <new path>` launches the editor
// and blocks before the agent has written anything, and the editor is driven by the control log —
// so an edit the wait never gates is an edit the human never sees. These pin the gating that runs
// while the wait is blocked, and the three ways it must not misbehave: it may not blank out a
// landing signal the turn already produced, it may not re-park its own revert on a loop, and it may
// not keep writing to a document it no longer owns.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LogEventType, MemoryControlChannel, MemoryDocumentStore, type LogEntry } from "@inplan/core/node";
import { waitCycle, type WaitBackend } from "../src/cli";
import { waitForActions } from "../src/wait";
import { proposedContent } from "./helpers";

const EMPTY = "";
const DRAFT = "# Plan\n\nThe body the human has to be able to see.\n";
const REVISED = "# Plan\n\nA second pass over the body.\n";

const DEBOUNCE_MS = 25;
const POLL_MS = 2;

let home: string;
beforeEach(() => {
  // Isolate settings (acceptance defaults to "review" with no settings file) and run the wait fast.
  home = mkdtempSync(join(tmpdir(), "inplan-livefill-"));
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll until `cond` holds — the deterministic replacement for "sleep long enough". */
async function waitUntil(cond: () => Promise<boolean> | boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error("waitUntil: condition not reached");
    await sleep(POLL_MS);
  }
}

const SIGNALS = ["SIGTERM", "SIGHUP", "SIGINT"] as const;

/** waitCycle over in-memory backends, with stdout/stderr captured and its process-global signal
 *  handlers removed on restore (see waitCycleResume.test.ts for why that matters). */
function harness(initialDoc: string) {
  const channel = new MemoryControlChannel();
  const store = new MemoryDocumentStore(initialDoc);
  const preListeners = new Map(SIGNALS.map((sig) => [sig, new Set(process.listeners(sig))]));
  const backend: WaitBackend = {
    channel,
    store,
    history: async () => (await channel.readSince(0)).entries,
    logExit: () => {},
  };
  let out = "";
  const so = vi.spyOn(process.stdout, "write").mockImplementation((c: unknown) => ((out += String(c)), true));
  const se = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  return {
    channel,
    store,
    backend,
    lastJson: () => JSON.parse(out.trim().split("\n").pop()!) as { status: string; proposal?: { state: string; id?: string }; entries: LogEntry[] },
    restore: () => {
      so.mockRestore();
      se.mockRestore();
      for (const sig of SIGNALS) {
        for (const l of process.listeners(sig)) if (!preListeners.get(sig)!.has(l)) process.off(sig, l);
      }
    },
  };
}

const count = async (channel: MemoryControlChannel, type: string): Promise<number> => (await channel.readSince(0)).entries.filter((e) => e.type === type).length;

describe("live fill — the agent's edits during a blocked wait", () => {
  it("gates a fill written after the wait blocked: it lands, and the editor is told", async () => {
    // The open-then-fill flow: the wait starts on the empty doc `open` just created.
    const h = harness(EMPTY);
    try {
      const run = waitCycle(h.backend, null, new Set(), undefined, null, { liveFill: true });
      await waitUntil(async () => (await count(h.channel, LogEventType.AgentRevised)) >= 1); // the turn ran: nothing to gate yet
      await h.store.saveDoc(DRAFT);

      // document_edited is what drives the editor's reload — the signal that the human's window
      // now holds the plan.
      await waitUntil(async () => (await count(h.channel, LogEventType.DocumentEdited)) >= 1);
      expect(await h.store.getCanonical()).toBe(DRAFT);

      await h.channel.append({ actor: "user", type: LogEventType.TurnEnded });
      await run;
    } finally {
      h.restore();
    }
  });

  it("keeps the turn's parked proposal in the final status (the revert is not a new edit)", async () => {
    // The normal loop: the agent edits, THEN waits. The turn parks that edit and reverts the
    // working copy to canonical — a write by the gate, not an edit by the agent. Reading it back
    // as a no-op edit used to blank `proposal` out of the status, which is the one field telling
    // the agent its work is safely parked (#88).
    const h = harness(REVISED);
    await h.store.setCanonical(DRAFT);
    try {
      const run = waitCycle(h.backend, null, new Set(), undefined, null, { liveFill: true });
      await waitUntil(async () => (await proposedContent(h.store)) === REVISED);
      await waitUntil(async () => (await h.store.loadDoc()) === DRAFT); // the revert landed
      // The gate's own revert must not be re-gated: every base read is a round-trip (and on the
      // plugin path, a hub call) spent on a write we made ourselves.
      const basesRead = vi.spyOn(h.store, "getCanonical");
      await sleep(POLL_MS * 20); // give the watcher several polls over the reverted file
      expect(basesRead).not.toHaveBeenCalled();

      // …and the human saves in the editor (file + canonical together). That is a real change on
      // disk, but no agent edit — gating it is a no-op, and a no-op must not clear the park either.
      const HUMAN = "# Plan\n\nThe human's own wording.\n";
      await h.store.saveDoc(HUMAN);
      await h.store.setCanonical(HUMAN);
      await sleep(POLL_MS * 20);

      await h.channel.append({ actor: "user", type: LogEventType.TurnEnded });
      await run;
      expect(h.lastJson().proposal?.state).toBe("pending_review");
      // …and the revert was never re-gated: exactly one park for one edit.
      expect(await count(h.channel, LogEventType.AgentRevisionProposed)).toBe(1);
    } finally {
      h.restore();
    }
  });

  it("evaluates a write that lands after a decision, instead of adopting it unseen", async () => {
    // Recording whatever the disk holds AFTER an apply swallows a write another process slipped in
    // between the two: text no one evaluated would be treated as already gated and skipped for the
    // rest of the wait, surfacing only when the agent's next `wait` runs.
    const h = harness(EMPTY);
    const CONCURRENT = "# Plan\n\nWritten by someone else, a moment later.\n";
    let raced = false;
    const setCanonical = h.store.setCanonical.bind(h.store);
    vi.spyOn(h.store, "setCanonical").mockImplementation(async (content: string) => {
      await setCanonical(content);
      if (!raced && content === DRAFT) {
        raced = true;
        await h.store.saveDoc(CONCURRENT); // lands the instant the decision is made
      }
    });
    try {
      const run = waitCycle(h.backend, null, new Set(), undefined, null, { liveFill: true });
      await waitUntil(async () => (await count(h.channel, LogEventType.AgentRevised)) >= 1);
      await h.store.saveDoc(DRAFT);

      await waitUntil(async () => (await proposedContent(h.store)) === CONCURRENT); // seen, not skipped
      await h.channel.append({ actor: "user", type: LogEventType.TurnEnded });
      await run;
    } finally {
      h.restore();
    }
  });

  it("stops writing once a newer waiter owns the doc", async () => {
    // A stale waiter that parks a proposal — or reverts the working copy — after stepping down is
    // mutating a document it no longer speaks for. The supersession lands in the window the race
    // actually has: after the edit settled, before the gate writes anything.
    const h = harness(DRAFT);
    await h.store.setCanonical(DRAFT);
    let atTheGate: (() => void) | null = null;
    const entered = new Promise<void>((r) => (atTheGate = r));
    let release: (() => void) | null = null;
    const held = new Promise<void>((r) => (release = r));
    let armed = false;
    const getCanonical = h.store.getCanonical.bind(h.store);
    vi.spyOn(h.store, "getCanonical").mockImplementation(async () => {
      if (!armed) return getCanonical();
      armed = false;
      atTheGate!(); // the fill has settled and is reading its base
      await held; // …hold it there while the doc changes hands
      return getCanonical();
    });
    try {
      const run = waitCycle(h.backend, null, new Set(), undefined, null, { liveFill: true });
      await waitUntil(async () => (await count(h.channel, LogEventType.AgentRevised)) >= 1);
      armed = true;
      await h.store.saveDoc(REVISED);
      await entered;

      await h.channel.claimLock("a-newer-waiter"); // the doc is someone else's now
      release!();
      await run; // the wait steps down on its own supersede probe

      expect(await proposedContent(h.store)).toBeNull(); // nothing parked by the waiter that left
      expect(await count(h.channel, LogEventType.AgentRevisionProposed)).toBe(0);
      expect(await h.store.loadDoc()).toBe(REVISED); // nor reverted out from under the new waiter
      expect(h.lastJson().status).toBe("superseded");
    } finally {
      h.restore();
    }
  });
});

describe("waitForActions — the onPoll hook's lifetime", () => {
  it("settles with an in-flight hook, not out from under it", async () => {
    // waitCycle's hook mutates the document (it can park a proposal and revert the working copy).
    // Resolving while it is mid-flight would print a status that omits what the hook then does.
    const channel = new MemoryControlChannel();
    let hookDone = false;
    let started = false;
    const onPoll = async (): Promise<void> => {
      if (started) return;
      started = true;
      await sleep(80);
      hookDone = true;
    };
    const wait = waitForActions({ channel, cursor: 0, debounceMs: 1, pollMs: 1, watchEditor: false, onPoll });
    await waitUntil(() => started);
    await channel.append({ actor: "user", type: LogEventType.TurnEnded });
    await wait;
    expect(hookDone).toBe(true);
  });
});
