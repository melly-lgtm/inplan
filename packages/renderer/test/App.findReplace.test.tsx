// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// App-level integration tests for the find & replace bar against the real
// <App/> with a memory-backed window.api. Opens the bar with ⌘F, asserts the
// N/M match count, exercises next/prev navigation, and performs a Replace All
// in Replace mode to confirm the document body changes.
//
// SourceEditor (CodeMirror) is stubbed — it needs layout APIs happy-dom only
// stubs, and the find/replace flow under test lives in App, not the editor.

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { forwardRef, useImperativeHandle } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryApi, type MemoryAgent } from "../src/memoryApi";

vi.mock("../src/SourceEditor", () => ({
  SourceEditor: forwardRef(function SourceEditorStub(_props: unknown, ref: React.Ref<unknown>) {
    useImperativeHandle(ref, () => ({ scrollToLine() {}, selectRange() {} }));
    return null;
  }),
}));

// "alpha" appears 3 times in the body.
const DOC = "# Plan\n\nalpha beta alpha gamma alpha delta.\n\n<!--inplan v1\n[]\n-->\n";
let agent: MemoryAgent;

function mount(content: string) {
  document.body.innerHTML = '<div id="root"></div>';
  const session = createMemoryApi({ content });
  (window as unknown as { api: unknown }).api = session.api;
  agent = session.agent;
}

beforeEach(() => mount(DOC));
afterEach(cleanup);

async function openFindBar() {
  const { App } = await import("../src/App");
  render(<App />);
  await waitFor(() => expect(document.body.textContent).toContain("alpha beta alpha"));
  expect(screen.queryByPlaceholderText(/Find/)).toBeNull();
  fireEvent.keyDown(document.body, { key: "f", metaKey: true });
  const input = await waitFor(() => screen.getByPlaceholderText("Find…"));
  return input;
}

describe("App find & replace (memory-backed)", () => {
  it("shows the N/M match count for a query in the body", async () => {
    const input = await openFindBar();

    await act(async () => {
      fireEvent.change(input, { target: { value: "alpha" } });
    });

    // Three matches, currently on the first.
    await waitFor(() => expect(document.body.textContent).toContain("1/3"));
  });

  it("advances the current-match index with Find Next / Find Prev", async () => {
    const input = await openFindBar();

    await act(async () => {
      fireEvent.change(input, { target: { value: "alpha" } });
    });
    await waitFor(() => expect(document.body.textContent).toContain("1/3"));

    const next = screen.getByRole("button", { name: /^find next$/i });
    const prev = screen.getByRole("button", { name: /^find prev$/i });

    await act(async () => {
      next.click();
    });
    await waitFor(() => expect(document.body.textContent).toContain("2/3"));

    await act(async () => {
      next.click();
    });
    await waitFor(() => expect(document.body.textContent).toContain("3/3"));

    await act(async () => {
      prev.click();
    });
    await waitFor(() => expect(document.body.textContent).toContain("2/3"));
  });

  it("Replace All in Replace mode rewrites every match in the body", async () => {
    const input = await openFindBar();

    await act(async () => {
      fireEvent.change(input, { target: { value: "alpha" } });
    });
    await waitFor(() => expect(document.body.textContent).toContain("1/3"));

    // Toggle Replace mode on via the Replace checkbox.
    const replaceToggle = screen.getByRole("checkbox", { name: /replace/i });
    await act(async () => {
      fireEvent.click(replaceToggle);
    });

    const replaceInput = await waitFor(() => screen.getByPlaceholderText("Replace…"));
    await act(async () => {
      fireEvent.change(replaceInput, { target: { value: "omega" } });
    });

    const replaceAll = screen.getByRole("button", { name: /^replace all$/i });
    await act(async () => {
      replaceAll.click();
    });

    // Every "alpha" in the body became "omega".
    await waitFor(() => expect(document.body.textContent).toContain("omega beta omega gamma omega delta"));
    expect(document.body.textContent).not.toContain("alpha beta");
  });
});
