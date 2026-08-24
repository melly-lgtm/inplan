// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The precedence between the three wait outcomes (#110). These are combinations of signals rather
// than whole wait cycles, which is why the decision is a pure function: driving the interesting
// case end-to-end would need a presence heartbeat to go false mid-cycle AND the presence grace
// short-circuited, neither of which a MemoryControlChannel run can express.

import { describe, expect, it } from "vitest";
import { resolveWaitStatus } from "../src/cli";

describe("resolveWaitStatus", () => {
  it("a logged close wins outright, and carries its own reason", () => {
    expect(resolveWaitStatus({ closeReason: "window_closed", editorGone: true, hasActionable: true, locksEditor: true })).toEqual({
      status: "closed",
      reason: "window_closed",
    });
  });

  it("an unlogged disappearance with nothing to act on is crashed_or_killed", () => {
    expect(resolveWaitStatus({ closeReason: null, editorGone: true, hasActionable: false, locksEditor: true })).toEqual({
      status: "closed",
      reason: "crashed_or_killed",
    });
  });

  // The #110 regression. The human accepted a proposal and resolved a comment, then closed the tab:
  // `revision_accepted_all` + `comment_resolved` in `entries`, and presence gone. Reporting the
  // departure told the agent the session had crashed and threw the completed handoff away.
  it("a handoff OUTRANKS an unlogged disappearance — the completed turn is still reported", () => {
    expect(resolveWaitStatus({ closeReason: null, editorGone: true, hasActionable: true, locksEditor: true })).toEqual({ status: "your_turn" });
  });

  it("...and in a live (non-locking) mode that handoff reports activity, not your_turn", () => {
    expect(resolveWaitStatus({ closeReason: null, editorGone: true, hasActionable: true, locksEditor: false })).toEqual({ status: "activity" });
  });

  it("no close, no departure: the ordinary turn handoff", () => {
    expect(resolveWaitStatus({ closeReason: null, editorGone: false, hasActionable: true, locksEditor: true })).toEqual({ status: "your_turn" });
    expect(resolveWaitStatus({ closeReason: null, editorGone: false, hasActionable: true, locksEditor: false })).toEqual({ status: "activity" });
  });

  it("a close entry with no reason in its payload defaults to completed at the call site", () => {
    // waitCycle passes "completed" when the payload carries no reason; this pins that the function
    // reports whatever it is handed rather than second-guessing it.
    expect(resolveWaitStatus({ closeReason: "completed", editorGone: false, hasActionable: false, locksEditor: true })).toEqual({
      status: "closed",
      reason: "completed",
    });
  });
});
