// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The agent never sets `resolved` — it flags `may_resolve` on the thread's last comment. The app
// reads that: auto-resolve on ⇒ resolve those threads (autoResolveSuggested); off ⇒ a badge
// (suggestsResolve). A later human reply (a new last comment without the flag) clears the suggestion.

import { describe, expect, it } from "vitest";
import type { Comment, ParsedDocument } from "@inplan/core";
import { autoResolveSuggested, buildThreads, lastComment, suggestsResolve } from "../src/docOps";

const C = (over: Partial<Comment> & { id: string; date: string }): Comment => ({
  author: "a",
  resolved: false,
  text: "t",
  ...over,
});

describe("may_resolve — agent resolve suggestion", () => {
  it("suggestsResolve is true when the thread's LAST comment is may_resolve and unresolved", () => {
    const thread = buildThreads([
      C({ id: "cmt-root", date: "2026-01-01T00:00:01Z" }),
      C({ id: "cmt-r1", parentId: "cmt-root", date: "2026-01-01T00:00:02Z", may_resolve: true }),
    ])[0]!;
    expect(lastComment(thread).id).toBe("cmt-r1");
    expect(suggestsResolve(thread)).toBe(true);
  });

  it("a later human reply (newest comment, no flag) clears the suggestion", () => {
    const thread = buildThreads([
      C({ id: "cmt-root", date: "2026-01-01T00:00:01Z" }),
      C({ id: "cmt-r1", parentId: "cmt-root", date: "2026-01-01T00:00:02Z", may_resolve: true }),
      C({ id: "cmt-r2", parentId: "cmt-root", date: "2026-01-01T00:00:03Z" }), // human reply, newest
    ])[0]!;
    expect(lastComment(thread).id).toBe("cmt-r2");
    expect(suggestsResolve(thread)).toBe(false);
  });

  it("an already-resolved thread is never suggested", () => {
    const thread = buildThreads([C({ id: "cmt-root", date: "2026-01-01T00:00:01Z", resolved: true, may_resolve: true })])[0]!;
    expect(suggestsResolve(thread)).toBe(false);
  });

  it("autoResolveSuggested resolves the suggested threads' roots; idempotent; null when none", () => {
    const doc: ParsedDocument = {
      body: "body",
      comments: [
        C({ id: "cmt-a", date: "2026-01-01T00:00:01Z" }),
        C({ id: "cmt-a1", parentId: "cmt-a", date: "2026-01-01T00:00:02Z", may_resolve: true }),
        C({ id: "cmt-b", date: "2026-01-01T00:00:03Z" }), // not suggested
      ],
    };
    const next = autoResolveSuggested(doc)!;
    expect(next).not.toBeNull();
    const byId = Object.fromEntries(next.comments.map((c) => [c.id, c]));
    expect(byId["cmt-a"]!.resolved).toBe(true); // the root is resolved
    expect(byId["cmt-b"]!.resolved).toBe(false);
    expect(autoResolveSuggested(next)).toBeNull(); // nothing left to resolve
  });
});
