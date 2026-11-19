// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// An agent edit that LANDS arrives here as an external change. Before live fill (CLI) that only
// happened at a turn boundary, with the human either locked or idle; now the first fill of a new
// document lands while the human may be typing into it. Replacing the buffer deletes those
// keystrokes, which exist in no other copy — while the incoming text is already on disk.

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { forwardRef, useImperativeHandle } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryApi, type MemoryAgent } from "../src/memoryApi";

/** The latest onChange handed to the stubbed SourceEditor: calling it is a human keystroke. */
let emitEdit: ((body: string) => void) | null = null;

vi.mock("../src/SourceEditor", () => ({
  SourceEditor: forwardRef(function SourceEditorStub(props: { onChange?: (body: string) => void }, ref: React.Ref<unknown>) {
    emitEdit = props.onChange ?? null;
    useImperativeHandle(ref, () => ({ scrollToLine() {}, selectRange() {} }));
    return null;
  }),
}));

const DOC = "# Plan\n\nThe original body.\n\n<!--inplan v1\n[]\n-->\n";
const AGENT = "# Plan\n\nThe agent's landed revision.\n\n<!--inplan v1\n[]\n-->\n";
let agent: MemoryAgent;

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '<div id="root"></div>';
  const session = createMemoryApi({ content: DOC });
  (window as unknown as { api: unknown }).api = session.api;
  agent = session.agent;
});
afterEach(() => {
  cleanup();
  emitEdit = null;
});

async function mount() {
  const { App } = await import("../src/App");
  render(<App />);
  await waitFor(() => expect(document.body.textContent).toContain("The original body."));
  await act(async () => {
    screen.getByRole("button", { name: /^Source$/ }).click(); // mount the stub, capture onChange
  });
  await waitFor(() => expect(emitEdit).toBeTruthy());
}

describe("an agent edit landing on an unsaved buffer", () => {
  it("keeps the human's unsaved text, and says the document changed underneath", async () => {
    await mount();
    await act(async () => {
      emitEdit?.("# Plan\n\nThe human's own sentence, not yet saved.\n"); // typed, NOT saved
    });
    expect(document.body.textContent).toContain("unsaved");

    await act(async () => {
      agent.externalChange(AGENT);
    });

    expect(document.body.textContent).toContain("The human's own sentence"); // not deleted
    expect(document.body.textContent).not.toContain("The agent's landed revision."); // not shown yet, and on disk
    expect(document.body.textContent).toContain("unsaved"); // still theirs to save
  });

  it("takes the agent's edit when the buffer is clean — the normal case is unchanged", async () => {
    await mount();

    await act(async () => {
      agent.externalChange(AGENT);
    });

    await waitFor(() => expect(document.body.textContent).toContain("The agent's landed revision."));
  });
});
