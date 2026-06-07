// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { moveDocTitle, slugifyFilename } from "../src/newDoc";
import { linkSelectionToDoc, moveSelectionToDoc, spanSource } from "../src/docOps";

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

  it("moveSelectionToDoc replaces the selection with a [title](link), and spanSource returns the moved text", () => {
    const sel = "Use Postgres for storage and scale.";
    expect(spanSource(body, sel)).toBe(sel);
    expect(moveSelectionToDoc(body, sel, undefined, "Datastore", "./datastore.md")).toBe(
      "# Plan\n\n[Datastore](./datastore.md)\n",
    );
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
