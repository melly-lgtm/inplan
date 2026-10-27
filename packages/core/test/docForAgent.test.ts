// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { docForAgent, unwrapAnchors, stripAnchors, serializeCanonical, parse, type ParsedDocument } from "../src";

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
  it("unwraps bracketed link text too, so no dangling link is left behind", () => {
    expect(unwrapAnchors("[A [x]](#cmt-aaa111) [B](#cmt-bbb222)", new Set(["cmt-aaa111"]))).toBe("A [x] [B](#cmt-bbb222)");
  });
  it("unwraps only the listed id when anchors are nested, keeping the other's link", () => {
    expect(unwrapAnchors("[Use [PG](#cmt-aaa111) now](#cmt-bbb222)", new Set(["cmt-aaa111"]))).toBe("[Use PG now](#cmt-bbb222)");
  });
  it("skips an anchor inside code, so a documentation example survives removal of its id", () => {
    expect(unwrapAnchors("Guide `[x](#cmt-aaa111)`", new Set(["cmt-aaa111"]))).toBe("Guide `[x](#cmt-aaa111)`");
  });
});

describe("stripAnchors", () => {
  // The reported case: anchoring a comment to the `# ` heading rewrites it in place, and the title
  // derived from it then carried the raw Markdown into every document list.
  it("unwraps a heading that is entirely one anchor", () => {
    expect(stripAnchors("[Auto multilingual mobile keyboard](#cmt-wp1927)")).toBe("Auto multilingual mobile keyboard");
  });
  it("unwraps EVERY anchor, needing no id set (unlike unwrapAnchors)", () => {
    expect(stripAnchors("See [here](#cmt-aaa111) and [there](#cmt-bbb222).")).toBe("See here and there.");
  });
  it("matches ids case-insensitively", () => {
    expect(stripAnchors("[x](#cmt-AbC123)")).toBe("x");
  });
  it("leaves ordinary Markdown links alone — only `#cmt-` hrefs are inplan's machinery", () => {
    const text = "Read [the docs](https://example.com) and [#cmt-notalink](#section).";
    expect(stripAnchors(text)).toBe(text);
  });
  it("leaves text with no anchors untouched", () => {
    expect(stripAnchors("Plain title")).toBe("Plain title");
    expect(stripAnchors("")).toBe("");
  });
  it("an empty link text unwraps to nothing, so a caller's fallback can take over", () => {
    expect(stripAnchors("[](#cmt-abc123)")).toBe("");
  });

  // The anchor wraps a VERBATIM span of the body, so the link text can itself contain brackets:
  // anchoring a comment to `# Release [v2]` yields `# [Release [v2]](#cmt-id)`. Such an anchor was
  // detectable (ANCHOR_LINK_RE needs only the `](#cmt-id)` tail) but not unwrappable, so it counted
  // toward integrity while being silently skipped here.
  it("unwraps link text containing brackets", () => {
    expect(stripAnchors("[Release [v2]](#cmt-abc123)")).toBe("Release [v2]");
    expect(stripAnchors("[a [b] c](#cmt-xyz789)")).toBe("a [b] c");
  });
  it("keeps adjacent anchors separate rather than swallowing the text between them", () => {
    expect(stripAnchors("[a](#cmt-aaa111) and [b](#cmt-bbb222)")).toBe("a and b");
  });
  it("handles brackets nested to any depth", () => {
    expect(stripAnchors("[deep [a [b] c] d](#cmt-ddd444)")).toBe("deep [a [b] c] d");
  });
  // Placing a comment over an already-anchored span nests one anchor inside another's text, so a
  // single pass would unwrap the outer and leave the inner's raw Markdown behind.
  it("unwraps an anchor nested inside another anchor's text", () => {
    expect(stripAnchors("[Use [Postgres](#cmt-aaa111) for storage](#cmt-bbb222)")).toBe("Use Postgres for storage");
  });
  // Detection already ignores anchors in code (see extractAnchorIdList) because they're
  // documentation examples. Unwrapping has to agree, or it would corrupt the example.
  it("leaves `#cmt-` links inside inline code alone, matching what detection counts", () => {
    expect(stripAnchors("Guide `[anchor](#cmt-abc123)`")).toBe("Guide `[anchor](#cmt-abc123)`");
    expect(stripAnchors("Guide `[x](#cmt-aaa111)` and [real](#cmt-bbb222)")).toBe("Guide `[x](#cmt-aaa111)` and real");
  });
  it("leaves anchors inside a fenced block alone", () => {
    expect(stripAnchors("```\n[x](#cmt-aaa111)\n```\n\n[real](#cmt-bbb222)")).toBe("```\n[x](#cmt-aaa111)\n```\n\nreal");
  });
  // The `](#cmt-id)` tail is inside a code span while the opening `[` is outside it. Only the
  // check at the closing bracket catches this — the backward scan skips code and would happily
  // pair the tail with that outside `[`, splicing the text and leaving a stray backtick.
  it("leaves an anchor alone when only its TAIL is inside code", () => {
    const text = "[foo`](#cmt-abc123)`";
    expect(stripAnchors(text)).toBe(text);
  });
  it("leaves an unbalanced tail alone rather than guessing where the link starts", () => {
    const text = "no open bracket here](#cmt-abc123)";
    expect(stripAnchors(text)).toBe(text);
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
