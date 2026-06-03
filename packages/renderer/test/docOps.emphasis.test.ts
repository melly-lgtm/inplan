// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { findSpanRange, addSpanComment } from "../src/docOps";

const doc = (body: string) => ({ body, comments: [] });
const fields = { text: "c", author: "me" };

describe("findSpanRange — leading-emphasis inclusion (item 7)", () => {
  it("pulls in the leading ** when the selection starts on a bold run", () => {
    // preview shows "Bold text"; selecting "Bold" must anchor "**Bold**", not "Bold".
    const body = "**Bold** text";
    const r = findSpanRange(body, "Bold")!;
    expect(body.slice(r.start, r.end)).toBe("**Bold**");
  });

  it("includes the opening ** when the selection starts bold and runs into plain text", () => {
    const body = "**Bold** rest";
    const r = findSpanRange(body, "Bold rest")!;
    expect(body.slice(r.start, r.end)).toBe("**Bold** rest");
  });

  it("handles italic and code markers the same way", () => {
    const it1 = findSpanRange("*it* x", "it")!;
    expect("*it* x".slice(it1.start, it1.end)).toBe("*it*");
    const c1 = findSpanRange("`code` x", "code")!;
    expect("`code` x".slice(c1.start, c1.end)).toBe("`code`");
  });

  it("does NOT pull in markers that close the previous word (preceded by a word char)", () => {
    const body = "x**y** z"; // not valid bold; the ** before y is not an opener
    const r = findSpanRange(body, "y")!;
    expect(body.slice(r.start, r.end)).toBe("y");
  });

  it("leaves a plain-text selection unchanged", () => {
    const body = "plain words here";
    const r = findSpanRange(body, "words")!;
    expect(body.slice(r.start, r.end)).toBe("words");
  });
});

describe("addSpanComment — wraps the emphasis-expanded span", () => {
  it("keeps the bold markers inside the anchor label", () => {
    const res = addSpanComment(doc("**Bold** text"), "Bold", fields)!;
    expect(res.doc.body).toMatch(/^\[\*\*Bold\*\*\]\(#cmt-[0-9a-z]+\) text$/);
  });
});
