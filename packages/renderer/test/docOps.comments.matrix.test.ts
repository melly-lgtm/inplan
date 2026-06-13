// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import {
  addAnswer,
  addDocComment,
  addReply,
  addSpanComment,
  setResolved,
  spanCommentBlocker,
} from "../src/docOps";
import {
  isDocComment,
  isReply,
  isSpanComment,
  parse,
  serialize,
  type ParsedDocument,
  type Question,
} from "@inplan/core";

const author = "You <you@inplan.ai>";

// --- span comment: where it can / can't anchor --------------------------------

describe("addSpanComment — anchoring matrix", () => {
  it("anchors a plain verbatim selection and records the comment", () => {
    const doc: ParsedDocument = { body: "Pick the storage backend now.", comments: [] };
    const res = addSpanComment(doc, "storage backend", { text: "why?", author });
    expect(res).not.toBeNull();
    expect(res!.doc.body).toBe("Pick the [storage backend](#" + res!.id + ") now.");
    expect(res!.doc.comments).toHaveLength(1);
    const c = res!.doc.comments[0]!;
    expect(c.id).toBe(res!.id);
    expect(c.text).toBe("why?");
    expect(c.author).toBe(author);
    expect(c.resolved).toBe(false);
    expect(c.anchor).toBeUndefined(); // span comment, not doc-level
    expect(c.parentId).toBeUndefined();
    expect(isSpanComment(c)).toBe(true);
  });

  it("returns null when the selection text is not present (not-found)", () => {
    const doc: ParsedDocument = { body: "nothing here", comments: [] };
    expect(addSpanComment(doc, "missing phrase", { text: "x", author })).toBeNull();
  });

  it("anchors across inline markup (preview text lacks the asterisks)", () => {
    const doc: ParsedDocument = { body: "toggle showing resolved *and* orphaned comments", comments: [] };
    const res = addSpanComment(doc, "showing resolved and orphaned", { text: "hi", author });
    expect(res).not.toBeNull();
    expect(res!.doc.body).toContain("[showing resolved *and* orphaned](#" + res!.id + ")");
  });

  it("anchors a multi-line span (collapsed whitespace across a newline)", () => {
    const doc: ParsedDocument = { body: "tasks are stored locally\nin a single file", comments: [] };
    const res = addSpanComment(doc, "stored locally in a single file", { text: "note", author });
    expect(res).not.toBeNull();
    // The anchored label preserves the original newline between "locally" and "in".
    expect(res!.doc.body).toContain("[stored locally\nin a single file](#" + res!.id + ")");
    expect(res!.doc.comments).toHaveLength(1);
  });

  it("a duplicate identical phrase: the SourceSpan picks the clicked occurrence", () => {
    // "the plan" occurs twice; line 0 and line 2.
    const body = "the plan is good\n\nrewrite the plan soon";
    const doc: ParsedDocument = { body, comments: [] };
    const second = body.lastIndexOf("the plan");

    // No span ⇒ first occurrence is anchored.
    const first = addSpanComment(doc, "the plan", { text: "first", author })!;
    expect(first.doc.body.indexOf("[the plan](#")).toBeLessThan(second);

    // With the span of line 2, the SECOND occurrence is anchored.
    const scoped = addSpanComment(doc, "the plan", { text: "second", author }, { startLine: 2, endLine: 2 })!;
    expect(scoped.doc.body.indexOf("[the plan](#")).toBeGreaterThan(body.indexOf("good"));
  });
});

// --- spanCommentBlocker -------------------------------------------------------

describe("spanCommentBlocker", () => {
  const plain: ParsedDocument = { body: "Pick the storage backend now.", comments: [] };

  it("returns null for an anchorable selection", () => {
    expect(spanCommentBlocker(plain.body, "storage backend")).toBeNull();
  });

  it("returns null for an empty / whitespace-only selection (treated as doc-level)", () => {
    expect(spanCommentBlocker(plain.body, "")).toBeNull();
    expect(spanCommentBlocker(plain.body, "   \n\t ")).toBeNull();
  });

  it("returns 'not-found' when the selection isn't in the body", () => {
    expect(spanCommentBlocker(plain.body, "nope")).toBe("not-found");
  });

  it("returns 'overlap' when the selection intersects an existing anchor", () => {
    // Anchor "storage backend" first, then select a SUBSPAN ("backend") that still maps to
    // a source range inside the anchor label — wrapping it would nest links, so it's blocked.
    const res = addSpanComment(plain, "storage backend", { text: "first", author })!;
    expect(spanCommentBlocker(res.doc.body, "backend")).toBe("overlap");
    // A non-overlapping selection elsewhere is fine.
    expect(spanCommentBlocker(res.doc.body, "Pick")).toBeNull();
  });

  it("addSpanComment over an existing anchor is reported as overlap by the blocker", () => {
    const res = addSpanComment(plain, "storage backend", { text: "first", author })!;
    // The blocker is the gate the UI consults before offering a span comment.
    expect(spanCommentBlocker(res.doc.body, "storage backend")).toBe("overlap");
  });
});

// --- doc-level comments -------------------------------------------------------

describe("addDocComment", () => {
  it("adds a doc-level comment without touching the body", () => {
    const doc: ParsedDocument = { body: "Some plan body.", comments: [] };
    const res = addDocComment(doc, { text: "overall thought", author });
    expect(res.doc.body).toBe("Some plan body."); // body unchanged — no anchor link
    expect(res.doc.comments).toHaveLength(1);
    const c = res.doc.comments[0]!;
    expect(c.anchor).toBe("doc");
    expect(isDocComment(c)).toBe(true);
    expect(isSpanComment(c)).toBe(false);
    expect(c.text).toBe("overall thought");
    expect(c.resolved).toBe(false);
  });

  it("carries a question payload on a doc-level comment", () => {
    const question: Question = { multiSelect: false, choices: [{ label: "A" }, { label: "B", description: "the b option" }] };
    const res = addDocComment({ body: "x", comments: [] }, { text: "which?", author, question });
    expect(res.doc.comments[0]!.question).toEqual(question);
  });
});

// --- the MEMO flag (agent:false) ----------------------------------------------

describe("memo flag (agent:false)", () => {
  it("span comment: agent:false is persisted as a memo", () => {
    const res = addSpanComment({ body: "Pick the storage backend now.", comments: [] }, "storage backend", {
      text: "note to self",
      author,
      agent: false,
    })!;
    expect(res.doc.comments[0]!.agent).toBe(false);
  });

  it("doc comment: agent:false is persisted as a memo", () => {
    const res = addDocComment({ body: "x", comments: [] }, { text: "memo", author, agent: false });
    expect(res.doc.comments[0]!.agent).toBe(false);
  });

  it("agent omitted (talk-to-agent default): the field is NOT written", () => {
    const span = addSpanComment({ body: "Pick the storage backend now.", comments: [] }, "storage backend", { text: "ask", author })!;
    expect("agent" in span.doc.comments[0]!).toBe(false);
    const docc = addDocComment({ body: "x", comments: [] }, { text: "ask", author });
    expect("agent" in docc.doc.comments[0]!).toBe(false);
  });

  it("agent:true (explicit) is also not written — only false is materialized", () => {
    const docc = addDocComment({ body: "x", comments: [] }, { text: "ask", author, agent: true });
    expect("agent" in docc.doc.comments[0]!).toBe(false);
  });
});

// --- reply + answer -----------------------------------------------------------

describe("addReply / addAnswer", () => {
  it("addReply attaches a child reply (no anchor, no selected) to a thread", () => {
    const root = addDocComment({ body: "x", comments: [] }, { text: "root", author });
    const res = addReply(root.doc, root.id, "a reply", "Agent <a@inplan.ai>");
    expect(res.doc.comments).toHaveLength(2);
    const reply = res.doc.comments.find((c) => c.id === res.id)!;
    expect(reply.parentId).toBe(root.id);
    expect(reply.text).toBe("a reply");
    expect(reply.author).toBe("Agent <a@inplan.ai>");
    expect(reply.selected).toBeUndefined();
    expect(isReply(reply)).toBe(true);
  });

  it("addAnswer attaches a reply carrying the selected labels", () => {
    const question: Question = { multiSelect: true, choices: [{ label: "X" }, { label: "Y" }, { label: "Z" }] };
    const root = addDocComment({ body: "x", comments: [] }, { text: "pick any", author, question });
    const res = addAnswer(root.doc, root.id, ["X", "Z"], "and an other note", author);
    const ans = res.doc.comments.find((c) => c.id === res.id)!;
    expect(ans.parentId).toBe(root.id);
    expect(ans.selected).toEqual(["X", "Z"]);
    expect(ans.text).toBe("and an other note");
    expect(isReply(ans)).toBe(true);
  });

  it("addAnswer with an empty selection (none chosen) keeps an empty array", () => {
    const root = addDocComment({ body: "x", comments: [] }, { text: "pick", author });
    const res = addAnswer(root.doc, root.id, [], "", author);
    expect(res.doc.comments.find((c) => c.id === res.id)!.selected).toEqual([]);
  });
});

// --- resolve / reopen toggling ------------------------------------------------

describe("setResolved — toggling", () => {
  it("resolves then reopens a comment, leaving others untouched", () => {
    const a = addDocComment({ body: "x", comments: [] }, { text: "a", author });
    const b = addDocComment(a.doc, { text: "b", author });
    const resolved = setResolved(b.doc, a.id, true);
    expect(resolved.comments.find((c) => c.id === a.id)!.resolved).toBe(true);
    expect(resolved.comments.find((c) => c.id === b.id)!.resolved).toBe(false); // sibling unchanged
    const reopened = setResolved(resolved, a.id, false);
    expect(reopened.comments.find((c) => c.id === a.id)!.resolved).toBe(false);
  });

  it("toggling a non-existent id is a no-op", () => {
    const a = addDocComment({ body: "x", comments: [] }, { text: "a", author });
    const out = setResolved(a.doc, "cmt-zzzzzz", true);
    expect(out.comments).toEqual(a.doc.comments);
  });
});

// --- unique ids ---------------------------------------------------------------

describe("generated ids", () => {
  it("are well-formed and unique across many adds in one document", () => {
    let doc: ParsedDocument = { body: "Pick the storage backend now and pick it again later.", comments: [] };
    const ids = new Set<string>();
    // doc comments avoid body-anchor collisions, so we can add many freely.
    for (let i = 0; i < 50; i++) {
      const res = addDocComment(doc, { text: `c${i}`, author });
      doc = res.doc;
      expect(res.id).toMatch(/^cmt-[0-9a-z]{6}$/);
      expect(ids.has(res.id)).toBe(false); // never collides with an existing id
      ids.add(res.id);
    }
    expect(ids.size).toBe(50);
    expect(doc.comments.map((c) => c.id)).toEqual([...ids]);
  });

  it("a reply/answer id differs from its parent and siblings", () => {
    const root = addDocComment({ body: "x", comments: [] }, { text: "root", author });
    const r1 = addReply(root.doc, root.id, "r1", author);
    const r2 = addReply(r1.doc, root.id, "r2", author);
    expect(new Set([root.id, r1.id, r2.id]).size).toBe(3);
  });
});

// --- full round-trip ----------------------------------------------------------

describe("add → serialize → parse round-trip", () => {
  it("preserves every field including agent, selected, question, and the body anchor", () => {
    // Build a doc with: a span comment, a doc-level question, an answer, a reply,
    // a resolved comment, and a memo (agent:false) — exercising the full schema.
    let doc: ParsedDocument = { body: "Pick the storage backend now.", comments: [] };

    const span = addSpanComment(doc, "storage backend", { text: "anchored?", author })!;
    doc = span.doc;

    const question: Question = { multiSelect: true, choices: [{ label: "Postgres" }, { label: "SQLite", description: "embedded" }] };
    const q = addDocComment(doc, { text: "which backend?", author, question });
    doc = q.doc;

    const ans = addAnswer(doc, q.id, ["Postgres", "SQLite"], "either works", "Agent <a@inplan.ai>");
    doc = ans.doc;

    const reply = addReply(doc, span.id, "looks right", author);
    doc = reply.doc;

    const memo = addDocComment(doc, { text: "private note", author, agent: false });
    doc = memo.doc;

    // Resolve the span comment so the round-trip carries a resolved:true too.
    doc = setResolved(doc, span.id, true);

    const round = parse(serialize(doc));

    // Body (with the anchor link) survives.
    expect(round.body).toBe(doc.body);
    expect(round.body).toContain("[storage backend](#" + span.id + ")");

    // Comment count + ids preserved.
    expect(round.comments).toHaveLength(5);
    const byId = new Map(round.comments.map((c) => [c.id, c]));

    const spanC = byId.get(span.id)!;
    expect(spanC.text).toBe("anchored?");
    expect(spanC.resolved).toBe(true); // toggled before serialization
    expect(spanC.anchor).toBeUndefined();

    const qC = byId.get(q.id)!;
    expect(qC.anchor).toBe("doc");
    expect(qC.question).toEqual(question); // nested choices + description survive

    const ansC = byId.get(ans.id)!;
    expect(ansC.parentId).toBe(q.id);
    expect(ansC.selected).toEqual(["Postgres", "SQLite"]);
    expect(ansC.text).toBe("either works");
    expect(ansC.author).toBe("Agent <a@inplan.ai>");

    const replyC = byId.get(reply.id)!;
    expect(replyC.parentId).toBe(span.id);

    const memoC = byId.get(memo.id)!;
    expect(memoC.agent).toBe(false); // the memo flag survives the JSON round-trip

    // Full structural equality of the comment set (order-independent).
    expect([...byId.values()].sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      [...doc.comments].sort((a, b) => a.id.localeCompare(b.id)),
    );
  });

  it("round-trips a unicode span selection and comment text", () => {
    const doc: ParsedDocument = { body: "Adopt the café ☕ résumé policy.", comments: [] };
    const res = addSpanComment(doc, "café ☕ résumé", { text: "naïve? 日本語 ok", author })!;
    const round = parse(serialize(res.doc));
    expect(round.body).toContain("[café ☕ résumé](#" + res.id + ")");
    expect(round.comments[0]!.text).toBe("naïve? 日本語 ok");
  });

  it("stamps and preserves the data-block version on round-trip", () => {
    const res = addDocComment({ body: "x", comments: [] }, { text: "c", author });
    const round = parse(serialize(res.doc));
    expect(round.version).toBe(1);
  });
});
