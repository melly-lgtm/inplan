// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// App-level deep-interaction slice: the undo/redo history stack and the Escape
// shortcut dismissals. We drive the REAL <App/> with a memory-backed window.api.
//
// Coverage targets (App.tsx): the undo()/redo() callbacks (incl. their empty-
// stack "nothing to (un|re)do" branches), and the keydown effect's ⌘/Ctrl+Z /
// ⌘/Ctrl+Shift+Z dispatch plus the Escape ladder that closes the composer, the
// find bar, and the review panel in that priority order.
//
// SourceEditor (CodeMirror) is stubbed: it needs layout APIs happy-dom only
// stubs, and none of the behaviour under test lives in the editor pane.

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { forwardRef, useImperativeHandle } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryApi, type MemoryAgent } from "../src/memoryApi";

vi.mock("../src/SourceEditor", () => ({
  SourceEditor: forwardRef(function SourceEditorStub(_props: unknown, ref: React.Ref<unknown>) {
    useImperativeHandle(ref, () => ({ scrollToLine() {}, selectRange() {} }));
    return null;
  }),
}));

const DOC = "# Plan\n\nHello world.\n\n<!--inplan v1\n[]\n-->\n";
let agent: MemoryAgent;

function mount(content: string) {
  document.body.innerHTML = '<div id="root"></div>';
  const session = createMemoryApi({ content });
  (window as unknown as { api: unknown }).api = session.api;
  agent = session.agent;
}
afterEach(cleanup);

// Add a document-level comment through the real composer popover. Leaves the
// undo history with one snapshot to revert.
async function addDocComment(text: string) {
  const addBtn = screen.getByRole("button", { name: /comment on doc/i });
  await act(async () => {
    addBtn.click();
  });
  const ta = await screen.findByPlaceholderText(/Add a comment/i);
  await act(async () => {
    fireEvent.change(ta, { target: { value: text } });
  });
  const commentBtn = screen.getByRole("button", { name: /^comment$/i });
  await act(async () => {
    commentBtn.click();
  });
}

describe("App undo/redo + Escape shortcuts (memory-backed)", () => {
  it("⌘Z undoes an edit and ⌘⇧Z redoes it", async () => {
    mount(DOC);
    const { App } = await import("../src/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("Hello world."));

    // Make an edit so the undo history grows: add a doc comment.
    await addDocComment("First reviewer note");
    await waitFor(() => expect(document.body.textContent).toContain("First reviewer note"));

    // ⌘Z reverts the doc to the pre-comment state.
    await act(async () => {
      fireEvent.keyDown(document.body, { key: "z", metaKey: true });
    });
    await waitFor(() => expect(document.body.textContent).toContain("undid last change"));
    expect(document.body.textContent).not.toContain("First reviewer note");

    // ⌘⇧Z re-applies it.
    await act(async () => {
      fireEvent.keyDown(document.body, { key: "z", metaKey: true, shiftKey: true });
    });
    await waitFor(() => expect(document.body.textContent).toContain("redid change"));
    expect(document.body.textContent).toContain("First reviewer note");
  });

  it("Ctrl+Z works too (non-mac modifier path)", async () => {
    mount(DOC);
    const { App } = await import("../src/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("Hello world."));

    await addDocComment("Ctrl note");
    await waitFor(() => expect(document.body.textContent).toContain("Ctrl note"));

    await act(async () => {
      fireEvent.keyDown(document.body, { key: "z", ctrlKey: true });
    });
    await waitFor(() => expect(document.body.textContent).toContain("undid last change"));
    expect(document.body.textContent).not.toContain("Ctrl note");
  });

  it("⌘Z with an empty history reports nothing to undo; ⌘⇧Z reports nothing to redo", async () => {
    mount(DOC);
    const { App } = await import("../src/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("Hello world."));

    await act(async () => {
      fireEvent.keyDown(document.body, { key: "z", metaKey: true });
    });
    await waitFor(() => expect(document.body.textContent).toContain("nothing to undo"));

    await act(async () => {
      fireEvent.keyDown(document.body, { key: "z", metaKey: true, shiftKey: true });
    });
    await waitFor(() => expect(document.body.textContent).toContain("nothing to redo"));
  });

  it("Escape closes the comment composer", async () => {
    mount(DOC);
    const { App } = await import("../src/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("Hello world."));

    const addBtn = screen.getByRole("button", { name: /comment on doc/i });
    await act(async () => {
      addBtn.click();
    });
    expect(await screen.findByPlaceholderText(/Add a comment/i)).toBeTruthy();

    await act(async () => {
      fireEvent.keyDown(document.body, { key: "Escape" });
    });
    await waitFor(() => expect(screen.queryByPlaceholderText(/Add a comment/i)).toBeNull());
  });

  it("Escape closes the find bar", async () => {
    mount(DOC);
    const { App } = await import("../src/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("Hello world."));

    await act(async () => {
      fireEvent.keyDown(document.body, { key: "f", metaKey: true });
    });
    await waitFor(() => expect(screen.getByPlaceholderText(/Find/)).toBeTruthy());

    await act(async () => {
      fireEvent.keyDown(document.body, { key: "Escape" });
    });
    await waitFor(() => expect(screen.queryByPlaceholderText(/Find/)).toBeNull());
  });

  it("Escape collapses the open review panel to its awaiting banner", async () => {
    mount(DOC);
    const { App } = await import("../src/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("Hello world."));

    await act(async () => {
      agent.proposeRevision("# Plan\n\nHello CHANGED.\n\n<!--inplan v1\n[]\n-->\n");
    });
    await waitFor(() => expect(document.body.textContent).toContain("Agent proposed changes"));

    await act(async () => {
      fireEvent.keyDown(document.body, { key: "Escape" });
    });
    // Review bar closes; the parked-proposal banner appears in its place.
    await waitFor(() => expect(document.body.textContent).not.toContain("Agent proposed changes"));
    expect(document.body.textContent).toContain("awaiting your review");
  });

  it("undo/redo is per-doc: navigating clears the stack so undo can't pull the old doc in", async () => {
    mount(DOC);
    const { App } = await import("../src/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("Hello world."));

    // Edit doc A (grows its undo history), then follow a link to doc B.
    await addDocComment("note on doc A");
    await waitFor(() => expect(document.body.textContent).toContain("note on doc A"));
    await act(async () => {
      agent.navigate("# Doc B\n\nFresh content.\n\n<!--inplan v1\n[]\n-->\n");
    });
    await waitFor(() => expect(document.body.textContent).toContain("Fresh content."));

    // ⌘Z must be a no-op on doc B — not revert into doc A's pre-comment state.
    await act(async () => {
      fireEvent.keyDown(document.body, { key: "z", metaKey: true });
    });
    await waitFor(() => expect(document.body.textContent).toMatch(/nothing to undo/i));
    expect(document.body.textContent).toContain("Fresh content."); // still doc B
    expect(document.body.textContent).not.toContain("note on doc A"); // didn't pull doc A back
  });
});
