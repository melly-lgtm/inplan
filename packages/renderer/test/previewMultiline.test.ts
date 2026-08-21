// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A multi-line block typed into a plan document must READ in the preview the way it reads in
// the source pane: same number of lines, same columns. Markdown's paragraph rule keeps the
// author's newlines in the token stream, and markdown-it duly emits them inside the <p> — but
// HTML's default whitespace processing collapses a newline, and every run of alignment spaces,
// down to a single space. A directory tree pasted into a plan therefore arrived as one run-on
// line with its columns gone.
//
// These tests assert the property a READER cares about (how many lines, and do the columns line
// up), not the shape of the markup: they take the rendered HTML and put it through the same
// whitespace processing the browser will, using the `white-space` value the stylesheet actually
// declares for the preview's paragraph content. So they fail both when the renderer drops the
// newlines and when the stylesheet doesn't honor them.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
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

/** The text of the first rendered <p>, with <br> turned into the line break it draws. */
function paragraphText(html: string): string {
  const inner = /<p\b[^>]*>([\s\S]*?)<\/p>/.exec(html)?.[1] ?? "";
  return inner
    .replace(/<br\s*\/?>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
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
    // The reason the author cannot escape into a code fence: an anchor's link text is inline,
    // so the multi-line block has to stay a paragraph. The anchor must survive intact.
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
