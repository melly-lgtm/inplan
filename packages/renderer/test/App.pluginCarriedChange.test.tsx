// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Where the editor reads an agent's edit FROM. An edit that went out through a runtime plugin is
// in the plugin's shared document, which a bound editor sees through its binding — while the
// `content` the host read from disk can be a pre-revision projection the plugin wrote over the
// working file. Adopting that would push stale text into the binding, over the turn that just
// landed. Every other case reads `content`, as before.

import { act, cleanup, render, waitFor } from "@testing-library/react";
import { forwardRef, useImperativeHandle } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../src/bindingRead";
import { parse } from "@inplan/core";
import { createMemoryCommentStore } from "../src/commentStore";
import { createMemoryApi } from "../src/memoryApi";

vi.mock("../src/SourceEditor", () => ({
  SourceEditor: forwardRef(function SourceEditorStub(_p: unknown, ref: React.Ref<unknown>) {
    useImperativeHandle(ref, () => ({ scrollToLine() {}, selectRange() {} }));
    return null;
  }),
}));

const DOC = "# Plan\n\nThe original body.\n\n<!--inplan v1\n[]\n-->\n";
const STALE_FILE = "# Plan\n\nA stale projection read from the working file.\n\n<!--inplan v1\n[]\n-->\n";
const IN_BINDING = "# Plan\n\nThe revision, as the shared document holds it.\n\n<!--inplan v1\n[]\n-->\n";
const LANDED = "# Plan\n\nThe text the gate landed, file-backed.\n\n<!--inplan v1\n[]\n-->\n";
const PATH = "memory://doc"; // the path the in-memory host loads the document under
type Payload = { path: string; content: string; viaPlugin?: boolean; bodyHash?: string };
let emit: ((p: Payload) => void) | null = null;

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '<div id="root"></div>';
  const session = createMemoryApi({ content: DOC });
  const api = session.api as unknown as { onExternalChange: (cb: (p: Payload) => void) => () => void };
  api.onExternalChange = (cb) => {
    emit = cb;
    return () => (emit = null);
  };
  (window as unknown as { api: unknown }).api = api;
});
afterEach(() => {
  cleanup();
  emit = null;
});

/** A legacy-shaped binding (no comment store): its text is the whole serialized document. */
function bind(text: string) {
  const binding = { extensions: [], getText: vi.fn(() => text), setText: vi.fn() };
  (window as unknown as { api: { binding: unknown } }).api.binding = binding;
  return binding;
}
async function mount() {
  const { App } = await import("../src/App");
  render(<App />);
  await waitFor(() => expect(document.body.textContent).toContain("The original body."));
  await waitFor(() => expect(emit).toBeTruthy());
}

describe("where an agent's edit is read from", () => {
  it("through the plugin + bound: from the binding — the file's content is never adopted or pushed", async () => {
    const binding = bind(IN_BINDING);
    await mount();

    act(() => emit!({ path: PATH, content: STALE_FILE, viaPlugin: true }));

    // The preview shows what the shared document holds — also in this (default) layout, where no
    // source pane is mounted to observe the binding…
    await waitFor(() => expect(document.body.textContent).toContain("as the shared document holds it"));
    expect(document.body.textContent).not.toContain("A stale projection");
    expect(binding.setText).not.toHaveBeenCalled(); // …and above all nothing is written back into it
  });

  it("waits for the binding to HOLD the revision — pre-revision text is never adopted", async () => {
    // The event beat the plugin's own delivery: the binding still holds the text from before the
    // turn. Adopting that makes it the base of the editor's next programmatic change, which is
    // written back through the binding — over the revision, once it arrives.
    let text = DOC;
    const binding = bind(DOC);
    binding.getText.mockImplementation(() => text);
    await mount();
    const landed = (await sha256Hex(parse(IN_BINDING).body))!;

    act(() => emit!({ path: PATH, content: STALE_FILE, viaPlugin: true, bodyHash: landed }));
    await new Promise((r) => setTimeout(r, 250)); // several polls go by…
    expect(document.body.textContent).not.toContain("agent updated the document"); // …with nothing adopted or announced

    text = IN_BINDING; // the plugin delivers
    await waitFor(() => expect(document.body.textContent).toContain("as the shared document holds it"));
    expect(binding.setText).not.toHaveBeenCalled();
  });

  it("unified (bare-body binding + comment store): the body from the binding, comments from the store", async () => {
    // What a real plugin installs. The binding's text is the body alone — parsing it as a whole
    // document, or taking comments from it, is the legacy shape.
    const body = parse(IN_BINDING).body;
    const binding = bind(body);
    const comment = { id: "cmt-aaa111", anchor: "doc" as const, author: "Agent <agent@example.com>", text: "From the store, not the text.", date: "2026-06-01T00:00:00Z", resolved: false };
    (window as unknown as { api: { commentStore: unknown } }).api.commentStore = createMemoryCommentStore([comment]);
    await mount();
    const landed = (await sha256Hex(body))!;

    act(() => emit!({ path: PATH, content: STALE_FILE, viaPlugin: true, bodyHash: landed }));

    await waitFor(() => expect(document.body.textContent).toContain("as the shared document holds it"));
    expect(document.body.textContent).toContain("From the store, not the text.");
    expect(binding.setText).not.toHaveBeenCalled();
  });

  it("an edit to ANOTHER document is not this editor's: nothing adopted, nothing pushed", async () => {
    // Mid-navigation the host is already watching the next document while this editor still shows
    // — and is still bound to — the previous one. Its file-backed edit would have been parsed and
    // pushed through this binding into the wrong shared document.
    const binding = bind(DOC);
    await mount();

    act(() => emit!({ path: "/somewhere/else.plan.md", content: LANDED }));

    expect(document.body.textContent).toContain("The original body.");
    expect(document.body.textContent).not.toContain("The text the gate landed");
    expect(binding.setText).not.toHaveBeenCalled();
  });

  it("an unreadable binding is not an edit: nothing is adopted or announced", async () => {
    // A legacy binding caught mid-edit, its comment block not yet valid. Nothing was read, so
    // carrying on would reset the saved baseline, clear dirty and announce an update nobody saw.
    const binding = bind("# Plan\n\nHalf-typed.\n\n<!--inplan v1\n[{ broken\n-->\n");
    await mount();

    act(() => emit!({ path: PATH, content: STALE_FILE, viaPlugin: true }));

    expect(document.body.textContent).toContain("The original body."); // still showing what it had
    expect(document.body.textContent).not.toContain("A stale projection"); // and it did not fall back to the file
    expect(document.body.textContent).not.toContain("agent updated the document");
    expect(binding.setText).not.toHaveBeenCalled();
  });

  it("through the plugin + NOT bound: from the content — it is the only copy this editor has", async () => {
    await mount(); // the plugin's browser entry never loaded: no binding

    act(() => emit!({ path: PATH, content: IN_BINDING, viaPlugin: true }));

    await waitFor(() => expect(document.body.textContent).toContain("as the shared document holds it"));
  });

  it("file-backed + bound: from the content, and pushed into the binding to reach the shared document", async () => {
    // The first `open` is always this: it read the plugin session before the editor published
    // one, so its edits are file-backed while the editor is already bound. The host sends the text
    // the gate landed (the canonical), and the binding is the only road into the shared document.
    const binding = bind(DOC);
    await mount();

    act(() => emit!({ path: PATH, content: LANDED }));

    await waitFor(() => expect(document.body.textContent).toContain("The text the gate landed"));
    expect(binding.setText).toHaveBeenCalledTimes(1);
    expect(String(binding.setText.mock.calls[0]![0])).toContain("The text the gate landed");
  });
});
