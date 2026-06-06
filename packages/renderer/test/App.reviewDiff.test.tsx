// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// App-level integration test for the Review diff controls: the per-hunk
// accept/reject toggles, "Review next" stepping, "Reject all", and the
// "later"-parks-then-re-shows banner. Mounts the real <App/> against a
// memory-backed window.api and drives the scripted agent's proposeRevision.
//
// App.review.test.tsx already covers Accept-all -> Apply; this file covers the
// OTHER review-bar controls. SourceEditor (CodeMirror) is stubbed because it
// needs layout APIs happy-dom only stubs, and the review flow under test lives
// in App, not the editor.

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

const DOC = "# Plan\n\nAlpha line.\n\nBeta line.\n\n<!--inplan v1\n[]\n-->\n";
// Two distinct body edits => two change hunks.
const REVISED = "# Plan\n\nAlpha CHANGED.\n\nBeta CHANGED.\n\n<!--inplan v1\n[]\n-->\n";

let agent: MemoryAgent;

type Win = {
  api: { getProposal(): Promise<string | null> };
};

function mount(content: string) {
  document.body.innerHTML = '<div id="root"></div>';
  const session = createMemoryApi({ content });
  (window as unknown as { api: unknown }).api = session.api;
  agent = session.agent;
}
afterEach(cleanup);

describe("App review diff controls (memory-backed)", () => {
  beforeEach(() => mount(DOC));

  async function renderAndPropose() {
    const { App } = await import("../src/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("Alpha line."));
    await act(async () => {
      agent.proposeRevision(REVISED);
    });
    await waitFor(() => expect(document.body.textContent).toContain("Agent proposed changes"));
  }

  it("'Review next' steps through the change hunks, showing the cursor position", async () => {
    await renderAndPropose();

    // Two distinct body edits surface as two changes in the bar.
    expect(document.body.textContent).toContain("2 changes shown inline below");
    const reviewNext = screen.getByRole("button", { name: /^Review next/ });

    // First step lands on 1/2, second on 2/2, then wraps back to 1/2.
    await act(async () => {
      fireEvent.click(reviewNext);
    });
    await waitFor(() => expect(screen.getByRole("button", { name: /Review next \(1\/2\)/ })).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Review next/ }));
    });
    await waitFor(() => expect(screen.getByRole("button", { name: /Review next \(2\/2\)/ })).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Review next/ }));
    });
    await waitFor(() => expect(screen.getByRole("button", { name: /Review next \(1\/2\)/ })).toBeTruthy());
  });

  it("a per-hunk reject toggle then Apply keeps only the accepted hunks", async () => {
    await renderAndPropose();

    // Per-hunk toggles are on/off switches (one per change), default on (accepted).
    // Turn the first change's switch off to reject it (both panes share the state).
    const change1 = screen.getAllByRole("switch", { name: /accept change 1/ });
    expect(change1.length).toBeGreaterThanOrEqual(1);
    await act(async () => {
      fireEvent.click(change1[0]!);
    });

    const apply = screen.getByRole("button", { name: /^Apply$/ });
    await act(async () => {
      fireEvent.click(apply);
    });

    // Review bar clears; the rejected first hunk kept "Alpha line.", the accepted
    // second hunk became "Beta CHANGED."
    await waitFor(() => expect(document.body.textContent).not.toContain("Agent proposed changes"));
    expect(document.body.textContent).toContain("Alpha line.");
    expect(document.body.textContent).toContain("Beta CHANGED.");
    expect(document.body.textContent).not.toContain("Beta line.");
    // Proposal was discarded after a decision was made.
    expect(await (window as unknown as Win).api.getProposal()).toBeNull();
  });

  it("'Reject all' then Apply keeps the original body and discards the proposal", async () => {
    await renderAndPropose();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Reject all$/ }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Apply$/ }));
    });

    await waitFor(() => expect(document.body.textContent).not.toContain("Agent proposed changes"));
    // Nothing from the proposal survived.
    expect(document.body.textContent).toContain("Alpha line.");
    expect(document.body.textContent).toContain("Beta line.");
    expect(document.body.textContent).not.toContain("CHANGED");
    expect(await (window as unknown as Win).api.getProposal()).toBeNull();
  });

  it("'later' parks the proposal behind a banner with a Review button that re-shows it", async () => {
    await renderAndPropose();

    // Park the review.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^later$/ }));
    });

    // The review bar is gone; a parked banner with a "Review" button appears.
    await waitFor(() => expect(document.body.textContent).not.toContain("Agent proposed changes"));
    expect(document.body.textContent).toContain("The agent proposed changes awaiting your review.");
    const reviewBtn = screen.getByRole("button", { name: /^Review$/ });

    // Re-show: the full review bar comes back, banner goes away.
    await act(async () => {
      fireEvent.click(reviewBtn);
    });
    await waitFor(() => expect(document.body.textContent).toContain("Agent proposed changes"));
    expect(document.body.textContent).not.toContain("awaiting your review.");
    // The proposal is still parked (not yet decided).
    expect(await (window as unknown as Win).api.getProposal()).toBe(REVISED);
  });
});
