// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Regression: in COLLAB mode (a binding owns the source + the shared/persisted doc), accepting an
// agent Review proposal must push the accepted body to the binding — not just React state. The bug:
// applyProposal called setDoc (preview) + save({apply}) (a no-op in the unified-Yjs model) but never
// wrote the binding, so the source pane stayed stale and the change reverted on reload. Here we inject
// a binding + comment store and assert the accepted body is handed to binding.setText.

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { forwardRef, useImperativeHandle } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryApi, type MemoryAgent } from "../src/memoryApi";
import { createMemoryCommentStore } from "../src/commentStore";
import { setHostApi } from "../src/api";

vi.mock("../src/SourceEditor", () => ({
  SourceEditor: forwardRef(function SourceEditorStub(_props: unknown, ref: React.Ref<unknown>) {
    useImperativeHandle(ref, () => ({ scrollToLine() {}, selectRange() {} }));
    return null;
  }),
}));

const DOC = "# Plan\n\nHello world.\n\n<!--inplan v1\n[]\n-->\n";
let agent: MemoryAgent;
let bound = ""; // the binding's shared text (unified: the bare body)
const setText = vi.fn((s: string) => { bound = s; });

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>';
  setText.mockClear();
  bound = "# Plan\n\nHello world.\n";
  const session = createMemoryApi({ content: DOC });
  // Merge a collab binding + comment store onto the memory api (what the desktop/web collab host does).
  setHostApi({ ...session.api, commentStore: createMemoryCommentStore([]), binding: { extensions: [], getText: () => bound, setText } });
  (window as unknown as { api: unknown }).api = session.api;
  agent = session.agent;
});
afterEach(cleanup);

describe("App applyProposal (collab binding path)", () => {
  it("accepting a proposal writes the accepted body to the binding (source + persistence), not just the preview", async () => {
    const { App } = await import("../src/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("Hello world."));

    await act(async () => {
      agent.proposeRevision("# Plan\n\nHello CHANGED body.\n\n<!--inplan v1\n[]\n-->\n");
    });
    await waitFor(() => expect(document.body.textContent).toContain("Agent proposed changes"));

    await act(async () => screen.getByRole("button", { name: /accept all/i }).click());
    await act(async () => screen.getByRole("button", { name: /^apply$/i }).click());

    await waitFor(() => expect(document.body.textContent).not.toContain("Agent proposed changes"));
    // The accepted body reached the binding (the collab source-of-truth), as the BARE body (unified).
    expect(setText).toHaveBeenCalled();
    const lastWrite = setText.mock.calls.at(-1)![0];
    expect(lastWrite).toContain("Hello CHANGED body.");
    expect(lastWrite).not.toContain("<!--inplan"); // bare body, not the serialized doc
    expect(bound).toContain("Hello CHANGED body.");
  });
});
