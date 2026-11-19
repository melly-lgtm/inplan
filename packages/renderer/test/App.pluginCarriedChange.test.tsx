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
let host: ReturnType<typeof createMemoryApi>;

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '<div id="root"></div>';
  const session = (host = createMemoryApi({ content: DOC }));
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
    const landed = (await sha256Hex(parse(IN_BINDING).body))!;

    act(() => emit!({ path: PATH, content: STALE_FILE, viaPlugin: true, bodyHash: landed })); // as the CLI stamps it: carrier and hash together

    // The preview shows what the shared document holds — also in this (default) layout, where no
    // source pane is mounted to observe the binding…
    await waitFor(() => expect(document.body.textContent).toContain("as the shared document holds it"));
    expect(document.body.textContent).not.toContain("A stale projection");
    expect(binding.setText).not.toHaveBeenCalled(); // …and above all nothing is written back into it
  });

  it("does not adopt pre-revision text while the revision is still on its way", async () => {
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

  it("adopts what the binding holds when the wait ends — not what the wait looked at", async () => {
    // Checking the binding takes an await. A keystroke landing in it meanwhile has to be in what
    // is adopted, or the editor's copy is behind the binding again, by exactly that keystroke.
    const typedSince = IN_BINDING.replace("holds it.", "holds it. And a keystroke since.");
    const binding = bind(IN_BINDING);
    await mount();
    const landed = (await sha256Hex(parse(IN_BINDING).body))!;
    binding.getText.mockImplementationOnce(() => IN_BINDING).mockImplementation(() => typedSince); // the check sees the revision; the adoption, what came after

    act(() => emit!({ path: PATH, content: STALE_FILE, viaPlugin: true, bodyHash: landed }));

    await waitFor(() => expect(document.body.textContent).toContain("And a keystroke since."));
  });

  it("a newer edit supersedes a wait still running for an older one", async () => {
    let text = DOC;
    const binding = bind(DOC);
    binding.getText.mockImplementation(() => text);
    await mount();
    const landed = (await sha256Hex(parse(IN_BINDING).body))!;

    act(() => emit!({ path: PATH, content: STALE_FILE, viaPlugin: true, bodyHash: landed })); // …waiting
    act(() => emit!({ path: PATH, content: LANDED })); // a file-backed edit lands meanwhile
    await waitFor(() => expect(document.body.textContent).toContain("The text the gate landed"));

    text = IN_BINDING; // what the older wait was waiting for turns up
    await new Promise((r) => setTimeout(r, 300));
    expect(document.body.textContent).toContain("The text the gate landed"); // the newer edit stands
    expect(document.body.textContent).not.toContain("as the shared document holds it");
  });

  it("an edit announced while this editor is still loading is adopted once it has loaded", async () => {
    // Every plugin re-activation re-mounts the editor, and an event can arrive before that
    // mount's load resolves. Load then installs the document it was handed — from the file — so
    // the edit has to be adopted AFTER it, and must not be dropped because load moved on.
    bind(IN_BINDING);
    const release = await mountHeld();
    const landed = (await sha256Hex(parse(IN_BINDING).body))!;

    act(() => emit!({ path: PATH, content: STALE_FILE, viaPlugin: true, bodyHash: landed }));
    await new Promise((r) => setTimeout(r, 150));
    release();

    await waitFor(() => expect(document.body.textContent).toContain("as the shared document holds it"));
  });

  /** Mount with the host's load() held open, to stand inside it. */
  async function mountHeld(): Promise<() => void> {
    const api = (window as unknown as { api: { load: () => Promise<unknown> } }).api;
    const realLoad = api.load.bind(api);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    api.load = async () => (await held, realLoad());
    const { App } = await import("../src/App");
    render(<App />);
    await waitFor(() => expect(emit).toBeTruthy());
    return release;
  }

  it("…also when the host did not say what landed: nothing is read ahead of the load", async () => {
    // An immediate read here was adopted and then replaced by load, with the file's copy.
    bind(IN_BINDING);
    const release = await mountHeld();

    act(() => emit!({ path: PATH, content: STALE_FILE, viaPlugin: true }));
    await new Promise((r) => setTimeout(r, 50));
    release();

    await waitFor(() => expect(document.body.textContent).toContain("as the shared document holds it"));
  });

  it("a wait does not outlive its binding", async () => {
    let text = DOC;
    const first = bind(DOC);
    first.getText.mockImplementation(() => text);
    await mount();
    const landed = (await sha256Hex(parse(IN_BINDING).body))!;

    act(() => emit!({ path: PATH, content: STALE_FILE, viaPlugin: true, bodyHash: landed })); // …waiting on `first`
    bind(DOC); // the editor is re-bound (another document's plugin took over)
    text = IN_BINDING; // and the old binding then receives what the wait wanted
    await new Promise((r) => setTimeout(r, 300));

    expect(document.body.textContent).toContain("The original body.");
    expect(document.body.textContent).not.toContain("agent updated the document");
  });

  it("an edit announced for one document is not adopted into another that loads instead", async () => {
    // Before load this editor has no path of its own to compare against, so the EVENT's path is
    // what the wait is for — and the document that then loads is a different one.
    bind(IN_BINDING);
    const release = await mountHeld();
    const landed = (await sha256Hex(parse(IN_BINDING).body))!;

    act(() => emit!({ path: "/another/document.plan.md", content: STALE_FILE, viaPlugin: true, bodyHash: landed }));
    release();
    await waitFor(() => expect(document.body.textContent).toContain("The original body."));
    await new Promise((r) => setTimeout(r, 300));

    expect(document.body.textContent).not.toContain("as the shared document holds it");
  });

  it("a navigation ends a wait for the document being left", async () => {
    let text = DOC;
    const binding = bind(DOC);
    binding.getText.mockImplementation(() => text);
    await mount();
    const landed = (await sha256Hex(parse(IN_BINDING).body))!;

    act(() => emit!({ path: PATH, content: STALE_FILE, viaPlugin: true, bodyHash: landed })); // …waiting
    act(() => host.agent.navigate("# Next\n\nThe document navigated to.\n\n<!--inplan v1\n[]\n-->\n", PATH)); // away and back between two polls: same path, new document
    await waitFor(() => expect(document.body.textContent).toContain("The document navigated to."));
    text = IN_BINDING;
    await new Promise((r) => setTimeout(r, 300));

    expect(document.body.textContent).toContain("The document navigated to.");
    expect(document.body.textContent).not.toContain("as the shared document holds it");
  });

  it("a load overtaken by a navigation does not leave the editor on its loading screen", async () => {
    const release = await mountHeld();
    act(() => host.agent.navigate("# Next\n\nThe document navigated to.\n\n<!--inplan v1\n[]\n-->\n"));
    release();

    await waitFor(() => expect(document.body.textContent).toContain("The document navigated to."));
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

describe("the in-memory host", () => {
  it("announces an external change under the document it is on, also after a navigation", async () => {
    // The editor ignores an external change for another document. A host that kept announcing
    // changes under its FIRST document's path would have every change after a navigation dropped.
    document.body.innerHTML = '<div id="root"></div>';
    const session = createMemoryApi({ content: DOC });
    (window as unknown as { api: unknown }).api = session.api;
    const { App } = await import("../src/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("The original body."));

    act(() => session.agent.navigate("# Next\n\nThe document navigated to.\n\n<!--inplan v1\n[]\n-->\n"));
    await waitFor(() => expect(document.body.textContent).toContain("The document navigated to."));
    act(() => session.agent.externalChange(LANDED));

    await waitFor(() => expect(document.body.textContent).toContain("The text the gate landed"));
  });
});
