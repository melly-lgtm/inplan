// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// #137: a binding owns the body, but with no source pane mounted nothing observed it, so the
// editor's copy went stale whenever the shared text changed from elsewhere — and every programmatic
// edit built from that copy wrote the newer change away. With `binding.observe`, the editor follows
// the binding in any layout.

import { act, cleanup, render, waitFor } from "@testing-library/react";
import { forwardRef, useImperativeHandle } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryApi } from "../src/memoryApi";
import { createMemoryCommentStore } from "../src/commentStore";
import { setHostApi } from "../src/api";

let sourceMounted = false;
vi.mock("../src/SourceEditor", () => ({
  SourceEditor: forwardRef(function SourceEditorStub(_props: unknown, ref: React.Ref<unknown>) {
    useImperativeHandle(ref, () => ({ scrollToLine() {}, selectRange() {} }));
    sourceMounted = true;
    return null;
  }),
}));

const DOC = "# Plan\n\nHello world.\n\n<!--inplan v1\n[]\n-->\n";
let bound = "";
let listeners: Array<() => void> = [];
const reportState = vi.fn();

function change(text: string): void {
  bound = text;
  for (const l of listeners) l();
}

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>';
  sourceMounted = false;
  bound = "# Plan\n\nHello world.\n";
  listeners = [];
  reportState.mockClear();
  const session = createMemoryApi({ content: DOC });
  const binding = {
    extensions: [],
    getText: () => bound,
    setText: (s: string) => change(s),
    observe: (cb: () => void) => {
      listeners.push(cb);
      return () => (listeners = listeners.filter((l) => l !== cb));
    },
  };
  setHostApi({ ...session.api, reportState, commentStore: createMemoryCommentStore([]), binding });
  (window as unknown as { api: unknown }).api = session.api;
});
afterEach(cleanup);

describe("the editor follows its binding without a source pane (#137)", () => {
  it("a change to the shared text from elsewhere reaches the preview and the editor's copy", async () => {
    const { App } = await import("../src/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("Hello world."));
    expect(sourceMounted).toBe(false); // the default layout: nothing else observes the binding

    act(() => change("# Plan\n\nHello world.\n\nA collaborator's new line.\n"));
    await waitFor(() => expect(document.body.textContent).toContain("A collaborator's new line."));
    // The copy programmatic edits are built from has it too (the editor reports its document state).
    expect(reportState.mock.calls.at(-1)![1]).toContain("A collaborator's new line.");
  });

  it("unsubscribes on unmount", async () => {
    const { App } = await import("../src/App");
    const view = render(<App />);
    await waitFor(() => expect(listeners.length).toBeGreaterThan(0));
    view.unmount();
    expect(listeners).toHaveLength(0);
  });

  it("whole-document binding (no comment store): takes the parsed body, and skips a text that doesn't parse yet", async () => {
    const session = createMemoryApi({ content: DOC });
    bound = DOC;
    const binding = { extensions: [], getText: () => bound, observe: (cb: () => void) => (listeners.push(cb), () => {}) };
    setHostApi({ ...session.api, binding });
    const { App } = await import("../src/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("Hello world."));

    act(() => change("# Plan\n\nHello world.\n\n<!--inplan v1\n[{broken"));
    expect(document.body.textContent).toContain("Hello world."); // mid-edit: nothing adopted
    act(() => change("# Plan\n\nParsed again.\n\n<!--inplan v1\n[]\n-->\n"));
    await waitFor(() => expect(document.body.textContent).toContain("Parsed again."));
    expect(document.body.textContent).not.toContain("<!--inplan");
  });
});
