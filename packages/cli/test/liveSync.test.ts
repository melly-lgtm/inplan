// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { shouldHydrateWorkFile, pendingRequiresReplay } from "../src/liveSync";

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
