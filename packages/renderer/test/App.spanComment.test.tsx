// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Regression: creating a SPAN comment from a preview selection (happy-dom can't make a
// real selection via fireEvent, so window.getSelection is mocked) through the composer.

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

const DOC = "# Plan\n\nHello world.\n\n<!--inplan v1\n[]\n-->\n";
let origGetSelection: typeof window.getSelection;

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>';
  const session = createMemoryApi({ content: DOC });
  (window as unknown as { api: unknown }).api = session.api;
  origGetSelection = window.getSelection;
});
afterEach(() => {
  window.getSelection = origGetSelection;
  cleanup();
});

function mockSelection(text: string) {
  const range = { cloneRange: () => range, getBoundingClientRect: () => ({ left: 0, bottom: 0, top: 0, right: 0, width: 0, height: 0 }) } as unknown as Range;
  window.getSelection = (() => ({ toString: () => text, rangeCount: 1, getRangeAt: () => range, removeAllRanges() {}, addRange() {} })) as unknown as typeof window.getSelection;
}

async function mountApp() {
  const { App } = await import("../src/App");
  render(<App />);
  await waitFor(() => expect(document.body.textContent).toContain("Hello world."));
}

describe("span comment creation (regression)", () => {
  it("adds a span comment from a preview selection via the toolbar composer", async () => {
    await mountApp();
    mockSelection("Hello world.");
    await act(async () => void document.dispatchEvent(new Event("selectionchange")));
    await act(async () => void screen.getByRole("button", { name: /^add comment$/i }).click());
    const ta = await screen.findByPlaceholderText(/Add a comment/i);
    await act(async () => void fireEvent.change(ta, { target: { value: "On the greeting." } }));
    await act(async () => void screen.getByRole("button", { name: /^comment$/i }).click());
    await waitFor(() => expect(document.body.textContent).toContain("On the greeting."));
  });

  it("adds a span comment via the right-click menu using the selection captured at right-click", async () => {
    await mountApp();
    mockSelection("Hello world.");
    // Right-click captures the selection; the menu acts on the capture even if the live
    // selection were lost afterward (the regression).
    await act(async () => void fireEvent.contextMenu(document.querySelector(".ap-rendered")!));
    mockSelection(""); // simulate the selection being collapsed by the menu interaction
    await act(async () => void screen.getByRole("menuitem", { name: /add comment/i }).click());
    const ta = await screen.findByPlaceholderText(/Add a comment/i);
    await act(async () => void fireEvent.change(ta, { target: { value: "Menu-anchored note." } }));
    await act(async () => void screen.getByRole("button", { name: /^comment$/i }).click());
    await waitFor(() => expect(document.body.textContent).toContain("Menu-anchored note."));
    // It anchored as a SPAN (the greeting became a comment link), not a doc-level comment.
    await waitFor(() => expect(document.querySelector('[data-cmt]')).toBeTruthy());
  });

  it("⌘/Ctrl+/ opens the composer on a valid selection", async () => {
    await mountApp();
    mockSelection("Hello world.");
    await act(async () => void document.dispatchEvent(new Event("selectionchange")));
    await act(async () => void fireEvent.keyDown(document, { key: "/", metaKey: true }));
    expect(await screen.findByPlaceholderText(/Add a comment/i)).toBeTruthy();
  });

  it("blocks Add Comment on a whitespace-only selection (toolbar + ⌘/Ctrl+/)", async () => {
    await mountApp();
    mockSelection("   "); // selected only spaces
    await act(async () => void document.dispatchEvent(new Event("selectionchange")));
    const btn = screen.getByRole("button", { name: /add comment/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.title.toLowerCase()).toContain("white space");
    // ⌘/Ctrl+/ doesn't open a composer for whitespace either.
    await act(async () => void fireEvent.keyDown(document, { key: "/", metaKey: true }));
    expect(screen.queryByPlaceholderText(/Add a comment/i)).toBeNull();
  });
});
