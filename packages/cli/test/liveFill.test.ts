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
import { onceAtATime, waitForActions } from "../src/wait";
import { proposedContent } from "./helpers";

const EMPTY = "";
const DRAFT = "# Plan\n\nThe body the human has to be able to see.\n\n<!--inplan\n[]\n-->\n";
const REVISED = "# Plan\n\nA second pass over the body.\n\n<!--inplan\n[]\n-->\n";
const SPAN_DOC =
  "# Plan\n\nThe [datastore choice](#cmt-q1) needs a decision.\n\n<!--inplan\n" +
  JSON.stringify([{ id: "cmt-q1", author: "a", date: "2026-01-01T00:00:00Z", resolved: false, text: "Which datastore?" }]) +
  "\n-->\n";
/** SPAN_DOC with the anchor link rewritten away — the comment is orphaned, which needs the agent's
 *  own confirmation before it can be accepted. */
const SPAN_ORPHANED = SPAN_DOC.replace("The [datastore choice](#cmt-q1) needs a decision.", "The datastore choice is settled.");
const COMMENT_BLOCK = '<!--inplan\n[{"id":"cmt-aaa111","author":"a","date":"2026-01-01T00:00:00Z","resolved":false,"anchor":"doc","text":"q"}]\n-->';
/** DRAFT with a document-level comment added — a comment-only change, which lands in review mode. */
const COMMENTED = DRAFT.replace("<!--inplan\n[]\n-->", COMMENT_BLOCK);

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
  let err = "";
  const so = vi.spyOn(process.stdout, "write").mockImplementation((c: unknown) => ((out += String(c)), true));
  const se = vi.spyOn(process.stderr, "write").mockImplementation((c: unknown) => ((err += String(c)), true));
  return {
    channel,
    store,
    backend,
    stderr: () => err,
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
    const CONCURRENT = COMMENTED; // a comment-only change, so gating it is observable: it lands
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

      await waitUntil(async () => (await h.store.getCanonical()) === CONCURRENT); // seen, not skipped
      await h.channel.append({ actor: "user", type: LogEventType.TurnEnded });
      await run;
    } finally {
      h.restore();
    }
  });

  it("stops writing once a newer waiter owns the doc", async () => {
    // A stale waiter that advances the canonical after stepping down is writing to a document it
    // no longer speaks for. The supersession lands in the window the race actually has: after the
    // edit settled, before the gate writes anything. The edit is comment-only, so it is one the
    // live path really would land.
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
      await held; // …and the doc changes hands right here
      return getCanonical();
    });
    try {
      const run = waitCycle(h.backend, null, new Set(), undefined, null, { liveFill: true });
      await waitUntil(async () => (await count(h.channel, LogEventType.AgentRevised)) >= 1);
      armed = true;
      await h.store.saveDoc(COMMENTED);
      await entered;

      await h.channel.claimLock("a-newer-waiter"); // the doc is someone else's now
      release!();
      await run; // the wait steps down on its own supersede probe

      expect(await count(h.channel, LogEventType.DocumentEdited)).toBe(0); // nothing written by the waiter that left
      expect(await h.store.getCanonical()).toBe(DRAFT);
      expect(h.lastJson().status).toBe("superseded");
    } finally {
      h.restore();
    }
  });

  it("defers a revision that review mode would park — it is never written out from under the agent", async () => {
    // A park is a write: it reverts the working copy to the base. Mid-turn the agent is still
    // editing, and its tools read-modify-write the file (`inplan comment` is a readFileSync /
    // writeFileSync pair), so parking here hands it a reverted file to compose its next write
    // from — and that comment-only write LANDS, withdrawing the park. The body revision then
    // exists nowhere: not on disk, not as a proposal, never seen by the human.
    const h = harness(DRAFT);
    await h.store.setCanonical(DRAFT);
    try {
      const run = waitCycle(h.backend, null, new Set(), undefined, null, { liveFill: true });
      await waitUntil(async () => (await count(h.channel, LogEventType.AgentRevised)) >= 1);

      await h.store.saveDoc(REVISED); // the agent revises the body mid-turn
      await sleep(POLL_MS * 20);
      expect(await h.store.loadDoc()).toBe(REVISED); // left exactly where the agent put it
      expect(await proposedContent(h.store)).toBeNull(); // nothing parked mid-turn
      expect(await h.store.getCanonical()).toBe(DRAFT); // …and nothing landed either

      // The agent keeps working from its own text, as it would with any read-modify-write tool.
      const next = (await h.store.loadDoc()).replace("<!--inplan\n[]\n-->", COMMENT_BLOCK);
      await h.store.saveDoc(next);
      await sleep(POLL_MS * 20);
      expect(await h.store.loadDoc()).toContain("A second pass"); // the revision survived
      expect(await h.store.loadDoc()).toContain("cmt-aaa111");

      await h.channel.append({ actor: "user", type: LogEventType.TurnEnded });
      await run;
      // The deferral is the agent's to hear about, so it is never silent.
      expect(h.stderr()).toMatch(/held for review/);
    } finally {
      h.restore();
    }
  });

  it("reports a comment block that will not parse instead of swallowing it", async () => {
    // `parse` THROWS on a malformed block, so a broken document never reaches the integrity check.
    // Unhandled, onPoll's catch ate it and the agent got no signal at all for the whole wait.
    const h = harness(EMPTY);
    try {
      const run = waitCycle(h.backend, null, new Set(), undefined, null, { liveFill: true });
      await waitUntil(async () => (await count(h.channel, LogEventType.AgentRevised)) >= 1);
      await h.store.saveDoc("# Plan\n\nHalf-written.\n\n<!--inplan\n[{ broken json\n-->\n");
      await waitUntil(() => /could not be parsed/.test(h.stderr()));
      expect(await h.store.getCanonical()).toBe(EMPTY); // nothing gated from an unreadable document

      // …and the agent's FIX is evaluated afresh rather than written off with the broken version.
      await h.store.saveDoc(DRAFT);
      await waitUntil(async () => (await h.store.getCanonical()) === DRAFT);
      await h.channel.append({ actor: "user", type: LogEventType.TurnEnded });
      await run;
    } finally {
      h.restore();
    }
  });

  it("a comment the agent adds after the TURN parked its revision does not destroy it", async () => {
    // The agent edited, then called wait: the turn parks the revision and reverts the working copy.
    // The agent keeps working from that reverted file — and a comment-only write LANDS. Retracting
    // the parked revision there left it nowhere: not on disk, not pending, never decided.
    const h = harness(REVISED);
    await h.store.setCanonical(DRAFT);
    try {
      const run = waitCycle(h.backend, null, new Set(), undefined, null, { liveFill: true });
      await waitUntil(async () => (await proposedContent(h.store)) === REVISED); // the turn parked it
      await waitUntil(async () => (await h.store.loadDoc()) === DRAFT); // …and reverted the file

      await h.store.saveDoc(COMMENTED); // `inplan comment` on the reverted file
      await waitUntil(async () => (await h.store.getCanonical()) === COMMENTED); // the comment lands

      expect(await proposedContent(h.store)).toBe(REVISED); // the revision is still the human's to decide
      await h.channel.append({ actor: "user", type: LogEventType.TurnEnded });
      await run;
      expect(h.lastJson().proposal?.state).toBe("pending_review"); // …and the agent is still told so
    } finally {
      h.restore();
    }
  });

  it("says so when an edit lands but its announcement cannot be logged", async () => {
    // The write happens before the announcement, so a degraded control log leaves the canonical
    // advanced and the editor — which is driven by that log — none the wiser. The hook's rejection
    // is discarded by the poll that calls it, so without a word here it is silence on both sides.
    const h = harness(DRAFT);
    await h.store.setCanonical(DRAFT);
    const append = h.channel.append.bind(h.channel);
    vi.spyOn(h.channel, "append").mockImplementation(async (e: Parameters<typeof append>[0]) => {
      if (e.type === LogEventType.DocumentEdited) throw new Error("control log is write-degraded");
      return append(e);
    });
    try {
      const run = waitCycle(h.backend, null, new Set(), undefined, null, { liveFill: true });
      await waitUntil(async () => (await count(h.channel, LogEventType.AgentRevised)) >= 1);

      await h.store.saveDoc(COMMENTED); // a comment-only edit: it lands
      await waitUntil(async () => (await h.store.getCanonical()) === COMMENTED);
      await waitUntil(() => /could not be logged/.test(h.stderr()));

      await h.channel.append({ actor: "user", type: LogEventType.TurnEnded });
      await run;
    } finally {
      h.restore();
    }
  });

  it("says so when the apply itself throws, rather than letting the poll swallow it", async () => {
    const h = harness(DRAFT);
    await h.store.setCanonical(DRAFT);
    vi.spyOn(h.store, "setCanonical").mockRejectedValue(new Error("disk is full"));
    try {
      const run = waitCycle(h.backend, null, new Set(), undefined, null, { liveFill: true });
      await waitUntil(async () => (await count(h.channel, LogEventType.AgentRevised)) >= 1);

      await h.store.saveDoc(COMMENTED);
      await waitUntil(() => /could not be applied/.test(h.stderr()));
      expect(await h.store.loadDoc()).toBe(COMMENTED); // kept where the agent put it

      await h.channel.append({ actor: "user", type: LogEventType.TurnEnded });
      await run;
    } finally {
      h.restore();
    }
  });

  it("does not re-gate the TURN's own write after a confirmed comment deletion", async () => {
    // Same rule as the live path's, one layer earlier: when the turn lands confirmed deletions it
    // writes the ACCEPTED text — the orphaned comment objects dropped — not what the agent wrote.
    // Recording the agent's text as the disk state sends the first poll off to settle and
    // re-evaluate the gate's own write.
    const h = harness(SPAN_ORPHANED); // the agent's edit is already on disk when the wait starts
    await h.store.setCanonical(SPAN_DOC);
    await h.channel.append({ actor: "user", type: LogEventType.SettingsChanged, payload: { acceptance: "auto" } });
    try {
      const run = waitCycle(h.backend, null, new Set(["cmt-q1"]), undefined, null, { liveFill: true });
      await waitUntil(async () => (await count(h.channel, LogEventType.DocumentEdited)) >= 1);
      expect(await h.store.loadDoc()).not.toBe(SPAN_ORPHANED); // the gate rewrote the file

      const basesRead = vi.spyOn(h.store, "getCanonical");
      await sleep(POLL_MS * 20);
      expect(basesRead).not.toHaveBeenCalled(); // …and that rewrite is not an agent edit

      await h.channel.append({ actor: "user", type: LogEventType.TurnEnded });
      await run;
    } finally {
      h.restore();
    }
  });

  it("does not re-gate its own write after a confirmed comment deletion", async () => {
    // A confirmed deletion writes the ACCEPTED text — the orphaned comment objects dropped — not
    // what the agent wrote. Recording the agent's text as the disk state sent the next poll off to
    // settle and re-evaluate the gate's own write.
    const h = harness(SPAN_DOC);
    await h.store.setCanonical(SPAN_DOC);
    // Auto acceptance: a confirmed deletion rewrites the body, which review mode would defer — so
    // the landing path this guards is only reachable where bodies land.
    await h.channel.append({ actor: "user", type: LogEventType.SettingsChanged, payload: { acceptance: "auto" } });
    try {
      const run = waitCycle(h.backend, null, new Set(["cmt-q1"]), undefined, null, { liveFill: true });
      await waitUntil(async () => (await count(h.channel, LogEventType.AgentRevised)) >= 1);

      await h.store.saveDoc(SPAN_ORPHANED); // confirmed, so it lands with the comment dropped
      await waitUntil(async () => (await count(h.channel, LogEventType.DocumentEdited)) >= 1);
      const onDisk = await h.store.loadDoc();
      expect(onDisk).not.toBe(SPAN_ORPHANED); // the gate rewrote it

      const basesRead = vi.spyOn(h.store, "getCanonical");
      await sleep(POLL_MS * 20);
      expect(basesRead).not.toHaveBeenCalled(); // …and that rewrite is not an agent edit

      await h.channel.append({ actor: "user", type: LogEventType.TurnEnded });
      await run;
    } finally {
      h.restore();
    }
  });

  it("does not write a snapshot older than a save that landed mid-decision", async () => {
    // Between the settle and the write there are awaits — the base read, the history read, the
    // lock probe — and the human can save in any of them. The confirmed-deletion path writes the
    // FILE, so applying the stale evaluation would overwrite their text outright.
    const HUMAN = "# Plan\n\nThe human's own save, made mid-decision.\n\n<!--inplan\n[]\n-->\n";
    const h = harness(SPAN_DOC);
    await h.store.setCanonical(SPAN_DOC);
    await h.channel.append({ actor: "user", type: LogEventType.SettingsChanged, payload: { acceptance: "auto" } });
    let armed = false;
    const history = h.backend.history;
    h.backend.history = async () => {
      const entries = await history();
      if (armed) {
        armed = false;
        await h.store.saveDoc(HUMAN); // the human saves while we are mid-decision
        await h.store.setCanonical(HUMAN);
      }
      return entries;
    };
    try {
      const run = waitCycle(h.backend, null, new Set(["cmt-q1"]), undefined, null, { liveFill: true });
      await waitUntil(async () => (await count(h.channel, LogEventType.AgentRevised)) >= 1);
      armed = true;
      await h.store.saveDoc(SPAN_ORPHANED);

      await waitUntil(async () => (await h.store.loadDoc()) === HUMAN);
      await sleep(POLL_MS * 20);
      expect(await h.store.loadDoc()).toBe(HUMAN); // their save stands
      expect(await count(h.channel, LogEventType.DocumentEdited)).toBe(0); // the stale snapshot never landed

      await h.channel.append({ actor: "user", type: LogEventType.TurnEnded });
      await run;
    } finally {
      h.restore();
    }
  });

  it("retries a write that failed once, without waiting for the next wait", async () => {
    // Gating a FAILED apply would leave the human looking at the document the editor was launched
    // on for the rest of the wait — the very failure this watcher exists to end — even once the
    // store recovers. A failure backs off; it does not give up.
    const h = harness(EMPTY);
    let fail = true;
    const setCanonical = h.store.setCanonical.bind(h.store);
    vi.spyOn(h.store, "setCanonical").mockImplementation(async (content: string) => {
      // Only the agent's fill, not the turn's seeding of the empty base.
      if (fail && content === DRAFT) {
        fail = false;
        throw new Error("the store is briefly unavailable");
      }
      return setCanonical(content);
    });
    try {
      const run = waitCycle(h.backend, null, new Set(), undefined, null, { liveFill: true });
      await waitUntil(async () => (await count(h.channel, LogEventType.AgentRevised)) >= 1);

      await h.store.saveDoc(DRAFT);
      await waitUntil(() => /could not be applied/.test(h.stderr()));
      await waitUntil(async () => (await h.store.getCanonical()) === DRAFT, 8000); // …and it lands on the retry

      await h.channel.append({ actor: "user", type: LogEventType.TurnEnded });
      await run;
    } finally {
      h.restore();
    }
  }, 15_000);

  it("says why an edit was declined once per REASON, not once per wait", async () => {
    // A single "have we spoken yet" latch kept the first reason and swallowed every later one: an
    // agent told its revision was safely held then corrupted the comment block and heard nothing —
    // the exact silence the parse guard exists to end.
    const h = harness(DRAFT);
    await h.store.setCanonical(DRAFT);
    try {
      const run = waitCycle(h.backend, null, new Set(), undefined, null, { liveFill: true });
      await waitUntil(async () => (await count(h.channel, LogEventType.AgentRevised)) >= 1);

      await h.store.saveDoc(REVISED); // decline #1: held for review
      await waitUntil(() => /held for review/.test(h.stderr()));
      await h.store.saveDoc("# Plan\n\nHalf-written.\n\n<!--inplan\n[{ broken json\n-->\n"); // #2: a DIFFERENT reason
      await waitUntil(() => /could not be parsed/.test(h.stderr()));

      // …and a repeat of a reason already given stays quiet.
      const before = h.stderr();
      await h.store.saveDoc("# Plan\n\nStill half-written.\n\n<!--inplan\n[{ broken json\n-->\n");
      await sleep(POLL_MS * 20);
      expect(h.stderr()).toBe(before);

      await h.channel.append({ actor: "user", type: LogEventType.TurnEnded });
      await run;
    } finally {
      h.restore();
    }
  });

  it("declines an edit that orphans an anchored comment, naming the remedy", async () => {
    // Accepting this needs --confirmed-comment-deletion, which is a STATUS with a non-zero exit —
    // and this wait is holding the human's turn, so it cannot report one without ending their turn
    // for them. The file is left exactly as the agent wrote it for the next wait to report on.
    const h = harness(SPAN_DOC);
    await h.store.setCanonical(SPAN_DOC);
    try {
      const run = waitCycle(h.backend, null, new Set(), undefined, null, { liveFill: true });
      await waitUntil(async () => (await count(h.channel, LogEventType.AgentRevised)) >= 1);

      await h.store.saveDoc(SPAN_ORPHANED);
      await waitUntil(() => /confirmed-comment-deletion/.test(h.stderr()));
      expect(await h.store.loadDoc()).toBe(SPAN_ORPHANED); // untouched
      expect(await h.store.getCanonical()).toBe(SPAN_DOC); // nothing landed
      expect(await count(h.channel, LogEventType.DocumentEdited)).toBe(0);

      await h.channel.append({ actor: "user", type: LogEventType.TurnEnded });
      await run;
    } finally {
      h.restore();
    }
  });

  it("holds a fill when the hub reads empty but we remember the document having content", async () => {
    // An empty base waives review — there is nothing of the human's to overwrite. On the plugin
    // path that base is an opaque hub read, and a document whose shared state has not loaded yet
    // reads empty too. Taking the waiver there would push a body revision into a document that was
    // never empty. It takes evidence, though, not suspicion: only a LOCAL memory of content makes
    // an empty hub read suspect.
    const h = harness(EMPTY);
    await h.store.setCanonical(DRAFT); // we remember this document having a body
    const gate = { readCanonical: vi.fn(async () => EMPTY), applyRevision: vi.fn(async () => {}) };
    try {
      const run = waitCycle(h.backend, null, new Set(), undefined, gate, { liveFill: true });
      await waitUntil(async () => (await count(h.channel, LogEventType.AgentRevised)) >= 1);

      await h.store.saveDoc(REVISED);
      await waitUntil(() => /held for review/.test(h.stderr()));
      expect(gate.applyRevision).not.toHaveBeenCalled(); // not pushed into the shared document

      await h.channel.append({ actor: "user", type: LogEventType.TurnEnded });
      await run;
    } finally {
      h.restore();
    }
  });

  it("retries a fill the plugin hub could not judge, instead of marking it gated", async () => {
    // On the plugin path the hub's projection IS the base, so a blip leaves nothing to judge
    // against. Falling back to "the agent's own text" reads as no change — and marking it gated
    // would hide the edit for the rest of the wait, long after the hub came back.
    const h = harness(EMPTY);
    let down = true;
    const gate = {
      readCanonical: vi.fn(async () => {
        if (down) throw new Error("hub unreachable");
        return EMPTY;
      }),
      applyRevision: vi.fn(async (md: string) => {
        await h.store.setCanonical(md);
      }),
    };
    try {
      const run = waitCycle(h.backend, null, new Set(), undefined, gate, { liveFill: true });
      await waitUntil(async () => (await count(h.channel, LogEventType.AgentRevised)) >= 1);
      await h.store.saveDoc(DRAFT);
      await sleep(POLL_MS * 20);
      expect(gate.applyRevision).not.toHaveBeenCalled(); // nothing judged while the hub was down

      down = false; // the hub comes back — the same text must still be gated
      await waitUntil(() => gate.applyRevision.mock.calls.length > 0);
      expect(gate.applyRevision).toHaveBeenCalledWith(DRAFT);

      await h.channel.append({ actor: "user", type: LogEventType.TurnEnded });
      await run;
    } finally {
      h.restore();
    }
  });
});

describe("waitForActions — batching the human's actions", () => {
  it("does not let the agent's own writes hold a finished turn open", async () => {
    // The debounce batches a burst of HUMAN actions. Keyed on the whole batch, any other append
    // restarted it — and live fill's own `document_edited` entries arrive in the same read, so an
    // agent writing more often than the debounce could keep `your_turn` from ever being reported.
    const channel = new MemoryControlChannel();
    await channel.append({ actor: "user", type: LogEventType.TurnEnded });
    const chatter = setInterval(() => void channel.append({ actor: "agent", type: LogEventType.DocumentEdited, payload: { bytes: 1 } }), 10);
    try {
      const started = Date.now();
      await waitForActions({ channel, cursor: 0, debounceMs: 100, pollMs: 2, watchEditor: false });
      expect(Date.now() - started).toBeLessThan(600); // ~one debounce, not one per agent write
    } finally {
      clearInterval(chatter);
    }
  });
});

describe("onceAtATime", () => {
  it("drops a call made while one is in flight, instead of running two", async () => {
    // waitForActions' own guard is per CALL, and waitCycle reuses one hook across every call its
    // wait loop makes — so a hook still running when the settle budget expires would be joined by
    // a fresh one, two runs sharing one closure's state.
    let running = 0;
    let peak = 0;
    const fn = onceAtATime(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await sleep(20);
      running -= 1;
    });
    await Promise.all([fn(), fn(), fn()]);
    expect(peak).toBe(1);
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

  it("keeps calling a hook that threw before it returned", async () => {
    // The hook type allows a plain `void` function, so it can throw synchronously — ahead of the
    // assignment that records the in-flight run. Clearing the slot from inside the run was undone
    // by that assignment, and the hook was never called again for the rest of the wait.
    const channel = new MemoryControlChannel();
    let calls = 0;
    const wait = waitForActions({
      channel,
      cursor: 0,
      debounceMs: 1,
      pollMs: 1,
      watchEditor: false,
      onPoll: () => {
        calls += 1;
        throw new Error("hook blew up before returning");
      },
    });
    await waitUntil(() => calls >= 3); // …not stuck at 1
    await channel.append({ actor: "user", type: LogEventType.TurnEnded });
    await wait;
  });

  it("but does not hang on one that never settles — the status still goes out", async () => {
    // Waiting for the hook is right; waiting forever is the failure the grace budgets exist to
    // rule out. A wedged hook would otherwise leave the agent with no status and no exit code.
    const channel = new MemoryControlChannel();
    let started = false;
    const wait = waitForActions({
      channel,
      cursor: 0,
      debounceMs: 1,
      pollMs: 1,
      watchEditor: false,
      hookSettleMs: 30,
      onPoll: () =>
        new Promise<void>(() => {
          started = true; // …and never resolves
        }),
    });
    await waitUntil(() => started);
    await channel.append({ actor: "user", type: LogEventType.TurnEnded });
    const result = await wait;
    expect(result.entries.some((e) => e.type === LogEventType.TurnEnded)).toBe(true);
  });
});
