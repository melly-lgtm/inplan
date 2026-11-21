// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// When an agent created the document and its first draft is still to come, the editor says so in
// a dismissible banner instead of showing a bare empty page that reads as a broken load. It never
// blocks: the human can close it or simply start writing, and it goes for good once the body has
// anything in it.

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { forwardRef, useImperativeHandle } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryApi } from "../src/memoryApi";
import type { DocPayload } from "../src/api";

let typeIntoSource: ((text: string) => void) | null = null;
vi.mock("../src/SourceEditor", () => ({
  SourceEditor: forwardRef(function SourceEditorStub(props: { onChange: (v: string) => void }, ref: React.Ref<unknown>) {
    useImperativeHandle(ref, () => ({ scrollToLine() {}, selectRange() {} }));
    typeIntoSource = props.onChange;
    return null;
  }),
}));

afterEach(() => {
  cleanup();
  typeIntoSource = null;
});

const BANNER = /Opus 5\.5 may be writing the first draft/;

function mount(content: string, draftPending?: { model: string }) {
  document.body.innerHTML = '<div id="root"></div>';
  const mem = createMemoryApi({ content });
  const load = mem.api.load.bind(mem.api);
  mem.api.load = async (): Promise<DocPayload> => ({ ...(await load()), ...(draftPending ? { draftPending } : {}) });
  (window as unknown as { api: unknown }).api = mem.api;
  return mem;
}

async function renderApp(): Promise<void> {
  const { App } = await import("../src/App");
  render(<App />);
  await waitFor(() => expect(screen.queryByText(/Loading/)).toBeNull());
}

describe("the 'agent may be writing the first draft' banner", () => {
  it("shows on an empty document the agent created, naming its model", async () => {
    mount("", { model: "Opus 5.5" });
    await renderApp();
    expect(screen.getByText(BANNER)).toBeTruthy();
  });

  it("is never shown for a document no agent created, nor once it has content", async () => {
    mount("");
    await renderApp();
    expect(screen.queryByText(BANNER)).toBeNull();
    cleanup();

    mount("# Already written\n\nBody.\n", { model: "Opus 5.5" });
    await renderApp();
    expect(screen.queryByText(BANNER)).toBeNull();
  });

  it("closes on dismiss", async () => {
    mount("", { model: "Opus 5.5" });
    await renderApp();
    fireEvent.click(screen.getByRole("button", { name: "dismiss" }));
    expect(screen.queryByText(BANNER)).toBeNull();
  });

  it("goes for good once the human starts writing — clearing the page again does not bring it back", async () => {
    mount("", { model: "Opus 5.5" });
    await renderApp();
    // The source pane may not be mounted in the default layout; open it if so.
    if (!typeIntoSource) fireEvent.click(screen.getAllByRole("button", { name: /source/i })[0]!);
    await waitFor(() => expect(typeIntoSource).not.toBeNull());
    act(() => typeIntoSource!("# My own plan"));
    expect(screen.queryByText(BANNER)).toBeNull();
    act(() => typeIntoSource!(""));
    expect(screen.queryByText(BANNER)).toBeNull();
  });

  it("goes when the agent's draft lands", async () => {
    const mem = mount("", { model: "Opus 5.5" });
    await renderApp();
    expect(screen.getByText(BANNER)).toBeTruthy();
    await act(async () => mem.agent.externalChange("# The plan\n\nDrafted by the agent.\n"));
    await waitFor(() => expect(document.body.textContent).toContain("Drafted by the agent."));
    expect(screen.queryByText(BANNER)).toBeNull();
  });
});
