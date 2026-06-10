// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pure clipboard helpers: which comment threads a copied fragment carries, how they're
// re-IDed on paste, and the text/html (de)serialization that smuggles them through the
// system clipboard.

import type { Comment } from "@inplan/core";
import { describe, expect, it } from "vitest";
import { anchorIdsIn, buildClipHtml, readClipHtml, remapComments, rewriteAnchors, threadsFor } from "../src/clipboard";

const c = (over: Partial<Comment> & { id: string }): Comment => ({
  author: "Human <h@x>",
  date: "2026-06-08T00:00:00Z",
  resolved: false,
  text: "",
  ...over,
});

describe("anchorIdsIn", () => {
  it("returns the ids of complete anchor links only", () => {
    const frag = "see [this](#cmt-aaa111) and [that](#cmt-bbb222) here";
    expect(anchorIdsIn(frag)).toEqual(["cmt-aaa111", "cmt-bbb222"]);
  });

  it("ignores a dangling href whose opening label bracket was clipped off", () => {
    // The selection started mid-anchor: "](#cmt-ccc333)" has no leading `[label]`.
    expect(anchorIdsIn("orphan](#cmt-ccc333) tail")).toEqual([]);
  });

  it("returns an empty array when the fragment has no anchors", () => {
    expect(anchorIdsIn("plain text, no links")).toEqual([]);
  });
});

describe("threadsFor", () => {
  const comments: Comment[] = [
    c({ id: "cmt-root1", text: "root one" }),
    c({ id: "cmt-rep1a", parentId: "cmt-root1", text: "reply to root1" }),
    c({ id: "cmt-rep1b", parentId: "cmt-rep1a", text: "nested reply" }),
    c({ id: "cmt-root2", text: "root two" }),
    c({ id: "cmt-rep2a", parentId: "cmt-root2", text: "reply to root2" }),
    c({ id: "cmt-other", text: "unrelated root" }),
  ];

  it("collects a root plus all transitive descendants, in document order", () => {
    const got = threadsFor(["cmt-root1"], comments).map((x) => x.id);
    expect(got).toEqual(["cmt-root1", "cmt-rep1a", "cmt-rep1b"]);
  });

  it("collects multiple threads and excludes unrelated comments", () => {
    const got = threadsFor(["cmt-root1", "cmt-root2"], comments).map((x) => x.id);
    expect(got).toEqual(["cmt-root1", "cmt-rep1a", "cmt-rep1b", "cmt-root2", "cmt-rep2a"]);
    expect(got).not.toContain("cmt-other");
  });

  it("returns empty for ids not present", () => {
    expect(threadsFor(["cmt-missing"], comments)).toEqual([]);
  });
});

describe("remapComments", () => {
  it("re-IDs every comment, avoids taken ids, and remaps parentId references", () => {
    const carried: Comment[] = [
      c({ id: "cmt-root1", text: "root" }),
      c({ id: "cmt-rep1a", parentId: "cmt-root1", text: "reply" }),
    ];
    const taken = new Set(["cmt-root1", "cmt-rep1a", "cmt-zzz999"]);
    const { comments, idMap } = remapComments(carried, taken);

    // New ids, none colliding with taken or each other.
    const newIds = comments.map((x) => x.id);
    expect(new Set(newIds).size).toBe(2);
    for (const id of newIds) expect(taken.has(id)).toBe(false);

    // idMap covers both old ids; the reply's parentId points at the root's NEW id.
    expect(idMap.get("cmt-root1")).toBe(comments[0]!.id);
    expect(idMap.get("cmt-rep1a")).toBe(comments[1]!.id);
    expect(comments[1]!.parentId).toBe(comments[0]!.id);

    // Non-id fields are preserved.
    expect(comments[0]!.text).toBe("root");
  });

  it("leaves a parentId pointing outside the carried set untouched", () => {
    const carried: Comment[] = [c({ id: "cmt-rep", parentId: "cmt-elsewhere", text: "r" })];
    const { comments } = remapComments(carried, new Set());
    expect(comments[0]!.parentId).toBe("cmt-elsewhere");
  });
});

describe("rewriteAnchors", () => {
  it("rewrites mapped hrefs and leaves unmapped ones alone", () => {
    const idMap = new Map([["cmt-old111", "cmt-new111"]]);
    const frag = "a [x](#cmt-old111) b [y](#cmt-keep00) c";
    expect(rewriteAnchors(frag, idMap)).toBe("a [x](#cmt-new111) b [y](#cmt-keep00) c");
  });
});

describe("buildClipHtml / readClipHtml", () => {
  it("round-trips a payload through the text/html representation", () => {
    const comments: Comment[] = [c({ id: "cmt-root1", text: "café — naïve 🙂", question: { multiSelect: false, choices: [{ label: "A" }] } })];
    const html = buildClipHtml("hello [x](#cmt-root1) world", comments);
    expect(html).toContain("hello"); // the visible text survives, escaped
    const payload = readClipHtml(html);
    expect(payload?.v).toBe(1);
    expect(payload?.comments).toEqual(comments);
  });

  it("escapes HTML-special characters in the visible text", () => {
    const html = buildClipHtml("a < b & c > d \"q\"", [c({ id: "cmt-root1" })]);
    expect(html).toContain("a &lt; b &amp; c &gt; d &quot;q&quot;");
  });

  it("returns null for foreign html with no inplan marker", () => {
    expect(readClipHtml("<p>just some copied html</p>")).toBeNull();
  });

  it("returns null when the embedded payload is malformed", () => {
    expect(readClipHtml('<span data-inplan-clip="not-base64-@@@"></span>')).toBeNull();
  });
});
