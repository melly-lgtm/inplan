// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A multi-line block typed into a plan document must READ in the preview the way it reads in
// the source pane: same number of lines, same columns, and no markdown plumbing on show. The
// reported document broke that in TWO places, and both are covered here.
//
// 1. AS A PARAGRAPH. Markdown's paragraph rule keeps the author's newlines in the token stream,
//    and markdown-it duly emits them inside the <p> — but HTML's default whitespace processing
//    collapses a newline, and every run of alignment spaces, down to a single space. A directory
//    tree pasted into a plan therefore arrived as one run-on line with its columns gone.
//
// 2. INSIDE A FENCE. The same tree also appears inside a ``` fence, carrying the same comment
//    anchor. CommonMark treats fence content as literal text, so `[label](#cmt-id)` written
//    there is not a link at all: markdown-it hands the renderer the raw characters and the
//    default fence renderer escapes them into the <code>. The reader saw the anchor SYNTAX as
//    if it were part of the code, and the comment had nothing to point at — no <a>/<span>
//    carrying data-cmt, so it was neither clickable in the preview nor reachable from the rail.
//
// These tests assert the property a READER cares about (how many lines, do the columns line up,
// is any markdown plumbing visible), not the shape of the markup: they take the rendered HTML
// and put it through the same whitespace processing the browser will, using the `white-space`
// the stylesheet actually declares for that kind of content. So they fail both when the
// renderer drops the newlines and when the stylesheet doesn't honor them.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { addSpanComment, spanCommentBlocker } from "../src/docOps";
import { renderMarkdown } from "../src/markdown";

const css = readFileSync(fileURLToPath(new URL("../src/styles.css", import.meta.url)), "utf8");

/** The `white-space` the stylesheet applies to a paragraph of rendered preview content. */
function previewParagraphWhiteSpace(): string {
  // Any rule whose selector list targets a <p> inside .ap-rendered (the preview's content root,
  // shared by the inline-diff view) and sets white-space.
  const re = /(?:^|\})([^{}]*\.ap-rendered[^{}]*\bp\b[^{}]*)\{([^}]*)\}/gm;
  let ws = "normal";
  for (const m of css.matchAll(re)) {
    const decl = /white-space:\s*([a-z-]+)/.exec(m[2]!);
    if (decl) ws = decl[1]!;
  }
  return ws;
}

/** The entities markdown-it's `escapeHtml` produces, and the characters they stand for. */
const ENTITIES: Record<string, string> = { "&lt;": "<", "&gt;": ">", "&quot;": '"', "&amp;": "&" };

/** The character data a reader sees for a run of markup: tags dropped, entities decoded. */
function decodeText(markup: string): string {
  return markup.replace(/<[^>]+>/g, "").replace(/&(?:lt|gt|quot|amp);/g, (e) => ENTITIES[e]!);
}

/** The text of the first rendered <p>, with <br> turned into the line break it draws. */
function paragraphText(html: string): string {
  const inner = /<p\b[^>]*>([\s\S]*?)<\/p>/.exec(html)?.[1] ?? "";
  return decodeText(inner.replace(/<br\s*\/?>/g, "\n"));
}

/**
 * The lines a reader actually sees for a rendered paragraph — the browser's whitespace
 * processing for the stylesheet's declared `white-space`, applied to the paragraph's text.
 * `pre`/`pre-wrap` preserve newlines AND space runs; `pre-line` preserves only the newlines;
 * anything else collapses every whitespace run, newlines included, into one space.
 */
function visibleLines(html: string): string[] {
  const text = paragraphText(html);
  const ws = previewParagraphWhiteSpace();
  if (ws === "pre" || ws === "pre-wrap") return text.split("\n");
  if (ws === "pre-line") return text.split("\n").map((l) => l.replace(/[^\S\n]+/g, " "));
  return [text.replace(/\s+/g, " ")];
}

/** The three-line directory tree from the bug report, as one span-comment anchor's link text. */
const ANCHORED_TREE =
  "[├── /dashboard       — 분석 대시보드 (로그인 필요)\n" +
  "├── /collections     — 컬렉션 관리 (웹 버전)\n" +
  "└── /login           — 인증](#cmt-cwnj04)";

/** The same block with no anchor — the tree renders through the same paragraph path. */
const PLAIN_TREE =
  "├── /dashboard       — 분석 대시보드 (로그인 필요)\n" +
  "├── /collections     — 컬렉션 관리 (웹 버전)\n" +
  "└── /login           — 인증";

describe("preview keeps a multi-line block's lines and columns", () => {
  for (const [label, src] of [
    ["carrying a span-comment anchor", ANCHORED_TREE],
    ["as plain text", PLAIN_TREE],
  ] as const) {
    describe(`a three-line directory tree ${label}`, () => {
      const lines = visibleLines(renderMarkdown(src));

      it("reads as three separate lines, not one run-on line", () => {
        expect(lines.length).toBe(3);
        expect(lines[0]).toMatch(/^├── \/dashboard\b/);
        expect(lines[1]).toMatch(/^├── \/collections\b/);
        expect(lines[2]).toMatch(/^└── \/login\b/);
      });

      it("keeps the runs of alignment spaces, so the columns still line up", () => {
        // The author padded each line so every "—" sits in the same column. That is the whole
        // point of the block; collapsing the space runs destroys it even if the lines survive.
        const dashColumns = lines.map((l) => l.indexOf("—"));
        expect(dashColumns).toEqual([21, 21, 21]);
      });
    });
  }

  it("keeps the anchor a single clickable/highlightable link around the whole block", () => {
    // A paragraph anchor is a real markdown link, so markdown-it renders it as one <a> — it must
    // survive the whitespace handling intact, wrapping every line of the block.
    const html = renderMarkdown(ANCHORED_TREE);
    const opens = [...html.matchAll(/<a\b[^>]*>/g)];
    expect(opens.length).toBe(1);
    expect(opens[0]![0]).toContain('data-cmt="cmt-cwnj04"');
    expect(opens[0]![0]).toContain('class="ap-anchor"');
    // …and it wraps all three lines, rather than only the first.
    const linkText = /<a\b[^>]*>([\s\S]*?)<\/a>/.exec(html)?.[1] ?? "";
    expect(linkText.split("\n").length).toBe(3);
  });

  it("still renders a hidden (resolved) anchor's multi-line label as plain text", () => {
    const html = renderMarkdown(ANCHORED_TREE, () => false);
    expect(html).not.toContain("<a");
    expect(visibleLines(html).length).toBe(3);
  });

  it("does not double a markdown hard break into a blank line", () => {
    // markdown-it's default hardbreak rule emits "<br>\n" — the trailing newline is cosmetic
    // source formatting, invisible under normal whitespace processing but a SECOND line break
    // once the paragraph preserves newlines. Three hard-broken lines must stay three lines.
    const html = renderMarkdown("alpha  \nbeta  \ngamma\n");
    expect(html).toContain("<br>");
    expect(visibleLines(html)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("leaves markdown's own block-level newlines out of the preserved scope", () => {
    // The stylesheet must scope the preservation to paragraph content. markdown-it puts
    // cosmetic newlines between BLOCK tags (inside <li>, <blockquote>, <ul>, …); preserving
    // those would open a blank line before every nested list and in every loose list item.
    const ws = previewParagraphWhiteSpace();
    expect(ws).toBe("pre-wrap");
    const scoped = /(?:^|\})([^{}]*)\{[^}]*white-space:\s*pre-wrap[^}]*\}/gm;
    const selectors = [...css.matchAll(scoped)].map((m) => m[1]!.trim()).filter((s) => s.includes(".ap-rendered"));
    expect(selectors.length).toBeGreaterThan(0);
    for (const sel of selectors) {
      expect(sel).not.toMatch(/\.ap-rendered\s+(li|ul|ol|blockquote|table)\b/);
    }
  });
});

// --- half two: the same block inside a fence ----------------------------------

/** The markup inside the n-th rendered `<pre><code>`. */
function codeMarkup(html: string, n = 0): string {
  const blocks = [...html.matchAll(/<pre\b[^>]*>\s*<code\b[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/g)];
  return blocks[n]?.[1] ?? "";
}

/** The `white-space` the stylesheet applies to the preview's code blocks. Nothing is declared
 *  for `.ap-rendered pre`, which is the point: a `<pre>` keeps the UA default `pre`, so a code
 *  block already draws every newline and every run of alignment spaces as typed. If a rule ever
 *  overrides that to something collapsing, the reader assertions below stop holding — so read
 *  the value out of the stylesheet rather than assuming it. */
function previewCodeWhiteSpace(): string {
  const re = /(?:^|\})([^{}]*\.ap-rendered[^{}]*\b(?:pre|code)\b[^{}]*)\{([^}]*)\}/gm;
  let ws = "pre"; // the UA default for <pre>
  for (const m of css.matchAll(re)) {
    const decl = /white-space:\s*([a-z-]+)/.exec(m[2]!);
    if (decl) ws = decl[1]!;
  }
  return ws;
}

/** The lines a reader sees inside the n-th rendered code block. */
function codeLines(html: string, n = 0): string[] {
  const text = decodeText(codeMarkup(html, n)).replace(/\n$/, ""); // fences end with a newline
  const ws = previewCodeWhiteSpace();
  if (ws === "pre" || ws === "pre-wrap") return text.split("\n");
  if (ws === "pre-line") return text.split("\n").map((l) => l.replace(/[^\S\n]+/g, " "));
  return [text.replace(/\s+/g, " ")];
}

/** Every element in the rendered HTML that carries a comment anchor's id. */
function anchorTags(html: string): string[] {
  return [...html.matchAll(/<(?:a|span)\b[^>]*\bdata-cmt=[^>]*>/g)].map((m) => m[0]);
}

/** The user's exact reported case: the three-line tree, anchored, inside a fence. */
const FENCED_ANCHORED_TREE = "```\n" + ANCHORED_TREE + "\n```\n";

describe("a comment anchor written inside a code fence", () => {
  it("renders as a real anchor the reader can click, not as visible anchor syntax", () => {
    const html = renderMarkdown(FENCED_ANCHORED_TREE);
    // What the reader sees is the code — no brackets, no (#cmt-…) tail.
    const lines = codeLines(html);
    expect(lines).toEqual([
      "├── /dashboard       — 분석 대시보드 (로그인 필요)",
      "├── /collections     — 컬렉션 관리 (웹 버전)",
      "└── /login           — 인증",
    ]);
    expect(codeMarkup(html)).not.toContain("#cmt-cwnj04)");
    expect(decodeText(codeMarkup(html))).not.toContain("](");
    // …and the columns still line up, as they do in the fence's source.
    expect(lines.map((l) => l.indexOf("—"))).toEqual([21, 21, 21]);
    // The comment has exactly one element to point at, tagged the way the rail and the
    // click/highlight path look it up.
    const tags = anchorTags(html);
    expect(tags.length).toBe(1);
    expect(tags[0]).toContain('data-cmt="cmt-cwnj04"');
    expect(tags[0]).toContain('class="ap-anchor"');
    // …and it covers all three lines, not just the first.
    const inner = /<span\b[^>]*\bdata-cmt="cmt-cwnj04"[^>]*>([\s\S]*?)<\/span>/.exec(html)?.[1] ?? "";
    expect(inner.split("\n")).toHaveLength(3);
  });

  it("keeps the code block a code block: no <a>, and the <pre> still carries its source line", () => {
    const html = renderMarkdown(FENCED_ANCHORED_TREE);
    // A link inside <code> would inherit link styling and read as prose; the marker is a <span>.
    expect(html).not.toContain("<a ");
    expect(html).toMatch(/^<pre data-line="0"><code>/);
  });

  it("carries an anchor in an indented (four-space) code block too", () => {
    const html = renderMarkdown("    [tabs vs spaces](#cmt-ab12cd)\n");
    expect(codeLines(html)).toEqual(["tabs vs spaces"]);
    expect(anchorTags(html)).toHaveLength(1);
  });

  it("renders every anchor in a fence that carries several", () => {
    const html = renderMarkdown("```\n[first](#cmt-aaa111)\nmiddle\n[second](#cmt-bbb222)\n```\n");
    expect(codeLines(html)).toEqual(["first", "middle", "second"]);
    const tags = anchorTags(html);
    expect(tags).toHaveLength(2);
    expect(tags[0]).toContain('data-cmt="cmt-aaa111"');
    expect(tags[1]).toContain('data-cmt="cmt-bbb222"');
  });

  it("normalizes the id's case, the way a paragraph anchor does", () => {
    // link_open lowercases a `#CMT-…` href before tagging it, so the rail's lookup by the
    // comment's own (lowercase) id finds it. The fenced marker must agree, or a hand-typed
    // uppercase anchor would render a marker nothing can find.
    const html = renderMarkdown("```\n[case](#CMT-AAA111)\n```\n");
    expect(anchorTags(html)[0]).toContain('data-cmt="cmt-aaa111"');
    expect(codeLines(html)).toEqual(["case"]);
  });

  it("marks only the anchored part of a fence, leaving the rest plain code", () => {
    const html = renderMarkdown("```\nkeep me\n[watch this](#cmt-aaa111)\nkeep me too\n```\n");
    expect(codeLines(html)).toEqual(["keep me", "watch this", "keep me too"]);
    // The span must not swallow the surrounding lines.
    const inner = /<span\b[^>]*\bdata-cmt="cmt-aaa111"[^>]*>([\s\S]*?)<\/span>/.exec(html)?.[1] ?? "";
    expect(inner).toBe("watch this");
  });

  it("keeps the fence's language class, so highlighting/styling by language is unaffected", () => {
    const html = renderMarkdown("```ts\nconst [a](#cmt-aaa111) = 1;\n```\n");
    expect(html).toContain('<code class="language-ts">');
    expect(codeLines(html)).toEqual(["const a = 1;"]);
    expect(anchorTags(html)).toHaveLength(1);
  });

  it("leaves a link that only LOOKS like an anchor completely literal", () => {
    // Only `#cmt-<id>` is a comment anchor. Anything else in a fence is code, shown verbatim.
    const html = renderMarkdown("```\n[x](#not-cmt)\n[y](https://example.com)\n[z](#cmt)\n```\n");
    expect(codeLines(html)).toEqual(["[x](#not-cmt)", "[y](https://example.com)", "[z](#cmt)"]);
    expect(anchorTags(html)).toHaveLength(0);
  });

  it("still escapes the code it renders — an anchor is no way in for raw HTML", () => {
    // The renderer escapes raw HTML everywhere else on purpose (see markdown.ts's html_block /
    // html_inline rules); handling the anchor ourselves must not open a hole, inside the
    // anchor's label or outside it.
    const html = renderMarkdown('```\n<script>alert(1)</script> & "q"\n[<img onerror=x>](#cmt-aaa111)\n```\n');
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img onerror=x&gt;");
    expect(html).toContain("&amp;");
    // The reader still sees exactly the characters typed.
    expect(codeLines(html)).toEqual(['<script>alert(1)</script> & "q"', "<img onerror=x>"]);
  });

  it("renders a hidden (resolved) fenced anchor as plain code, with no marker and no syntax", () => {
    const html = renderMarkdown(FENCED_ANCHORED_TREE, () => false);
    expect(anchorTags(html)).toHaveLength(0);
    expect(codeMarkup(html)).not.toContain("#cmt-cwnj04");
    expect(codeLines(html)).toHaveLength(3);
  });

  it("is the anchor the editor itself writes there — commenting on fenced code round-trips", () => {
    // This is how the reported document came to exist. spanCommentBlocker matches the selection
    // against the body TEXT and is fence-unaware, so it does not refuse a selection inside a
    // fence; addSpanComment then wraps those lines in place. That is now a supported thing to
    // do rather than a way to break a document, and this pins the two ends together: whatever
    // the editor writes, the preview renders as a working anchor over unchanged code.
    const body = "```\n" + PLAIN_TREE + "\n```\n";
    const span = { startLine: 0, endLine: 4 };
    expect(spanCommentBlocker(body, PLAIN_TREE, span)).toBeNull();
    const res = addSpanComment({ body, comments: [] }, PLAIN_TREE, { text: "still needed?", author: "alice" }, span);
    expect(res).not.toBeNull();
    // The fence itself is untouched — the anchor went inside it, not around it.
    expect(res!.doc.body.startsWith("```\n[")).toBe(true);
    const html = renderMarkdown(res!.doc.body);
    expect(codeLines(html)).toEqual(PLAIN_TREE.split("\n"));
    const tags = anchorTags(html);
    expect(tags).toHaveLength(1);
    expect(tags[0]).toContain(`data-cmt="${res!.id}"`);
  });

  it("leaves an ordinary fence byte-for-byte as markdown-it renders it", () => {
    // The anchor handling is a branch, not a rewrite: a fence with no anchor must go down the
    // untouched default path.
    const src = "```py\ndef f(x):\n    return x < 1 & x > 0\n```\n";
    expect(renderMarkdown(src)).toBe('<pre data-line="0"><code class="language-py">def f(x):\n    return x &lt; 1 &amp; x &gt; 0\n</code></pre>\n');
  });
});
