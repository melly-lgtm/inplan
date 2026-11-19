// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// An external change read from a file a PLUGIN owns. The plugin overwrites that file with its own
// projection on its own schedule, so the content can be pre-revision — and an editor bound to that
// plugin would push it into the binding, writing it over the shared document. An editor that never
// bound (the plugin's browser entry can fail to import) has no other copy, so it uses it.

import { act, cleanup, render, waitFor } from "@testing-library/react";
import { forwardRef, useImperativeHandle } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryApi } from "../src/memoryApi";

vi.mock("../src/SourceEditor", () => ({
  SourceEditor: forwardRef(function SourceEditorStub(_p: unknown, ref: React.Ref<unknown>) {
    useImperativeHandle(ref, () => ({ scrollToLine() {}, selectRange() {} }));
    return null;
  }),
}));

const DOC = "# Plan\n\nThe original body.\n\n<!--inplan v1\n[]\n-->\n";
const INCOMING = "# Plan\n\nRead from the file the plugin owns.\n\n<!--inplan v1\n[]\n-->\n";
let emit: ((p: { path: string; content: string; pluginOwned?: boolean }) => void) | null = null;

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '<div id="root"></div>';
  const session = createMemoryApi({ content: DOC });
  const api = session.api as unknown as { onExternalChange: (cb: (p: never) => void) => () => void; binding?: unknown };
  api.onExternalChange = (cb) => {
    emit = cb as never;
    return () => (emit = null);
  };
  (window as unknown as { api: unknown }).api = api;
});
afterEach(() => {
  cleanup();
  emit = null;
});

async function mount() {
  const { App } = await import("../src/App");
  render(<App />);
  await waitFor(() => expect(document.body.textContent).toContain("The original body."));
  await waitFor(() => expect(emit).toBeTruthy());
}

describe("an external change from a plugin-owned file", () => {
  it("is ignored when the editor is bound to that plugin", async () => {
    const setText = vi.fn();
    (window as unknown as { api: { binding: unknown } }).api.binding = { setText };
    await mount();

    act(() => emit!({ path: "p.md", content: INCOMING, pluginOwned: true }));

    expect(document.body.textContent).not.toContain("Read from the file the plugin owns.");
    expect(setText).not.toHaveBeenCalled(); // above all: never written into the shared document
  });

  it("is used when the editor never bound — it is the only copy there is", async () => {
    await mount(); // no binding on the api

    act(() => emit!({ path: "p.md", content: INCOMING, pluginOwned: true }));

    await waitFor(() => expect(document.body.textContent).toContain("Read from the file the plugin owns."));
  });

  it("still reports, rather than going silent", async () => {
    // Not adopting must not mean ignoring: a bare return left the agent-thinking indicator up
    // forever and told the human nothing had happened.
    //
    // The same branch also re-shows an open review so its frozen base cannot make Apply publish a
    // body computed before this change. That part is NOT pinned here and the name does not claim
    // it: in this path the document is deliberately not adopted, so `docRef` has not moved and the
    // re-show recomputes an identical base — observably a no-op. It only bites once the BINDING
    // has moved the document, which this harness cannot drive.
    const setText = vi.fn();
    (window as unknown as { api: { binding: unknown } }).api.binding = { setText };
    await mount();

    act(() => emit!({ path: "p.md", content: INCOMING, pluginOwned: true }));

    await waitFor(() => expect(document.body.textContent).toContain("agent updated the document"));
    expect(setText).not.toHaveBeenCalled();
  });

  it("is used when no plugin owns it, bound or not", async () => {
    const setText = vi.fn();
    (window as unknown as { api: { binding: unknown } }).api.binding = { setText };
    await mount();

    act(() => emit!({ path: "p.md", content: INCOMING }));

    await waitFor(() => expect(document.body.textContent).toContain("Read from the file the plugin owns."));
  });
});
