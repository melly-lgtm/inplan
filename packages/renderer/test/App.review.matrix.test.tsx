// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// App-level "matrix" integration test for the Review controls, exercising the
// accept/reject decision surface end-to-end against a memory-backed window.api:
//   - a parked proposal shows the diff with N hunks
//   - the tri-switch defaults to ALL ACCEPTED (aria-checked=true) and cycling it
//     flips accept/reject (aria-checked false)
//   - a per-hunk Switch toggles exactly one hunk (the tri goes mixed)
//   - Apply with all accepted writes the proposed body
//   - Reject-all then Apply discards (body unchanged)
//   - the pencil edits a hunk and Apply uses the edited text
//   - Review-next steps the cursor through the hunks
//
// Mirrors App.reviewDiff.test.tsx for setup/style. SourceEditor (CodeMirror) is
// stubbed because it needs layout APIs happy-dom doesn't provide, and the review
// flow under test lives in App, not the editor.

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
// A single body edit => exactly one change hunk (singular wording boundary).
const REVISED_ONE = "# Plan\n\nAlpha CHANGED.\n\nBeta line.\n\n<!--inplan v1\n[]\n-->\n";

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

const tri = (): HTMLElement => screen.getByRole("checkbox", { name: /accept or reject all changes/i });

describe("App review decision matrix (memory-backed)", () => {
  beforeEach(() => mount(DOC));

  async function renderAndPropose(revision = REVISED) {
    const { App } = await import("../src/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("Alpha line."));
    await act(async () => {
      agent.proposeRevision(revision);
    });
    await waitFor(() => expect(document.body.textContent).toContain("Agent proposed changes"));
  }

  it("a parked proposal shows the diff with N hunks (one switch per hunk)", async () => {
    await renderAndPropose();

    // The bar announces the change count; two body edits => two changes.
    expect(document.body.textContent).toContain("2 changes shown inline below");
    // Each hunk renders an accept switch in BOTH diff panes (shared state), so we
    // expect a per-index switch to exist for change 1 and change 2 but not change 3.
    expect(screen.getAllByRole("switch", { name: /accept change 1/ }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByRole("switch", { name: /accept change 2/ }).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryAllByRole("switch", { name: /accept change 3/ }).length).toBe(0);
  });

  it("a single-hunk proposal uses the singular '1 change' wording", async () => {
    await renderAndPropose(REVISED_ONE);
    expect(document.body.textContent).toContain("1 change shown inline below");
    expect(document.body.textContent).not.toContain("changes shown inline below");
    expect(screen.getAllByRole("switch", { name: /accept change 1/ }).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryAllByRole("switch", { name: /accept change 2/ }).length).toBe(0);
  });

  it("the tri-switch defaults to ALL ACCEPTED (aria-checked=true) and one click flips it to reject (false)", async () => {
    await renderAndPropose();
    // Default: every hunk accepted → tri reports checked.
    expect(tri().getAttribute("aria-checked")).toBe("true");
    expect(document.querySelector(".ap-tri--accept")).toBeTruthy();

    // Cycle once: accept → reject. aria-checked becomes false.
    await act(async () => fireEvent.click(tri()));
    expect(tri().getAttribute("aria-checked")).toBe("false");
    expect(document.querySelector(".ap-tri--reject")).toBeTruthy();
    expect(document.body.textContent).not.toContain("will be accepted");

    // Cycle again: reject → accept.
    await act(async () => fireEvent.click(tri()));
    expect(tri().getAttribute("aria-checked")).toBe("true");
    expect(document.querySelector(".ap-tri--accept")).toBeTruthy();
  });

  it("a per-hunk Switch toggles exactly one hunk and drives the tri-switch to mixed", async () => {
    await renderAndPropose();
    // All accepted to start.
    const hunk1Before = screen.getAllByRole("switch", { name: /accept change 1/ })[0] as HTMLInputElement;
    const hunk2Before = screen.getAllByRole("switch", { name: /accept change 2/ })[0] as HTMLInputElement;
    expect(hunk1Before.checked).toBe(true);
    expect(hunk2Before.checked).toBe(true);

    // Reject ONLY change 1.
    await act(async () => fireEvent.click(hunk1Before));

    const hunk1 = screen.getAllByRole("switch", { name: /accept change 1/ })[0] as HTMLInputElement;
    const hunk2 = screen.getAllByRole("switch", { name: /accept change 2/ })[0] as HTMLInputElement;
    expect(hunk1.checked).toBe(false); // the one we toggled
    expect(hunk2.checked).toBe(true); // untouched
    // Mixed selection: the tri reports aria-checked="mixed".
    expect(tri().getAttribute("aria-checked")).toBe("mixed");
    expect(document.querySelector(".ap-tri--mixed")).toBeTruthy();
    // The per-hunk status labels reflect the split.
    expect(document.body.textContent).toContain("will be rejected");
    expect(document.body.textContent).toContain("will be accepted");

    // One click on the mixed tri resolves the whole set back to accept.
    await act(async () => fireEvent.click(tri()));
    expect(document.querySelector(".ap-tri--accept")).toBeTruthy();
    expect((screen.getAllByRole("switch", { name: /accept change 1/ })[0] as HTMLInputElement).checked).toBe(true);
  });

  it("Apply with all accepted writes the proposed body and clears the proposal", async () => {
    await renderAndPropose();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Apply$/ }));
    });

    await waitFor(() => expect(document.body.textContent).not.toContain("Agent proposed changes"));
    // Both accepted hunks landed in the applied (preview) body.
    expect(document.body.textContent).toContain("Alpha CHANGED.");
    expect(document.body.textContent).toContain("Beta CHANGED.");
    expect(document.body.textContent).not.toContain("Alpha line.");
    expect(document.body.textContent).not.toContain("Beta line.");
    // Decision made → proposal discarded.
    expect(await (window as unknown as Win).api.getProposal()).toBeNull();
  });

  it("Reject-all then Apply discards the proposal and leaves the body unchanged", async () => {
    await renderAndPropose();
    // accept → reject (one click rejects every hunk).
    await act(async () => fireEvent.click(tri()));
    expect(document.querySelector(".ap-tri--reject")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Apply$/ }));
    });

    await waitFor(() => expect(document.body.textContent).not.toContain("Agent proposed changes"));
    // Original body intact; nothing from the proposal survived.
    expect(document.body.textContent).toContain("Alpha line.");
    expect(document.body.textContent).toContain("Beta line.");
    expect(document.body.textContent).not.toContain("CHANGED");
    expect(await (window as unknown as Win).api.getProposal()).toBeNull();
  });

  it("the pencil edits a hunk's proposed text and Apply uses the EDITED text", async () => {
    await renderAndPropose();

    // Open the inline editor for change 1; it is seeded with the agent's proposed text.
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: /edit change 1/ })[0]!);
    });
    const ta = screen.getByRole("textbox", { name: /edit change 1/ }) as HTMLTextAreaElement;
    expect(ta.value).toContain("Alpha CHANGED.");

    await act(async () => {
      fireEvent.change(ta, { target: { value: "Alpha EDITED." } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /save edit/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Apply$/ }));
    });

    await waitFor(() => expect(document.body.textContent).not.toContain("Agent proposed changes"));
    // The human's edit wins over the agent's proposal for hunk 1; hunk 2 still applies.
    expect(document.body.textContent).toContain("Alpha EDITED.");
    expect(document.body.textContent).not.toContain("Alpha CHANGED.");
    expect(document.body.textContent).toContain("Beta CHANGED.");
  });

  it("an edited hunk that is then REJECTED contributes neither the edit nor the proposal", async () => {
    await renderAndPropose();
    // Edit change 1.
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: /edit change 1/ })[0]!);
    });
    await act(async () => {
      fireEvent.change(screen.getByRole("textbox", { name: /edit change 1/ }), { target: { value: "Alpha EDITED." } });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /save edit/i }));
    });
    // Now reject change 1 entirely.
    await act(async () => fireEvent.click(screen.getAllByRole("switch", { name: /accept change 1/ })[0]!));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Apply$/ }));
    });

    await waitFor(() => expect(document.body.textContent).not.toContain("Agent proposed changes"));
    // Rejected hunk keeps the ORIGINAL line; the saved edit is discarded with the rejection.
    expect(document.body.textContent).toContain("Alpha line.");
    expect(document.body.textContent).not.toContain("Alpha EDITED.");
    expect(document.body.textContent).not.toContain("Alpha CHANGED.");
    // The other hunk was left accepted.
    expect(document.body.textContent).toContain("Beta CHANGED.");
  });

  it("'Review next' steps the cursor through the hunks and wraps around", async () => {
    await renderAndPropose();

    const reviewNext = (): HTMLElement => screen.getByRole("button", { name: /^Review next/ });
    // No cursor position shown until the first step.
    expect(reviewNext().textContent).not.toMatch(/\d+\/\d+/);

    // Step 1 → 1/2.
    await act(async () => fireEvent.click(reviewNext()));
    await waitFor(() => expect(screen.getByRole("button", { name: /Review next \(1\/2\)/ })).toBeTruthy());

    // Step 2 → 2/2.
    await act(async () => fireEvent.click(reviewNext()));
    await waitFor(() => expect(screen.getByRole("button", { name: /Review next \(2\/2\)/ })).toBeTruthy());

    // Step 3 wraps back to 1/2.
    await act(async () => fireEvent.click(reviewNext()));
    await waitFor(() => expect(screen.getByRole("button", { name: /Review next \(1\/2\)/ })).toBeTruthy());
  });
});
