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

  it("ADJACENT replacements on different sides are independent — both land, never a conflict", () => {
    // [0,1) and [1,2) share only a boundary point; treating them as one region would hand the
    // canonical's line-1 edit to the proposal and silently drop it.
    const base = doc("a", "b", "c");
    const ours = doc("A!", "b", "c"); // canonical replaced line 1
    const theirs = doc("a", "B!", "c"); // proposal replaced the ADJACENT line 2
    expect(merge3(base, ours, theirs)).toBe(doc("A!", "B!", "c"));
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

  it("a small edit in a large document merges without quadratic blowup (prefix/suffix trim)", () => {
    // 20k lines with one edit per side near opposite ends: the untrimmed O(n·m) LCS matrix here
    // is 400M cells — this must complete instantly because the DP only ever sees the changed
    // middle between the common prefix and suffix.
    const lines = Array.from({ length: 20_000 }, (_, i) => `line ${i}`);
    const base = lines.join("\n");
    const ours = [...lines.slice(0, 5), "OURS EDIT", ...lines.slice(6)].join("\n");
    const theirs = [...lines.slice(0, 19_990), "THEIRS EDIT", ...lines.slice(19_991)].join("\n");
    const started = performance.now();
    const merged = merge3(base, ours, theirs);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(merged).toContain("OURS EDIT");
    expect(merged).toContain("THEIRS EDIT");
    expect(merged.split("\n")).toHaveLength(20_000);
  });

  it("trailing-region changes after the last common line merge cleanly", () => {
    const base = doc("a", "b");
    const ours = doc("a", "b", "c-ours"); // canonical appended
    const theirs = doc("A!", "b"); // proposal edited the head
    expect(merge3(base, ours, theirs)).toBe(doc("A!", "b", "c-ours"));
  });
});
