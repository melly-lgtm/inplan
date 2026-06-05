// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Comment-rail thread navigation (Issue 5): the Prev/Next Thread buttons step
// focus through the visible threads in order and disable at the first/last.

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

// Two document-level comments → two threads, always visible.
const TWO = `# Plan

Body text.

<!--inplan v1
[
  { "id": "cmt-aaaaaa", "anchor": "doc", "author": "A <a@a>", "date": "2026-01-01T00:00:00Z", "resolved": false, "text": "first thread" },
  { "id": "cmt-bbbbbb", "anchor": "doc", "author": "A <a@a>", "date": "2026-01-01T00:00:00Z", "resolved": false, "text": "second thread" }
]
-->
`;

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>';
  (window as unknown as { api: unknown }).api = createMemoryApi({ content: TWO }).api;
});
afterEach(cleanup);

describe("comment-thread navigation", () => {
  it("Next/Prev Thread step focus and disable at the ends", async () => {
    const { App } = await import("../src/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("second thread"));

    const next = screen.getByRole("button", { name: /next thread/i }) as HTMLButtonElement;
    const prev = screen.getByRole("button", { name: /previous thread/i }) as HTMLButtonElement;
    // Nothing focused yet → neither is at an end.
    expect(prev.disabled).toBe(false);
    expect(next.disabled).toBe(false);

    await act(async () => next.click()); // → first thread
    expect(prev.disabled).toBe(true); // at the first

    await act(async () => next.click()); // → second (last) thread
    expect(next.disabled).toBe(true); // at the last
    expect(prev.disabled).toBe(false);
  });
});
