// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The source editor's copy/cut/paste that carries span-comment threads. Mounts the REAL
// CodeMirror editor (it renders in happy-dom) and dispatches synthetic ClipboardEvents,
// asserting the editor (a) embeds threads in the clipboard's text/html on copy/cut, (b) asks
// the app to remove the span on cut, (c) hands a decoded payload to the app on an inplan
// paste, and (d) falls through to native paste for foreign clipboard content.

import { cleanup, render } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Comment } from "@inplan/core";
import { SourceEditor, type SourceEditorHandle } from "../src/SourceEditor";
import { buildClipHtml, readClipHtml, type ClipboardPayload } from "../src/clipboard";

const DOC = "Look at [this point](#cmt-root1) now";
const THREAD: Comment[] = [{ id: "cmt-root1", author: "H <h@x>", date: "2026-06-08T00:00:00Z", resolved: false, text: "why here?" }];

function mount(opts: {
  editable?: boolean;
  commentsForCopy?: (t: string) => Comment[];
  onCutComments?: (t: string, f: number, to: number) => void;
  onPasteComments?: (t: string, p: ClipboardPayload, f: number, to: number) => void;
}) {
  const ref = createRef<SourceEditorHandle>();
  const utils = render(
    <SourceEditor
      ref={ref}
      value={DOC}
      editable={opts.editable ?? true}
      onChange={() => {}}
      commentsForCopy={opts.commentsForCopy}
      onCutComments={opts.onCutComments}
      onPasteComments={opts.onPasteComments}
    />,
  );
  const content = utils.container.querySelector(".cm-content") as HTMLElement;
  return { ref, content, ...utils };
}

/** Fire a copy/cut/paste ClipboardEvent on the editor content with a fresh DataTransfer. */
function fireClip(content: HTMLElement, type: "copy" | "cut" | "paste", seed?: (dt: DataTransfer) => void): DataTransfer {
  const dt = new DataTransfer();
  seed?.(dt);
  const ev = new ClipboardEvent(type, { clipboardData: dt, bubbles: true, cancelable: true });
  content.dispatchEvent(ev);
  return dt;
}

afterEach(cleanup);

describe("SourceEditor clipboard (carry span comments)", () => {
  it("copy embeds the anchored threads in text/html and mirrors text/plain", () => {
    const commentsForCopy = vi.fn(() => THREAD);
    const { ref, content } = mount({ commentsForCopy });
    ref.current!.selectRange(0, DOC.length);

    const dt = fireClip(content, "copy");

    expect(commentsForCopy).toHaveBeenCalledWith(DOC);
    expect(dt.getData("text/plain")).toBe(DOC);
    const payload = readClipHtml(dt.getData("text/html"));
    expect(payload?.comments).toEqual(THREAD);
  });

  it("copy with no anchored comments falls through to native (no inplan html)", () => {
    const commentsForCopy = vi.fn(() => []); // app finds no threads in the selection
    const { ref, content } = mount({ commentsForCopy });
    ref.current!.selectRange(0, 4); // "Look" — no anchor

    const dt = fireClip(content, "copy");

    expect(commentsForCopy).toHaveBeenCalled();
    expect(dt.getData("text/html")).toBe(""); // we did not take over
  });

  it("cut embeds threads AND asks the app to remove the span", () => {
    const onCutComments = vi.fn();
    const { ref, content } = mount({ commentsForCopy: () => THREAD, onCutComments });
    ref.current!.selectRange(0, DOC.length);

    const dt = fireClip(content, "cut");

    expect(readClipHtml(dt.getData("text/html"))?.comments).toEqual(THREAD);
    expect(onCutComments).toHaveBeenCalledWith(DOC, 0, DOC.length);
  });

  it("cut falls through to native when the app gave no remover", () => {
    const { ref, content } = mount({ commentsForCopy: () => THREAD, onCutComments: undefined });
    ref.current!.selectRange(0, DOC.length);

    const dt = fireClip(content, "cut");

    expect(dt.getData("text/html")).toBe(""); // no remover → we don't take over the cut
  });

  it("paste of an inplan clip hands the decoded payload + selection to the app", () => {
    const onPasteComments = vi.fn();
    const { ref, content } = mount({ onPasteComments });
    ref.current!.selectRange(3, 3); // collapsed cursor at offset 3

    fireClip(content, "paste", (dt) => {
      dt.setData("text/plain", "[moved](#cmt-root1)");
      dt.setData("text/html", buildClipHtml("[moved](#cmt-root1)", THREAD));
    });

    expect(onPasteComments).toHaveBeenCalledTimes(1);
    const [text, payload, from, to] = onPasteComments.mock.calls[0]!;
    expect(text).toBe("[moved](#cmt-root1)");
    expect(payload.comments).toEqual(THREAD);
    expect([from, to]).toEqual([3, 3]);
  });

  it("paste of foreign content does not invoke the app paste handler", () => {
    const onPasteComments = vi.fn();
    const { ref, content } = mount({ onPasteComments });
    ref.current!.selectRange(0, 0);

    fireClip(content, "paste", (dt) => {
      dt.setData("text/plain", "just text");
      dt.setData("text/html", "<p>copied from elsewhere</p>");
    });

    expect(onPasteComments).not.toHaveBeenCalled();
  });
});
