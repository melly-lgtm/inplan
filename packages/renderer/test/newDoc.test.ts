// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import type { Comment, ParsedDocument } from "@inplan/core";
import { moveDocTitle, slugifyFilename } from "../src/newDoc";
import { linkSelectionToDoc, moveSelectionToDoc, spanSource } from "../src/docOps";

const c = (over: Partial<Comment> & { id: string }): Comment => ({ author: "a", date: "2026-01-01T00:00:00Z", resolved: false, text: "t", ...over });
const ids = (cs: Comment[]): string[] => cs.map((x) => x.id);

describe("slugifyFilename", () => {
  it("lowercases, turns spaces into underscores, and appends .md", () => {
    expect(slugifyFilename("My Section")).toBe("my_section.md");
    expect(slugifyFilename("Use Postgres")).toBe("use_postgres.md");
  });
  it("drops unsafe characters and collapses repeats", () => {
    expect(slugifyFilename("Hello, World!!")).toBe("hello_world.md");
    expect(slugifyFilename("  a   b  ")).toBe("a_b.md");
    expect(slugifyFilename("***")).toBe("untitled.md"); // nothing safe left
  });
});

describe("moveDocTitle", () => {
  it("uses the first sentence when it's shorter than five words", () => {
    expect(moveDocTitle("Do it. Then more words follow here.")).toBe("Do it");
  });
  it("uses the first five words when the sentence is longer", () => {
    expect(moveDocTitle("one two three four five six seven")).toBe("one two three four five");
  });
  it("collapses whitespace and trims trailing punctuation; blank → Untitled", () => {
    expect(moveDocTitle("  Hello   world  ")).toBe("Hello world");
    expect(moveDocTitle("   ")).toBe("Untitled");
  });
});

describe("body edits (Create Doc / Move Text to New Doc)", () => {
  const body = "# Plan\n\nUse Postgres for storage and scale.\n";

  it("linkSelectionToDoc keeps the text in place, wrapped as a link", () => {
    expect(linkSelectionToDoc(body, "Postgres", undefined, "./postgres.md")).toBe(
      "# Plan\n\nUse [Postgres](./postgres.md) for storage and scale.\n",
    );
  });

  it("moveSelectionToDoc (verbatim, no span) replaces the inline selection with a [title](link)", () => {
    const sel = "Use Postgres for storage and scale.";
    expect(spanSource(body, sel)).toBe(sel);
    const r = moveSelectionToDoc({ body, comments: [] }, sel, undefined, "Datastore", "./datastore.md")!;
    expect(r.remaining.body).toBe("# Plan\n\n[Datastore](./datastore.md)\n");
    expect(r.movedBody).toBe(sel);
    expect(r.movedComments).toEqual([]);
  });

  it("moves whole blocks by line span (multi-block) and carries the enclosed comment thread", () => {
    const doc: ParsedDocument = {
      body: "# Plan\n\n## Section A\n\nUse [Postgres](#cmt-a1) here.\n\n## Section B\n\nKeep this.\n",
      comments: [
        c({ id: "cmt-a1", text: "datastore?" }), // span comment anchored inside Section A
        c({ id: "cmt-r1", parentId: "cmt-a1", text: "Postgres." }), // its reply
        c({ id: "cmt-doc", anchor: "doc", text: "overall" }), // doc-level — stays
      ],
    };
    const r = moveSelectionToDoc(doc, "ignored-when-span", { startLine: 2, endLine: 4 }, "Section A", "./a.md")!;
    // moved body = the two blocks (heading + paragraph), with the anchor intact
    expect(r.movedBody).toBe("## Section A\n\nUse [Postgres](#cmt-a1) here.");
    expect(ids(r.movedComments)).toEqual(["cmt-a1", "cmt-r1"]); // thread travels with the text
    // original: section replaced by a link that KEEPS the block's heading form; thread gone;
    // doc-level + Section B remain, with the blank-line separation intact.
    expect(ids(r.remaining.comments)).toEqual(["cmt-doc"]);
    expect(r.remaining.body).toBe("# Plan\n\n## [Section A](./a.md)\n\n## Section B\n\nKeep this.\n");
  });

  it("keeps the link its own block: doesn't fuse onto the next paragraph (span swallows the blank line)", () => {
    // selectionSourceSpan extends endLine to the blank line before the next block, so the span
    // includes the trailing blank — the link must still get its own paragraph break.
    const doc: ParsedDocument = { body: "# Plan\n\nfirst para\n\nsecond para\n", comments: [] };
    const r = moveSelectionToDoc(doc, "first para", { startLine: 2, endLine: 3 }, "First", "./first.md")!;
    expect(r.remaining.body).toBe("# Plan\n\n[First](./first.md)\n\nsecond para\n");
    expect(r.movedBody).toBe("first para");
  });

  it("a moved list item stays a list item (keeps its marker on the link)", () => {
    const doc: ParsedDocument = { body: "# Plan\n\n- alpha\n- beta\n- gamma\n", comments: [] };
    const r = moveSelectionToDoc(doc, "beta", { startLine: 3, endLine: 3 }, "Beta", "./beta.md")!;
    expect(r.remaining.body).toBe("# Plan\n\n- alpha\n- [Beta](./beta.md)\n- gamma\n");
    expect(r.movedBody).toBe("- beta");
  });

  it("returns null when a comment anchor straddles the selection boundary", () => {
    // Verbatim selection starts in the middle of an anchor → can't move without splitting it.
    const doc: ParsedDocument = { body: "a [foo](#cmt-x) b", comments: [c({ id: "cmt-x" })] };
    expect(moveSelectionToDoc(doc, "foo](#cmt-x) b", undefined, "T", "./t.md")).toBeNull();
  });

  it("returns null when the selection can't be located", () => {
    expect(linkSelectionToDoc(body, "nonexistent", undefined, "./x.md")).toBeNull();
    expect(spanSource(body, "nonexistent")).toBeNull();
  });

  it("refuses a selection that crosses an inline-emphasis boundary (would dangle a marker)", () => {
    const b = "a **bold and** plain";
    // "bold and** plain" opens **inside the selection but closes... mismatched stacks → null.
    expect(linkSelectionToDoc(b, "and** plain", undefined, "./x.md")).toBeNull();
  });
});
