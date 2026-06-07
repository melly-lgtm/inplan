// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The "Add comment" control is disabled (with an explanatory tooltip) when the current
// selection can't become a span comment — notably when it overlaps an existing comment
// anchor (Markdown links can't nest).

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { forwardRef, useImperativeHandle } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryApi } from "../src/memoryApi";

vi.mock("../src/SourceEditor", () => ({
  SourceEditor: forwardRef(function SourceEditorStub(_props: unknown, ref: React.Ref<unknown>) {
    useImperativeHandle(ref, () => ({ scrollToLine() {}, selectRange() {} }));
    return null;
  }),
}));

const DOC_WITH_COMMENT =
  "# Plan\n\nUse [Postgres](#cmt-abc123) here.\n\n<!--inplan v1\n" +
  '[ { "id": "cmt-abc123", "author": "alice", "date": "2026-05-30T10:00:00", "resolved": false, "text": "Why not SQLite?" } ]\n' +
  "-->\n";

let origGetSelection: typeof window.getSelection;
beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>';
  const session = createMemoryApi({ content: DOC_WITH_COMMENT });
  (window as unknown as { api: unknown }).api = session.api;
  origGetSelection = window.getSelection;
});
afterEach(() => {
  window.getSelection = origGetSelection;
  cleanup();
});

function mockSelection(text: string) {
  window.getSelection = (() => ({ toString: () => text, rangeCount: 0, removeAllRanges() {}, addRange() {} })) as unknown as typeof window.getSelection;
}

async function mountApp() {
  const { App } = await import("../src/App");
  render(<App />);
  await waitFor(() => expect(document.body.textContent).toContain("here."));
}

describe("Add comment disabled on un-anchorable selections", () => {
  it("disables the toolbar Add Comment with a 'can't overlap' tooltip when the selection overlaps an anchor", async () => {
    await mountApp();
    mockSelection("Postgres"); // the label of the existing anchor → overlap
    await act(async () => void document.dispatchEvent(new Event("selectionchange")));
    const btn = screen.getByRole("button", { name: /comment on text/i }) as HTMLButtonElement;
    await waitFor(() => expect(btn.disabled).toBe(true));
    expect(btn.title.toLowerCase()).toContain("overlap");
  });

  it("flags OVERLAP (not 'cant anchor') when a real selection crosses an existing anchor", async () => {
    await mountApp();
    // Select the whole paragraph, which contains the [Postgres](#cmt-abc123) anchor.
    const anchor = document.querySelector('[data-cmt="cmt-abc123"]')!;
    const para = anchor.closest("p") ?? (anchor.parentElement as Element);
    const range = document.createRange();
    range.selectNodeContents(para);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    await act(async () => void document.dispatchEvent(new Event("selectionchange")));
    const btn = screen.getByRole("button", { name: /comment on text/i }) as HTMLButtonElement;
    await waitFor(() => expect(btn.disabled).toBe(true));
    expect(btn.title.toLowerCase()).toContain("overlap"); // the overlap message, not cant-anchor
  });

  it("keeps Add Comment enabled for a normal, non-overlapping selection", async () => {
    await mountApp();
    mockSelection("here");
    await act(async () => void document.dispatchEvent(new Event("selectionchange")));
    const btn = screen.getByRole("button", { name: /comment on text/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });
});
