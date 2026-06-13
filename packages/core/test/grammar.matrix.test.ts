// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import {
  parse,
  serialize,
  serializeCanonical,
  orderComments,
  docForAgent,
  checkIntegrity,
  unwrapAnchors,
  extractAnchorIds,
  type Comment,
  type ParsedDocument,
} from "../src";

/** Compact comment factory mirroring the rest of the core suite. */
const c = (id: string, over: Partial<Comment> = {}): Comment => ({
  id,
  text: `text ${id}`,
  author: "Tester <t@inplan.ai>",
  date: "2026-06-08T00:00:00Z",
  resolved: false,
  ...over,
});

// ───────────────────────────────────────────────────────────────────────────
// parse ↔ serialize round-trip, all comment fields
// ───────────────────────────────────────────────────────────────────────────
describe("parse ↔ serialize round-trip preserves every comment field", () => {
  it("preserves agent:false, may_resolve, question, selected, parentId, anchor across a full round-trip", () => {
    const doc: ParsedDocument = {
      version: 1,
      body: "# Plan\n\nUse [Postgres](#cmt-span01) for storage.",
      comments: [
        // span comment (anchored to a body link)
        { id: "cmt-span01", author: "Dana <dana@example.com>", date: "2026-05-28T13:34:00Z", resolved: false, text: "Why not SQLite?" },
        // question payload (agent -> human)
        {
          id: "cmt-ques01",
          anchor: "doc",
          author: "Opus 4.8 <claude@inplan.ai>",
          date: "2026-05-28T13:35:00Z",
          resolved: false,
          text: "Which targets?",
          question: { multiSelect: true, choices: [{ label: "macOS", description: "" }, { label: "Windows", description: "primary" }] },
        },
        // answer reply carrying `selected`
        { id: "cmt-ans001", parentId: "cmt-ques01", author: "Dana <dana@example.com>", date: "2026-05-28T13:36:00Z", resolved: false, text: "go simple", selected: ["macOS"] },
        // reply carrying may_resolve (agent's resolve suggestion)
        { id: "cmt-rep001", parentId: "cmt-span01", author: "Opus 4.8 <claude@inplan.ai>", date: "2026-05-28T13:40:00Z", resolved: false, text: "Adopted Postgres.", may_resolve: true },
        // a memo (agent:false) and a doc-level comment
        { id: "cmt-memo01", anchor: "doc", author: "Dana <dana@example.com>", date: "2026-05-28T13:41:00Z", resolved: true, text: "note to self", agent: false },
      ],
    };
    expect(parse(serialize(doc))).toEqual(doc);
  });

  it("round-trips a single-select question (multiSelect:false) and an empty selected[]", () => {
    const doc: ParsedDocument = {
      version: 1,
      body: "Pick [one](#cmt-qq0001).",
      comments: [
        { id: "cmt-qq0001", author: "Agent <agent@inplan>", date: "2026-06-01T00:00:00Z", resolved: false, text: "Choose:", question: { multiSelect: false, choices: [{ label: "A" }] } },
        { id: "cmt-aa0001", parentId: "cmt-qq0001", author: "You", date: "2026-06-01T00:00:01Z", resolved: false, text: "none", selected: [] },
      ],
    };
    expect(parse(serialize(doc))).toEqual(doc);
  });

  it("round-trips a document with no comments (empty data block)", () => {
    const doc: ParsedDocument = { version: 1, body: "# Just a body\n\nNo comments.", comments: [] };
    expect(parse(serialize(doc))).toEqual(doc);
  });

  it("round-trips an empty body (serialize emits a leading newline, parse strips trailing space)", () => {
    const doc: ParsedDocument = { version: 1, body: "", comments: [] };
    const round = parse(serialize(doc));
    expect(round.body).toBe("");
    expect(round.comments).toEqual([]);
  });

  it("round-trips unicode + emoji in body and comment text", () => {
    const doc: ParsedDocument = {
      version: 1,
      body: "# 計画 🚀\n\nUse [데이터베이스](#cmt-uni001) — café ☕.",
      comments: [{ id: "cmt-uni001", author: "박 <p@example.com>", date: "2026-06-01T00:00:00Z", resolved: false, text: "왜 안 돼요? 🤔" }],
    };
    expect(parse(serialize(doc))).toEqual(doc);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// version marker
// ───────────────────────────────────────────────────────────────────────────
describe("the <!--inplan vN--> version marker", () => {
  it("serialize stamps v1 on the marker", () => {
    expect(serialize({ body: "b", comments: [] })).toContain("<!--inplan v1");
  });

  it("serialize honors an explicit version on the doc", () => {
    expect(serialize({ version: 7, body: "b", comments: [] })).toContain("<!--inplan v7");
  });

  it("parse reads an explicit version token without consuming the JSON", () => {
    const doc = parse('text\n\n<!--inplan v2\n[ { "id": "cmt-ver002", "author": "x", "date": "d", "resolved": false, "text": "v2" } ]\n-->\n');
    expect(doc.version).toBe(2);
    expect(doc.comments.map((x) => x.id)).toEqual(["cmt-ver002"]);
  });

  it("parse defaults a version-less legacy block to version 1", () => {
    const doc = parse('text\n\n<!--inplan\n[ { "id": "cmt-leg001", "author": "x", "date": "d", "resolved": false, "text": "legacy" } ]\n-->\n');
    expect(doc.version).toBe(1);
    expect(doc.comments.map((x) => x.id)).toEqual(["cmt-leg001"]);
  });

  it("parse defaults to version 1 for a document with no data block at all", () => {
    expect(parse("# plain markdown\n").version).toBe(1);
  });

  it("a multi-digit version round-trips through serialize → parse", () => {
    expect(parse(serialize({ version: 12, body: "b", comments: [] })).version).toBe(12);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// fenced-code example block must NOT be mistaken for the real data block
// ───────────────────────────────────────────────────────────────────────────
describe("a fenced-code example block is not mistaken for the real data block", () => {
  it("ignores an <!--inplan block inside a fence and uses the real one below it", () => {
    const md = [
      "# Doc documenting its own format",
      "",
      "```markdown",
      "<!--inplan",
      '[ { "id": "cmt-examp1", "author": "x", "date": "d", "resolved": false, "text": "example only" } ]',
      "-->",
      "```",
      "",
      "Body with [a span](#cmt-real01).",
      "",
      "<!--inplan v1",
      '[ { "id": "cmt-real01", "author": "Dana", "date": "d", "resolved": false, "text": "the real comment" } ]',
      "-->",
      "",
    ].join("\n");
    const doc = parse(md);
    expect(doc.comments.map((x) => x.id)).toEqual(["cmt-real01"]);
    expect(doc.body).toContain("```markdown");
    expect(doc.body).toContain("# Doc documenting its own format");
  });

  it("ignores a tilde-fenced (~~~) example block too", () => {
    const md = ["~~~", "<!--inplan", "[]", "-->", "~~~", "", "Real [span](#cmt-real02).", "", "<!--inplan", '[ { "id": "cmt-real02", "author": "x", "date": "d", "resolved": false, "text": "r" } ]', "-->", ""].join("\n");
    const doc = parse(md);
    expect(doc.comments.map((x) => x.id)).toEqual(["cmt-real02"]);
    expect(doc.body).toContain("~~~");
  });

  it("treats a document whose only <!--inplan lives inside a fence as having no data block", () => {
    const md = ["Some prose.", "", "```", "<!--inplan", '[ { "id": "cmt-x" } ]', "-->", "```", ""].join("\n");
    const doc = parse(md);
    expect(doc.comments).toEqual([]);
    expect(doc.body).toContain("<!--inplan"); // the fenced example stays in the body
  });
});

// ───────────────────────────────────────────────────────────────────────────
// serializeCanonical: byte-identical regardless of input order
// ───────────────────────────────────────────────────────────────────────────
describe("serializeCanonical is byte-identical regardless of input order", () => {
  const comments: Comment[] = [
    c("cmt-rep1b0", { parentId: "cmt-root01", date: "2026-06-08T00:00:05Z" }),
    c("cmt-root02", { date: "2026-06-08T00:00:03Z" }),
    c("cmt-rep1a0", { parentId: "cmt-root01", date: "2026-06-08T00:00:02Z" }),
    c("cmt-root01", { date: "2026-06-08T00:00:01Z" }),
  ];

  it("produces identical bytes for any input permutation", () => {
    const a = serializeCanonical({ body: "# B\n\nx", comments });
    const b = serializeCanonical({ body: "# B\n\nx", comments: [...comments].reverse() });
    const cc = serializeCanonical({ body: "# B\n\nx", comments: [comments[2]!, comments[0]!, comments[3]!, comments[1]!] });
    expect(b).toBe(a);
    expect(cc).toBe(a);
  });

  it("re-serializing a reparsed canonical doc is a fixpoint", () => {
    const text = serializeCanonical({ body: "# B\n\nx", comments });
    expect(serializeCanonical(parse(text))).toBe(text);
  });

  it("imposes a canonical FIELD order independent of source key order", () => {
    const a: Comment = { resolved: false, text: "t", id: "cmt-aaa111", author: "x", date: "2026-06-08T00:00:01Z" } as Comment;
    const b: Comment = { id: "cmt-aaa111", date: "2026-06-08T00:00:01Z", author: "x", text: "t", resolved: false };
    expect(serializeCanonical({ body: "b", comments: [a] })).toBe(serializeCanonical({ body: "b", comments: [b] }));
  });
});

// ───────────────────────────────────────────────────────────────────────────
// orderComments: stable depth-first (date,id) walk
// ───────────────────────────────────────────────────────────────────────────
describe("orderComments is a stable depth-first (date, id) walk", () => {
  it("orders roots by (date, id), grouping replies under their parent in (date, id) order", () => {
    const ordered = orderComments([
      c("cmt-rep1b0", { parentId: "cmt-root01", date: "2026-06-08T00:00:05Z" }),
      c("cmt-root02", { date: "2026-06-08T00:00:03Z" }),
      c("cmt-rep1a0", { parentId: "cmt-root01", date: "2026-06-08T00:00:02Z" }),
      c("cmt-root01", { date: "2026-06-08T00:00:01Z" }),
    ]);
    expect(ordered.map((x) => x.id)).toEqual(["cmt-root01", "cmt-rep1a0", "cmt-rep1b0", "cmt-root02"]);
  });

  it("tiebreaks equal dates by id and is order-independent", () => {
    const items = [
      c("cmt-zzz999", { date: "2026-06-08T00:00:02Z" }),
      c("cmt-aaa111", { date: "2026-06-08T00:00:02Z" }),
      c("cmt-mmm555", { date: "2026-06-08T00:00:01Z" }),
    ];
    const a = orderComments(items).map((x) => x.id);
    expect(a).toEqual(orderComments([...items].reverse()).map((x) => x.id));
    expect(a).toEqual(["cmt-mmm555", "cmt-aaa111", "cmt-zzz999"]);
  });

  it("treats an orphan reply (absent parent) as a root, dropping/duplicating nothing", () => {
    const ordered = orderComments([
      c("cmt-orph01", { parentId: "cmt-gone00", date: "2026-06-08T00:00:09Z" }),
      c("cmt-root01", { date: "2026-06-08T00:00:01Z" }),
    ]);
    expect(ordered).toHaveLength(2);
    expect(new Set(ordered.map((x) => x.id))).toEqual(new Set(["cmt-orph01", "cmt-root01"]));
  });

  it("survives a 2-cycle, emitting each comment exactly once", () => {
    const ordered = orderComments([
      c("cmt-aaa111", { parentId: "cmt-bbb222" }),
      c("cmt-bbb222", { parentId: "cmt-aaa111" }),
    ]);
    expect(ordered).toHaveLength(2);
    expect(new Set(ordered.map((x) => x.id))).toEqual(new Set(["cmt-aaa111", "cmt-bbb222"]));
  });

  it("survives a 3-cycle and emits each member once", () => {
    const ordered = orderComments([
      c("cmt-aaa111", { parentId: "cmt-ccc333" }),
      c("cmt-bbb222", { parentId: "cmt-aaa111" }),
      c("cmt-ccc333", { parentId: "cmt-bbb222" }),
    ]);
    expect(ordered).toHaveLength(3);
    expect(new Set(ordered.map((x) => x.id))).toEqual(new Set(["cmt-aaa111", "cmt-bbb222", "cmt-ccc333"]));
  });

  it("returns an empty array for empty input", () => {
    expect(orderComments([])).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// integrity
// ───────────────────────────────────────────────────────────────────────────
describe("checkIntegrity accepts valid documents and rejects malformed ones", () => {
  it("accepts a valid doc: unique span links, doc comment + reply with no links, parent present", () => {
    const doc: ParsedDocument = {
      body: "Use [Postgres](#cmt-span01) here.",
      comments: [
        { id: "cmt-span01", author: "h", date: "d1", resolved: false, text: "span" },
        { id: "cmt-rep001", parentId: "cmt-span01", author: "h", date: "d2", resolved: false, text: "reply" },
        { id: "cmt-doc001", anchor: "doc", author: "h", date: "d3", resolved: false, text: "doc-level" },
      ],
    };
    const r = checkIntegrity(doc);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it("flags a dangling link (anchor with no matching comment)", () => {
    const r = checkIntegrity({ body: "[x](#cmt-gone00)", comments: [] });
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.code)).toContain("dangling_link");
  });

  it("flags duplicate comment ids", () => {
    const r = checkIntegrity({
      body: "[a](#cmt-dup001)",
      comments: [
        { id: "cmt-dup001", author: "h", date: "d", resolved: false, text: "one" },
        { id: "cmt-dup001", author: "h", date: "d", resolved: false, text: "two" },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.map((e) => e.code)).toContain("duplicate_id");
  });

  it("flags a span comment whose in-body link is missing", () => {
    const r = checkIntegrity({ body: "no link here", comments: [{ id: "cmt-span01", author: "h", date: "d", resolved: false, text: "span" }] });
    expect(r.errors.map((e) => e.code)).toContain("span_missing_link");
  });

  it("flags a span comment with duplicate (more than one) in-body links", () => {
    const r = checkIntegrity({ body: "[a](#cmt-span01) and again [b](#cmt-span01)", comments: [{ id: "cmt-span01", author: "h", date: "d", resolved: false, text: "span" }] });
    expect(r.errors.map((e) => e.code)).toContain("span_duplicate_link");
  });

  it("flags a non-span comment (doc/reply) that wrongly carries a link", () => {
    const r = checkIntegrity({
      body: "[a](#cmt-doc001)",
      comments: [{ id: "cmt-doc001", anchor: "doc", author: "h", date: "d", resolved: false, text: "doc" }],
    });
    expect(r.errors.map((e) => e.code)).toContain("nonspan_has_link");
  });

  it("flags a reply whose parent is missing", () => {
    const r = checkIntegrity({ body: "x", comments: [{ id: "cmt-rep001", parentId: "cmt-gone00", author: "h", date: "d", resolved: false, text: "orphan" }] });
    expect(r.errors.map((e) => e.code)).toContain("missing_parent");
  });

  it("flags a malformed comment id", () => {
    const r = checkIntegrity({ body: "[a](#cmt-bad)", comments: [{ id: "BAD_ID", author: "h", date: "d", resolved: false, text: "x" }] });
    expect(r.errors.map((e) => e.code)).toContain("malformed_id");
  });

  it("flags a link that targets a non-span (doc-level) comment", () => {
    const r = checkIntegrity({
      body: "[a](#cmt-doc001)",
      comments: [{ id: "cmt-doc001", anchor: "doc", author: "h", date: "d", resolved: false, text: "doc" }],
    });
    expect(r.errors.map((e) => e.code)).toContain("link_targets_nonspan");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// unwrapAnchors edge cases
// ───────────────────────────────────────────────────────────────────────────
describe("unwrapAnchors edge cases", () => {
  it("unwraps only listed ids, leaving other anchors intact", () => {
    const body = "See [here](#cmt-aaa111) and [there](#cmt-bbb222).";
    expect(unwrapAnchors(body, new Set(["cmt-aaa111"]))).toBe("See here and [there](#cmt-bbb222).");
  });

  it("is a no-op for an empty id set", () => {
    const body = "[x](#cmt-aaa111)";
    expect(unwrapAnchors(body, new Set())).toBe(body);
  });

  it("matches case-insensitively in BOTH the body and the id set", () => {
    expect(unwrapAnchors("[x](#cmt-AbC123)", new Set(["cmt-abc123"]))).toBe("x");
    expect(unwrapAnchors("[y](#cmt-def456)", new Set(["CMT-DEF456"]))).toBe("y");
  });

  it("does not unwrap on a partial / non-matching id", () => {
    const body = "[x](#cmt-abc123)";
    expect(unwrapAnchors(body, new Set(["cmt-abc"]))).toBe(body); // partial prefix is not a match
    expect(unwrapAnchors(body, new Set(["cmt-abc1234"]))).toBe(body); // longer is not a match
    expect(unwrapAnchors(body, new Set(["cmt-zzz999"]))).toBe(body); // unrelated id
  });

  it("unwraps every occurrence of a repeated anchor", () => {
    expect(unwrapAnchors("[a](#cmt-aaa111) x [b](#cmt-aaa111)", new Set(["cmt-aaa111"]))).toBe("a x b");
  });

  it("returns the body unchanged when no anchors are present", () => {
    expect(unwrapAnchors("plain text, no anchors", new Set(["cmt-aaa111"]))).toBe("plain text, no anchors");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// extractAnchorIds (supporting integrity / anchoring grammar)
// ───────────────────────────────────────────────────────────────────────────
describe("extractAnchorIds", () => {
  it("collects distinct, lowercased ids and ignores anchors inside code", () => {
    const body = "Real [a](#cmt-AAA111) and [b](#cmt-bbb222). `inline [c](#cmt-ccc333)` and:\n```\n[d](#cmt-ddd444)\n```\n";
    expect(extractAnchorIds(body)).toEqual(new Set(["cmt-aaa111", "cmt-bbb222"]));
  });

  it("returns an empty set for a body with no anchors", () => {
    expect(extractAnchorIds("nothing here")).toEqual(new Set());
  });
});

// ───────────────────────────────────────────────────────────────────────────
// docForAgent
// ───────────────────────────────────────────────────────────────────────────
describe("docForAgent removes memo subtrees and unwraps span-memo anchors", () => {
  const doc: ParsedDocument = {
    body: "Intro. A [flagged span](#cmt-span01) and a normal [span](#cmt-keep01).",
    comments: [
      { id: "cmt-doc001", anchor: "doc", author: "h", date: "2026-06-13T00:00:00Z", resolved: false, text: "memo to teammates", agent: false },
      { id: "cmt-rep001", parentId: "cmt-doc001", author: "h", date: "2026-06-13T00:01:00Z", resolved: false, text: "reply on the memo" },
      { id: "cmt-span01", author: "h", date: "2026-06-13T00:02:00Z", resolved: false, text: "a span memo", agent: false },
      { id: "cmt-keep01", author: "h", date: "2026-06-13T00:03:00Z", resolved: false, text: "talk to the agent" },
    ],
  };

  it("drops memos + their replies and unwraps the span-memo anchor; keeps agent-facing comments", () => {
    const agentDoc = docForAgent(doc);
    expect(agentDoc.comments.map((x) => x.id)).toEqual(["cmt-keep01"]);
    expect(agentDoc.body).toBe("Intro. A flagged span and a normal [span](#cmt-keep01).");
  });

  it("removes a memo's descendants transitively (deep reply chains can't leak)", () => {
    const nested: ParsedDocument = {
      body: "Body.",
      comments: [
        { id: "cmt-memo00", anchor: "doc", author: "h", date: "2026-06-13T00:00:00Z", resolved: false, text: "memo root", agent: false },
        { id: "cmt-rep1", parentId: "cmt-memo00", author: "h", date: "2026-06-13T00:01:00Z", resolved: false, text: "reply" },
        { id: "cmt-rep2", parentId: "cmt-rep1", author: "h", date: "2026-06-13T00:02:00Z", resolved: false, text: "reply2" },
        { id: "cmt-rep3", parentId: "cmt-rep2", author: "h", date: "2026-06-13T00:03:00Z", resolved: false, text: "reply3" },
        { id: "cmt-keep", anchor: "doc", author: "h", date: "2026-06-13T00:04:00Z", resolved: false, text: "unrelated" },
      ],
    };
    expect(docForAgent(nested).comments.map((x) => x.id)).toEqual(["cmt-keep"]);
  });

  it("is a referential no-op (returns the same object) when there are no memos", () => {
    const clean: ParsedDocument = { body: "x", comments: [{ id: "cmt-keep01", anchor: "doc", author: "h", date: "d", resolved: false, text: "hi" }] };
    expect(docForAgent(clean)).toBe(clean);
  });

  it("treats absent/true agent as agent-facing (not a memo)", () => {
    const d: ParsedDocument = {
      body: "[a](#cmt-aaa111) [b](#cmt-bbb222)",
      comments: [
        { id: "cmt-aaa111", author: "h", date: "d", resolved: false, text: "no agent field" },
        { id: "cmt-bbb222", author: "h", date: "d", resolved: false, text: "agent true", agent: true },
      ],
    };
    expect(docForAgent(d)).toBe(d); // no memos → identical reference, body untouched
  });
});
