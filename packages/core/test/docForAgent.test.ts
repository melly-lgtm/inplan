// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { docForAgent, unwrapAnchors, serializeCanonical, parse, type ParsedDocument } from "../src";

describe("unwrapAnchors", () => {
  it("unwraps only the listed ids; leaves other anchors + non-matching text intact", () => {
    const body = "See [here](#cmt-aaa111) and [there](#cmt-bbb222).";
    expect(unwrapAnchors(body, new Set(["cmt-aaa111"]))).toBe("See here and [there](#cmt-bbb222).");
    expect(unwrapAnchors(body, new Set())).toBe(body); // no-op
  });
  it("matches ids case-insensitively in BOTH the body and the id set", () => {
    expect(unwrapAnchors("[x](#cmt-AbC123)", new Set(["cmt-abc123"]))).toBe("x"); // upper in body
    expect(unwrapAnchors("[y](#cmt-def456)", new Set(["CMT-DEF456"]))).toBe("y"); // upper in the set
  });
});

describe("docForAgent", () => {
  const doc: ParsedDocument = {
    body: "Intro. A [flagged span](#cmt-span01) and a normal [span](#cmt-keep01).",
    comments: [
      { id: "cmt-doc001", anchor: "doc", author: "h", date: "2026-06-13T00:00:00Z", resolved: false, text: "a memo to teammates", agent: false },
      { id: "cmt-rep001", parentId: "cmt-doc001", author: "h", date: "2026-06-13T00:01:00Z", resolved: false, text: "reply on the memo" },
      { id: "cmt-span01", author: "h", date: "2026-06-13T00:02:00Z", resolved: false, text: "a span memo", agent: false },
      { id: "cmt-keep01", author: "h", date: "2026-06-13T00:03:00Z", resolved: false, text: "talk to the agent" },
    ],
  };

  it("removes memos + their replies and unwraps span-memo anchors; keeps agent-facing comments", () => {
    const agentDoc = docForAgent(doc);
    expect(agentDoc.comments.map((c) => c.id)).toEqual(["cmt-keep01"]); // memo, its reply, and the span memo gone
    expect(agentDoc.body).toBe("Intro. A flagged span and a normal [span](#cmt-keep01)."); // span-memo anchor unwrapped, kept one intact
  });

  it("removes a memo's descendants transitively (reply-of-reply chains can't leak)", () => {
    const nested: ParsedDocument = {
      body: "Body.",
      comments: [
        { id: "cmt-memo00", anchor: "doc", author: "h", date: "2026-06-13T00:00:00Z", resolved: false, text: "memo root", agent: false },
        { id: "cmt-rep1", parentId: "cmt-memo00", author: "h", date: "2026-06-13T00:01:00Z", resolved: false, text: "reply" },
        { id: "cmt-rep2", parentId: "cmt-rep1", author: "h", date: "2026-06-13T00:02:00Z", resolved: false, text: "reply of reply" },
        { id: "cmt-rep3", parentId: "cmt-rep2", author: "h", date: "2026-06-13T00:03:00Z", resolved: false, text: "reply of reply of reply" },
        { id: "cmt-keep", anchor: "doc", author: "h", date: "2026-06-13T00:04:00Z", resolved: false, text: "unrelated" },
      ],
    };
    expect(docForAgent(nested).comments.map((c) => c.id)).toEqual(["cmt-keep"]); // entire memo subtree gone
  });

  it("returns the doc unchanged when there are no memos", () => {
    const clean: ParsedDocument = { body: "x", comments: [{ id: "cmt-keep01", anchor: "doc", author: "h", date: "2026-06-13T00:00:00Z", resolved: false, text: "hi" }] };
    expect(docForAgent(clean)).toBe(clean);
  });
});

describe("comment.agent round-trips through serialize/parse", () => {
  it("preserves agent:false (a memo) across a canonical serialize → parse", () => {
    const doc: ParsedDocument = {
      body: "Body.",
      comments: [{ id: "cmt-memo01", anchor: "doc", author: "h", date: "2026-06-13T00:00:00Z", resolved: false, text: "memo", agent: false }],
    };
    const round = parse(serializeCanonical(doc));
    expect(round.comments[0]!.agent).toBe(false);
  });
});
