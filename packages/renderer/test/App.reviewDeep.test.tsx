// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// App-level integration test covering the DEEP review-bar controls the existing
// review slice (App.review.test.tsx) doesn't: "Reject all" then Apply (discards
// the proposal), "later" (parks the review behind an "awaiting your review"
// banner), re-showing the review from that banner, and "Review next" stepping
// the N/total cursor across multiple change hunks.
//
// SourceEditor (CodeMirror) is stubbed — it needs layout APIs happy-dom only
// stubs, and the review flow under test lives in App, not the editor.

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { forwardRef, useImperativeHandle } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryApi, type MemoryAgent } from "../src/memoryApi";

vi.mock("../src/SourceEditor", () => ({
  SourceEditor: forwardRef(function SourceEditorStub(_props: unknown, ref: React.Ref<unknown>) {
    useImperativeHandle(ref, () => ({ scrollToLine() {}, selectRange() {} }));
    return null;
  }),
}));

// Two changed regions (Alpha + Beta) separated by an unchanged blank line, so the
// diff yields exactly two change hunks — enough to exercise "Review next" stepping.
const DOC = "# Plan\n\nAlpha line.\n\nBeta line.\n\n<!--inplan v1\n[]\n-->\n";
const REVISED = "# Plan\n\nAlpha CHANGED.\n\nBeta CHANGED.\n\n<!--inplan v1\n[]\n-->\n";

let agent: MemoryAgent;

type ProposalApi = { getProposal(): Promise<string | null>; logAction(t: string, p?: unknown): Promise<void> };
const api = () => (window as unknown as { api: ProposalApi }).api;

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>';
  const session = createMemoryApi({ content: DOC });
  (window as unknown as { api: unknown }).api = session.api;
  agent = session.agent;
});
afterEach(cleanup);

async function mountAndPropose() {
  const { App } = await import("../src/App");
  render(<App />);
  await waitFor(() => expect(document.body.textContent).toContain("Alpha line."));
  await act(async () => {
    agent.proposeRevision(REVISED);
  });
  await waitFor(() => expect(document.body.textContent).toContain("Agent proposed changes"));
}

describe("App deep review flow (memory-backed)", () => {
  it('"Reject all" then Apply discards the proposal without changing the body', async () => {
    await mountAndPropose();

    // Default is all-accepted; one click on the tri-state toggle flips it to reject-all.
    const tri = screen.getByRole("checkbox", { name: /accept or reject all changes/i });
    const apply = screen.getByRole("button", { name: /^apply$/i });

    await act(async () => {
      tri.click();
    });
    expect(document.querySelector(".ap-tri--reject")).toBeTruthy();
    await act(async () => {
      apply.click();
    });

    // Review bar is gone and the parked proposal was cleared.
    await waitFor(() => expect(document.body.textContent).not.toContain("Agent proposed changes"));
    expect(await api().getProposal()).toBeNull();

    // The proposed text was NOT adopted — the original body survives.
    expect(document.body.textContent).toContain("Alpha line.");
    expect(document.body.textContent).not.toContain("Alpha CHANGED.");

    // Rejecting every hunk logs the rejected-all decision.
    const log = await agent.log();
    expect(log.some((e) => e.type === "revision_rejected_all")).toBe(true);
  });

  it('"later" parks the review behind an "awaiting your review" banner that re-shows it', async () => {
    await mountAndPropose();

    const later = screen.getByRole("button", { name: /^later$/i });
    await act(async () => {
      later.click();
    });

    // The review bar is parked; a banner offers to re-open it.
    await waitFor(() => expect(document.body.textContent).not.toContain("Agent proposed changes"));
    expect(document.body.textContent).toContain("awaiting your review");
    // The proposal itself is still parked (not discarded).
    expect(await api().getProposal()).not.toBeNull();

    // Re-show the review from the banner.
    const reShow = screen.getByRole("button", { name: /^review$/i });
    await act(async () => {
      reShow.click();
    });
    await waitFor(() => expect(document.body.textContent).toContain("Agent proposed changes"));
    expect(document.body.textContent).not.toContain("awaiting your review");
  });

  it('"Review next" steps the N/total cursor across the change hunks', async () => {
    await mountAndPropose();

    // With two hunks, the bar reports "2 changes" and the cursor starts unset.
    expect(document.body.textContent).toContain("2 changes");
    const reviewNext = () => screen.getByRole("button", { name: /review next/i });
    expect(reviewNext().textContent).toMatch(/Review next$/); // no (n/total) before first step

    // First step -> 1/2.
    await act(async () => {
      reviewNext().click();
    });
    await waitFor(() => expect(reviewNext().textContent).toContain("(1/2)"));

    // Second step -> 2/2.
    await act(async () => {
      reviewNext().click();
    });
    await waitFor(() => expect(reviewNext().textContent).toContain("(2/2)"));

    // Wraps back around to 1/2.
    await act(async () => {
      reviewNext().click();
    });
    await waitFor(() => expect(reviewNext().textContent).toContain("(1/2)"));
  });
});
