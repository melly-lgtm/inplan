// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Link to Doc / Move Text write a link to a new document by its path, and following that link must
// open exactly that path. Each case is a ROUND TRIP through the real pipeline: the writer, the
// renderer's markdown-it parse (which normalizes the href), resolveDocPath, and the host's decode.
// Written raw, "my doc.md" was not a link at all and "a%20b.md" opened "a b.md".

import MarkdownIt from "markdown-it";
import { describe, expect, it } from "vitest";
import { decodeLinkPath } from "@inplan/core";
import { linkSelectionToDoc, moveSelectionToDoc } from "../src/docOps";
import { resolveDocPath } from "../src/links";

const md = new MarkdownIt();

/** The href markdown-it gives the first link in `body`, or null when it parses no link at all. */
function hrefOf(body: string): string | null {
  for (const block of md.parse(body, {})) {
    for (const t of block.children ?? []) if (t.type === "link_open") return t.attrGet("href");
  }
  return null;
}

/** What following the link opens, from a document at `current`: the path the host decodes. */
function opens(body: string, current: string): string | null {
  const href = hrefOf(body);
  return href === null ? null : decodeLinkPath(resolveDocPath(current, href));
}

const PATHS = [
  ["a space", "my doc.md"],
  ["parentheses", "x (1).md"],
  ["an unbalanced parenthesis", "draft (v2.md"],
  ["a literal %20", "a%20b.md"],
  ["a percent sign", "100% done.md"],
  ["angle brackets and a hash", "a <b> #c.md"],
  ["non-ASCII", "계획 문서.md"],
  ["a subfolder with a space", "notes/q3 plan.md"],
] as const;

describe("a link to a new document opens exactly that document", () => {
  it.each(PATHS)("Link to Doc, with %s", (_, name) => {
    const body = linkSelectionToDoc("# Plan\n\nUse Postgres here.\n", "Postgres", undefined, `./${name}`)!;
    expect(hrefOf(body)).not.toBeNull(); // it IS a link
    expect(opens(body, "PLAN.md")).toBe(name);
  });

  it.each(PATHS)("Move Text to New Doc, with %s", (_, name) => {
    const r = moveSelectionToDoc({ body: "# Plan\n\nUse Postgres here.\n", comments: [] }, "Use Postgres here.", undefined, "Datastore", `./${name}`)!;
    expect(hrefOf(r.remaining.body)).not.toBeNull();
    expect(opens(r.remaining.body, "docs/PLAN.md")).toBe(`docs/${name}`);
  });

  it("an ordinary path is written exactly as before", () => {
    expect(linkSelectionToDoc("Use Postgres.", "Postgres", undefined, "./postgres.md")).toBe("Use [Postgres](./postgres.md).");
  });

  it("a title with brackets or a backslash stays the link's text instead of breaking it", () => {
    const r = moveSelectionToDoc({ body: "Use Postgres here.\n", comments: [] }, "Use Postgres here.", undefined, "Q3 ] draft \\]", "./q3.md")!;
    const inline = md.parseInline(r.remaining.body.trim(), {})[0]!.children!;
    expect(inline[0]!.type).toBe("link_open");
    expect(inline.filter((t) => t.type === "text").map((t) => t.content).join("")).toBe("Q3 ] draft \\]");
  });
});

describe("decodeLinkPath (the host's read of a link)", () => {
  it("decodes each segment once, keeping slashes and a segment that isn't valid encoding", () => {
    expect(decodeLinkPath("notes/my%20doc.md")).toBe("notes/my doc.md");
    expect(decodeLinkPath("100%.md")).toBe("100%.md");
    expect(decodeLinkPath("a%2Fb/c.md")).toBe("a/b/c.md");
  });
});
