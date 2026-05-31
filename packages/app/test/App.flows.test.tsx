// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// App-level flow tests against the real <App/> with a memory-backed window.api:
// instant-mode auto-accept, comment-thread rendering, and the find bar. SourceEditor
// (CodeMirror) is stubbed — it needs layout APIs happy-dom only stubs.

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { forwardRef, useImperativeHandle } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryApi, type MemoryAgent } from "../src/renderer/memoryApi";

vi.mock("../src/renderer/SourceEditor", () => ({
  SourceEditor: forwardRef(function SourceEditorStub(_props: unknown, ref: React.Ref<unknown>) {
    useImperativeHandle(ref, () => ({ scrollToLine() {}, selectRange() {} }));
    return null;
  }),
}));

const DOC_WITH_COMMENT =
  '# Plan\n\nUse [Postgres](#cmt-abc123) here.\n\n<!--inplan v1\n[ { "id": "cmt-abc123", "author": "x", "date": "d", "resolved": false, "text": "Why not SQLite for v1?" } ]\n-->\n';

let agent: MemoryAgent;

function mount(content: string) {
  document.body.innerHTML = '<div id="root"></div>';
  const session = createMemoryApi({ content });
  (window as unknown as { api: unknown }).api = session.api;
  agent = session.agent;
}
afterEach(cleanup);

describe("App flows (memory-backed)", () => {
  it("instant mode: an agent auto-accept edit updates the document live", async () => {
    mount("# Plan\n\nFirst body.\n\n<!--inplan v1\n[]\n-->\n");
    const { App } = await import("../src/renderer/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("First body."));

    await act(async () => {
      agent.externalChange("# Plan\n\nAUTO ACCEPTED body.\n\n<!--inplan v1\n[]\n-->\n");
    });
    await waitFor(() => expect(document.body.textContent).toContain("AUTO ACCEPTED body."));
    expect(document.body.textContent).not.toContain("First body.");
  });

  it("renders a loaded comment thread in the rail", async () => {
    mount(DOC_WITH_COMMENT);
    const { App } = await import("../src/renderer/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("Why not SQLite for v1?"));
  });

  it("⌘F opens the find bar", async () => {
    mount("# Plan\n\nsome text\n\n<!--inplan v1\n[]\n-->\n");
    const { App } = await import("../src/renderer/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("some text"));

    expect(screen.queryByPlaceholderText(/Find/)).toBeNull();
    fireEvent.keyDown(document.body, { key: "f", metaKey: true });
    await waitFor(() => expect(screen.getByPlaceholderText(/Find/)).toBeTruthy());
  });
});
