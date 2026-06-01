// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// App-level integration test: mount the real <App/> with a memory-backed
// window.api, have the scripted agent propose a Review-mode revision, and assert
// the review UI surfaces and Accept applies it. This is the exact path the
// Review-mode adopt-race lived in — here it can't race, because the proposal
// arrives through onProposal (not a working-file write).
//
// SourceEditor (CodeMirror) is stubbed: it needs layout APIs happy-dom only
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

const DOC = "# Plan\n\nHello world.\n\n<!--inplan v1\n[]\n-->\n";
let agent: MemoryAgent;

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>';
  const session = createMemoryApi({ content: DOC });
  (window as unknown as { api: unknown }).api = session.api;
  agent = session.agent;
});
afterEach(cleanup);

describe("App review flow (memory-backed)", () => {
  it("surfaces an agent Review proposal and clears it on Apply", async () => {
    const { App } = await import("../src/App");
    render(<App />);

    // Initial document loads into the preview.
    await waitFor(() => expect(document.body.textContent).toContain("Hello world."));

    // The agent proposes a Review-mode revision.
    await act(async () => {
      agent.proposeRevision("# Plan\n\nHello CHANGED.\n\n<!--inplan v1\n[]\n-->\n");
    });

    // The review bar surfaces (no adopt-race in this path).
    await waitFor(() => expect(document.body.textContent).toContain("Agent proposed changes"));
    const acceptAll = screen.getByRole("button", { name: /accept all/i });
    const apply = screen.getByRole("button", { name: /^apply$/i });

    // Accept all hunks, then Apply.
    await act(async () => {
      acceptAll.click();
    });
    await act(async () => {
      apply.click();
    });

    // Review bar is gone and the parked proposal was cleared.
    await waitFor(() => expect(document.body.textContent).not.toContain("Agent proposed changes"));
    expect(await (window as unknown as { api: { getProposal(): Promise<string | null> } }).api.getProposal()).toBeNull();
  });
});
