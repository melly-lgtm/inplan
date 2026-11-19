// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// An agent edit that LANDS arrives as an external change. Live fill (CLI) means that now happens
// while the human may be typing, which it never did before — landings used to fall on turn
// boundaries, when nobody was mid-sentence. Replacing the buffer deletes keystrokes that exist in
// no other copy; keeping the buffer drops the agent's version at the human's next save, unseen.
// So it arrives as a REVIEW against what is on screen, and the human decides.

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
const MINE = "# Plan\n\nThe human's own sentence, not yet saved.\n";
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

/** Type without saving, then have an agent edit land on top of it. */
async function collide() {
  await mount();
  await act(async () => {
    emitEdit?.(MINE);
  });
  expect(document.body.textContent).toContain("unsaved");
  await act(async () => {
    agent.externalChange(AGENT);
  });
  await waitFor(() => expect(document.body.textContent).toContain("Agent proposed changes"));
}

describe("an agent edit landing on an unsaved buffer", () => {
  it("opens a review instead of choosing for the human", async () => {
    await collide();
    // Their text is untouched while they decide, and the agent's version is in front of them.
    expect(document.body.textContent).toContain("The human's own sentence");
  });

  it("accepting takes the agent's version, and it stays unsaved work", async () => {
    await collide();
    expect(document.querySelector(".ap-tri--accept")).toBeTruthy(); // defaults to accept-all
    await act(async () => {
      screen.getByRole("button", { name: /^apply$/i }).click();
    });

    await waitFor(() => expect(document.body.textContent).not.toContain("Agent proposed changes"));
    expect(document.body.textContent).toContain("The agent's landed revision.");
    expect(document.body.textContent).toContain("unsaved"); // the human's to save, as it was
  });

  it("deciding settles nothing, because there is no proposal behind it", async () => {
    // A local review has no row: settling one would throw ("no pending proposal to settle") and
    // logging a decision would record one nobody made.
    await collide();
    const settle = vi.spyOn(window.api as { clearProposal: () => Promise<void> }, "clearProposal");
    await act(async () => {
      screen.getByRole("button", { name: /^apply$/i }).click();
    });
    await waitFor(() => expect(document.body.textContent).not.toContain("Agent proposed changes"));
    expect(settle).not.toHaveBeenCalled();
  });

  it("takes the agent's edit outright when the buffer is clean — the normal case is unchanged", async () => {
    await mount();
    await act(async () => {
      agent.externalChange(AGENT);
    });
    await waitFor(() => expect(document.body.textContent).toContain("The agent's landed revision."));
    expect(document.body.textContent).not.toContain("Agent proposed changes"); // no review needed
  });
});
