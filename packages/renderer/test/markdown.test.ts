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

  it("tags a single-line paragraph with matching data-line and data-end-line", () => {
    const html = renderMarkdown("intro\n\nOne line.\n");
    expect(html).toMatch(/data-line="2" data-end-line="2"/);
  });

  it("tags a multi-line paragraph's data-end-line as its LAST line, not its first (so an insert-after lands past the whole paragraph)", () => {
    const html = renderMarkdown("line one\nline two\nline three\n");
    expect(html).toMatch(/data-line="0" data-end-line="2"/);
  });
});

describe("renderMarkdown image src resolution (pasted/picked images)", () => {
  it("leaves a relative image src untouched when no docPath is given", () => {
    const html = renderMarkdown("![](plan.assets/x.png)");
    expect(html).toContain('src="plan.assets/x.png"');
  });

  it("leaves a relative image src untouched when docPath isn't a real absolute filesystem path (e.g. a memory/cloud doc)", () => {
    const html = renderMarkdown("![](plan.assets/x.png)", undefined, "memory://doc");
    expect(html).toContain('src="plan.assets/x.png"');
  });

  it("resolves a relative src against a POSIX doc path into a file:// URL", () => {
    const html = renderMarkdown("![](plan.assets/x.png)", undefined, "/home/user/project/plan.md");
    expect(html).toContain('src="file:///home/user/project/plan.assets/x.png"');
  });

  it("resolves against a Windows doc path (backslashes, drive letter) into a well-formed file:/// URL", () => {
    const html = renderMarkdown("![](plan.assets/x.png)", undefined, "C:\\Users\\me\\project\\plan.md");
    expect(html).toContain('src="file:///C:/Users/me/project/plan.assets/x.png"');
  });

  it("resolves ../ segments the same way doc-to-doc links do", () => {
    const html = renderMarkdown("![](../shared/x.png)", undefined, "/home/user/project/docs/plan.md");
    expect(html).toContain('src="file:///home/user/project/shared/x.png"');
  });

  it("resolves an angle-bracket destination (spaces/parens, e.g. from a doc named 'Product Plan.md') without double-encoding", () => {
    // markdown-it percent-encodes the destination at parse time ("Product%20Plan..." / "x%20y.png")
    // before our rule ever sees it — the rule must decode before resolving + re-encoding, or the
    // "%20" becomes "%2520" and the OS looks for a file literally named "x%20y.png".
    const html = renderMarkdown("![](<Product Plan.assets/x y.png>)", undefined, "/home/user/project/plan.md");
    expect(html).toContain('src="file:///home/user/project/Product%20Plan.assets/x%20y.png"');
    expect(html).not.toContain("%2520");
    expect(html).not.toContain("%25");
  });

  it("leaves an already-absolute/URL src untouched even with a docPath present", () => {
    // file:// itself is excluded here: markdown-it's own link-destination grammar doesn't parse
    // a triple-slash URL as an image link at all (stays literal `![...]` text) regardless of
    // our rule — a pre-existing markdown-it limitation, not something our paste feature produces.
    for (const src of ["http://example.com/x.png", "https://example.com/x.png", "data:image/png;base64,AAAA", "/already/abs.png"]) {
      const html = renderMarkdown(`![](${src})`, undefined, "/home/user/project/plan.md");
      expect(html).toContain(`src="${src}"`);
    }
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

  it("does not eat a paragraph sitting between two inline code spans that each contain comment delimiters", () => {
    // A naive `<!--[\s\S]*?-->` regex over raw text would span from the `<!--` inside the first
    // code span to the `-->` inside the second, deleting everything between — including this
    // paragraph. markdown-it's own backtick rule consumes each code span before html_inline ever
    // sees the characters inside it, so this can't happen here.
    const body = "Use `<!--` to start.\n\nThis paragraph must survive.\n\nUse `-->` to end.\n";
    const html = renderMarkdown(body);
    expect(html).toContain("This paragraph must survive.");
    expect(html).toContain("<code>&lt;!--</code>");
    expect(html).toContain("<code>--&gt;</code>");
  });

  it("does not strip a `<!-- -->` example inside an UNCLOSED fenced code block", () => {
    const html = renderMarkdown("```html\n<!-- unclosed fence, no closing marker -->\n");
    expect(html).toContain("unclosed fence, no closing marker");
  });

  it("requires the closing fence to match the opening fence's character and length (~~~ isn't closed by ```)", () => {
    // A stray ``` inside a ~~~ block must not be treated as closing it — the `<!-- -->` inside
    // stays a syntax example either way, but for the RIGHT reason (still inside the fence).
    const body = "~~~html\n<!-- inside a tilde fence -->\n```\nstill inside\n~~~\n";
    const html = renderMarkdown(body);
    expect(html).toContain("inside a tilde fence");
  });

  it("still escapes non-comment raw HTML as visible literal text (XSS guard unchanged)", () => {
    const html = renderMarkdown('before <script>alert(1)</script> after');
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("hides a block HTML comment indented up to 3 spaces (CommonMark still treats it as an HTML block)", () => {
    for (const indent of ["", " ", "  ", "   "]) {
      const html = renderMarkdown(`# Title\n\n${indent}<!-- indented note -->\n\nAfter.\n`);
      expect(html).not.toContain("indented note");
      expect(html).not.toContain("&lt;!--");
    }
  });

  it("escapes block-level raw HTML, not just inline — the XSS guard covers html_block too", () => {
    // The inline `<script>` case above exercises the html_inline path; a `<script>` on its own
    // line parses as an html_block. Both must escape (never emit raw HTML into the preview, which
    // is fed to dangerouslySetInnerHTML). This locks the more dangerous, block-level path.
    const html = renderMarkdown("<script>alert(1)</script>\n");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");

    const div = renderMarkdown('<div onclick="alert(1)">x</div>\n');
    expect(div).not.toContain("<div");
    expect(div).toContain("&lt;div");
  });

  it("hides the trailing <!--inplan …--> comment block (the app's own comment store)", () => {
    // doc.body carries the plan's trailing inplan comment block; under `html: false` it used to
    // render as visible escaped JSON at the bottom of every preview. It must now be hidden.
    const body = '# Title\n\nSome text.\n\n<!--inplan\n[ { "id": "cmt-abc123", "text": "note" } ]\n-->\n';
    const html = renderMarkdown(body);
    expect(html).toContain("Some text.");
    expect(html).not.toContain("cmt-abc123");
    expect(html).not.toContain("&lt;!--inplan");
  });
});
