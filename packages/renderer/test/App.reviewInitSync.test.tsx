// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Regression: the review's per-hunk state must be initialized SYNCHRONOUSLY with the proposal —
// there must be NO commit in which the review bar is on screen while `accepted`/`edits` still hold
// the previous (on a first proposal, empty) values.
//
// The state used to be initialized from an effect keyed on the proposal, which left exactly such a
// window: the bar's first commit was observable before the effect flushed. It was invisible in the
// DOM (the per-hunk switches render `accepted[idx] ?? true`, so they LOOK accepted either way), but
// an interaction landing in it was lost two different ways — a per-hunk toggle mapped over the
// stale array and no-oped, and anything that did commit (tri-state reject-all, a saved hunk edit)
// was overwritten when the initialization flushed, silently reverting the review to all-accepted.
//
// Driving that window needs commit-phase granularity, finer than `act`: the StatusBar is stubbed
// with a probe that runs a LAYOUT effect on every App commit, and layout effects run strictly
// before any passive effect of the same commit. The probe fires a real click on the real control
// the moment the review bar first exists in the DOM — i.e. inside the window — and the test then
// asserts the interaction both took effect and survived the rest of the commit.
//
// SourceEditor (CodeMirror) is stubbed because it needs layout APIs happy-dom only stubs.

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { forwardRef, useImperativeHandle, useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryApi, type MemoryAgent } from "../src/memoryApi";

/** Set by a test to run in the commit phase of every App render; cleared when it has fired. */
const probe = vi.hoisted(() => ({ onCommit: null as null | (() => void) }));

vi.mock("../src/SourceEditor", () => ({
  SourceEditor: forwardRef(function SourceEditorStub(_props: unknown, ref: React.Ref<unknown>) {
    useImperativeHandle(ref, () => ({ scrollToLine() {}, selectRange() {} }));
    return null;
  }),
}));

// The status bar is App's last child and re-renders with it, so its layout effect is a hook into
// the commit phase of every App render — after the whole tree's DOM is in place, before the passive
// effects (which is where the review state used to be initialized) of that same commit.
vi.mock("../src/StatusBar", () => ({
  StatusBar: function StatusBarProbe() {
    useLayoutEffect(() => {
      probe.onCommit?.();
    });
    return null;
  },
}));

const DOC = "# Plan\n\nAlpha line.\n\nBeta line.\n\n<!--inplan v1\n[]\n-->\n";
// Two distinct body edits => two change hunks.
const REVISED = "# Plan\n\nAlpha CHANGED.\n\nBeta CHANGED.\n\n<!--inplan v1\n[]\n-->\n";
const REVISED2 = "# Plan\n\nAlpha SECOND.\n\nBeta SECOND.\n\n<!--inplan v1\n[]\n-->\n";

let agent: MemoryAgent;

type Win = { api: { getProposal(): Promise<{ id?: string; content: string } | null> } };

function mount(content: string) {
  document.body.innerHTML = '<div id="root"></div>';
  const session = createMemoryApi({ content });
  (window as unknown as { api: unknown }).api = session.api;
  agent = session.agent;
}

afterEach(() => {
  probe.onCommit = null;
  cleanup();
});

const hunkSwitches = () => document.querySelectorAll<HTMLInputElement>('input[aria-label="accept change 1"]');
const tri = () => document.querySelector<HTMLButtonElement>("button.ap-tri:not([disabled])");
const hunk1 = () => screen.getAllByRole("switch", { name: /accept change 1/ })[0] as HTMLInputElement;

/**
 * Arm the probe to act ONCE, in the commit phase of the first render that shows the review bar.
 * `ready` guards on the control the action needs actually being in the DOM. Returns a getter for
 * whether it fired, so a test can prove it really drove the window rather than passing vacuously.
 */
function armOnFirstReviewCommit(ready: () => boolean, action: () => void): () => boolean {
  let fired = false;
  probe.onCommit = () => {
    if (fired || !document.querySelector(".ap-review-bar") || !ready()) return;
    fired = true;
    action();
  };
  return () => fired;
}

describe("review state initializes synchronously with the proposal", () => {
  beforeEach(() => mount(DOC));

  async function renderApp() {
    const { App } = await import("../src/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("Alpha line."), { timeout: 5000 });
  }

  it("a per-hunk reject clicked in the review's FIRST commit takes effect and survives", async () => {
    await renderApp();

    // Reject hunk 1 from inside the window. Before the fix this mapped over the still-empty
    // `accepted` (a no-op) and was then overwritten by the initialization — the hunk came back
    // accepted and Apply took the agent's text for it.
    const fired = armOnFirstReviewCommit(
      () => hunkSwitches().length > 0,
      () => hunkSwitches()[0]!.click(),
    );
    await act(async () => {
      await agent.proposeRevision(REVISED);
    });
    expect(fired()).toBe(true); // the window was really driven

    // Took effect, and nothing overwrote it once the commit finished. Read once rather than poll:
    // `act` above drained the commit AND its effects, so this IS the settled state — a value that
    // only arrived later would mean something landed after the commit, which is the bug itself.
    expect(hunk1().checked).toBe(false);
    expect(document.querySelector(".ap-tri--mixed")).toBeTruthy(); // one of two hunks rejected

    // And it is the state Apply uses: hunk 1 rejected, hunk 2 accepted.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Apply$/ }));
    });
    await waitFor(() => expect(document.body.textContent).not.toContain("Agent proposed changes"), { timeout: 5000 });
    expect(document.body.textContent).toContain("Alpha line.");
    expect(document.body.textContent).toContain("Beta CHANGED.");
    expect(document.body.textContent).not.toContain("Alpha CHANGED.");
    await waitFor(async () => expect(await (window as unknown as Win).api.getProposal()).toBeNull(), { timeout: 5000 });
  });

  it("a tri-state reject-all clicked in the review's FIRST commit is not overwritten", async () => {
    await renderApp();

    // Reject-all from inside the window. This one did commit (`fill(false)` needs no prior state)
    // and was then reverted to all-accepted by the initialization — the reviewer's rejection
    // became a full accept.
    const fired = armOnFirstReviewCommit(
      () => tri() !== null,
      () => tri()!.click(),
    );
    await act(async () => {
      await agent.proposeRevision(REVISED);
    });
    expect(fired()).toBe(true);

    expect(document.querySelector(".ap-tri--reject")).toBeTruthy(); // settled after act — see above
    expect(document.body.textContent).not.toContain("will be accepted");

    // Apply keeps the original body — nothing from the proposal survives.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Apply$/ }));
    });
    await waitFor(() => expect(document.body.textContent).not.toContain("Agent proposed changes"), { timeout: 5000 });
    expect(document.body.textContent).toContain("Alpha line.");
    expect(document.body.textContent).toContain("Beta line.");
    expect(document.body.textContent).not.toContain("CHANGED");
  });

  it("'Review next' pressed in the review's FIRST commit keeps its cursor", async () => {
    await renderApp();

    const fired = armOnFirstReviewCommit(
      () => screen.queryAllByRole("button", { name: /^Review next/ }).length > 0,
      () => screen.getAllByRole("button", { name: /^Review next/ })[0]!.click(),
    );
    await act(async () => {
      await agent.proposeRevision(REVISED);
    });
    expect(fired()).toBe(true);

    // The cursor reset used to run from its own effect, so a step taken in the window was undone.
    expect(screen.getByRole("button", { name: /Review next \(1\/2\)/ })).toBeTruthy();
  });

  it("a NEW proposal starts pristine: no inherited rejects, and ⌘Z can't reach the old review", async () => {
    await renderApp();
    await act(async () => {
      await agent.proposeRevision(REVISED);
    });
    await waitFor(() => expect(document.body.textContent).toContain("Agent proposed changes"), { timeout: 5000 });

    // Reject a hunk in the FIRST review, then park it and let a second proposal replace it.
    await act(async () => {
      fireEvent.click(hunk1());
    });
    await waitFor(() => expect(hunk1().checked).toBe(false), { timeout: 5000 });
    await act(async () => {
      await agent.proposeRevision(REVISED2);
    });
    await waitFor(() => expect(document.body.textContent).toContain("Alpha SECOND."), { timeout: 5000 });

    // The second review is all-accepted from its first commit — the first review's reject is gone.
    expect(hunk1().checked).toBe(true);
    expect(document.querySelector(".ap-tri--accept")).toBeTruthy();

    // ⌘Z has nothing to undo here: the timeline belongs to the proposal, so it cannot step back
    // into the previous review's snapshots (which would resurrect that reject).
    await act(async () => {
      fireEvent.keyDown(document, { key: "z", metaKey: true });
    });
    expect(hunk1().checked).toBe(true);

    // Undo/redo still work WITHIN this review.
    await act(async () => {
      fireEvent.click(hunk1());
    });
    await waitFor(() => expect(hunk1().checked).toBe(false), { timeout: 5000 });
    await act(async () => {
      fireEvent.keyDown(document, { key: "z", metaKey: true });
    });
    await waitFor(() => expect(hunk1().checked).toBe(true), { timeout: 5000 });
    await act(async () => {
      fireEvent.keyDown(document, { key: "z", metaKey: true, shiftKey: true });
    });
    await waitFor(() => expect(hunk1().checked).toBe(false), { timeout: 5000 });
  });
});
