// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { checkIntegrity } from "../src/integrity";
import type { ParsedDocument } from "../src/types";

function codes(doc: ParsedDocument): string[] {
  return checkIntegrity(doc).errors.map((e) => e.code).sort();
}

describe("checkIntegrity", () => {
  it("accepts a valid document", () => {
    const doc: ParsedDocument = {
      body: "Use [Postgres](#cmt-abc123). Overall fine.",
      comments: [
        { id: "cmt-abc123", author: "a", date: "d", resolved: false, text: "?" },
        { id: "cmt-rep001", parentId: "cmt-abc123", author: "a", date: "d", resolved: false, text: "reply" },
        { id: "cmt-doc001", anchor: "doc", author: "a", date: "d", resolved: false, text: "doc" },
      ],
    };
    const r = checkIntegrity(doc);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it("rejects a span comment with no link", () => {
    const doc: ParsedDocument = {
      body: "no links here",
      comments: [{ id: "cmt-abc123", author: "a", date: "d", resolved: false, text: "?" }],
    };
    expect(codes(doc)).toContain("span_missing_link");
  });

  it("rejects a span comment with duplicate links", () => {
    const doc: ParsedDocument = {
      body: "[a](#cmt-abc123) and [b](#cmt-abc123)",
      comments: [{ id: "cmt-abc123", author: "a", date: "d", resolved: false, text: "?" }],
    };
    expect(codes(doc)).toContain("span_duplicate_link");
  });

  it("rejects a reply that carries a link", () => {
    const doc: ParsedDocument = {
      body: "[x](#cmt-abc123) [y](#cmt-rep001)",
      comments: [
        { id: "cmt-abc123", author: "a", date: "d", resolved: false, text: "?" },
        { id: "cmt-rep001", parentId: "cmt-abc123", author: "a", date: "d", resolved: false, text: "reply" },
      ],
    };
    expect(codes(doc)).toContain("nonspan_has_link");
  });

  it("rejects dangling links", () => {
    const doc: ParsedDocument = { body: "[x](#cmt-zzzzzz)", comments: [] };
    expect(codes(doc)).toContain("dangling_link");
  });

  it("rejects duplicate ids", () => {
    const doc: ParsedDocument = {
      body: "[x](#cmt-abc123)",
      comments: [
        { id: "cmt-abc123", author: "a", date: "d", resolved: false, text: "?" },
        { id: "cmt-abc123", anchor: "doc", author: "a", date: "d", resolved: false, text: "dup" },
      ],
    };
    expect(codes(doc)).toContain("duplicate_id");
  });

  it("rejects a missing parent", () => {
    const doc: ParsedDocument = {
      body: "no links",
      comments: [{ id: "cmt-rep001", parentId: "cmt-nope00", author: "a", date: "d", resolved: false, text: "reply" }],
    };
    expect(codes(doc)).toContain("missing_parent");
  });

  it("ignores anchor links inside fenced code examples", () => {
    const doc: ParsedDocument = {
      body: ["Real [span](#cmt-abc123).", "", "```markdown", "Example [x](#cmt-zzzzzz) inside a fence.", "```"].join("\n"),
      comments: [{ id: "cmt-abc123", author: "a", date: "d", resolved: false, text: "?" }],
    };
    // cmt-zzzzzz is only inside the fence, so it must NOT be flagged as dangling.
    const r = checkIntegrity(doc);
    expect(r.ok).toBe(true);
  });

  it("rejects a malformed id", () => {
    const doc: ParsedDocument = {
      body: "",
      comments: [{ id: "bad-id", anchor: "doc", author: "a", date: "d", resolved: false, text: "x" }],
    };
    expect(codes(doc)).toContain("malformed_id");
  });
});
