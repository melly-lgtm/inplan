// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Matrix coverage for the Create Doc / Move Text to New Doc actions: title + filename derivation
// (newDoc.ts), relative-link path resolution that seeds the move's link target (links.ts), and the
// move/link splice itself (docOps.ts) — verbatim and block-span, comment-thread carry, edge cases,
// and the new-doc-body seeding that the host appends (serialize/parse round-trip + genId collisions).

import { describe, expect, it } from "vitest";
import { genId, parse, serialize, type Comment, type ParsedDocument } from "@inplan/core";
import { moveDocTitle, slugifyFilename } from "../src/newDoc";
import { resolveDocPath } from "../src/links";
import { linkSelectionToDoc, moveSelectionToDoc, spanSource } from "../src/docOps";

const c = (over: Partial<Comment> & { id: string }): Comment => ({ author: "a", date: "2026-01-01T00:00:00Z", resolved: false, text: "t", ...over });
const ids = (cs: Comment[]): string[] => cs.map((x) => x.id);

// --- title derivation -----------------------------------------------------------------------

describe("moveDocTitle (title derivation from the selected text)", () => {
  it("picks the first sentence when it is shorter than the first five words", () => {
    expect(moveDocTitle("Do it. Then more words follow here.")).toBe("Do it");
    expect(moveDocTitle("Wow! more text here too")).toBe("Wow");
    expect(moveDocTitle("Why not? extra words go here")).toBe("Why not");
  });

  it("falls back to the first five words when the sentence is longer (or absent)", () => {
    expect(moveDocTitle("one two three four five six seven")).toBe("one two three four five");
    expect(moveDocTitle("just four plain words")).toBe("just four plain words"); // < 5 words, no punctuation
  });

  it("ties to the sentence when sentence length <= five-word length", () => {
    // sentence "alpha beta gamma delta." vs fiveWords "alpha beta gamma delta. epsilon" → sentence wins.
    expect(moveDocTitle("alpha beta gamma delta. epsilon")).toBe("alpha beta gamma delta");
  });

  it("collapses internal/leading/trailing whitespace and trims trailing sentence punctuation", () => {
    expect(moveDocTitle("  Hello   world  ")).toBe("Hello world");
    expect(moveDocTitle("Hi.")).toBe("Hi");
    expect(moveDocTitle("Done!!!")).toBe("Done");
  });

  it("returns Untitled for blank / punctuation-only input", () => {
    expect(moveDocTitle("")).toBe("Untitled");
    expect(moveDocTitle("   ")).toBe("Untitled");
    expect(moveDocTitle("\t\n ")).toBe("Untitled");
    expect(moveDocTitle("...")).toBe("Untitled"); // first sentence is "." → trimmed to empty
  });

  it("keeps unicode letters in the title (no ASCII restriction here)", () => {
    expect(moveDocTitle("café señor mañana niño rocío más")).toBe("café señor mañana niño rocío");
  });
});

// --- filename derivation --------------------------------------------------------------------

describe("slugifyFilename (default Markdown filename)", () => {
  it("lowercases, turns whitespace runs into a single underscore, and appends .md", () => {
    expect(slugifyFilename("My Section")).toBe("my_section.md");
    expect(slugifyFilename("  a   b  ")).toBe("a_b.md");
    expect(slugifyFilename("Plan 2 v3")).toBe("plan_2_v3.md");
  });

  it("drops unsafe characters, collapses underscore runs, and trims leading/trailing _ or -", () => {
    expect(slugifyFilename("Hello, World!!")).toBe("hello_world.md");
    expect(slugifyFilename("--lead--")).toBe("lead.md");
    expect(slugifyFilename("a-b-c")).toBe("a-b-c.md"); // hyphens are safe and preserved
  });

  it("falls back to untitled.md when nothing safe remains (empty / punctuation-only / unicode-only)", () => {
    expect(slugifyFilename("")).toBe("untitled.md");
    expect(slugifyFilename("   ")).toBe("untitled.md");
    expect(slugifyFilename("***")).toBe("untitled.md");
    expect(slugifyFilename("Café Señor")).toBe("caf_seor.md"); // non-ASCII letters are stripped
  });
});

// --- link-target resolution (seeds the move's [title](target)) ------------------------------

describe("resolveDocPath (relative/absolute/nested/'..' link targets)", () => {
  it("joins a relative href against the base doc's directory", () => {
    expect(resolveDocPath("docs/PLAN.md", "./design.md")).toBe("docs/design.md");
    expect(resolveDocPath("a.md", "./b.md")).toBe("b.md"); // base has no directory
    expect(resolveDocPath("docs/a.md", "././x.md")).toBe("docs/x.md"); // redundant ./ segments
  });

  it("normalizes '..' to climb directories, and stops at the root", () => {
    expect(resolveDocPath("docs/PLAN.md", "../README.md")).toBe("README.md");
    expect(resolveDocPath("docs/sub/deep/a.md", "../../b.md")).toBe("docs/b.md");
    expect(resolveDocPath("a.md", "../../x.md")).toBe("x.md"); // popping past root is clamped, not negative
  });

  it("treats a leading '/' as repo-absolute (ignores the base directory)", () => {
    expect(resolveDocPath("docs/sub/a.md", "/x.md")).toBe("x.md");
    expect(resolveDocPath("docs/PLAN.md", "/root.md")).toBe("root.md");
  });

  it("drops the query/anchor, keeping only the target path", () => {
    expect(resolveDocPath("docs/PLAN.md", "./x.md#sec")).toBe("docs/x.md");
    expect(resolveDocPath("docs/PLAN.md", "/sub/x.md?q=1#f")).toBe("sub/x.md");
  });
});

// --- spanSource (the new doc's body for a verbatim selection) -------------------------------

describe("spanSource (selected Markdown that seeds the new-doc body)", () => {
  const body = "# Plan\n\nUse Postgres for storage and scale.\n";

  it("returns the exact source of a self-balanced selection", () => {
    const sel = "Use Postgres for storage and scale.";
    expect(spanSource(body, sel)).toBe(sel);
    expect(spanSource("a **bold** b", "**bold**")).toBe("**bold**"); // emphasis fully inside
  });

  it("returns null for a not-found, empty, or whitespace-only selection", () => {
    expect(spanSource(body, "nonexistent")).toBeNull();
    expect(spanSource(body, "")).toBeNull();
    expect(spanSource(body, "   ")).toBeNull();
  });

  it("returns null when the selection crosses an inline-emphasis boundary", () => {
    expect(spanSource("a **bold and** plain", "and** plain")).toBeNull();
  });
});

// --- linkSelectionToDoc (Create Doc: keep text, wrap as a link) -----------------------------

describe("linkSelectionToDoc (Create Doc — keeps the text in place as a link)", () => {
  const body = "# Plan\n\nUse Postgres for storage and scale.\n";

  it("wraps the located selection as [text](target), leaving the rest untouched", () => {
    expect(linkSelectionToDoc(body, "Postgres", undefined, "./postgres.md")).toBe(
      "# Plan\n\nUse [Postgres](./postgres.md) for storage and scale.\n",
    );
  });

  it("returns null when the selection can't be located or crosses formatting", () => {
    expect(linkSelectionToDoc(body, "nonexistent", undefined, "./x.md")).toBeNull();
    expect(linkSelectionToDoc("a **bold and** plain", "and** plain", undefined, "./x.md")).toBeNull();
  });
});

// --- moveSelectionToDoc (Move Text to New Doc) ----------------------------------------------

describe("moveSelectionToDoc (Move Text — carries text + threads, leaves a link)", () => {
  it("verbatim (no span): replaces the inline selection with [title](target); no threads to carry", () => {
    const body = "# Plan\n\nUse Postgres for storage and scale.\n";
    const sel = "Use Postgres for storage and scale.";
    const r = moveSelectionToDoc({ body, comments: [] }, sel, undefined, "Datastore", "./datastore.md")!;
    expect(r.remaining.body).toBe("# Plan\n\n[Datastore](./datastore.md)\n");
    expect(r.movedBody).toBe(sel);
    expect(r.movedComments).toEqual([]);
  });

  it("block span with no comments inside: moves the block, leaves a link, comments untouched", () => {
    const doc: ParsedDocument = { body: "# T\n\npara one\n\npara two\n", comments: [] };
    const r = moveSelectionToDoc(doc, "para one", { startLine: 2, endLine: 3 }, "P1", "./p1.md")!;
    expect(r.movedBody).toBe("para one");
    expect(r.movedComments).toEqual([]);
    expect(r.remaining.body).toBe("# T\n\n[P1](./p1.md)\n\npara two\n"); // link keeps its own block
  });

  it("carries a span-comment thread (root + reply) with the moved text; doc-level + outside stay", () => {
    const doc: ParsedDocument = {
      body: "# Plan\n\n## Section A\n\nUse [Postgres](#cmt-a1) here.\n\n## Section B\n\nKeep this.\n",
      comments: [
        c({ id: "cmt-a1", text: "datastore?" }),
        c({ id: "cmt-r1", parentId: "cmt-a1", text: "Postgres." }),
        c({ id: "cmt-doc", anchor: "doc", text: "overall" }),
      ],
    };
    const r = moveSelectionToDoc(doc, "ignored-when-span", { startLine: 2, endLine: 4 }, "Section A", "./a.md")!;
    expect(r.movedBody).toBe("## Section A\n\nUse [Postgres](#cmt-a1) here."); // anchor travels intact
    expect(ids(r.movedComments)).toEqual(["cmt-a1", "cmt-r1"]);
    expect(ids(r.remaining.comments)).toEqual(["cmt-doc"]); // doc-level stays
    expect(r.remaining.body).toBe("# Plan\n\n## [Section A](./a.md)\n\n## Section B\n\nKeep this.\n");
  });

  it("carries MULTIPLE anchors in the moved span, plus replies of each moved root", () => {
    const doc: ParsedDocument = {
      body: "# Plan\n\n## Sec\n\nUse [PG](#cmt-a1) and [Redis](#cmt-b2) here.\n\n## Other\n\nkeep\n",
      comments: [
        c({ id: "cmt-a1", text: "pg?" }),
        c({ id: "cmt-b2", text: "redis?" }),
        c({ id: "cmt-r", parentId: "cmt-a1", text: "reply to pg" }),
        c({ id: "cmt-doc", anchor: "doc", text: "overall" }),
      ],
    };
    const r = moveSelectionToDoc(doc, "ignored", { startLine: 2, endLine: 4 }, "Sec", "./sec.md")!;
    expect(r.movedBody).toBe("## Sec\n\nUse [PG](#cmt-a1) and [Redis](#cmt-b2) here.");
    expect(ids(r.movedComments)).toEqual(["cmt-a1", "cmt-b2", "cmt-r"]); // both roots + the reply
    expect(ids(r.remaining.comments)).toEqual(["cmt-doc"]);
    expect(r.remaining.body).toBe("# Plan\n\n## [Sec](./sec.md)\n\n## Other\n\nkeep\n");
  });

  it("keeps the placeholder link its own block (span swallows the inter-block blank line)", () => {
    const doc: ParsedDocument = { body: "# Plan\n\nfirst para\n\nsecond para\n", comments: [] };
    const r = moveSelectionToDoc(doc, "first para", { startLine: 2, endLine: 3 }, "First", "./first.md")!;
    expect(r.remaining.body).toBe("# Plan\n\n[First](./first.md)\n\nsecond para\n");
    expect(r.movedBody).toBe("first para");
  });

  it("keeps a moved list item a list item (carries its marker onto the link)", () => {
    const doc: ParsedDocument = { body: "# Plan\n\n- alpha\n- beta\n- gamma\n", comments: [] };
    const r = moveSelectionToDoc(doc, "beta", { startLine: 3, endLine: 3 }, "Beta", "./beta.md")!;
    expect(r.remaining.body).toBe("# Plan\n\n- alpha\n- [Beta](./beta.md)\n- gamma\n");
    expect(r.movedBody).toBe("- beta");
  });

  it("returns null for an empty / whitespace-only verbatim selection (no usable span)", () => {
    const doc: ParsedDocument = { body: "# T\n\nhi\n", comments: [] };
    expect(moveSelectionToDoc(doc, "", undefined, "X", "./x.md")).toBeNull();
    expect(moveSelectionToDoc(doc, "   ", undefined, "X", "./x.md")).toBeNull();
  });

  it("returns null when a comment anchor straddles the verbatim selection boundary", () => {
    const doc: ParsedDocument = { body: "a [foo](#cmt-x) b", comments: [c({ id: "cmt-x" })] };
    expect(moveSelectionToDoc(doc, "foo](#cmt-x) b", undefined, "T", "./t.md")).toBeNull();
  });

  it("returns null when the verbatim selection can't be located", () => {
    expect(moveSelectionToDoc({ body: "# T\n\nhi\n", comments: [] }, "nope", undefined, "T", "./t.md")).toBeNull();
  });
});

// --- new-doc body construction + id collisions ----------------------------------------------

describe("new-doc seeding (movedBody + movedComments → serialize/parse round-trip)", () => {
  it("the moved body and its carried threads serialize, then re-parse with anchors + ids intact", () => {
    const doc: ParsedDocument = {
      body: "# Plan\n\n## Sec\n\nUse [PG](#cmt-a1) here.\n",
      comments: [c({ id: "cmt-a1", text: "pg?" }), c({ id: "cmt-r", parentId: "cmt-a1", text: "reply" })],
    };
    const r = moveSelectionToDoc(doc, "ignored", { startLine: 2, endLine: 4 }, "Sec", "./sec.md")!;
    // The host seeds the new doc as `${movedBody}\n` + the moved comment block (see App.tsx).
    const seeded = serialize({ body: `${r.movedBody}\n`, comments: r.movedComments });
    const round = parse(seeded);
    expect(round.body).toContain("[PG](#cmt-a1)"); // body anchor preserved
    expect(ids(round.comments)).toEqual(["cmt-a1", "cmt-r"]); // ids carried verbatim (not regenerated)
    expect(round.comments.find((x) => x.id === "cmt-r")?.parentId).toBe("cmt-a1"); // thread link intact
  });

  it("move preserves the moved comment ids (it does not regenerate them on extraction)", () => {
    const doc: ParsedDocument = {
      body: "# Plan\n\n## Sec\n\nUse [PG](#cmt-a1) here.\n",
      comments: [c({ id: "cmt-a1" })],
    };
    const r = moveSelectionToDoc(doc, "ignored", { startLine: 2, endLine: 4 }, "Sec", "./sec.md")!;
    expect(ids(r.movedComments)).toEqual(["cmt-a1"]);
    expect(r.movedBody).toContain("(#cmt-a1)");
  });
});

describe("genId (id collisions regenerate a fresh, well-formed comment id)", () => {
  it("never returns an id already taken in the target doc, and stays cmt-base36 shaped", () => {
    const taken = new Set(["cmt-a1", "cmt-b2", "cmt-r"]);
    const id = genId(taken);
    expect(taken.has(id)).toBe(false);
    expect(id).toMatch(/^cmt-[0-9a-z]{6}$/);
  });

  it("regenerates a distinct id on each call so a batch stays collision-free", () => {
    const taken = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const id = genId(taken);
      expect(taken.has(id)).toBe(false);
      taken.add(id);
    }
    expect(taken.size).toBe(50);
  });

  it("skips a function-predicate's reserved ids", () => {
    let firstTry: string | null = null;
    const id = genId((candidate) => {
      if (firstTry === null) {
        firstTry = candidate; // pretend the first proposed id is taken
        return true;
      }
      return false;
    });
    expect(id).not.toBe(firstTry);
    expect(id).toMatch(/^cmt-[0-9a-z]{6}$/);
  });
});
