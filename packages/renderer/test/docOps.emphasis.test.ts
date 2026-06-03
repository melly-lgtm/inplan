// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Inserting a comment link must keep crossed inline markup (bold/italic/strike/code)
// balanced — close a run before the boundary, reopen it after — and deleting the comment
// must merge the split runs back (round-trip).

import { describe, expect, it } from "vitest";
import { addSpanComment, deleteComment, scanOpenMarkers } from "../src/docOps";

const doc = (body: string) => ({ body, comments: [] });
const fields = { text: "c", author: "me" };
const wrap = (body: string, sel: string) => addSpanComment(doc(body), sel, fields)!.doc.body;
function roundtrip(body: string, sel: string): string {
  const r = addSpanComment(doc(body), sel, fields)!;
  return deleteComment(r.doc, r.id).body;
}

describe("comment link keeps inline markup balanced", () => {
  it("crossing the end of a bold run splits it (the reported bug)", () => {
    expect(wrap("for **human 9**", "for human")).toMatch(/^\[for \*\*human\*\*\]\(#cmt-[0-9a-z]+\)\*\* 9\*\*$/);
  });
  it("a fully-contained bold word keeps its markers inside the label", () => {
    expect(wrap("**Bold**", "Bold")).toMatch(/^\[\*\*Bold\*\*\]\(#cmt-[0-9a-z]+\)$/);
  });
  it("a bold word at the start of a longer run", () => {
    expect(wrap("**human and more**", "human")).toMatch(/^\[\*\*human\*\*\]\(#cmt-[0-9a-z]+\)\*\* and more\*\*$/);
  });
  it("plain text is wrapped as-is", () => {
    expect(wrap("plain text here", "text")).toMatch(/^plain \[text\]\(#cmt-[0-9a-z]+\) here$/);
  });
  it("contained italic", () => {
    expect(wrap("say *hi* there", "hi")).toMatch(/^say \[\*hi\*\]\(#cmt-[0-9a-z]+\) there$/);
  });
  it("contained strikethrough", () => {
    expect(wrap("a ~~b~~ c", "b")).toMatch(/^a \[~~b~~\]\(#cmt-[0-9a-z]+\) c$/);
  });
  it("crossing a strikethrough boundary splits it", () => {
    expect(wrap("a ~~b c~~ d", "a b")).toMatch(/^\[a ~~b~~\]\(#cmt-[0-9a-z]+\)~~ c~~ d$/);
  });
  it("nested bold+italic — bold wraps the link, italic stays in the label", () => {
    expect(wrap("**a *b* c**", "b")).toMatch(/^\*\*a \[\*b\*\]\(#cmt-[0-9a-z]+\) c\*\*$/);
  });
});

describe("deleting a comment merges the split run back (round-trip)", () => {
  it.each([
    ["for **human 9**", "for human"],
    ["**Bold**", "Bold"],
    ["**human and more**", "human"],
    ["plain text here", "text"],
    ["say *hi* there", "hi"],
    ["a ~~b~~ c", "b"],
    ["a ~~b c~~ d", "a b"],
    ["**a *b* c**", "b"],
  ])("%s / select %s round-trips", (body, sel) => {
    expect(roundtrip(body, sel)).toBe(body);
  });
});

describe("scanOpenMarkers", () => {
  it("tracks open emphasis at a position", () => {
    expect(scanOpenMarkers("**a b** c", 3)).toEqual(["**"]); // inside the bold run
    expect(scanOpenMarkers("**a b** c", 8)).toEqual([]); // after it closes
    expect(scanOpenMarkers("*a* **b", 7)).toEqual(["**"]); // first run closed, second open
    expect(scanOpenMarkers("**a *b*", 7)).toEqual(["**"]); // italic closed, bold still open
  });
  it("ignores markers inside code spans and escapes", () => {
    expect(scanOpenMarkers("`**not bold**` x", 15)).toEqual([]); // code content is opaque
    expect(scanOpenMarkers("\\*a\\* x", 7)).toEqual([]); // both stars escaped
  });
});
