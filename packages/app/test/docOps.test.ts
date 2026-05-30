// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { addSpanComment, findSpanRange } from "../src/renderer/docOps";
import type { ParsedDocument } from "@inplan/core";

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
