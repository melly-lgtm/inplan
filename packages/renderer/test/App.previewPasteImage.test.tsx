// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pasting an image directly into the (read-only) rendered preview — not just the Source pane:
// it's inserted right after the active (blue-highlighted, click-synced) block, using that
// block's data-end-line so a paste into a multi-line paragraph lands after the WHOLE paragraph
// rather than splitting it. No active block yet ⇒ appended at the end of the document.

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { forwardRef, useImperativeHandle } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryApi } from "../src/memoryApi";

vi.mock("../src/SourceEditor", () => ({
  SourceEditor: forwardRef(function SourceEditorStub(_props: unknown, ref: React.Ref<unknown>) {
    useImperativeHandle(ref, () => ({ scrollToLine() {}, selectRange() {} }));
    return null;
  }),
}));

// A multi-line paragraph ("line one\nline two continues") so a click syncs to its FIRST source
// line (2) while its data-end-line (3) differs — the case that actually exercises the fix.
const DOC = "# Plan\n\nline one\nline two continues\n\nSecond paragraph.\n\n<!--inplan v1\n[]\n-->\n";
const PNG = new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" });

function firePasteImage(el: Element, file: File) {
  const ev = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "clipboardData", { value: { files: [file], getData: () => "" } });
  el.dispatchEvent(ev);
}

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>';
  const session = createMemoryApi({ content: DOC });
  (session.api as unknown as { saveAsset: unknown }).saveAsset = vi.fn(async () => ({ relPath: "plan.assets/x.png" }));
  (window as unknown as { api: unknown }).api = session.api;
});
afterEach(cleanup);

async function mountApp() {
  const { App } = await import("../src/App");
  render(<App />);
  await waitFor(() => expect(document.body.textContent).toContain("Second paragraph."));
}

describe("preview pane image paste", () => {
  it("with no active block yet, appends the image at the end of the document", async () => {
    await mountApp();
    const rendered = document.querySelector(".ap-rendered")!;

    await act(async () => firePasteImage(rendered, PNG));
    await waitFor(() => expect(document.querySelector(".ap-rendered")?.innerHTML).toContain("plan.assets/x.png"));

    const html = document.querySelector(".ap-rendered")!.innerHTML;
    expect(html.indexOf("Second paragraph.")).toBeLessThan(html.indexOf("plan.assets/x.png"));
  });

  it("inserts right after the WHOLE active paragraph (its data-end-line), not mid-paragraph", async () => {
    await mountApp();
    // Click the multi-line paragraph — syncs activePreviewLine to its FIRST line (2).
    const para = screen.getByText(/line one/);
    fireEvent.click(para.closest("[data-line]")!);

    const rendered = document.querySelector(".ap-rendered")!;
    await act(async () => firePasteImage(rendered, PNG));

    await waitFor(() => expect(document.querySelector(".ap-rendered")?.innerHTML).toContain("plan.assets/x.png"));
    // "line two continues" (the paragraph's LAST line) must precede the image in the source
    // order; if the insert had used data-line (2) instead of data-end-line (3), the image
    // would land between "line one" and "line two continues" instead.
    const html = document.querySelector(".ap-rendered")!.innerHTML;
    expect(html.indexOf("line two continues")).toBeLessThan(html.indexOf("plan.assets/x.png"));
    expect(html.indexOf("plan.assets/x.png")).toBeLessThan(html.indexOf("Second paragraph."));
  });

  it("does nothing for a plain (non-image) paste", async () => {
    const saveAsset = vi.fn();
    await mountApp();
    (window as unknown as { api: { saveAsset: unknown } }).api.saveAsset = saveAsset;
    const rendered = document.querySelector(".ap-rendered")!;

    const ev = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "clipboardData", { value: { files: [], getData: () => "plain text" } });
    await act(async () => rendered.dispatchEvent(ev));

    expect(saveAsset).not.toHaveBeenCalled();
  });
});
