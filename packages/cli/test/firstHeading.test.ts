// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The title a cloud document is uploaded with, derived from the body's first H1.
//
// The anchor cases are the point: anchoring a comment to the title rewrites the heading in place
// to `# [Title](#cmt-id)`, so a title taken verbatim carried that Markdown into `documents.title`
// and every document list rendered it raw — reported as a title showing up as
// "[Auto multilingual mobile keyboard](#cmt-wp1927)".

import { describe, it, expect } from "vitest";
import { firstHeading } from "../src/cli";

describe("firstHeading", () => {
  it("takes the first H1", () => {
    expect(firstHeading("# Title\n\nbody\n\n# Later heading")).toBe("Title");
  });

  it("finds an H1 that isn't the first line", () => {
    expect(firstHeading("---\nfrontmatter: yes\n---\n\n# Title\n")).toBe("Title");
  });

  it("returns null when there is no H1 (the caller falls back to the filename)", () => {
    expect(firstHeading("## Only an H2\n\nbody")).toBeNull();
    expect(firstHeading("no headings at all")).toBeNull();
    expect(firstHeading("")).toBeNull();
  });

  it("ignores a comment anchor wrapping the whole title", () => {
    expect(firstHeading("# [Auto multilingual mobile keyboard](#cmt-wp1927)\n\nbody")).toBe("Auto multilingual mobile keyboard");
  });

  it("ignores a comment anchor on only part of the title", () => {
    expect(firstHeading("# Auto [multilingual](#cmt-ab12cd) keyboard")).toBe("Auto multilingual keyboard");
  });

  it("ignores several anchors in one title", () => {
    expect(firstHeading("# [A](#cmt-aaa111) and [B](#cmt-bbb222)")).toBe("A and B");
  });

  it("keeps an ordinary Markdown link — only inplan's own `#cmt-` anchors are stripped", () => {
    expect(firstHeading("# Read [the docs](https://example.com)")).toBe("Read [the docs](https://example.com)");
  });

  it("falls back to null when the title is nothing but an empty anchor", () => {
    expect(firstHeading("# [](#cmt-abc123)\n\nbody")).toBeNull();
  });

  it("trims surrounding whitespace left behind", () => {
    expect(firstHeading("#   Spaced title   \n")).toBe("Spaced title");
  });
});
