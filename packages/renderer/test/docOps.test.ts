// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { addSpanComment, deleteComment, findSpanRange } from "../src/docOps";
import type { ParsedDocument } from "@inplan/core";

describe("findSpanRange — source-span scoping (preview block disambiguation)", () => {
  // "an ma" renders identically inside source `inplan` makes AND inside "human marks".
  const body = "Use `inplan` makes sense.\n\nThe human marks it later.\n";

  it("without a span hint, verbatim wrongly matches the later plain occurrence", () => {
    const r = findSpanRange(body, "an ma")!;
    expect(body.slice(r.start, r.end)).toBe("an ma"); // verbatim — inside "human marks"
    expect(r.start).toBeGreaterThan(body.indexOf("human")); // the wrong, later spot
  });

  it("with the clicked line's span, it anchors at the markup'd occurrence (crossing the code boundary)", () => {
    const r = findSpanRange(body, "an ma", { startLine: 0, endLine: 0 })!;
    expect(body.slice(r.start, r.end)).toBe("an` ma"); // source range spans the closing backtick
    expect(r.start).toBeLessThan(body.indexOf("human")); // earlier than the decoy
  });

  it("a bogus (negative / fractional) span never crashes — it falls back to a global search", () => {
    expect(() => findSpanRange(body, "an ma", { startLine: -1, endLine: -5 })).not.toThrow();
    // negative bounds clamp out of the way; the global fallback still finds the text
    const r = findSpanRange(body, "an ma", { startLine: -1, endLine: -5 })!;
    expect(body.slice(r.start, r.end)).toBe("an ma");
    expect(findSpanRange(body, "an ma", { startLine: 1.5, endLine: 9.9 })).not.toBeNull();
  });
});

describe("addSpanComment across formatting boundaries round-trips (balanced)", () => {
  const fields = { text: "c", author: "me" };
  it.each([
    ["code span", "Use `inplan` makes sense.\n", "an ma"],
    ["bold", "say **hi there** ok\n", "hi there ok"],
    ["italic→plain", "a *b c* d\n", "b c d"],
  ])("%s: insert then delete restores the exact source", (_label, body, sel) => {
    const r = addSpanComment({ body, comments: [] }, sel, fields, { startLine: 0, endLine: 0 })!;
    expect(r).not.toBeNull();
    expect(r.doc.body).toContain("](#cmt-"); // a link was anchored
    expect(deleteComment(r.doc, r.id).body).toBe(body); // balanced ⇒ exact round-trip
  });
});

describe("findSpanRange", () => {
  it("matches a verbatim selection", () => {
    const body = "Pick the storage backend now.";
    expect(findSpanRange(body, "storage backend")).toEqual({ start: 9, end: 24 });
  });

  it("matches a selection across inline markdown markup", () => {
    const body = "toggle showing resolved *and* orphaned comments";
    // The preview selection has no asterisks; the source does.
    const r = findSpanRange(body, "showing resolved and orphaned");
    expect(r).not.toBeNull();
    expect(body.slice(r!.start, r!.end)).toBe("showing resolved *and* orphaned");
  });

  it("matches across markup AND collapsed whitespace", () => {
    const body = "tasks are stored *locally*\nin a single file";
    const r = findSpanRange(body, "stored locally in a single file");
    expect(r).not.toBeNull();
    const span = body.slice(r!.start, r!.end);
    expect(span.startsWith("stored")).toBe(true);
    expect(span.endsWith("file")).toBe(true);
  });

  it("returns null when the text isn't present", () => {
    expect(findSpanRange("nothing here", "missing phrase")).toBeNull();
  });
});

describe("addSpanComment", () => {
  it("wraps the original source span (with markup) in the anchor link", () => {
    const doc: ParsedDocument = { body: "toggle showing resolved *and* orphaned comments", comments: [] };
    const res = addSpanComment(doc, "showing resolved and orphaned", { text: "hi", author: "You" });
    expect(res).not.toBeNull();
    expect(res!.doc.body).toContain("[showing resolved *and* orphaned](#" + res!.id + ")");
    expect(res!.doc.comments).toHaveLength(1);
  });
});
