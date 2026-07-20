// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/markdown";

describe("renderMarkdown", () => {
  it("renders body markdown to HTML and tags blocks with data-line", () => {
    const html = renderMarkdown("# Title\n\nA paragraph.\n");
    expect(html).toContain("Title");
    expect(html).toContain("data-line=");
  });

  it("injects data-line onto fenced code blocks", () => {
    const html = renderMarkdown("# T\n\n```js\nconst x = 1;\n```\n");
    expect(html).toMatch(/<pre data-line="\d+"/);
    expect(html).toContain("const x = 1;");
  });

  it("tags each table ROW with its own data-line (so a cell click syncs to the row)", () => {
    const html = renderMarkdown("intro\n\n| A | B |\n| - | - |\n| r1a | r1b |\n| r2a | r2b |\n");
    // one <tr> per header + 2 body rows, each with a distinct data-line
    const lines = [...html.matchAll(/<tr data-line="(\d+)"/g)].map((m) => Number(m[1]));
    expect(lines.length).toBe(3);
    expect(new Set(lines).size).toBe(3); // distinct lines, not all the table's first line
  });
});

describe("renderMarkdown comment anchors", () => {
  const md = "before [anchored](#cmt-abc123) after";

  it("renders an anchor as a highlighted link when showAnchor is true (or omitted)", () => {
    const html = renderMarkdown(md, () => true);
    expect(html).toContain('class="ap-anchor"');
    expect(html).toContain('data-cmt="cmt-abc123"');
    expect(html).toContain("anchored");
  });

  it("renders the anchor as PLAIN TEXT (no <a>) when showAnchor is false", () => {
    const html = renderMarkdown(md, () => false);
    expect(html).toContain("anchored"); // label text survives
    expect(html).not.toContain("ap-anchor");
    expect(html).not.toContain("data-cmt");
    expect(html).not.toMatch(/<a\b/); // the <a> wrapper is dropped on both ends
  });

  it("shows some anchors and hides others by id (per-anchor predicate)", () => {
    const body = "[keep](#cmt-keep01) and [hide](#cmt-hide01)";
    const html = renderMarkdown(body, (id) => id === "cmt-keep01");
    expect(html).toContain('data-cmt="cmt-keep01"');
    expect(html).not.toContain("cmt-hide01"); // hidden one is plain text
    expect(html).toContain("hide");
    expect((html.match(/<a\b/g) ?? []).length).toBe(1); // only the kept anchor is a link
  });

  it("leaves ordinary (non-comment) links as links regardless of the predicate", () => {
    const html = renderMarkdown("see [docs](https://x.test)", () => false);
    expect(html).toMatch(/<a\b/);
    expect(html).toContain("https://x.test");
  });
});

describe("renderMarkdown HTML comments", () => {
  it("hides an inline HTML comment from the rendered preview", () => {
    const html = renderMarkdown("before <!-- private note --> after");
    expect(html).toContain("before");
    expect(html).toContain("after");
    expect(html).not.toContain("private note");
    expect(html).not.toContain("&lt;!--"); // not even as escaped literal text
  });

  it("hides a multi-line HTML comment while keeping later line numbers aligned with the source", () => {
    const body = "# Title\n\n<!--\nhidden note\nspanning lines\n-->\n\nAfter.\n";
    const html = renderMarkdown(body);
    expect(html).not.toContain("hidden note");
    // "After." is on source line 7 (0-based) — must still be, since only the comment's
    // own newlines were preserved, not deleted along with its content.
    expect(html).toMatch(/data-line="7"[^>]*>\s*After\./);
  });

  it("does NOT strip a `<!-- -->` shown as a syntax example inside a fenced code block", () => {
    const html = renderMarkdown("```html\n<!-- example comment -->\n```\n");
    expect(html).toContain("example comment");
  });

  it("leaves the raw source (SourceEditor's doc.body) untouched — only the rendered preview hides comments", () => {
    // renderMarkdown never mutates its input; the caller's doc.body (fed to SourceEditor) is
    // whatever was passed in, unaffected by what the preview renders.
    const body = "before <!-- note --> after";
    renderMarkdown(body);
    expect(body).toBe("before <!-- note --> after");
  });
});
