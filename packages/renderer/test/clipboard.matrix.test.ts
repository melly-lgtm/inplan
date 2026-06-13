// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Matrix coverage for carrying span-comment threads through copy/cut/paste. The clipboard
// module exposes the primitives, not a single copy()/paste() — so we model a copy as
//   anchorIdsIn(text) -> threadsFor(ids, all) -> buildClipHtml(text, threads)
// and a paste as
//   readClipHtml(html) -> remapComments(payload.comments, taken) -> rewriteAnchors(text, idMap)
// and assert the end-to-end invariants (fresh ids, no collisions, threads preserved).

import type { Comment } from "@inplan/core";
import { describe, expect, it } from "vitest";
import { anchorIdsIn, buildClipHtml, readClipHtml, remapComments, rewriteAnchors, threadsFor } from "../src/clipboard";

const c = (over: Partial<Comment> & { id: string }): Comment => ({
  author: "Human <h@x>",
  date: "2026-06-08T00:00:00Z",
  resolved: false,
  text: "",
  ...over,
});

/** Model the copy side: pick the carried threads for the anchors in `text`, then serialize. */
function copy(text: string, all: Comment[]): { text: string; html: string } {
  const ids = anchorIdsIn(text);
  const threads = threadsFor(ids, all);
  return { text, html: buildClipHtml(text, threads) };
}

/** Model the paste side: deserialize, re-ID against `taken`, rewrite the fragment's hrefs. */
function paste(clip: { text: string; html: string }, taken: Set<string>): { text: string; comments: Comment[] } | null {
  const payload = readClipHtml(clip.html);
  if (!payload) return null;
  const { comments, idMap } = remapComments(payload.comments, taken);
  return { text: rewriteAnchors(clip.text, idMap), comments };
}

describe("copy carries an anchored thread", () => {
  const all: Comment[] = [
    c({ id: "cmt-root1", text: "root one" }),
    c({ id: "cmt-rep1a", parentId: "cmt-root1", text: "reply" }),
    c({ id: "cmt-rep1b", parentId: "cmt-rep1a", text: "nested reply" }),
    c({ id: "cmt-other", text: "unrelated" }),
  ];

  it("carries the anchored root plus its replies (transitively)", () => {
    const clip = copy("look [here](#cmt-root1) please", all);
    const payload = readClipHtml(clip.html)!;
    expect(payload.comments.map((x) => x.id)).toEqual(["cmt-root1", "cmt-rep1a", "cmt-rep1b"]);
    expect(payload.comments.map((x) => x.id)).not.toContain("cmt-other");
  });

  it("keeps the visible Markdown (anchor links intact) in the clip text", () => {
    const clip = copy("look [here](#cmt-root1) please", all);
    expect(clip.text).toBe("look [here](#cmt-root1) please");
    expect(clip.html).toContain("look [here](#cmt-root1) please".replace(/&/g, "&amp;"));
  });
});

describe("paste re-anchors with fresh ids", () => {
  const all: Comment[] = [
    c({ id: "cmt-root1", text: "root one" }),
    c({ id: "cmt-rep1a", parentId: "cmt-root1", text: "reply" }),
  ];

  it("mints fresh ids that collide with neither existing comments nor the source ids", () => {
    const clip = copy("see [x](#cmt-root1)", all);
    // The thread is pasted back into the SAME doc, so the source ids are already taken.
    const taken = new Set(all.map((x) => x.id));
    const out = paste(clip, taken)!;

    const newIds = out.comments.map((x) => x.id);
    expect(new Set(newIds).size).toBe(newIds.length); // all distinct
    for (const id of newIds) {
      expect(taken.has(id)).toBe(false); // no collision with existing
      expect(/^cmt-[0-9a-z]+$/.test(id)).toBe(true); // well-formed
    }
    // The reply still points at the (new) root id, preserving the thread shape.
    expect(out.comments[1]!.parentId).toBe(out.comments[0]!.id);
  });

  it("rewrites the fragment's anchor href to the new root id", () => {
    const clip = copy("see [x](#cmt-root1)", all);
    const taken = new Set(all.map((x) => x.id));
    const out = paste(clip, taken)!;

    const newRoot = out.comments[0]!.id;
    expect(out.text).toBe(`see [x](#${newRoot})`);
    expect(out.text).not.toContain("cmt-root1");
  });

  it("preserves all non-id fields through the round-trip", () => {
    const rich = c({ id: "cmt-root1", text: "café — naïve 🙂", author: "Opus 4.8 <claude@inplan.ai>", resolved: true });
    const clip = copy("note [x](#cmt-root1)", [rich]);
    const out = paste(clip, new Set(["cmt-root1"]))!;
    const pasted = out.comments[0]!;
    expect(pasted.text).toBe("café — naïve 🙂");
    expect(pasted.author).toBe("Opus 4.8 <claude@inplan.ai>");
    expect(pasted.resolved).toBe(true);
    expect(pasted.id).not.toBe("cmt-root1");
  });
});

describe("copy text with no anchor", () => {
  const all: Comment[] = [c({ id: "cmt-root1", text: "root" })];

  it("carries no comments when the selection has no anchor link", () => {
    const clip = copy("just some plain prose, no links", all);
    const payload = readClipHtml(clip.html)!;
    expect(payload.comments).toEqual([]);
  });

  it("pastes back the plain text unchanged with an empty comment set", () => {
    const clip = copy("plain prose", all);
    const out = paste(clip, new Set(["cmt-root1"]))!;
    expect(out.text).toBe("plain prose");
    expect(out.comments).toEqual([]);
  });

  it("carries nothing for an empty or whitespace-only selection", () => {
    expect(readClipHtml(copy("", all).html)!.comments).toEqual([]);
    expect(readClipHtml(copy("   \n\t ", all).html)!.comments).toEqual([]);
  });
});

describe("partial selection of an anchored span", () => {
  const all: Comment[] = [
    c({ id: "cmt-aaa111", text: "thread A" }),
    c({ id: "cmt-rep1", parentId: "cmt-aaa111", text: "reply" }),
  ];

  it("drops a thread whose opening label bracket was clipped off (dangling href)", () => {
    // The user selected from the middle of the anchored span: "](#cmt-aaa111) tail".
    const clip = copy("part of label](#cmt-aaa111) and a tail", all);
    const payload = readClipHtml(clip.html)!;
    // No FULL_ANCHOR match -> no thread carried, so a paste can't produce a dangling link
    // pointing at a non-existent (re-IDed) comment.
    expect(payload.comments).toEqual([]);
  });

  it("drops a thread whose closing paren was clipped off (truncated href)", () => {
    const clip = copy("look [here](#cmt-aaa111", all); // missing trailing ")"
    expect(readClipHtml(clip.html)!.comments).toEqual([]);
  });

  it("carries the thread when the WHOLE anchor survives even if surrounding text is partial", () => {
    const clip = copy("[here](#cmt-aaa111) plus a few trailing", all);
    expect(readClipHtml(clip.html)!.comments.map((x) => x.id)).toEqual(["cmt-aaa111", "cmt-rep1"]);
  });
});

describe("multiple anchored spans in one selection", () => {
  const all: Comment[] = [
    c({ id: "cmt-root1", text: "one" }),
    c({ id: "cmt-rep1", parentId: "cmt-root1", text: "r1" }),
    c({ id: "cmt-root2", text: "two" }),
    c({ id: "cmt-rep2", parentId: "cmt-root2", text: "r2" }),
    c({ id: "cmt-other", text: "untouched" }),
  ];

  it("carries every anchored thread, in document order, excluding unrelated comments", () => {
    const clip = copy("a [x](#cmt-root1) mid [y](#cmt-root2) end", all);
    const payload = readClipHtml(clip.html)!;
    expect(payload.comments.map((x) => x.id)).toEqual(["cmt-root1", "cmt-rep1", "cmt-root2", "cmt-rep2"]);
    expect(payload.comments.map((x) => x.id)).not.toContain("cmt-other");
  });

  it("re-IDs both threads to distinct fresh ids and rewrites both hrefs accordingly", () => {
    const clip = copy("a [x](#cmt-root1) mid [y](#cmt-root2) end", all);
    const taken = new Set(all.map((x) => x.id));
    const out = paste(clip, taken)!;

    const newIds = out.comments.map((x) => x.id);
    expect(new Set(newIds).size).toBe(4); // all four distinct
    for (const id of newIds) expect(taken.has(id)).toBe(false);

    // Replies stay attached to their respective (new) roots.
    const [nRoot1, nRep1, nRoot2, nRep2] = newIds;
    expect(out.comments[1]!.parentId).toBe(nRoot1);
    expect(out.comments[3]!.parentId).toBe(nRoot2);
    expect(nRep1).not.toBe(nRep2);

    // Both fragment hrefs were rewritten to their respective roots.
    expect(out.text).toBe(`a [x](#${nRoot1}) mid [y](#${nRoot2}) end`);
    expect(out.text).not.toContain("cmt-root1");
    expect(out.text).not.toContain("cmt-root2");
  });

  it("handles a selection anchoring the same comment twice without duplicating the carried thread", () => {
    const clip = copy("[a](#cmt-root1) and again [b](#cmt-root1)", all);
    const payload = readClipHtml(clip.html)!;
    // threadsFor de-dupes via a Set, so the root appears once.
    expect(payload.comments.map((x) => x.id)).toEqual(["cmt-root1", "cmt-rep1"]);

    // Both hrefs rewrite to the single new id.
    const out = paste(clip, new Set(all.map((x) => x.id)))!;
    const newRoot = out.comments[0]!.id;
    expect(out.text).toBe(`[a](#${newRoot}) and again [b](#${newRoot})`);
  });
});

describe("pasting the same clipboard twice yields distinct ids each time", () => {
  const all: Comment[] = [
    c({ id: "cmt-root1", text: "root" }),
    c({ id: "cmt-rep1", parentId: "cmt-root1", text: "reply" }),
  ];

  it("the second paste does not collide with the first paste's minted ids", () => {
    const clip = copy("see [x](#cmt-root1)", all);

    // First paste into the live doc.
    const taken = new Set(all.map((x) => x.id));
    const first = paste(clip, taken)!;
    // Those ids are now live too; reflect that in `taken` for the second paste.
    for (const x of first.comments) taken.add(x.id);

    const second = paste(clip, taken)!;

    const firstIds = first.comments.map((x) => x.id);
    const secondIds = second.comments.map((x) => x.id);
    // No overlap between the two pastes, and none reuse the originals.
    for (const id of secondIds) {
      expect(firstIds).not.toContain(id);
      expect(id).not.toBe("cmt-root1");
      expect(id).not.toBe("cmt-rep1");
    }
    // Each paste rewrites its fragment to its own root id.
    expect(first.text).toBe(`see [x](#${first.comments[0]!.id})`);
    expect(second.text).toBe(`see [x](#${second.comments[0]!.id})`);
    expect(first.text).not.toBe(second.text);
  });
});

describe("round-trips a question + answer thread", () => {
  const all: Comment[] = [
    c({
      id: "cmt-q1",
      author: "Opus 4.8 <claude@inplan.ai>",
      text: "Which approach?",
      question: { multiSelect: false, choices: [{ label: "A", description: "first" }, { label: "B" }] },
    }),
    c({ id: "cmt-a1", parentId: "cmt-q1", text: "going with A", selected: ["A"] }),
  ];

  it("preserves the question payload and the answer's selected choices, with fresh linked ids", () => {
    const clip = copy("decision: [q](#cmt-q1)", all);
    const out = paste(clip, new Set(all.map((x) => x.id)))!;

    expect(out.comments).toHaveLength(2);
    const [q, a] = out.comments;

    // Question structure preserved verbatim.
    expect(q!.question).toEqual({ multiSelect: false, choices: [{ label: "A", description: "first" }, { label: "B" }] });
    expect(q!.text).toBe("Which approach?");

    // Answer preserved; selected choices survive; parent re-linked to the new question id.
    expect(a!.text).toBe("going with A");
    expect(a!.selected).toEqual(["A"]);
    expect(a!.parentId).toBe(q!.id);

    // Fresh ids on both, and the fragment href points at the new question id.
    expect(q!.id).not.toBe("cmt-q1");
    expect(a!.id).not.toBe("cmt-a1");
    expect(out.text).toBe(`decision: [q](#${q!.id})`);
  });
});

describe("foreign / plain-text clipboard falls through", () => {
  it("returns null for HTML with no inplan marker (native paste, no comments)", () => {
    expect(readClipHtml("<p>copied from a browser</p>")).toBeNull();
  });

  it("returns null for a malformed (non-base64) payload", () => {
    expect(readClipHtml('<span data-inplan-clip="@@not-base64@@"></span>')).toBeNull();
  });
});
