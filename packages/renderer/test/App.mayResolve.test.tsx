// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// App-level: the agent's `may_resolve` suggestion (its last reply on a thread). With auto-resolve
// OFF the thread shows an "Agent suggested to resolve" badge; with it ON the editor resolves the
// thread on load (so it leaves the rail). SourceEditor (CodeMirror) is stubbed.

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { forwardRef, useImperativeHandle } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryApi, type MemoryAgent } from "../src/memoryApi";
import type { Settings } from "../src/api";

vi.mock("../src/SourceEditor", () => ({
  SourceEditor: forwardRef(function SourceEditorStub(_props: unknown, ref: React.Ref<unknown>) {
    useImperativeHandle(ref, () => ({ scrollToLine() {}, selectRange() {} }));
    return null;
  }),
}));

// A thread whose LAST comment (the agent's reply) carries may_resolve.
const DOC_SUGGESTED =
  "# Plan\n\nUse [Postgres](#cmt-root1) for storage.\n\n<!--inplan v1\n" +
  JSON.stringify([
    { id: "cmt-root1", author: "You", date: "2026-01-01T00:00:01Z", resolved: false, text: "Which datastore?" },
    { id: "cmt-rep01", parentId: "cmt-root1", author: "Opus 4.8 <claude@inplan.ai>", date: "2026-01-01T00:00:02Z", resolved: false, text: "Adopted Postgres.", may_resolve: true },
  ]) +
  "\n-->\n";

let agent: MemoryAgent;

function mount(settings: Settings) {
  document.body.innerHTML = '<div id="root"></div>';
  const session = createMemoryApi({ content: DOC_SUGGESTED, settings });
  (window as unknown as { api: typeof session.api }).api = session.api;
  agent = session.agent;
}
afterEach(cleanup);

describe("App — may_resolve suggestion", () => {
  it("auto-resolve OFF: shows the 'Agent suggested to resolve' badge", async () => {
    mount({ autoResolve: false });
    const { App } = await import("../src/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("Which datastore?"));
    expect(screen.getByText(/agent suggested to resolve/i)).toBeTruthy();
  });

  it("auto-resolve ON: resolves the suggested thread on load (no badge; logged)", async () => {
    mount({ autoResolve: true });
    const { App } = await import("../src/App");
    await act(async () => {
      render(<App />);
    });
    // The suggested thread is resolved on load → it leaves the rail and shows no badge.
    await waitFor(async () => {
      const log = await agent.log();
      expect(log.some((e) => e.type === "comment_resolved")).toBe(true);
    });
    expect(screen.queryByText(/agent suggested to resolve/i)).toBeNull();
  });
});
