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

// Exposes the SourceEditor's onCursorLine prop on window so a test can fire it directly — this
// is how activePreviewLine gets set from the SOURCE pane's cursor (as opposed to a preview
// click, which always lands on a block's own data-line), and it need not be a block boundary.
vi.mock("../src/SourceEditor", () => ({
  SourceEditor: forwardRef(function SourceEditorStub(props: { onCursorLine?: (line: number) => void }, ref: React.Ref<unknown>) {
    useImperativeHandle(ref, () => ({ scrollToLine() {}, selectRange() {} }));
    (window as unknown as { __fireCursorLine?: (line: number) => void }).__fireCursorLine = (line) => props.onCursorLine?.(line);
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

  it("with a list item active, inserts after the ITEM (not the whole list) — a <ul> and its first <li> share a data-line, and the item is the more specific (last-DOM-order) match", async () => {
    const { App } = await import("../src/App");
    document.body.innerHTML = '<div id="root"></div>';
    const listDoc = "# Plan\n\n- item one\n- item two\n\nNext paragraph.\n";
    const session = createMemoryApi({ content: listDoc });
    (session.api as unknown as { saveAsset: unknown }).saveAsset = vi.fn(async () => ({ relPath: "plan.assets/x.png" }));
    (window as unknown as { api: unknown }).api = session.api;
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("Next paragraph."));

    // Both the <ul> and its first <li> ("item one") report data-line="2" — click syncs to that line.
    const itemOne = screen.getByText("item one");
    fireEvent.click(itemOne.closest("[data-line]")!);

    const rendered = document.querySelector(".ap-rendered")!;
    await act(async () => firePasteImage(rendered, PNG));
    await waitFor(() => expect(document.querySelector(".ap-rendered")?.innerHTML).toContain("plan.assets/x.png"));

    // Must land right after "item one" (the <li>'s own end line), before "item two" — using the
    // <ul>'s end line instead (the querySelector-first-match bug) would push it past "item two".
    const html = document.querySelector(".ap-rendered")!.innerHTML;
    expect(html.indexOf("item one")).toBeLessThan(html.indexOf("plan.assets/x.png"));
    expect(html.indexOf("plan.assets/x.png")).toBeLessThan(html.indexOf("item two"));
  });

  it("with the active line synced mid-paragraph (source cursor, not a preview click), still inserts after the WHOLE paragraph instead of splitting it", async () => {
    const { App } = await import("../src/App");
    document.body.innerHTML = '<div id="root"></div>';
    const midDoc = "# Plan\n\nline one\nline two\nline three continues\n\nSecond paragraph.\n";
    const session = createMemoryApi({ content: midDoc });
    (session.api as unknown as { saveAsset: unknown }).saveAsset = vi.fn(async () => ({ relPath: "plan.assets/x.png" }));
    (window as unknown as { api: unknown }).api = session.api;
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("Second paragraph."));

    // The (mocked) SourceEditor only mounts once the Source tab is open.
    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    await waitFor(() => expect((window as unknown as { __fireCursorLine?: unknown }).__fireCursorLine).toBeTypeOf("function"));

    // The paragraph ("line one\nline two\nline three continues") spans source lines 2-4 as ONE
    // block (data-line=2, data-end-line=4). Sync to its MIDDLE line (3, "line two") — a line with
    // no [data-line] element of its own, the case an exact-match lookup can't resolve.
    act(() => (window as unknown as { __fireCursorLine: (line: number) => void }).__fireCursorLine(3));

    const rendered = document.querySelector(".ap-rendered")!;
    await act(async () => firePasteImage(rendered, PNG));
    await waitFor(() => expect(document.querySelector(".ap-rendered")?.innerHTML).toContain("plan.assets/x.png"));

    // Must land after "line three continues" (the paragraph's actual last line), not right after
    // "line two" (which would split the paragraph mid-block).
    const html = document.querySelector(".ap-rendered")!.innerHTML;
    expect(html.indexOf("line three continues")).toBeLessThan(html.indexOf("plan.assets/x.png"));
    expect(html.indexOf("plan.assets/x.png")).toBeLessThan(html.indexOf("Second paragraph."));
  });

  it("still renders as an actual <img> when relPath has a space (from a doc name like 'Product Plan.md') — a bare, unbracketed destination wouldn't parse as an image at all", async () => {
    (window as unknown as { api: { saveAsset: unknown } }).api.saveAsset = vi.fn(async () => ({ relPath: "Product Plan.assets/x.png" }));
    await mountApp();
    const rendered = document.querySelector(".ap-rendered")!;

    await act(async () => firePasteImage(rendered, PNG));
    await waitFor(() => expect(document.querySelector(".ap-rendered img")).toBeTruthy());

    expect(document.querySelector(".ap-rendered img")!.getAttribute("src")).toContain("Product%20Plan.assets/x.png");
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
