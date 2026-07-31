// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pure toggle-logic behind the source pane's formatting toolbar (SourceToolbar.tsx via
// SourceEditor.tsx). No DOM/CodeMirror involved — each function just maps
// (text, from, to) -> {changes, selection}, so we apply the change ourselves to assert
// on the resulting text.

import { describe, expect, it } from "vitest";
import {
  codeBlockEdit,
  headingEdit,
  horizontalRuleEdit,
  linePrefixEdit,
  linkEdit,
  orderedListEdit,
  wrapEdit,
  type TextEdit,
} from "../src/markdownEdits";

/** Apply a TextEdit to `text` the way CodeMirror would, for assertions. */
function apply(text: string, edit: TextEdit): string {
  return text.slice(0, edit.changes.from) + edit.changes.insert + text.slice(edit.changes.to);
}

describe("headingEdit", () => {
  it("adds a heading prefix to a plain line", () => {
    expect(apply("Hello", headingEdit("Hello", 2, 2))).toBe("## Hello");
  });
  it("clicking the same level again clears it", () => {
    const once = apply("Hello", headingEdit("Hello", 0, 1));
    expect(once).toBe("# Hello");
    expect(apply(once, headingEdit(once, 0, 1))).toBe("Hello");
  });
  it("switching levels replaces rather than stacks", () => {
    const h1 = apply("Hello", headingEdit("Hello", 0, 1));
    expect(apply(h1, headingEdit(h1, 0, 3))).toBe("### Hello");
  });
  it("only touches the cursor's line", () => {
    const doc = "First\nSecond\nThird";
    expect(apply(doc, headingEdit(doc, 8, 2))).toBe("First\n## Second\nThird");
  });
});

describe("wrapEdit", () => {
  it("wraps a selection with the given marker", () => {
    expect(apply("Hello world", wrapEdit("Hello world", 0, 5, "**"))).toBe("**Hello** world");
  });
  it("unwraps when the selection itself carries the markers", () => {
    const bold = "**Hello** world";
    expect(apply(bold, wrapEdit(bold, 0, 9, "**"))).toBe("Hello world");
  });
  it("unwraps when the markers sit just outside the selection", () => {
    const bold = "**Hello** world";
    expect(apply(bold, wrapEdit(bold, 2, 7, "**"))).toBe("Hello world");
  });
  it("inserts an empty pair with the cursor between them when nothing is selected", () => {
    const edit = wrapEdit("ab", 1, 1, "_");
    expect(apply("ab", edit)).toBe("a__b");
    expect(edit.selection).toEqual({ anchor: 2 });
  });
  it("supports distinct open/close markers (used for headings-adjacent inline code fences etc.)", () => {
    expect(apply("x", wrapEdit("x", 0, 1, "<", ">"))).toBe("<x>");
  });
});

describe("linePrefixEdit (blockquote / bullet / checklist)", () => {
  it("adds the prefix to a plain line", () => {
    expect(apply("Hello", linePrefixEdit("Hello", 0, 0, "> "))).toBe("> Hello");
  });
  it("toggles it back off", () => {
    const quoted = "> Hello";
    expect(apply(quoted, linePrefixEdit(quoted, 2, 2, "> "))).toBe("Hello");
  });
  it("adds to every spanned line when at least one lacks it", () => {
    const doc = "- a\nb\n- c";
    expect(apply(doc, linePrefixEdit(doc, 0, doc.length, "- "))).toBe("- a\n- b\n- c");
  });
  it("removes from every spanned line only when ALL already have it", () => {
    const doc = "- a\n- b\n- c";
    expect(apply(doc, linePrefixEdit(doc, 0, doc.length, "- "))).toBe("a\nb\nc");
  });
  it("leaves blank lines within a multi-line span untouched", () => {
    const doc = "a\n\nb";
    expect(apply(doc, linePrefixEdit(doc, 0, doc.length, "> "))).toBe("> a\n\n> b");
  });
  it("still prefixes a single blank line under the cursor (starting a fresh list/quote line)", () => {
    expect(apply("", linePrefixEdit("", 0, 0, "- "))).toBe("- ");
  });
  it("with a prefixPattern, recognizes any matching variant (e.g. a checked checklist item) as already-prefixed", () => {
    const checked = "- [x] Task";
    expect(apply(checked, linePrefixEdit(checked, 0, checked.length, "- [ ] ", /^-\s\[[ xX]\]\s/))).toBe("Task");
  });
  it("with a prefixPattern, adding still uses the literal prefix (not the pattern)", () => {
    const plain = "Task";
    expect(apply(plain, linePrefixEdit(plain, 0, 0, "- [ ] ", /^-\s\[[ xX]\]\s/))).toBe("- [ ] Task");
  });
});

describe("orderedListEdit", () => {
  it("numbers plain lines sequentially", () => {
    const doc = "a\nb\nc";
    expect(apply(doc, orderedListEdit(doc, 0, doc.length))).toBe("1. a\n2. b\n3. c");
  });
  it("strips numbering when every spanned line already has it", () => {
    const doc = "1. a\n2. b";
    expect(apply(doc, orderedListEdit(doc, 0, doc.length))).toBe("a\nb");
  });
  it("still numbers a single blank line under the cursor", () => {
    expect(apply("", orderedListEdit("", 0, 0))).toBe("1. ");
  });
  it("renumbers cleanly on a mixed selection instead of stacking old numbers into new ones", () => {
    const doc = "1. a\nb\n3. c";
    expect(apply(doc, orderedListEdit(doc, 0, doc.length))).toBe("1. a\n2. b\n3. c");
  });
});

describe("codeBlockEdit", () => {
  it("fences a selection", () => {
    expect(apply("x = 1", codeBlockEdit("x = 1", 0, 5))).toBe("```\nx = 1\n```");
  });
  it("unfences when the selection is already exactly the fenced block", () => {
    const fenced = "```\nx = 1\n```";
    expect(apply(fenced, codeBlockEdit(fenced, 0, fenced.length))).toBe("x = 1");
  });
  it("opens an empty fenced block at the cursor when nothing is selected", () => {
    expect(apply("", codeBlockEdit("", 0, 0))).toBe("```\n\n```");
  });
});

describe("horizontalRuleEdit", () => {
  it("inserts a padded rule so it can't glue onto a preceding paragraph as a Setext heading", () => {
    expect(apply("Para", horizontalRuleEdit("Para", 4, 4))).toBe("Para\n\n---\n\n");
  });
});

describe("linkEdit", () => {
  it("wraps a selection as link text and selects the url placeholder", () => {
    const edit = linkEdit("click here", 0, 10);
    expect(apply("click here", edit)).toBe("[click here](url)");
    expect(edit.selection).toEqual({ anchor: 13, head: 16 });
  });
  it("uses a text placeholder when nothing is selected", () => {
    expect(apply("", linkEdit("", 0, 0))).toBe("[text](url)");
  });
});
