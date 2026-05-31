// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// App-level integration tests against the real <App/> with a memory-backed
// window.api, exercising the top-bar mode toggle and the Save / Finish turn /
// Complete & quit controls. Each interaction lands a control-log event in the
// memory channel, which we assert through the agent driver's log().
//
// SourceEditor (CodeMirror) is stubbed: it needs layout APIs happy-dom only
// stubs, and these controls live in App's top bar, not the editor.

import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { forwardRef, useImperativeHandle } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryApi, type MemoryAgent, type MemorySession } from "../src/renderer/memoryApi";

vi.mock("../src/renderer/SourceEditor", () => ({
  SourceEditor: forwardRef(function SourceEditorStub(_props: unknown, ref: React.Ref<unknown>) {
    useImperativeHandle(ref, () => ({ scrollToLine() {}, selectRange() {} }));
    return null;
  }),
}));

const DOC = "# Plan\n\nHello world.\n\n<!--inplan v1\n[]\n-->\n";
let agent: MemoryAgent;
let session: MemorySession;

beforeEach(() => {
  // Layout (including cadence) is persisted to localStorage; clear it so each
  // test starts from the default Turn cadence rather than a prior test's toggle.
  localStorage.clear();
  document.body.innerHTML = '<div id="root"></div>';
  session = createMemoryApi({ content: DOC });
  (window as unknown as { api: unknown }).api = session.api;
  agent = session.agent;
});
afterEach(cleanup);

const types = async (): Promise<string[]> => (await agent.log()).map((e) => e.type);

describe("App mode toggle + save / finish turn / complete (memory-backed)", () => {
  it("toggling cadence to Instant logs a mode_changed event", async () => {
    const { App } = await import("../src/renderer/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("Hello world."));

    // Default cadence is Turn; switch to Instant via the top-bar cadence control.
    const group = screen.getByRole("group", { name: "cadence" });
    const instant = within(group).getByRole("button", { name: /instant/i });
    await act(async () => {
      instant.click();
    });

    await waitFor(async () => expect(await types()).toContain("mode_changed"));
  });

  it("Finish turn (Turn mode) logs a turn_ended event", async () => {
    const { App } = await import("../src/renderer/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("Hello world."));

    const finish = screen.getByRole("button", { name: /finish turn/i });
    await act(async () => {
      finish.click();
    });

    await waitFor(async () => expect(await types()).toContain("turn_ended"));
  });

  it("Save in Turn mode persists a backup without ending the turn", async () => {
    const { App } = await import("../src/renderer/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("Hello world."));

    const save = screen.getByRole("button", { name: /^save/i });
    await act(async () => {
      save.click();
    });

    // A backup save is silent on the control channel: no turn_ended / document_edited
    // is appended (those would wake the agent). The status line confirms the save.
    await waitFor(() => expect(document.body.textContent).toContain("checkpoint saved"));
    const t = await types();
    expect(t).not.toContain("turn_ended");
  });

  it("Complete & quit closes the session and logs session_closed", async () => {
    const { App } = await import("../src/renderer/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("Hello world."));

    expect(session.isClosed()).toBe(false);
    const complete = screen.getByRole("button", { name: /complete & quit/i });
    await act(async () => {
      complete.click();
    });

    await waitFor(() => expect(session.isClosed()).toBe(true));
    expect(await types()).toContain("session_closed");
  });
});
