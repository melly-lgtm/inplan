// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// App-level integration test for comment creation against the real <App/> with a
// memory-backed window.api. Drives the top-bar "+ Add Doc Comment" button, which
// opens the ComposerPopover; types into its textarea; submits via both the
// "Comment" button and ⌘/Ctrl+Enter; and asserts the new comment text surfaces in
// the comment rail.
//
// SourceEditor (CodeMirror) is stubbed: it needs layout APIs happy-dom only
// stubs, and document-level comment creation lives in App, not the editor.

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { forwardRef, useImperativeHandle } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryApi, type MemoryAgent } from "../src/memoryApi";

vi.mock("../src/SourceEditor", () => ({
  SourceEditor: forwardRef(function SourceEditorStub(_props: unknown, ref: React.Ref<unknown>) {
    useImperativeHandle(ref, () => ({ scrollToLine() {}, selectRange() {} }));
    return null;
  }),
}));

const DOC = "# Plan\n\nHello world.\n\n<!--inplan v1\n[]\n-->\n";
let agent: MemoryAgent;

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>';
  const session = createMemoryApi({ content: DOC });
  (window as unknown as { api: unknown }).api = session.api;
  agent = session.agent;
});
afterEach(cleanup);

async function mountApp() {
  const { App } = await import("../src/App");
  render(<App />);
  await waitFor(() => expect(document.body.textContent).toContain("Hello world."));
}

describe("App comment creation (memory-backed)", () => {
  it("opens the composer from '+ Add Doc Comment' with a document-level target", async () => {
    await mountApp();

    // No composer textarea before the button is clicked.
    expect(screen.queryByPlaceholderText(/Add a comment/i)).toBeNull();

    const addBtn = screen.getByRole("button", { name: /comment on doc/i });
    await act(async () => {
      addBtn.click();
    });

    // The ComposerPopover surfaces with its textarea and a document-level label.
    await waitFor(() => expect(screen.getByPlaceholderText(/Add a comment/i)).toBeTruthy());
    expect(document.body.textContent).toContain("document-level comment");
  });

  it("creates a document-level comment via the 'Comment' button", async () => {
    await mountApp();

    await act(async () => {
      screen.getByRole("button", { name: /comment on doc/i }).click();
    });
    const ta = await screen.findByPlaceholderText(/Add a comment/i);

    await act(async () => {
      fireEvent.change(ta, { target: { value: "Please clarify the rollout plan." } });
    });

    const commentBtn = screen.getByRole("button", { name: /^comment$/i });
    await act(async () => {
      commentBtn.click();
    });

    // The composer closes and the new comment text appears in the rail.
    await waitFor(() => expect(screen.queryByPlaceholderText(/Add a comment/i)).toBeNull());
    await waitFor(() => expect(document.body.textContent).toContain("Please clarify the rollout plan."));
  });

  it("creates a document-level comment via ⌘/Ctrl+Enter", async () => {
    await mountApp();

    await act(async () => {
      screen.getByRole("button", { name: /comment on doc/i }).click();
    });
    const ta = await screen.findByPlaceholderText(/Add a comment/i);

    await act(async () => {
      fireEvent.change(ta, { target: { value: "Keyboard-submitted note." } });
    });
    await act(async () => {
      fireEvent.keyDown(ta, { key: "Enter", metaKey: true });
    });

    await waitFor(() => expect(screen.queryByPlaceholderText(/Add a comment/i)).toBeNull());
    await waitFor(() => expect(document.body.textContent).toContain("Keyboard-submitted note."));
  });

  it("does not submit empty/whitespace-only text (Comment button stays disabled)", async () => {
    await mountApp();

    await act(async () => {
      screen.getByRole("button", { name: /comment on doc/i }).click();
    });
    const ta = await screen.findByPlaceholderText(/Add a comment/i);

    // Whitespace only — the Comment button must remain disabled.
    await act(async () => {
      fireEvent.change(ta, { target: { value: "   " } });
    });
    const commentBtn = screen.getByRole("button", { name: /^comment$/i }) as HTMLButtonElement;
    expect(commentBtn.disabled).toBe(true);

    await act(async () => {
      commentBtn.click();
    });
    // Composer is still open since nothing was submitted.
    expect(screen.getByPlaceholderText(/Add a comment/i)).toBeTruthy();
  });
});
