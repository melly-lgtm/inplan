// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// App wiring for clipboard carry-comments: the source editor is stubbed to capture the
// clipboard callbacks App hands it, then we invoke them directly and assert the document
// state (rail threads, body) responds — copy reads the right threads, paste re-IDs + adds
// them, cut removes the span's threads while leaving unrelated comments.

import { act, cleanup, render, waitFor } from "@testing-library/react";
import { forwardRef, useImperativeHandle } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Comment } from "@inplan/core";
import { createMemoryApi } from "../src/memoryApi";
import { buildClipHtml, readClipHtml, type ClipboardPayload } from "../src/clipboard";

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

// A span comment (root + reply) plus an unrelated doc-level comment that must survive a cut.
const DOC =
  "# Plan\n\nSee [the point](#cmt-root1) here.\n\n<!--inplan v1\n" +
  JSON.stringify([
    { id: "cmt-root1", author: "H <h@x>", date: "2026-06-08T00:00:00Z", resolved: false, text: "why here?" },
    { id: "cmt-rep1", parentId: "cmt-root1", author: "H <h@x>", date: "2026-06-08T00:01:00Z", resolved: false, text: "follow-up reply" },
    { id: "cmt-keep", anchor: "doc", author: "H <h@x>", date: "2026-06-08T00:02:00Z", resolved: false, text: "unrelated doc note" },
  ]) +
  "\n-->\n";

beforeEach(() => {
  clip = {};
  document.body.innerHTML = '<div id="root"></div>';
  localStorage.setItem("ap-layout", JSON.stringify({ panes: 3 })); // show the source pane (it hosts the clipboard props)
  const session = createMemoryApi({ content: DOC });
  (window as unknown as { api: unknown }).api = session.api;
});
afterEach(cleanup);

async function mountApp(content = DOC, waitText = "why here?") {
  document.body.innerHTML = '<div id="root"></div>';
  const session = createMemoryApi({ content });
  (window as unknown as { api: unknown }).api = session.api;
  const { App } = await import("../src/App");
  render(<App />);
  await waitFor(() => expect(document.body.textContent).toContain(waitText));
}

// A second, unrelated document to paste INTO — no comments, distinct body.
const OTHER_DOC = "# Other plan\n\nNothing here yet.\n\n<!--inplan v1\n[]\n-->\n";

describe("App clipboard carry-comments wiring", () => {
  it("commentsForCopy returns the anchored root + replies, or nothing when no anchor", async () => {
    await mountApp();
    const got = clip.commentsForCopy!("text [the point](#cmt-root1) more").map((c) => c.id);
    expect(got).toEqual(["cmt-root1", "cmt-rep1"]);
    expect(clip.commentsForCopy!("no anchor here")).toEqual([]);
  });

  it("onPasteComments re-IDs the carried thread, adds it, and rewrites the anchor", async () => {
    await mountApp();
    const payload: ClipboardPayload = {
      v: 1,
      comments: [{ id: "cmt-root1", author: "H <h@x>", date: "2026-06-08T00:00:00Z", resolved: false, text: "PASTED NOTE" }],
    };
    // Paste appended at the end of the body (offset past the end clamps in slice()).
    await act(async () => {
      clip.onPasteComments!("[copy](#cmt-root1)", payload, 9999, 9999);
    });
    // The pasted comment shows up as a NEW thread, and the original is untouched.
    await waitFor(() => expect(document.body.textContent).toContain("PASTED NOTE"));
    expect(document.body.textContent).toContain("why here?");
  });

  it("onCutComments removes the cut span's threads but keeps unrelated comments", async () => {
    await mountApp();
    // Cut a generous range covering the whole body (so the anchor is inside the slice).
    await act(async () => {
      clip.onCutComments!("whole body", 0, 9999);
    });
    await waitFor(() => expect(document.body.textContent).not.toContain("why here?"));
    expect(document.body.textContent).not.toContain("follow-up reply"); // the reply went too
    expect(document.body.textContent).toContain("unrelated doc note"); // the doc comment stays
  });

  it("CROSS-DOC: cut a commented span in one doc, paste into another — the whole thread travels", async () => {
    // Doc A: the cut handler writes text/plain + a text/html payload carrying the threads anchored
    // in the selection. Reproduce that write here (commentsForCopy → buildClipHtml), then cut.
    await mountApp(); // doc A (has cmt-root1 "why here?" + reply)
    const cutText = "See [the point](#cmt-root1) here.";
    const carried = clip.commentsForCopy!(cutText); // [root + reply]
    const clipboardHtml = buildClipHtml(cutText, carried); // what the cut handler puts on the clipboard
    await act(async () => clip.onCutComments!(cutText, 0, 9999)); // remove from doc A
    await waitFor(() => expect(document.body.textContent).not.toContain("why here?")); // gone from A

    // Doc B: a *different* document. The paste handler reads text/html and hands the decoded
    // payload to onPasteComments — re-IDed against B and spliced in.
    cleanup();
    await mountApp(OTHER_DOC, "Nothing here yet.");
    expect(document.body.textContent).not.toContain("why here?"); // B starts clean
    const payload = readClipHtml(clipboardHtml)!;
    expect(payload.comments.map((c) => c.text)).toEqual(["why here?", "follow-up reply"]);
    await act(async () => clip.onPasteComments!(cutText, payload, 0, 0));

    // The whole thread (root + reply) now lives in doc B.
    await waitFor(() => expect(document.body.textContent).toContain("why here?"));
    expect(document.body.textContent).toContain("follow-up reply");
  });
});
