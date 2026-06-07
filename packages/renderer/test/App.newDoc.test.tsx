// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Create Doc / Move Text to New Doc: the context items appear only with a selection + a host
// that can create docs; choosing one opens the modal, the host create() runs, and the selection
// becomes a link. happy-dom can't make a real selection, so window.getSelection is mocked.

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { forwardRef, useImperativeHandle } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryApi } from "../src/memoryApi";

vi.mock("../src/SourceEditor", () => ({
  SourceEditor: forwardRef(function SourceEditorStub(_props: unknown, ref: React.Ref<unknown>) {
    useImperativeHandle(ref, () => ({ scrollToLine() {}, selectRange() {} }));
    return null;
  }),
}));

const DOC = "# Plan\n\nHello world.\n\n<!--inplan v1\n[]\n-->\n";
let create: ReturnType<typeof vi.fn>;
let origGetSelection: typeof window.getSelection;

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>';
  const session = createMemoryApi({ content: DOC });
  create = vi.fn(async (path: string) => ({ linkTarget: path }));
  (session.api as unknown as { newDoc: unknown }).newDoc = { pickPath: vi.fn(async () => null), create };
  (window as unknown as { api: unknown }).api = session.api;
  origGetSelection = window.getSelection;
});
afterEach(() => {
  window.getSelection = origGetSelection;
  cleanup();
});

function mockSelection(text: string) {
  const range = { cloneRange: () => range, getBoundingClientRect: () => ({ left: 0, bottom: 0, top: 0, right: 0, width: 0, height: 0 }) } as unknown as Range;
  window.getSelection = (() => ({ toString: () => text, rangeCount: 1, getRangeAt: () => range, removeAllRanges() {}, addRange() {} })) as unknown as typeof window.getSelection;
}

async function mountApp() {
  const { App } = await import("../src/App");
  render(<App />);
  await waitFor(() => expect(document.body.textContent).toContain("Hello world."));
}

describe("new-doc actions", () => {
  it("offers Create Doc / Move Text to New Doc only with a selection + a host that can create", async () => {
    await mountApp();
    mockSelection("Hello world.");
    await act(async () => void fireEvent.contextMenu(document.querySelector(".ap-rendered")!));
    expect(screen.getByRole("menuitem", { name: /create doc/i })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /move text to new doc/i })).toBeTruthy();
  });

  it("Create Doc: opens the modal, calls host.create, and links the selection in place", async () => {
    await mountApp();
    mockSelection("Hello world.");
    await act(async () => void fireEvent.contextMenu(document.querySelector(".ap-rendered")!));
    await act(async () => void screen.getByRole("menuitem", { name: /create doc/i }).click());
    // Modal: title + filename pre-filled from the selection.
    const path = (await screen.findByDisplayValue("hello_world.md")) as HTMLInputElement;
    expect(path).toBeTruthy();
    await act(async () => void screen.getByRole("button", { name: /^create$/i }).click());
    await waitFor(() => expect(create).toHaveBeenCalledWith("hello_world.md", expect.stringContaining("# Hello world.")));
    // The selection turned into a link to the new doc.
    await waitFor(() => expect(document.querySelector(".ap-rendered a")).toBeTruthy());
  });

  it("does not create a file when the selection can't be linked (no orphans)", async () => {
    await mountApp();
    mockSelection("text that is not in the body"); // unlocatable → not linkable
    await act(async () => void fireEvent.contextMenu(document.querySelector(".ap-rendered")!));
    await act(async () => void screen.getByRole("menuitem", { name: /create doc/i }).click());
    await act(async () => void (await screen.findByRole("button", { name: /^create$/i })).click());
    expect(create).not.toHaveBeenCalled(); // pre-check bailed before touching the host
    expect(screen.getByRole("button", { name: /^create$/i })).toBeTruthy(); // modal stays open
  });
});
