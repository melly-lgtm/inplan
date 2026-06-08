// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import { orderComments, serializeCanonical, parse, type Comment } from "../src/index";

const c = (id: string, over: Partial<Comment> = {}): Comment => ({
  id,
  text: `text ${id}`,
  author: "Tester <t@inplan.ai>",
  date: "2026-06-08T00:00:00Z",
  resolved: false,
  ...over,
});

describe("orderComments", () => {
  it("orders roots by (date, id) with replies grouped under their parent", () => {
    const ordered = orderComments([
      c("cmt-rep1b0", { parentId: "cmt-root01", date: "2026-06-08T00:00:05Z" }),
      c("cmt-root02", { date: "2026-06-08T00:00:03Z" }),
      c("cmt-rep1a0", { parentId: "cmt-root01", date: "2026-06-08T00:00:02Z" }),
      c("cmt-root01", { date: "2026-06-08T00:00:01Z" }),
    ]);
    expect(ordered.map((x) => x.id)).toEqual(["cmt-root01", "cmt-rep1a0", "cmt-rep1b0", "cmt-root02"]);
  });

  it("is deterministic regardless of input order, tiebreaking equal dates by id", () => {
    const items = [
      c("cmt-zzz999", { date: "2026-06-08T00:00:02Z" }),
      c("cmt-aaa111", { date: "2026-06-08T00:00:02Z" }),
      c("cmt-mmm555", { date: "2026-06-08T00:00:01Z" }),
    ];
    const a = orderComments(items).map((x) => x.id);
    expect(a).toEqual(orderComments([...items].reverse()).map((x) => x.id));
    expect(a).toEqual(["cmt-mmm555", "cmt-aaa111", "cmt-zzz999"]);
  });

  it("treats an orphan reply as a root and never drops or duplicates a comment", () => {
    const ordered = orderComments([
      c("cmt-orph01", { parentId: "cmt-gone00", date: "2026-06-08T00:00:09Z" }),
      c("cmt-root01", { date: "2026-06-08T00:00:01Z" }),
    ]);
    expect(ordered).toHaveLength(2);
    expect(new Set(ordered.map((x) => x.id))).toEqual(new Set(["cmt-orph01", "cmt-root01"]));
  });

  it("survives a cycle (parentId pointing back) by emitting each comment once", () => {
    const ordered = orderComments([
      c("cmt-aaa111", { parentId: "cmt-bbb222" }),
      c("cmt-bbb222", { parentId: "cmt-aaa111" }),
    ]);
    expect(ordered).toHaveLength(2);
  });
});

describe("serializeCanonical", () => {
  it("emits the comment block in canonical order and round-trips through parse", () => {
    const doc = {
      body: "# Plan\n\nHello.",
      comments: [
        c("cmt-bbb222", { date: "2026-06-08T00:00:02Z" }),
        c("cmt-aaa111", { date: "2026-06-08T00:00:01Z" }),
      ],
    };
    const text = serializeCanonical(doc);
    const reparsed = parse(text);
    expect(reparsed.body).toBe(doc.body);
    expect(reparsed.comments.map((x) => x.id)).toEqual(["cmt-aaa111", "cmt-bbb222"]);
    // Deterministic: re-serializing the reparsed doc yields identical bytes.
    expect(serializeCanonical(reparsed)).toBe(text);
  });
});
