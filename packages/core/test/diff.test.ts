// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { detectLostComments, findOrphans } from "../src/diff";
import type { ParsedDocument } from "../src/types";

const comment = { id: "cmt-abc123", author: "a", date: "d", resolved: false, text: "?" };

describe("findOrphans", () => {
  it("flags a span comment with no link", () => {
    const doc: ParsedDocument = { body: "no links", comments: [comment] };
    expect(findOrphans(doc).map((c) => c.id)).toEqual(["cmt-abc123"]);
  });

  it("does not flag an anchored span comment", () => {
    const doc: ParsedDocument = { body: "[x](#cmt-abc123)", comments: [comment] };
    expect(findOrphans(doc)).toEqual([]);
  });

  it("does not flag replies or doc comments", () => {
    const doc: ParsedDocument = {
      body: "no links",
      comments: [
        { id: "cmt-rep001", parentId: "cmt-abc123", author: "a", date: "d", resolved: false, text: "r" },
        { id: "cmt-doc001", anchor: "doc", author: "a", date: "d", resolved: false, text: "d" },
      ],
    };
    expect(findOrphans(doc)).toEqual([]);
  });
});

describe("detectLostComments", () => {
  it("detects a link removed between versions", () => {
    const prev: ParsedDocument = { body: "[x](#cmt-abc123)", comments: [comment] };
    const next: ParsedDocument = { body: "the span was deleted", comments: [comment] };
    expect(detectLostComments(prev, next).map((c) => c.id)).toEqual(["cmt-abc123"]);
  });

  it("treats cut & paste (link moved) as not lost", () => {
    const prev: ParsedDocument = { body: "intro [x](#cmt-abc123) end", comments: [comment] };
    const next: ParsedDocument = { body: "end [x](#cmt-abc123) intro", comments: [comment] };
    expect(detectLostComments(prev, next)).toEqual([]);
  });

  it("does not re-report comments already orphaned in prev", () => {
    const prev: ParsedDocument = { body: "already no link", comments: [comment] };
    const next: ParsedDocument = { body: "still no link", comments: [comment] };
    expect(detectLostComments(prev, next)).toEqual([]);
  });
});
