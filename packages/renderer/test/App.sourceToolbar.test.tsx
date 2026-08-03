// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The source pane's formatting toolbar (SourceToolbar.tsx, above the CodeMirror pane): its
// buttons drive SourceEditorHandle's imperative commands, and the heading button shows the
// cursor line's current level (via a dropdown menu built on the shared ContextMenu). Only the
// toolbar's wiring is under test here — SourceEditor (CodeMirror) is stubbed.

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { forwardRef, useImperativeHandle } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryApi } from "../src/memoryApi";

const handle = {
  scrollToLine: vi.fn(),
  selectRange: vi.fn(),
  setHeading: vi.fn(),
  toggleBold: vi.fn(),
  toggleItalic: vi.fn(),
  toggleStrikethrough: vi.fn(),
  toggleInlineCode: vi.fn(),
  toggleCodeBlock: vi.fn(),
  toggleBlockquote: vi.fn(),
  toggleBulletList: vi.fn(),
  toggleOrderedList: vi.fn(),
  toggleChecklist: vi.fn(),
  insertLink: vi.fn(),
  insertHorizontalRule: vi.fn(),
  insertImage: vi.fn(),
};
let onCursorLine: ((line: number) => void) | undefined;

vi.mock("../src/SourceEditor", () => ({
  SourceEditor: forwardRef(function SourceEditorStub(props: { onCursorLine?: (line: number) => void }, ref: React.Ref<unknown>) {
    onCursorLine = props.onCursorLine;
    useImperativeHandle(ref, () => handle);
    return null;
  }),
}));

const DOC = "# Plan\n\n## Existing heading\n\nBody text.\n\n<!--inplan v1\n[]\n-->\n";

beforeEach(() => {
  // 3-pane layout so the source pane (and its toolbar) is on screen without extra clicks.
  localStorage.setItem("ap-layout", JSON.stringify({ panes: 3, zoom: 1, showResolvedOrphaned: false, cadence: "turn", srcW: 380, cmtW: 380 }));
  document.body.innerHTML = '<div id="root"></div>';
  (window as unknown as { api: unknown }).api = createMemoryApi({ content: DOC }).api;
  for (const fn of Object.values(handle)) fn.mockClear();
  onCursorLine = undefined;
});
afterEach(cleanup);

async function mount() {
  const { App } = await import("../src/App");
  render(<App />);
  await waitFor(() => expect(document.body.textContent).toContain("Body text."));
}

describe("source pane formatting toolbar", () => {
  it("renders all the formatting buttons", async () => {
    await mount();
    for (const name of ["Heading", "Bold", "Italic", "Strikethrough", "Horizontal rule", "Quote", "Bullet list", "Numbered list", "Checklist", "Link", "Inline code", "Code block", "Image"]) {
      expect(screen.getByTitle(name)).toBeTruthy();
    }
  });

  it("opens the heading dropdown and picking H2 calls setHeading(2)", async () => {
    await mount();
    await act(async () => screen.getByTitle("Heading").click());
    await act(async () => screen.getByRole("menuitem", { name: "Heading 2" }).click());
    expect(handle.setHeading).toHaveBeenCalledWith(2);
  });

  it("clicking Bold / Bullet list drives the matching SourceEditor command", async () => {
    await mount();
    await act(async () => screen.getByTitle("Bold").click());
    expect(handle.toggleBold).toHaveBeenCalledTimes(1);
    await act(async () => screen.getByTitle("Bullet list").click());
    expect(handle.toggleBulletList).toHaveBeenCalledTimes(1);
  });

  it("shows the cursor's heading level on the H button once the cursor moves onto it", async () => {
    await mount();
    expect(screen.getByTitle("Heading").textContent).toBe("H");

    await act(async () => onCursorLine?.(2)); // 0-based line 2 is "## Existing heading"

    expect(screen.getByTitle("Heading").textContent).toBe("H2");
  });

  it("the Image button is disabled when the host has no saveAsset (e.g. a cloud doc)", async () => {
    await mount(); // memoryApi never sets api.saveAsset
    expect((screen.getByTitle("Image") as HTMLButtonElement).disabled).toBe(true);
  });

  it("picking a file calls the host's saveAsset and inserts the returned link", async () => {
    const saveAsset = vi.fn(async (_bytes: ArrayBuffer, ext: string) => ({ relPath: `plan.assets/x.${ext}` }));
    (window as unknown as { api: { saveAsset: unknown } }).api.saveAsset = saveAsset;
    await mount();

    const imageBtn = screen.getByTitle("Image") as HTMLButtonElement;
    expect(imageBtn.disabled).toBe(false);
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File([new Uint8Array([1, 2, 3])], "shot.png", { type: "image/png" });
    Object.defineProperty(fileInput, "files", { value: [file] });

    await act(async () => fileInput.dispatchEvent(new Event("change", { bubbles: true })));

    expect(saveAsset).toHaveBeenCalledWith(expect.any(ArrayBuffer), "png");
    expect(handle.insertImage).toHaveBeenCalledWith("plan.assets/x.png");
  });

  it("maps each supported MIME type to its real extension (not the bare subtype, e.g. svg+xml)", async () => {
    const saveAsset = vi.fn(async (_bytes: ArrayBuffer, ext: string) => ({ relPath: `plan.assets/x.${ext}` }));
    (window as unknown as { api: { saveAsset: unknown } }).api.saveAsset = saveAsset;
    await mount();
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;

    for (const [mime, ext] of [
      ["image/png", "png"],
      ["image/jpeg", "jpg"],
      ["image/gif", "gif"],
      ["image/webp", "webp"],
      ["image/avif", "avif"],
      ["image/svg+xml", "svg"],
    ] as const) {
      const file = new File([new Uint8Array([1, 2, 3])], "shot", { type: mime });
      Object.defineProperty(fileInput, "files", { value: [file], configurable: true });
      await act(async () => fileInput.dispatchEvent(new Event("change", { bubbles: true })));
      expect(saveAsset).toHaveBeenLastCalledWith(expect.any(ArrayBuffer), ext);
    }
  });
});
