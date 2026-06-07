// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// App-level integration test for the review-time comment MERGE on Apply
// (App.tsx applyProposal). While an agent Review proposal is open, the human
// adds a document-level comment via the composer; accepting all hunks and
// applying must MERGE that review-time comment into the result rather than
// overwrite the live doc with the proposal's stale comment snapshot.
//
// SourceEditor (CodeMirror) is stubbed — it needs layout APIs happy-dom only
// stubs, and the merge logic under test lives entirely in App.

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

type SavingApi = {
  api: { getProposal(): Promise<string | null>; load(): Promise<{ content: string }> };
};

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>';
  const session = createMemoryApi({ content: DOC });
  (window as unknown as { api: unknown }).api = session.api;
  agent = session.agent;
});
afterEach(cleanup);

describe("App applyProposal comment merge (memory-backed)", () => {
  it("a doc comment added during review survives Accept all + Apply", async () => {
    const { App } = await import("../src/App");
    render(<App />);

    await waitFor(() => expect(document.body.textContent).toContain("Hello world."));

    // The agent proposes a Review-mode body revision (carrying its own empty
    // comment snapshot). The proposal parks and the review bar surfaces.
    await act(async () => {
      agent.proposeRevision("# Plan\n\nHello CHANGED body.\n\n<!--inplan v1\n[]\n-->\n");
    });
    await waitFor(() => expect(document.body.textContent).toContain("Agent proposed changes"));

    // WHILE the proposal is open, the human adds a document-level comment.
    // With no text selected, "+ Add Doc Comment" opens the composer for a
    // doc-level note. (No selection → target null → addDocComment.)
    const addBtn = screen.getByRole("button", { name: /comment on doc/i });
    expect((addBtn as HTMLButtonElement).disabled).toBe(false);
    await act(async () => {
      addBtn.click();
    });

    const textarea = await screen.findByPlaceholderText(/Add a comment/i);
    const REVIEW_NOTE = "Reviewer note added mid-review";
    await act(async () => {
      fireEvent.change(textarea, { target: { value: REVIEW_NOTE } });
    });
    const commentBtn = screen.getByRole("button", { name: /^comment$/i });
    await act(async () => {
      commentBtn.click();
    });

    // The new comment shows up in the rail immediately, before applying.
    await waitFor(() => expect(document.body.textContent).toContain(REVIEW_NOTE));

    // Accept all hunks, then Apply.
    const acceptAll = screen.getByRole("button", { name: /accept all/i });
    await act(async () => {
      acceptAll.click();
    });
    const apply = screen.getByRole("button", { name: /^apply$/i });
    await act(async () => {
      apply.click();
    });

    // Review bar is gone; the accepted body landed; the parked proposal cleared.
    await waitFor(() => expect(document.body.textContent).not.toContain("Agent proposed changes"));
    expect(document.body.textContent).toContain("Hello CHANGED body.");

    // The review-time comment SURVIVED the merge (not discarded by the
    // proposal's stale empty snapshot).
    expect(document.body.textContent).toContain(REVIEW_NOTE);

    const { api } = window as unknown as SavingApi;
    expect(await api.getProposal()).toBeNull();

    // And it persisted into the saved canonical document, demoted to doc-level
    // (it has no anchor link in the body) — so the saved doc stays valid.
    const persisted = await api.load();
    expect(persisted.content).toContain("Hello CHANGED body.");
    expect(persisted.content).toContain(REVIEW_NOTE);

    // The merge logged a full-accept revision decision (silent save, no turn end).
    const events = await agent.log();
    expect(events.some((e) => e.type === "revision_accepted_all")).toBe(true);
  });
});
