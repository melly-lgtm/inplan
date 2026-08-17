// SPDX-License-Identifier: AGPL-3.0-or-later
//
// merge3 — the stale-proposal review merge (proposals v1). The properties pinned here are the
// review-safety ones: a proposal's edits replay onto the current canonical without losing the
// canonical's own unrelated changes, and a genuine conflict resolves to the PROPOSAL so the
// reviewer sees the contested hunk against today's document (rejecting restores canonical).

import { describe, it, expect } from "vitest";
import { merge3 } from "../src/merge3";

const doc = (...lines: string[]) => lines.join("\n");

describe("merge3", () => {
  it("all equal → unchanged", () => {
    const b = doc("a", "b", "c");
    expect(merge3(b, b, b)).toBe(b);
  });

  it("only the proposal changed → the proposal", () => {
    const base = doc("a", "b", "c");
    const theirs = doc("a", "B!", "c");
    expect(merge3(base, base, theirs)).toBe(theirs);
  });

  it("only the canonical changed → the canonical (the proposal contributed nothing to lose)", () => {
    const base = doc("a", "b", "c");
    const ours = doc("a", "b2", "c");
    expect(merge3(base, ours, base)).toBe(ours);
  });

  it("non-overlapping edits combine — the canonical's own change survives the replay", () => {
    const base = doc("a", "b", "c", "d", "e");
    const ours = doc("A!", "b", "c", "d", "e"); // canonical edited line 1
    const theirs = doc("a", "b", "c", "d", "E!"); // proposal edited line 5
    expect(merge3(base, ours, theirs)).toBe(doc("A!", "b", "c", "d", "E!"));
  });

  it("both sides made the SAME change → applied once", () => {
    const base = doc("a", "b", "c");
    const same = doc("a", "B!", "c");
    expect(merge3(base, same, same)).toBe(same);
  });

  it("a genuine conflict resolves to the proposal (the reviewer decides via the hunk)", () => {
    const base = doc("a", "b", "c");
    const ours = doc("a", "b-ours", "c");
    const theirs = doc("a", "b-theirs", "c");
    expect(merge3(base, ours, theirs)).toBe(doc("a", "b-theirs", "c"));
  });

  it("proposal insertions and canonical deletions in different regions both land", () => {
    const base = doc("a", "b", "c", "d");
    const ours = doc("a", "c", "d"); // canonical deleted b
    const theirs = doc("a", "b", "c", "d", "e"); // proposal appended e
    expect(merge3(base, ours, theirs)).toBe(doc("a", "c", "d", "e"));
  });

  it("an insertion at the edge of the other side's change is one region, decided as a whole", () => {
    // Interleaving line-by-line here could stitch half of each side together; the region policy
    // hands the whole ambiguity to the proposal, whose hunk the reviewer then judges.
    const base = doc("a", "b", "c");
    const ours = doc("a", "b", "x", "c"); // canonical inserted x after b
    const theirs = doc("a", "B!", "c"); // proposal rewrote b (touching the same boundary)
    expect(merge3(base, ours, theirs)).toBe(doc("a", "B!", "c"));
  });

  it("empty base: both sides' content is a conflict → the proposal", () => {
    expect(merge3("", "ours", "theirs")).toBe("theirs");
  });

  it("trailing-region changes after the last common line merge cleanly", () => {
    const base = doc("a", "b");
    const ours = doc("a", "b", "c-ours"); // canonical appended
    const theirs = doc("A!", "b"); // proposal edited the head
    expect(merge3(base, ours, theirs)).toBe(doc("A!", "b", "c-ours"));
  });
});
