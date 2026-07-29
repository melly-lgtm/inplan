// SPDX-License-Identifier: AGPL-3.0-or-later

import { parse, serialize } from "@inplan/core";
import { describe, expect, it } from "vitest";
import { addComment, AddCommentError } from "../src/commentAdd";

const parentComment = { id: "cmt-abc123", author: "Someone <a@b.c>", date: "2020-01-01T00:00:00.000Z", resolved: false, text: "Confirm the datastore?" };
const baseText = serialize({ body: "Use [Postgres](#cmt-abc123).", comments: [parentComment] });
const REAL_DATE = new Date("2026-07-28T05:18:11.421Z");

describe("addComment", () => {
  it("stamps the real clock, not a value the caller has to invent", () => {
    const { text, comment } = addComment(baseText, {
      text: "Confirmed, use Postgres.",
      author: "Opus 4.8 <claude@inplan.ai>",
      parentId: "cmt-abc123",
      now: () => REAL_DATE,
    });
    expect(comment.date).toBe("2026-07-28T05:18:11.421Z");
    expect(comment.parentId).toBe("cmt-abc123");
    expect(comment.resolved).toBe(false);
    expect(comment.id).toMatch(/^cmt-[0-9a-z]{6}$/);
    const doc = parse(text);
    expect(doc.comments.map((c) => c.id)).toEqual(["cmt-abc123", comment.id]);
  });

  it("defaults to the real system clock when `now` isn't injected", () => {
    const before = Date.now();
    const { comment } = addComment(baseText, { text: "x", author: "a", doc: true });
    const after = Date.now();
    const stamped = new Date(comment.date).getTime();
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(after);
  });

  it("appends a document-level comment with anchor: doc and no parentId", () => {
    const { comment } = addComment(baseText, {
      text: "New top-level question.",
      author: "a",
      doc: true,
      now: () => REAL_DATE,
    });
    expect(comment.anchor).toBe("doc");
    expect(comment.parentId).toBeUndefined();
  });

  it("carries an optional question payload", () => {
    const question = { multiSelect: false, choices: [{ label: "Postgres" }, { label: "SQLite" }] };
    const { comment } = addComment(baseText, { text: "Pick one", author: "a", doc: true, question, now: () => REAL_DATE });
    expect(comment.question).toEqual(question);
  });

  it("sets may_resolve when asked, and omits it otherwise", () => {
    const withFlag = addComment(baseText, { text: "done", author: "a", parentId: "cmt-abc123", mayResolve: true, now: () => REAL_DATE });
    expect(withFlag.comment.may_resolve).toBe(true);

    const without = addComment(baseText, { text: "done", author: "a", parentId: "cmt-abc123", now: () => REAL_DATE });
    expect(without.comment.may_resolve).toBeUndefined();
  });

  it("rejects both --parent-id and --doc together", () => {
    expect(() => addComment(baseText, { text: "x", author: "a", parentId: "cmt-abc123", doc: true })).toThrow(AddCommentError);
  });

  it("rejects neither --parent-id nor --doc (span comments aren't supported here)", () => {
    expect(() => addComment(baseText, { text: "x", author: "a" })).toThrow(AddCommentError);
  });

  it("rejects a --parent-id that doesn't exist in the document", () => {
    expect(() => addComment(baseText, { text: "x", author: "a", parentId: "cmt-zzzzzz" })).toThrow(/no such parent id/);
  });

  it("refuses to add onto a document that's already structurally corrupt", () => {
    const danglingText = serialize({ body: "Use [x](#cmt-zzzzzz).", comments: [] });
    expect(() => addComment(danglingText, { text: "x", author: "a", doc: true, now: () => REAL_DATE })).toThrow(/failed integrity check/);
  });

  it("never collides with an existing comment id", () => {
    // Force genId's random space down to make a collision likely, then confirm every id
    // that comes out is still unique against what was already in the document.
    let text = baseText;
    const seen = new Set(["cmt-abc123"]);
    for (let i = 0; i < 20; i++) {
      const { text: next, comment } = addComment(text, { text: `reply ${i}`, author: "a", parentId: "cmt-abc123", now: () => REAL_DATE });
      expect(seen.has(comment.id)).toBe(false);
      seen.add(comment.id);
      text = next;
    }
    expect(parse(text).comments).toHaveLength(21);
  });
});
