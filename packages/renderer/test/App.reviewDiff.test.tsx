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
  api: { getProposal(): Promise<{ id?: string; content: string } | null> };
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
    await waitFor(() => expect(document.body.textContent).toContain("Alpha line."), { timeout: 5000 });
    // AWAIT the proposal inside act. Fire-and-forget let setProposal land outside act (the
    // propose chain hops the microtask queue through hashing), so the review bar could be
    // observed after its first commit but BEFORE the effect that initializes the per-hunk
    // accept state had flushed — a click in that window is a no-op on the empty state or is
    // overwritten by the init (the reject/edit silently reverts to all-accepted). Awaiting
    // inside act makes act drain that render AND its effects before the helper returns.
    await act(async () => {
      await agent.proposeRevision(REVISED);
    });
    await waitFor(() => expect(document.body.textContent).toContain("Agent proposed changes"), { timeout: 5000 });
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
    // Don't Apply until the reject actually committed — Apply reads the toggle state.
    await waitFor(() => expect((screen.getAllByRole("switch", { name: /accept change 1/ })[0] as HTMLInputElement).checked).toBe(false), { timeout: 5000 });

    const apply = screen.getByRole("button", { name: /^Apply$/ });
    await act(async () => {
      fireEvent.click(apply);
    });

    // Review bar clears; the rejected first hunk kept "Alpha line.", the accepted
    // second hunk became "Beta CHANGED."
    await waitFor(() => expect(document.body.textContent).not.toContain("Agent proposed changes"), { timeout: 5000 });
    expect(document.body.textContent).toContain("Alpha line.");
    expect(document.body.textContent).toContain("Beta CHANGED.");
    expect(document.body.textContent).not.toContain("Beta line.");
    // Proposal was discarded after a decision was made — the settle is a chained promise
    // (clearProposal → decideProposal), so poll rather than read once.
    await waitFor(async () => expect(await (window as unknown as Win).api.getProposal()).toBeNull(), { timeout: 5000 });
  });

  it("'Reject all' then Apply keeps the original body and discards the proposal", async () => {
    await renderAndPropose();

    // Default is all-accepted; one click on the tri-state toggle flips it to reject-all.
    await act(async () => {
      fireEvent.click(screen.getByRole("checkbox", { name: /accept or reject all changes/i }));
    });
    // Don't Apply until the tri-state observably flipped to reject — Apply reads the toggle state.
    await waitFor(() => expect(screen.getByRole("checkbox", { name: /accept or reject all changes/i }).getAttribute("aria-checked")).toBe("false"), { timeout: 5000 });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Apply$/ }));
    });

    await waitFor(() => expect(document.body.textContent).not.toContain("Agent proposed changes"), { timeout: 5000 });
    // Nothing from the proposal survived.
    expect(document.body.textContent).toContain("Alpha line.");
    expect(document.body.textContent).toContain("Beta line.");
    expect(document.body.textContent).not.toContain("CHANGED");
    await waitFor(async () => expect(await (window as unknown as Win).api.getProposal()).toBeNull(), { timeout: 5000 });
  });

  it("shows a per-hunk 'will be accepted/rejected' label and a tri-state that goes mixed", async () => {
    await renderAndPropose();
    expect(document.body.textContent).toContain("will be accepted"); // default: all accepted
    expect(document.querySelector(".ap-tri--accept")).toBeTruthy();
    // Reject one hunk → its label flips and the tri-state goes to mixed.
    await act(async () => {
      fireEvent.click(screen.getAllByRole("switch", { name: /accept change 1/ })[0]!);
    });
    await waitFor(() => expect(document.body.textContent).toContain("will be rejected"), { timeout: 5000 });
    expect(document.querySelector(".ap-tri--mixed")).toBeTruthy();
  });

  it("the tri-state toggle cycles accept→reject→accept, and mixed→accept", async () => {
    await renderAndPropose();
    const tri = (): HTMLElement => screen.getByRole("checkbox", { name: /accept or reject all changes/i });
    expect(document.querySelector(".ap-tri--accept")).toBeTruthy(); // default: all accepted
    // accept → reject (one click rejects every hunk). Each step waits for the state it
    // produced before clicking again — the next click's meaning depends on it.
    await act(async () => fireEvent.click(tri()));
    await waitFor(() => expect(document.querySelector(".ap-tri--reject")).toBeTruthy(), { timeout: 5000 });
    expect(document.body.textContent).not.toContain("will be accepted");
    // reject → accept.
    await act(async () => fireEvent.click(tri()));
    await waitFor(() => expect(document.querySelector(".ap-tri--accept")).toBeTruthy(), { timeout: 5000 });
    // Make it mixed (reject a single hunk), then one click resolves the whole set to accept.
    await act(async () => fireEvent.click(screen.getAllByRole("switch", { name: /accept change 1/ })[0]!));
    await waitFor(() => expect(document.querySelector(".ap-tri--mixed")).toBeTruthy(), { timeout: 5000 });
    await act(async () => fireEvent.click(tri()));
    await waitFor(() => expect(document.querySelector(".ap-tri--accept")).toBeTruthy(), { timeout: 5000 });
  });

  it("the pencil edits a hunk's proposed text and Apply uses the edited text", async () => {
    await renderAndPropose();
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: /edit change 1/ })[0]!);
    });
    const ta = screen.getByRole("textbox", { name: /edit change 1/ }) as HTMLTextAreaElement;
    expect(ta.value).toContain("Alpha CHANGED."); // seeded with the agent's proposed text
    await act(async () => {
      fireEvent.change(ta, { target: { value: "Alpha EDITED." } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /save edit/i }));
    });
    // Don't Apply until the saved edit is observably part of the review (the diff
    // preview renders the edited proposed text) — Apply reads the edits state.
    await waitFor(() => expect(document.body.textContent).toContain("Alpha EDITED."), { timeout: 5000 });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Apply$/ }));
    });
    await waitFor(() => expect(document.body.textContent).not.toContain("Agent proposed changes"), { timeout: 5000 });
    expect(document.body.textContent).toContain("Alpha EDITED."); // the human's edit, not the agent's
    expect(document.body.textContent).not.toContain("Alpha CHANGED.");
  });

  it("Cancel discards an inline edit", async () => {
    await renderAndPropose();
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: /edit change 1/ })[0]!);
    });
    await act(async () => {
      fireEvent.change(screen.getByRole("textbox", { name: /edit change 1/ }), { target: { value: "Alpha EDITED." } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /cancel edit/i }));
    });
    expect(screen.queryByRole("textbox", { name: /edit change 1/ })).toBeNull(); // editor closed
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Apply$/ }));
    });
    await waitFor(() => expect(document.body.textContent).not.toContain("Agent proposed changes"), { timeout: 5000 });
    expect(document.body.textContent).toContain("Alpha CHANGED."); // unchanged proposal applied
    expect(document.body.textContent).not.toContain("Alpha EDITED.");
  });

  it("⌘Z undoes a saved hunk edit while reviewing", async () => {
    await renderAndPropose();
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: /edit change 1/ })[0]!);
    });
    await act(async () => {
      fireEvent.change(screen.getByRole("textbox", { name: /edit change 1/ }), { target: { value: "Alpha EDITED." } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /save edit/i }));
    });
    // The saved edit must be committed before ⌘Z, or there is nothing to undo yet.
    await waitFor(() => expect(document.body.textContent).toContain("Alpha EDITED."), { timeout: 5000 });
    // Undo the edit through the review timeline (no field focused → routes to reviewUndo).
    await act(async () => {
      fireEvent.keyDown(document, { key: "z", metaKey: true });
    });
    // And the undo must observably restore the proposal before Apply reads the edits state.
    await waitFor(() => expect(document.body.textContent).not.toContain("Alpha EDITED."), { timeout: 5000 });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Apply$/ }));
    });
    await waitFor(() => expect(document.body.textContent).not.toContain("Agent proposed changes"), { timeout: 5000 });
    expect(document.body.textContent).toContain("Alpha CHANGED."); // edit undone → original proposal
    expect(document.body.textContent).not.toContain("Alpha EDITED.");
  });

  it("⌘/Ctrl+Z while the inline edit textarea is focused does NOT route to review undo", async () => {
    await renderAndPropose();
    // Save an inline edit, so there IS a review action that review-undo could revert.
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: /edit change 1/ })[0]!);
    });
    await act(async () => {
      fireEvent.change(screen.getByRole("textbox", { name: /edit change 1/ }), { target: { value: "Alpha EDITED." } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /save edit/i }));
    });
    // The saved edit must be committed before the keystrokes it must survive.
    await waitFor(() => expect(document.body.textContent).toContain("Alpha EDITED."), { timeout: 5000 });
    // Re-open the editor and press ⌘Z / Ctrl+Z WITH the textarea focused. The guard
    // (active element inside .ap-ihunk-edit-ta) must let CodeMirror/native undo own it and
    // skip review-undo — so the saved edit is left intact.
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: /edit change 1/ })[0]!);
    });
    const ta = screen.getByRole("textbox", { name: /edit change 1/ }) as HTMLTextAreaElement;
    ta.focus();
    await act(async () => {
      fireEvent.keyDown(ta, { key: "z", metaKey: true });
      fireEvent.keyDown(ta, { key: "z", ctrlKey: true }); // Windows/Linux variant — same bypass
    });
    // Cancel the re-opened editor (a no-op) and apply. Had ⌘Z wrongly routed to review-undo,
    // the saved edit would have reverted to the agent's original ("Alpha CHANGED.").
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /cancel edit/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Apply$/ }));
    });
    await waitFor(() => expect(document.body.textContent).not.toContain("Agent proposed changes"), { timeout: 5000 });
    expect(document.body.textContent).toContain("Alpha EDITED."); // bypass held → edit survived
    expect(document.body.textContent).not.toContain("Alpha CHANGED.");
  });

  it("'later' parks the proposal behind a banner with a Review button that re-shows it", async () => {
    await renderAndPropose();

    // Park the review.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^later$/ }));
    });

    // The review bar is gone; a parked banner with a "Review" button appears.
    await waitFor(() => expect(document.body.textContent).not.toContain("Agent proposed changes"), { timeout: 5000 });
    expect(document.body.textContent).toContain("The agent proposed changes awaiting your review.");
    const reviewBtn = screen.getByRole("button", { name: /^Review$/ });

    // Re-show: the full review bar comes back, banner goes away.
    await act(async () => {
      fireEvent.click(reviewBtn);
    });
    await waitFor(() => expect(document.body.textContent).toContain("Agent proposed changes"), { timeout: 5000 });
    expect(document.body.textContent).not.toContain("awaiting your review.");
    // The proposal is still parked (not yet decided).
    expect((await (window as unknown as Win).api.getProposal())?.content).toBe(REVISED);
  });
});
