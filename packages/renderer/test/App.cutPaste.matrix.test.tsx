// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// App wiring for cut/paste of span-comment threads (the body-offset slice in onCutComments /
// onPasteComments over clipboard.ts). The source editor is stubbed to capture the clipboard
// callbacks App hands it; we invoke them directly and assert the document's RESPONSE both in
// the rail (data-cmt-card per root thread) and in the rendered preview (anchor links tagged
// data-cmt per id). The preview's anchor ids are the live body — a spliced-out anchor link
// disappears, a re-minted paste shows up as a NEW id, and pre-existing anchors stay put.

import { act, cleanup, render, waitFor } from "@testing-library/react";
import { forwardRef, useImperativeHandle } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Comment } from "@inplan/core";
import { createMemoryApi, type MemorySession } from "../src/memoryApi";
import type { ClipboardPayload } from "../src/clipboard";

// Captured clipboard props from the latest render of the (stubbed) SourceEditor.
let clip: {
  commentsForCopy?: (t: string) => Comment[];
  onCutComments?: (t: string, f: number, to: number) => void;
  onPasteComments?: (t: string, p: ClipboardPayload, f: number, to: number) => void;
} = {};

vi.mock("../src/SourceEditor", () => ({
  SourceEditor: forwardRef(function Stub(props: Record<string, unknown>, ref: React.Ref<unknown>) {
    useImperativeHandle(ref, () => ({ scrollToLine() {}, selectRange() {} }));
    clip = props as typeof clip;
    return null;
  }),
}));

// A span comment (root + reply) on one line, plus an unrelated doc-level comment that must
// survive a cut. The anchored line sits before the comment block so its body offset == its
// offset in the markdown source (the comment block is HTML, not body text the editor sees as
// body — but offsets here are within the bare body, which is everything before <!--inplan).
const ANCHOR_LINE = "See [the point](#cmt-root1) here.";
const DOC =
  "# Plan\n\n" +
  ANCHOR_LINE +
  "\n\nKeep [this one](#cmt-keep2) too.\n\n<!--inplan v1\n" +
  JSON.stringify([
    { id: "cmt-root1", author: "H <h@x>", date: "2026-06-08T00:00:00Z", resolved: false, text: "why here?" },
    { id: "cmt-rep1", parentId: "cmt-root1", author: "H <h@x>", date: "2026-06-08T00:01:00Z", resolved: false, text: "follow-up reply" },
    { id: "cmt-keep2", author: "H <h@x>", date: "2026-06-08T00:02:00Z", resolved: false, text: "other span note" },
    { id: "cmt-keep", anchor: "doc", author: "H <h@x>", date: "2026-06-08T00:03:00Z", resolved: false, text: "unrelated doc note" },
  ]) +
  "\n-->\n";

let session: MemorySession;

beforeEach(() => {
  clip = {};
  document.body.innerHTML = '<div id="root"></div>';
  localStorage.clear();
  localStorage.setItem("ap-layout", JSON.stringify({ panes: 3 })); // show the source pane (it hosts the clipboard props)
});
afterEach(cleanup);

async function mountApp(content = DOC, waitText = "why here?") {
  document.body.innerHTML = '<div id="root"></div>';
  session = createMemoryApi({ content });
  (window as unknown as { api: unknown }).api = session.api;
  const { App } = await import("../src/App");
  render(<App />);
  await waitFor(() => expect(document.body.textContent).toContain(waitText));
}

// The set of comment-anchor ids the PREVIEW currently renders as links (the live body).
const previewAnchorIds = (): string[] =>
  Array.from(document.querySelectorAll(".ap-rendered [data-cmt]")).map((el) => el.getAttribute("data-cmt")!);
// The set of root-thread ids the RAIL currently renders as cards.
const railCardIds = (): string[] =>
  Array.from(document.querySelectorAll("[data-cmt-card]")).map((el) => el.getAttribute("data-cmt-card")!);

describe("App cut/paste matrix — span-comment carry over clipboard", () => {
  it("CUT an anchored span: thread removed, body anchor spliced out, comment_deleted logged", async () => {
    await mountApp();
    // Sanity: before the cut the anchored thread is live in both rail + preview.
    await waitFor(() => expect(previewAnchorIds()).toContain("cmt-root1"));
    expect(railCardIds()).toContain("cmt-root1");

    // Cut the EXACT anchored line (its body offset == its source offset, it precedes the block).
    const from = DOC.indexOf(ANCHOR_LINE);
    const to = from + ANCHOR_LINE.length;
    await act(async () => clip.onCutComments!(ANCHOR_LINE, from, to));

    // The carried thread (root + reply) is gone from the rail, and its anchor link is spliced
    // out of the body (no longer rendered in the preview).
    await waitFor(() => expect(railCardIds()).not.toContain("cmt-root1"));
    expect(previewAnchorIds()).not.toContain("cmt-root1"); // body anchor link gone
    expect(document.body.textContent).not.toContain("why here?");
    expect(document.body.textContent).not.toContain("follow-up reply"); // the reply travelled with the root

    // The unrelated comments survive (doc-level note + the other span and its anchor).
    expect(document.body.textContent).toContain("unrelated doc note");
    expect(railCardIds()).toContain("cmt-keep2");
    expect(previewAnchorIds()).toContain("cmt-keep2"); // untouched body anchor

    // A comment_deleted action was logged, counting the carried thread (root + 1 reply).
    const log = await session.agent.log();
    const del = log.filter((e) => e.type === "comment_deleted");
    expect(del).toHaveLength(1);
    expect((del[0]!.payload as { count: number }).count).toBe(2);
  });

  it("PASTE into the live doc: id re-minted (no collision), only the pasted fragment href rewritten", async () => {
    await mountApp();
    // A clipboard payload whose id COLLIDES with a live thread (cmt-root1). The paste must
    // re-mint it against the live taken set rather than alias the existing thread.
    const payload: ClipboardPayload = {
      v: 1,
      comments: [{ id: "cmt-root1", author: "H <h@x>", date: "2026-06-08T00:00:00Z", resolved: false, text: "PASTED NOTE" }],
    };
    const before = new Set(previewAnchorIds());
    expect(before.has("cmt-root1")).toBe(true);

    // Paste a fragment that references the (colliding) clipboard id, at the very front of the body.
    await act(async () => clip.onPasteComments!("[pasted](#cmt-root1) ", payload, 0, 0));

    await waitFor(() => expect(document.body.textContent).toContain("PASTED NOTE"));

    // A NEW anchor id appears — distinct from the colliding id and from every pre-existing id.
    const after = previewAnchorIds();
    const minted = after.filter((id) => !before.has(id));
    expect(minted).toHaveLength(1);
    expect(minted[0]).not.toBe("cmt-root1");
    expect(/^cmt-[0-9a-z]+$/.test(minted[0]!)).toBe(true);

    // No collision: the pre-existing cmt-root1 thread is still its own, untouched, distinct thread.
    expect(railCardIds()).toContain("cmt-root1");
    expect(railCardIds()).toContain(minted[0]); // the pasted thread is a separate card
    expect(document.body.textContent).toContain("why here?"); // original thread's text intact

    // Pre-existing body anchors are untouched — the other span's anchor id is unchanged.
    expect(previewAnchorIds()).toContain("cmt-keep2");

    // comment_created logged for the single pasted thread.
    const log = await session.agent.log();
    const created = log.filter((e) => e.type === "comment_created");
    expect(created).toHaveLength(1);
    expect((created[0]!.payload as { count: number }).count).toBe(1);
  });

  it("PASTE the SAME clipboard twice → two distinct re-minted ids", async () => {
    await mountApp();
    const payload: ClipboardPayload = {
      v: 1,
      comments: [{ id: "cmt-root1", author: "H <h@x>", date: "2026-06-08T00:00:00Z", resolved: false, text: "TWICE NOTE" }],
    };
    const base = new Set(previewAnchorIds());

    await act(async () => clip.onPasteComments!("[a](#cmt-root1) ", payload, 0, 0));
    await waitFor(() => expect(document.body.textContent).toContain("TWICE NOTE"));
    const firstMinted = previewAnchorIds().filter((id) => !base.has(id));
    expect(firstMinted).toHaveLength(1);

    // Second paste of the IDENTICAL clipboard — must mint a fresh id against the now-larger taken set.
    const afterFirst = new Set(previewAnchorIds());
    await act(async () => clip.onPasteComments!("[b](#cmt-root1) ", payload, 0, 0));
    await waitFor(() => expect(previewAnchorIds().filter((id) => !afterFirst.has(id))).toHaveLength(1));
    const secondMinted = previewAnchorIds().filter((id) => !afterFirst.has(id));

    expect(secondMinted[0]).not.toBe(firstMinted[0]); // distinct ids — no aliasing across pastes
    expect(secondMinted[0]).not.toBe("cmt-root1");

    // Two distinct pasted cards now exist alongside the original.
    const cards = railCardIds();
    expect(cards).toContain(firstMinted[0]);
    expect(cards).toContain(secondMinted[0]);
    expect(cards).toContain("cmt-root1");
  });

  it("CUT/PASTE with NO anchor in the selection carries nothing", async () => {
    await mountApp();
    const railBefore = railCardIds().slice().sort();
    const anchorsBefore = previewAnchorIds().slice().sort();

    // Cut a no-anchor stretch (the "# Plan" heading + blank line, which holds no comment anchor).
    const noAnchor = "# Plan";
    const from = DOC.indexOf(noAnchor);
    await act(async () => clip.onCutComments!(noAnchor, from, from + noAnchor.length));

    // No thread carried: rail + anchor ids unchanged, and comment_deleted logs count 0.
    await waitFor(() => expect(document.body.textContent).not.toContain("# Plan"));
    expect(railCardIds().slice().sort()).toEqual(railBefore);
    expect(previewAnchorIds().slice().sort()).toEqual(anchorsBefore);

    // Paste a fragment with NO anchor and an empty comment payload — nothing new is added.
    await act(async () => clip.onPasteComments!("just plain text", { v: 1, comments: [] }, 0, 0));
    await waitFor(() => expect(document.body.textContent).toContain("just plain text"));
    expect(railCardIds().slice().sort()).toEqual(railBefore); // still no new threads
    expect(previewAnchorIds().slice().sort()).toEqual(anchorsBefore);

    const log = await session.agent.log();
    const del = log.filter((e) => e.type === "comment_deleted");
    expect(del).toHaveLength(1);
    expect((del[0]!.payload as { count: number }).count).toBe(0); // nothing carried out
    const created = log.filter((e) => e.type === "comment_created");
    expect(created).toHaveLength(1);
    expect((created[0]!.payload as { count: number }).count).toBe(0); // nothing carried in
  });
});
