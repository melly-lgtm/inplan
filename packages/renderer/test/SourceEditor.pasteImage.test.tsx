// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pasting an image (screenshot tool, browser "copy image", etc.) onto the source editor: the
// editor hands the raw bytes + MIME type to the app's onPasteImage, then inserts a Markdown
// image link at the cursor once it resolves. A clipboard with no image file falls through to
// the existing (comment-aware) paste handling untouched.

import { cleanup, render } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SourceEditor, type SourceEditorHandle } from "../src/SourceEditor";

function mount(onPasteImage?: (bytes: ArrayBuffer, mime: string) => Promise<string | null>) {
  const ref = createRef<SourceEditorHandle>();
  const utils = render(<SourceEditor ref={ref} value="Hello world" editable onChange={() => {}} onPasteImage={onPasteImage} />);
  const content = utils.container.querySelector(".cm-content") as HTMLElement;
  const text = () => content.textContent;
  return { ref, content, text };
}

/** A synthetic "image on the clipboard" paste — a plain object standing in for DataTransfer
 *  (happy-dom's real DataTransfer doesn't wire `.items.add()` through to `.files`), which is
 *  all the handler under test reads (`e.clipboardData.files`). */
function firePasteImage(content: HTMLElement, file: File): ClipboardEvent {
  const ev = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "clipboardData", { value: { files: [file], getData: () => "" } });
  content.dispatchEvent(ev);
  return ev;
}

const PNG = new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" });

afterEach(cleanup);

describe("SourceEditor image paste", () => {
  it("hands the image's bytes + MIME type to onPasteImage and inserts the returned link", async () => {
    const onPasteImage = vi.fn(async () => "design.plan.assets/image-20260731.png");
    const { ref, text } = mount(onPasteImage);
    ref.current!.selectRange(0, 0);

    await firePasteImage(document.querySelector(".cm-content")!, PNG);
    await Promise.resolve(); // let the paste handler's async chain settle
    await Promise.resolve();

    expect(onPasteImage).toHaveBeenCalledTimes(1);
    const [bytes, mime] = onPasteImage.mock.calls[0]!;
    expect(mime).toBe("image/png");
    expect(new Uint8Array(bytes)).toEqual(new Uint8Array([1, 2, 3]));
    expect(text()).toBe("![](design.plan.assets/image-20260731.png)Hello world");
  });

  it("does nothing (no insert) when onPasteImage resolves null — e.g. the host couldn't write it", async () => {
    const onPasteImage = vi.fn(async () => null);
    const { ref, text } = mount(onPasteImage);
    ref.current!.selectRange(0, 0);

    await firePasteImage(document.querySelector(".cm-content")!, PNG);
    await Promise.resolve();
    await Promise.resolve();

    expect(text()).toBe("Hello world");
  });

  it("without an onPasteImage prop, an image paste falls through untouched (no crash)", () => {
    const { content, text } = mount(undefined);
    firePasteImage(content, PNG);
    expect(text()).toBe("Hello world");
  });

  it("a text-only paste is unaffected by the image-paste handler", () => {
    const onPasteImage = vi.fn();
    const { content, text } = mount(onPasteImage);
    const ev = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "clipboardData", { value: { files: [], getData: () => "plain text" } });
    content.dispatchEvent(ev);
    expect(onPasteImage).not.toHaveBeenCalled();
    expect(text()).toBe("plain textHello world"); // no inplan comment payload either → native paste happens
  });
});
