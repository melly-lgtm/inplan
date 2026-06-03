// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { spanCommentBlocker } from "../src/docOps";

describe("spanCommentBlocker", () => {
  it("returns null for an empty/whitespace selection (→ doc-level comment)", () => {
    expect(spanCommentBlocker("hello world", "")).toBeNull();
    expect(spanCommentBlocker("hello world", "   ")).toBeNull();
  });

  it("returns null for a normal, anchorable, non-overlapping selection", () => {
    expect(spanCommentBlocker("the quick brown fox", "quick brown")).toBeNull();
  });

  it("flags 'overlap' when the selection intersects an existing comment anchor", () => {
    const body = "See [the plan](#cmt-abc123) for details.";
    expect(spanCommentBlocker(body, "the plan")).toBe("overlap");
  });

  it("flags 'overlap' for the full label of an existing anchor", () => {
    const body = "intro [anchored text](#cmt-zz9aa1) trailing";
    expect(spanCommentBlocker(body, "anchored text")).toBe("overlap");
  });

  it("flags 'not-found' when the selection isn't a contiguous source substring", () => {
    expect(spanCommentBlocker("hello world", "nowhere to be seen")).toBe("not-found");
  });

  it("allows a selection adjacent to (but not overlapping) an anchor", () => {
    const body = "before [linked](#cmt-abc123) after the end";
    expect(spanCommentBlocker(body, "after the end")).toBeNull();
  });
});
