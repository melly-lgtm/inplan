// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Activation-funnel telemetry from the real <App/> with a memory-backed window.api. The host
// gates on the opt-in setting and never sees document content — these events carry only coarse,
// non-PII props. We assert the renderer FIRES the events (via api.telemetry); the memory host
// records them into session.telemetryEvents instead of sending a network request.

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { forwardRef, useImperativeHandle } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryApi, type MemorySession } from "../src/memoryApi";

vi.mock("../src/SourceEditor", () => ({
  SourceEditor: forwardRef(function SourceEditorStub(_props: unknown, ref: React.Ref<unknown>) {
    useImperativeHandle(ref, () => ({ scrollToLine() {}, selectRange() {} }));
    return null;
  }),
}));

const DOC = "# Plan\n\nHello world.\n\n<!--inplan v1\n[]\n-->\n";
let session: MemorySession;

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>';
  session = createMemoryApi({ content: DOC });
  (window as unknown as { api: unknown }).api = session.api;
});
afterEach(cleanup);

async function mountApp() {
  const { App } = await import("../src/App");
  render(<App />);
  await waitFor(() => expect(document.body.textContent).toContain("Hello world."));
}

describe("App activation-funnel telemetry (memory-backed)", () => {
  it("fires comment_created {kind:doc} when a document-level comment is added", async () => {
    await mountApp();
    await act(async () => {
      screen.getByRole("button", { name: /comment on doc/i }).click();
    });
    const ta = await screen.findByPlaceholderText(/Add a comment/i);
    await act(async () => {
      fireEvent.change(ta, { target: { value: "Clarify the rollout plan." } });
    });
    await act(async () => {
      screen.getByRole("button", { name: /^comment$/i }).click();
    });

    const ev = session.telemetryEvents.find((e) => e.event === "comment_created");
    expect(ev).toBeTruthy();
    expect(ev?.props).toEqual({ kind: "doc" });
    // The comment TEXT must never be in the telemetry payload.
    expect(JSON.stringify(session.telemetryEvents)).not.toContain("rollout");
  });

  it("fires turn_finished when the human finishes their turn", async () => {
    await mountApp();
    await act(async () => {
      screen.getByRole("button", { name: /finish turn/i }).click();
    });
    expect(session.telemetryEvents.some((e) => e.event === "turn_finished")).toBe(true);
  });
});
