// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, it, expect } from "vitest";
import * as Y from ***REMOVED***;
import type { Comment } from "@inplan/core";
import { createMemoryCommentStore, ***REMOVED***, orderComments, reconcileComments, type CommentStore } from "../src/commentStore";

const c = (id: string, over: Partial<Comment> = {}): Comment => ({
  id,
  text: `text ${id}`,
  author: "Tester <t@inplan.ai>",
  date: "2026-06-08T00:00:00Z",
  resolved: false,
  ...over,
});

function yStore(): { store: CommentStore; arr: Y.Array<***REMOVED***<unknown>> } {
  const doc = new ***REMOVED***();
  const arr = doc.getArray<***REMOVED***<unknown>>("comments");
  return { store: ***REMOVED***(arr), arr };
}

// Run the same behavioral contract against both implementations.
const FACTORIES: [string, () => CommentStore][] = [
  ["memory", () => createMemoryCommentStore()],
  [***REMOVED***, () => yStore().store],
];

describe.each(FACTORIES)("CommentStore (%s)", (_name, make) => {
  it("adds, lists, patches, and removes", () => {
    const s = make();
    s.add(c("cmt-aaa111", { date: "2026-06-08T00:00:01Z" }));
    s.add(c("cmt-bbb222", { date: "2026-06-08T00:00:02Z" }));
    expect(s.list().map((x) => x.id)).toEqual(["cmt-aaa111", "cmt-bbb222"]);

    s.patch("cmt-aaa111", { resolved: true, text: "edited" });
    const a = s.list().find((x) => x.id === "cmt-aaa111")!;
    expect(a.resolved).toBe(true);
    expect(a.text).toBe("edited");

    s.remove("cmt-bbb222");
    expect(s.list().map((x) => x.id)).toEqual(["cmt-aaa111"]);
  });

  it("round-trips unknown / forward-compat fields (not just the known schema)", () => {
    const s = make();
    s.add({ ...c("cmt-fwd001"), extra_meta: { k: "v" }, future_flag: true } as unknown as Comment);
    const got = s.list().find((x) => x.id === "cmt-fwd001")! as unknown as Record<string, unknown>;
    expect(got.extra_meta).toEqual({ k: "v" });
    expect(got.future_flag).toBe(true);
  });

  it("round-trips structured fields (question + selected)", () => {
    const s = make();
    s.add(
      c("cmt-q00001", {
        question: { multiSelect: false, choices: [{ label: "A", description: "first" }, { label: "B" }] },
      }),
    );
    s.add(c("cmt-a00002", { parentId: "cmt-q00001", selected: ["A"], date: "2026-06-08T00:00:05Z" }));
    const q = s.list().find((x) => x.id === "cmt-q00001")!;
    expect(q.question).toEqual({ multiSelect: false, choices: [{ label: "A", description: "first" }, { label: "B" }] });
    const ans = s.list().find((x) => x.id === "cmt-a00002")!;
    expect(ans.selected).toEqual(["A"]);
    expect(ans.parentId).toBe("cmt-q00001");
  });

  it("patch with undefined removes a field", () => {
    const s = make();
    s.add(c("cmt-aaa111", { may_resolve: true }));
    expect(s.list()[0]!.may_resolve).toBe(true);
    s.patch("cmt-aaa111", { may_resolve: undefined });
    expect(s.list()[0]!.may_resolve).toBeUndefined();
  });

  it("replaceAll seeds the whole set", () => {
    const s = make();
    s.add(c("cmt-old001"));
    s.replaceAll([c("cmt-new001"), c("cmt-new002")]);
    expect(s.list().map((x) => x.id)).toEqual(["cmt-new001", "cmt-new002"]);
  });

  it("notifies observers on change", () => {
    const s = make();
    let hits = 0;
    const off = s.observe(() => hits++);
    s.add(c("cmt-aaa111"));
    expect(hits).toBeGreaterThan(0);
    const before = hits;
    off();
    s.add(c("cmt-bbb222"));
    expect(hits).toBe(before);
  });
});

describe("orderComments (canonical projection order)", () => {
  it("orders roots by (date, id) with replies grouped under their parent", () => {
    const root1 = c("cmt-root01", { date: "2026-06-08T00:00:01Z" });
    const root2 = c("cmt-root02", { date: "2026-06-08T00:00:03Z" });
    const reply1b = c("cmt-rep1b0", { parentId: "cmt-root01", date: "2026-06-08T00:00:05Z" });
    const reply1a = c("cmt-rep1a0", { parentId: "cmt-root01", date: "2026-06-08T00:00:02Z" });
    // Deliberately shuffled input.
    const ordered = orderComments([reply1b, root2, reply1a, root1]);
    expect(ordered.map((x) => x.id)).toEqual(["cmt-root01", "cmt-rep1a0", "cmt-rep1b0", "cmt-root02"]);
  });

  it("is deterministic regardless of input order (two peers serialize identically)", () => {
    const items = [
      c("cmt-zzz999", { date: "2026-06-08T00:00:02Z" }),
      c("cmt-aaa111", { date: "2026-06-08T00:00:02Z" }), // same date -> tiebreak by id
      c("cmt-mmm555", { date: "2026-06-08T00:00:01Z" }),
    ];
    const a = orderComments(items).map((x) => x.id);
    const b = orderComments([...items].reverse()).map((x) => x.id);
    expect(a).toEqual(b);
    expect(a).toEqual(["cmt-mmm555", "cmt-aaa111", "cmt-zzz999"]);
  });

  it("treats an orphan reply (missing parent) as a root rather than dropping it", () => {
    const orphan = c("cmt-orph01", { parentId: "cmt-gone00", date: "2026-06-08T00:00:09Z" });
    const root = c("cmt-root01", { date: "2026-06-08T00:00:01Z" });
    const ordered = orderComments([orphan, root]);
    expect(ordered.map((x) => x.id).sort()).toEqual(["cmt-orph01", "cmt-root01"]);
    expect(ordered).toHaveLength(2);
  });
});

describe.each(FACTORIES)("reconcileComments (%s)", (_name, make) => {
  it("adds new, patches changed, removes gone — and preserves untouched ones", () => {
    const s = make();
    s.replaceAll([c("cmt-keep01"), c("cmt-edit01", { resolved: false }), c("cmt-gone01")]);
    const prev = s.list();
    const next = [
      c("cmt-keep01"), // untouched
      c("cmt-edit01", { resolved: true }), // patched
      c("cmt-new001", { date: "2026-06-08T00:00:09Z" }), // added
      // cmt-gone01 removed
    ];
    reconcileComments(s, prev, next);
    const byId = new Map(s.list().map((x) => [x.id, x]));
    expect([...byId.keys()].sort()).toEqual(["cmt-edit01", "cmt-keep01", "cmt-new001"]);
    expect(byId.get("cmt-edit01")!.resolved).toBe(true);
  });

  it("patch removes a field cleared in next", () => {
    const s = make();
    s.replaceAll([c("cmt-aaa111", { may_resolve: true })]);
    reconcileComments(s, s.list(), [c("cmt-aaa111")]);
    expect(s.list()[0]!.may_resolve).toBeUndefined();
  });

  it("a no-op delta touches nothing (no spurious notifications)", () => {
    const s = make();
    s.replaceAll([c("cmt-aaa111"), c("cmt-bbb222")]);
    let hits = 0;
    const off = s.observe(() => hits++);
    reconcileComments(s, s.list(), s.list());
    off();
    expect(hits).toBe(0);
  });
});

describe("***REMOVED*** over a shared doc", () => {
  it("reflects remote ops applied to the underlying Y.Array", () => {
    const { store, arr } = yStore();
    // Simulate a remote peer pushing a comment straight onto the array.
    const m = new ***REMOVED***<unknown>([
      ["id", "cmt-remote1"],
      ["text", "from a peer"],
      ["author", "Peer <p@inplan.ai>"],
      ["date", "2026-06-08T00:00:01Z"],
      ["resolved", false],
    ]);
    arr.doc!.transact(() => arr.push([m]));
    expect(store.list().map((x) => x.id)).toEqual(["cmt-remote1"]);
  });
});
