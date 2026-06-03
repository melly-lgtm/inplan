// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// App-level tests for comment-thread actions in the rail's ThreadCard: reply,
// resolve, modify (via the per-comment ⋯ menu), and delete. Mounts the real
// <App/> with a memory-backed window.api over a doc that already carries a span
// comment (an in-body [text](#cmt-xxxxxx) link plus a matching comment object in
// the data block). SourceEditor (CodeMirror) is stubbed — it needs layout APIs
// happy-dom only stubs, and these flows live in App, not the editor.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { forwardRef, useImperativeHandle } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryApi } from "../src/memoryApi";

vi.mock("../src/SourceEditor", () => ({
  SourceEditor: forwardRef(function SourceEditorStub(_props: unknown, ref: React.Ref<unknown>) {
    useImperativeHandle(ref, () => ({ scrollToLine() {}, selectRange() {} }));
    return null;
  }),
}));

// A doc with a span comment: in-body link [Postgres](#cmt-abc123) anchored to a
// matching comment object in the inplan data block.
const DOC_WITH_COMMENT =
  "# Plan\n\nUse [Postgres](#cmt-abc123) here.\n\n<!--inplan v1\n" +
  '[ { "id": "cmt-abc123", "author": "alice", "date": "2026-05-30T10:00:00", "resolved": false, "text": "Why not SQLite for v1?" } ]\n' +
  "-->\n";

function mount(content: string) {
  document.body.innerHTML = '<div id="root"></div>';
  const session = createMemoryApi({ content });
  (window as unknown as { api: unknown }).api = session.api;
}

beforeEach(() => mount(DOC_WITH_COMMENT));
afterEach(cleanup);

async function mountApp() {
  const { App } = await import("../src/App");
  render(<App />);
  await waitFor(() => expect(document.body.textContent).toContain("Why not SQLite for v1?"));
}

/** The ThreadCard <article> for the root comment. */
function card(): HTMLElement {
  const el = document.querySelector('[data-cmt-card="cmt-abc123"]');
  expect(el).toBeTruthy();
  return el as HTMLElement;
}

describe("App comment-thread actions (memory-backed)", () => {
  it("reply: opens the reply box, types, submits, and the reply shows", async () => {
    await mountApp();
    const scope = within(card());

    await act(async () => {
      fireEvent.click(scope.getByRole("button", { name: /^reply$/i }));
    });
    const box = await waitFor(() => scope.getByPlaceholderText(/Reply/));
    await act(async () => {
      fireEvent.change(box, { target: { value: "Postgres scales better here." } });
    });

    const commentBtn = scope.getByRole("button", { name: /^comment$/i });
    await act(async () => {
      fireEvent.click(commentBtn);
    });

    await waitFor(() => expect(card().textContent).toContain("Postgres scales better here."));
  });

  it("resolve: 'Resolve thread' resolves it, then it reappears as 'Reopen thread' when resolved threads are shown", async () => {
    await mountApp();

    // Resolve the thread. Resolved threads are hidden by default, so the card
    // drops out of the rail.
    await act(async () => {
      fireEvent.click(within(card()).getByRole("button", { name: /resolve thread/i }));
    });
    await waitFor(() => expect(document.querySelector('[data-cmt-card="cmt-abc123"]')).toBeNull());

    // Reveal resolved & orphaned threads; the now-resolved card returns offering
    // to reopen, confirming the resolve actually took. (The reveal control is the
    // eye-on-a-closed-box toggle button, labelled with the live hidden counts.)
    const toggle = screen.getByRole("button", { name: /resolved/i });
    await act(async () => {
      fireEvent.click(toggle);
    });
    await waitFor(() =>
      expect(within(card()).getByRole("button", { name: /reopen thread/i })).toBeTruthy(),
    );
  });

  it("modify: ⋯ → Modify → edit text → Save updates the comment", async () => {
    await mountApp();
    const scope = within(card());

    // Open the per-comment overflow menu (title "More").
    await act(async () => {
      fireEvent.click(scope.getByTitle("More"));
    });
    await act(async () => {
      fireEvent.click(await waitFor(() => scope.getByRole("button", { name: /modify/i })));
    });

    const ta = await waitFor(() => card().querySelector(".ap-edit textarea") as HTMLTextAreaElement);
    expect(ta).toBeTruthy();
    await act(async () => {
      fireEvent.change(ta, { target: { value: "Why not DuckDB for v1?" } });
    });
    await act(async () => {
      fireEvent.click(within(card()).getByRole("button", { name: /^save$/i }));
    });

    await waitFor(() => expect(card().textContent).toContain("Why not DuckDB for v1?"));
    expect(card().textContent).not.toContain("Why not SQLite for v1?");
  });

  it("delete: ⋯ → Delete removes the thread card", async () => {
    await mountApp();
    const scope = within(card());

    await act(async () => {
      fireEvent.click(scope.getByTitle("More"));
    });
    await act(async () => {
      fireEvent.click(await waitFor(() => scope.getByRole("button", { name: /delete/i })));
    });

    await waitFor(() => expect(document.querySelector('[data-cmt-card="cmt-abc123"]')).toBeNull());
    expect(document.body.textContent).not.toContain("Why not SQLite for v1?");
  });
});
