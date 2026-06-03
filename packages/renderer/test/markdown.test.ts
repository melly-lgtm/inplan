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
