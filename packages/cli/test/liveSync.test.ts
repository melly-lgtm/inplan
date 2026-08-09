// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { shouldHydrateWorkFile, pendingRequiresReplay, postTurnAction, trackGateDegradations } from "../src/liveSync";

describe("shouldHydrateWorkFile", () => {
  it("seeds when the working copy doesn't exist yet", () => {
    expect(shouldHydrateWorkFile({ exists: false, pending: false, currentHash: null, syncedHash: null })).toBe(true);
  });

  it("never overwrites while a local fallback edit is pending (must be pushed first)", () => {
    // Even if the hashes match, a pending un-pushed edit must be preserved.
    expect(shouldHydrateWorkFile({ exists: true, pending: true, currentHash: "a", syncedHash: "a" })).toBe(false);
  });

  it("hydrates when the agent hasn't touched the copy since our last sync (hashes match)", () => {
    // This is the failed-re-sync self-heal: the copy still equals what was applied, so it's safe to
    // refresh from the hub (pulling the human's edits) instead of reverting them.
    expect(shouldHydrateWorkFile({ exists: true, pending: false, currentHash: "h", syncedHash: "h" })).toBe(true);
  });

  it("keeps the copy when the agent has edited it since our last sync (hashes differ)", () => {
    expect(shouldHydrateWorkFile({ exists: true, pending: false, currentHash: "new", syncedHash: "old" })).toBe(false);
  });

  it("keeps the copy when there's no recorded synced hash to trust", () => {
    expect(shouldHydrateWorkFile({ exists: true, pending: false, currentHash: "h", syncedHash: null })).toBe(false);
  });
});

describe("pendingRequiresReplay", () => {
  it("marks pending on a hub WRITE failure (a local revision needs replay)", () => {
    expect(pendingRequiresReplay({ readFailed: false, writeFailed: true })).toBe(true);
  });

  it("does NOT mark pending on a read-only failure (no local revision to replay)", () => {
    // The regression: a transient read failure with a clean working copy must not create .pending,
    // or the next healthy run would skip hydration and could apply the stale copy over newer hub edits.
    expect(pendingRequiresReplay({ readFailed: true, writeFailed: false })).toBe(false);
  });

  it("marks pending if a write failed even when a read also failed", () => {
    expect(pendingRequiresReplay({ readFailed: true, writeFailed: true })).toBe(true);
  });
});

describe("trackGateDegradations", () => {
  const makeStore = () => {
    const calls = { setCanonical: [] as string[], saveDoc: [] as string[] };
    return {
      store: {
        setCanonical: async (c: string) => void calls.setCanonical.push(c),
        saveDoc: async (c: string) => void calls.saveDoc.push(c),
      },
      calls,
    };
  };

  it("read failure: re-throws and flags readFailed, without touching the local store", async () => {
    const { store, calls } = makeStore();
    const t = trackGateDegradations({ readCanonical: async () => { throw new Error("hub down"); }, applyRevision: async () => {} }, store);
    await expect(t.gate.readCanonical()).rejects.toThrow("hub down"); // re-throws ⇒ waitCycle takes its local fallback
    expect(t.readFailed()).toBe(true);
    expect(t.writeFailed()).toBe(false);
    expect(calls.setCanonical).toEqual([]); // the wrapper itself persists nothing on a read failure…
    expect(calls.saveDoc).toEqual([]); // …so no spurious local revision ⇒ no .pending
  });

  it("write failure: persists the edit locally, flags writeFailed, does NOT re-throw", async () => {
    const { store, calls } = makeStore();
    let logged = "";
    const t = trackGateDegradations(
      { readCanonical: async () => "CANON", applyRevision: async () => { throw new Error("post failed"); } },
      store,
      (m) => { logged = m; },
    );
    await expect(t.gate.applyRevision("EDIT")).resolves.toBeUndefined(); // swallowed ⇒ the turn still completes
    expect(t.writeFailed()).toBe(true);
    expect(t.readFailed()).toBe(false);
    expect(calls.setCanonical).toEqual(["EDIT"]); // preserve-and-retry: the edit is kept locally…
    expect(calls.saveDoc).toEqual(["EDIT"]);
    expect(logged).toContain("post failed");
  });

  it("success: delegates to the real gate and flags nothing", async () => {
    const { store, calls } = makeStore();
    const applied: string[] = [];
    const t = trackGateDegradations({ readCanonical: async () => "CANON", applyRevision: async (md) => void applied.push(md) }, store);
    expect(await t.gate.readCanonical()).toBe("CANON");
    await t.gate.applyRevision("X");
    expect(applied).toEqual(["X"]);
    expect(t.readFailed()).toBe(false);
    expect(t.writeFailed()).toBe(false);
    expect(calls.setCanonical).toEqual([]); // no local persistence on the happy path
  });
});

// `exitAfterFlush` SCHEDULES an exit rather than performing one, so a fail-fast turn no longer stops
// its caller by itself. This is the decision that has to stop it — and it is the one that protects
// the working copy, which on `confirm_required` holds the agent's pending edit and nothing else does.
describe("postTurnAction", () => {
  const healthy = { readFailed: false, writeFailed: false };

  it("stops on a fail-fast outcome, so the re-sync can't race the pending exit", () => {
    expect(postTurnAction("exiting", healthy)).toBe("stop");
  });

  it("stops on a fail-fast outcome even when the hub also degraded", () => {
    // `stop` must win outright: `keep-local` writes a `.pending` marker, which is still a mutation
    // on behalf of a turn that already reported failure.
    for (const d of [{ readFailed: true, writeFailed: false }, { readFailed: false, writeFailed: true }, { readFailed: true, writeFailed: true }]) {
      expect(postTurnAction("exiting", d), JSON.stringify(d)).toBe("stop");
    }
  });

  it("keeps local edits when the hub dropped mid-turn", () => {
    expect(postTurnAction("ok", { readFailed: true, writeFailed: false })).toBe("keep-local");
    expect(postTurnAction("ok", { readFailed: false, writeFailed: true })).toBe("keep-local");
    expect(postTurnAction("ok", { readFailed: true, writeFailed: true })).toBe("keep-local");
  });

  it("re-syncs only on a healthy turn", () => {
    expect(postTurnAction("ok", healthy)).toBe("resync");
  });

  it("is total: every outcome × degradation pair yields exactly one action", () => {
    const actions = new Set<string>();
    for (const outcome of ["ok", "exiting"] as const)
      for (const readFailed of [true, false])
        for (const writeFailed of [true, false]) actions.add(postTurnAction(outcome, { readFailed, writeFailed }));
    expect([...actions].sort()).toEqual(["keep-local", "resync", "stop"]);
  });
});
