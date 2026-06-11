// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// App-level tests for the unified collaboration comment seam: when the host provides a CommentStore
// (web/cloud), the editor sources comments from it, routes comment CRUD through it (NOT a
// documents.body save — the dual-write that caused #71), and re-renders on remote store
// changes. Mounts the real <App/> with a memory-backed window.api augmented with a
// memory-backed CommentStore. SourceEditor is stubbed (layout APIs happy-dom lacks).

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { forwardRef, useImperativeHandle } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse, type Comment } from "@inplan/core";
import { createMemoryApi } from "../src/memoryApi";
import { createMemoryCommentStore, type CommentStore } from "../src/commentStore";

vi.mock("../src/SourceEditor", () => ({
  SourceEditor: forwardRef(function SourceEditorStub(_props: unknown, ref: React.Ref<unknown>) {
    useImperativeHandle(ref, () => ({ scrollToLine() {}, selectRange() {} }));
    return null;
  }),
}));

const DOC =
  "# Plan\n\nUse [Postgres](#cmt-abc123) here.\n\n<!--inplan v1\n" +
  '[ { "id": "cmt-abc123", "author": "alice", "date": "2026-05-30T10:00:00", "resolved": false, "text": "Why not SQLite for v1?" } ]\n' +
  "-->\n";

let store: CommentStore;
let saveSpy: ReturnType<typeof vi.fn>;

function mount(content: string) {
  document.body.innerHTML = '<div id="root"></div>';
  const session = createMemoryApi({ content });
  store = createMemoryCommentStore(parse(content).comments);
  saveSpy = vi.fn(session.api.save);
  // Augment the host with a comment store + a save spy (the collab/web shape).
  (window as unknown as { api: unknown }).api = { ...session.api, commentStore: store, save: saveSpy };
}

beforeEach(() => mount(DOC));
afterEach(cleanup);

async function mountApp() {
  const { App } = await import("../src/App");
  render(<App />);
  await waitFor(() => expect(document.body.textContent).toContain("Why not SQLite for v1?"));
}

function card(): HTMLElement {
  const el = document.querySelector('[data-cmt-card="cmt-abc123"]');
  expect(el).toBeTruthy();
  return el as HTMLElement;
}

describe("App comment seam (store-backed / collab)", () => {
  it("sources the comment list from the store", async () => {
    await mountApp();
    expect(card().textContent).toContain("Why not SQLite for v1?");
  });

  it("a reply routes to the store (not a documents.body save)", async () => {
    await mountApp();
    const scope = within(card());
    await act(async () => fireEvent.click(scope.getByRole("button", { name: /^reply$/i })));
    const box = await waitFor(() => scope.getByPlaceholderText(/Reply/));
    await act(async () => fireEvent.change(box, { target: { value: "Postgres scales better here." } }));
    await act(async () => fireEvent.click(scope.getByRole("button", { name: /^comment$/i })));

    await waitFor(() => expect(card().textContent).toContain("Postgres scales better here."));
    // The reply landed in the store as a real comment (parentId set)...
    const reply = store.list().find((c: Comment) => c.parentId === "cmt-abc123");
    expect(reply?.text).toBe("Postgres scales better here.");
    // ...and NO documents.body save was issued for the comment-only change (the #71 fix).
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it("re-renders when the store changes underneath (a remote peer's comment)", async () => {
    await mountApp();
    expect(document.body.textContent).not.toContain("Added by a peer");
    await act(async () => {
      store.add({ id: "cmt-peer01", parentId: "cmt-abc123", author: "bob", date: "2026-05-30T11:00:00", resolved: false, text: "Added by a peer" });
    });
    await waitFor(() => expect(document.body.textContent).toContain("Added by a peer"));
  });

  it("resolving a thread routes to the store", async () => {
    await mountApp();
    await act(async () => fireEvent.click(within(card()).getByRole("button", { name: /resolve thread/i })));
    await waitFor(() => expect(store.list().find((c: Comment) => c.id === "cmt-abc123")?.resolved).toBe(true));
    expect(saveSpy).not.toHaveBeenCalled();
  });
});
