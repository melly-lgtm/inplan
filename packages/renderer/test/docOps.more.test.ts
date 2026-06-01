// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Comment, ParsedDocument } from "@inplan/core";
import { describe, expect, it } from "vitest";
import { addAnswer, addDocComment, addReply, addSpanComment, buildThreads, deleteComment, editCommentText, findSpanRange, setResolved } from "../src/docOps";

const author = "You";
const base: ParsedDocument = { body: "The plan uses Postgres for storage.", comments: [] };

describe("docOps", () => {
  it("addSpanComment wraps the span + adds the comment, or returns null when the span is absent", () => {
    const r = addSpanComment(base, "Postgres", { author, text: "why?" });
    expect(r).not.toBeNull();
    expect(r!.doc.body).toContain(`[Postgres](#${r!.id})`);
    expect(r!.doc.comments).toHaveLength(1);
    expect(addSpanComment(base, "NOT PRESENT", { author, text: "x" })).toBeNull();
  });

  it("addSpanComment carries a question when provided", () => {
    const q = { multiSelect: false, choices: [{ label: "A", description: "" }] };
    const r = addSpanComment(base, "Postgres", { author, text: "pick", question: q });
    expect(r!.doc.comments[0]!.question).toEqual(q);
  });

  it("addDocComment adds an anchor:doc comment without changing the body", () => {
    const r = addDocComment(base, { author, text: "overall ok" });
    expect(r.doc.body).toBe(base.body);
    expect(r.doc.comments[0]).toMatchObject({ anchor: "doc", text: "overall ok" });
  });

  it("addReply and addAnswer attach to a parent", () => {
    expect(addReply(base, "cmt-p", "a reply", author).doc.comments[0]).toMatchObject({ parentId: "cmt-p", text: "a reply" });
    expect(addAnswer(base, "cmt-q", ["SQLite"], "go simple", author).doc.comments[0]).toMatchObject({ parentId: "cmt-q", selected: ["SQLite"], text: "go simple" });
  });

  it("setResolved and editCommentText update the targeted comment only", () => {
    const doc: ParsedDocument = { body: "x", comments: [{ id: "cmt-a", author, date: "d", resolved: false, text: "t" }] };
    expect(setResolved(doc, "cmt-a", true).comments[0]!.resolved).toBe(true);
    expect(editCommentText(doc, "cmt-a", "new").comments[0]!.text).toBe("new");
    expect(setResolved(doc, "cmt-missing", true).comments[0]!.resolved).toBe(false); // no-op on miss
  });

  it("deleteComment strips the anchor link and cascades to descendant replies", () => {
    const doc: ParsedDocument = {
      body: "Use [Postgres](#cmt-root) here.",
      comments: [
        { id: "cmt-root", author, date: "d", resolved: false, text: "root" },
        { id: "cmt-r1", parentId: "cmt-root", author, date: "d", resolved: false, text: "reply" },
        { id: "cmt-r2", parentId: "cmt-r1", author, date: "d", resolved: false, text: "nested" },
        { id: "cmt-other", author, date: "d", resolved: false, text: "unrelated" },
      ],
    };
    const out = deleteComment(doc, "cmt-root");
    expect(out.body).toBe("Use Postgres here.");
    expect(out.comments.map((c) => c.id)).toEqual(["cmt-other"]);
  });

  it("buildThreads groups each root with its descendant replies; doc comments are roots", () => {
    const comments: Comment[] = [
      { id: "cmt-root", author, date: "d", resolved: false, text: "root" },
      { id: "cmt-r1", parentId: "cmt-root", author, date: "d1", resolved: false, text: "r1" },
      { id: "cmt-r2", parentId: "cmt-r1", author, date: "d2", resolved: false, text: "r2 nested" },
      { id: "cmt-doc", anchor: "doc", author, date: "d", resolved: false, text: "doc-level" },
    ];
    const threads = buildThreads(comments);
    const root = threads.find((t) => t.root.id === "cmt-root")!;
    expect(root.replies.map((c) => c.id)).toEqual(["cmt-r1", "cmt-r2"]);
    expect(threads.some((t) => t.root.id === "cmt-doc")).toBe(true);
  });

  it("findSpanRange locates a substring or returns null", () => {
    expect(findSpanRange("abc def", "def")).toEqual({ start: 4, end: 7 });
    expect(findSpanRange("abc", "zzz")).toBeNull();
  });
});
