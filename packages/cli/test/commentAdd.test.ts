// SPDX-License-Identifier: AGPL-3.0-or-later

import { parse, serialize } from "@inplan/core";
import { describe, expect, it, vi } from "vitest";
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

  it.each([
    ["not an object", "just a string"],
    ["missing multiSelect", { choices: [{ label: "x" }] }],
    ["missing choices", { multiSelect: false }],
    ["multiSelect not a boolean", { multiSelect: "false", choices: [] }],
    ["choices not an array", { multiSelect: false, choices: "x" }],
    ["a choice missing label", { multiSelect: false, choices: [{ description: "no label" }] }],
    ["a null choice", { multiSelect: false, choices: [null] }],
    ["a choice with a non-string description", { multiSelect: false, choices: [{ label: "x", description: 1 }] }],
  ])("rejects a --question payload that's syntactically valid JSON but not shaped like a Question (%s)", (_case, question) => {
    expect(() => addComment(baseText, { text: "x", author: "a", doc: true, question, now: () => REAL_DATE })).toThrow(/must be shaped like/);
  });

  it("sets may_resolve when asked, and omits it otherwise", () => {
    const withFlag = addComment(baseText, { text: "done", author: "a", parentId: "cmt-abc123", mayResolve: true, now: () => REAL_DATE });
    expect(withFlag.comment.may_resolve).toBe(true);

    const without = addComment(baseText, { text: "done", author: "a", parentId: "cmt-abc123", now: () => REAL_DATE });
    expect(without.comment.may_resolve).toBeUndefined();
  });

  it.each([
    ["--parent-id + --doc", { parentId: "cmt-abc123", doc: true }],
    ["--parent-id + --span", { parentId: "cmt-abc123", span: "Postgres" }],
    ["--doc + --span", { doc: true, span: "Postgres" }],
  ])("rejects combining more than one of --parent-id/--doc/--span (%s)", (_case, extra) => {
    expect(() => addComment(baseText, { text: "x", author: "a", ...extra })).toThrow(/mutually exclusive/);
  });

  it("rejects when none of --parent-id/--doc/--span is given", () => {
    expect(() => addComment(baseText, { text: "x", author: "a" })).toThrow(AddCommentError);
  });

  it("rejects a --parent-id that doesn't exist in the document", () => {
    expect(() => addComment(baseText, { text: "x", author: "a", parentId: "cmt-zzzzzz" })).toThrow(/no such parent id/);
  });

  it("refuses to add onto a document that's already structurally corrupt, and says so rather than blaming the new comment", () => {
    const danglingText = serialize({ body: "Use [x](#cmt-zzzzzz).", comments: [] });
    expect(() => addComment(danglingText, { text: "x", author: "a", doc: true, now: () => REAL_DATE })).toThrow(
      /already had a structural problem before this call \(this comment didn't cause it\)/,
    );
  });

  describe("--span", () => {
    // A fresh, link-free body — baseText already has "Postgres" wrapped in cmt-abc123's own
    // link, which is exactly the overlap case exercised separately below.
    const plainText = serialize({ body: "Use Postgres for storage.", comments: [] });

    it("wraps the exact span text in a fresh anchor link, with no parentId/anchor field", () => {
      const { text, comment } = addComment(plainText, { text: "Confirm.", author: "a", span: "Postgres", now: () => REAL_DATE });
      expect(comment.parentId).toBeUndefined();
      expect(comment.anchor).toBeUndefined();
      const doc = parse(text);
      expect(doc.body).toBe(`Use [Postgres](#${comment.id}) for storage.`);
      expect(doc.comments.map((c) => c.id)).toEqual([comment.id]);
    });

    it("rejects span text that isn't in the body", () => {
      expect(() => addComment(plainText, { text: "x", author: "a", span: "SQLite", now: () => REAL_DATE })).toThrow(/not found in the body/);
    });

    it("rejects span text that appears more than once, rather than guessing", () => {
      const ambiguousText = serialize({ body: "Postgres or Postgres?", comments: [] });
      expect(() => addComment(ambiguousText, { text: "x", author: "a", span: "Postgres", now: () => REAL_DATE })).toThrow(/appears more than once/);
    });

    it("treats an empty --span the same as not passing --span at all", () => {
      expect(() => addComment(plainText, { text: "x", author: "a", span: "", now: () => REAL_DATE })).toThrow(
        /pass --parent-id .* --doc .* or --span/,
      );
    });

    it("refuses to add onto a document that's already structurally corrupt via --span too", () => {
      const danglingText = serialize({ body: "Use [x](#cmt-zzzzzz) for storage.", comments: [] });
      expect(() => addComment(danglingText, { text: "x", author: "a", span: "storage", now: () => REAL_DATE })).toThrow(
        /already had a structural problem before this call \(this comment didn't cause it\)/,
      );
    });
  });

  it("produces a distinct id on each of several sequential calls", () => {
    // genId's random space (36^6) makes a natural collision here astronomically unlikely, so this
    // is only a basic sanity check (ids come out distinct in normal repeated use) — it can't tell
    // a broken exclusion-set path from a working one. See the next test for that.
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

  it("retries when the random candidate collides with an existing comment id", () => {
    const collidingId = "cmt-000000"; // what an all-zero byte fill decodes to (0 % 36 = "0", ×6)
    const withCollisionTarget = serialize({
      body: "Use [Postgres](#cmt-abc123).",
      comments: [parentComment, { id: collidingId, parentId: "cmt-abc123", author: "a", date: "d", resolved: false, text: "existing" }],
    });
    const spy = vi.spyOn(globalThis.crypto, "getRandomValues");
    let call = 0;
    // @ts-expect-error — narrow test double, not the full getRandomValues overload set
    spy.mockImplementation((arr: Uint8Array) => {
      call++;
      arr.fill(call === 1 ? 0 : 1); // 1st candidate: all-zero bytes -> "cmt-000000" (collides, forces a retry); 2nd: all-one -> "cmt-111111"
      return arr;
    });
    try {
      const { comment } = addComment(withCollisionTarget, { text: "x", author: "a", parentId: "cmt-abc123", now: () => REAL_DATE });
      expect(comment.id).toBe("cmt-111111");
      expect(comment.id).not.toBe(collidingId);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });
});
