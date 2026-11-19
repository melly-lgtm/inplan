// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// An agent edit that LANDS arrives as an external change. Live fill (CLI) means that now happens
// while the human may be typing, which it never did before — landings used to fall on turn
// boundaries. Replacing the buffer deletes keystrokes that exist in no other copy; keeping it
// wholesale drops what the agent just wrote, and the agent writes QUESTIONS. Comments cannot
// conflict with prose, so they are taken and the body is left alone.

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

const COMMENT = JSON.stringify([
  { id: "cmt-q1", author: "Agent <a@b>", date: "2026-01-01T00:00:00Z", resolved: false, text: "Which datastore should this use?" },
]);
const DOC = "# Plan\n\nThe original body.\n\n<!--inplan v1\n[]\n-->\n";
/** The agent asks a question: a comment-only landing, the case that motivates all of this. */
const ASKED = `# Plan\n\nThe original body.\n\n<!--inplan v1\n${COMMENT}\n-->\n`;
/** …and one that also rewrites the body. */
const ASKED_AND_REWROTE = `# Plan\n\nThe agent's rewritten body.\n\n<!--inplan v1\n${COMMENT}\n-->\n`;
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

async function mountAndType() {
  const { App } = await import("../src/App");
  render(<App />);
  await waitFor(() => expect(document.body.textContent).toContain("The original body."));
  await act(async () => {
    screen.getByRole("button", { name: /^Source$/ }).click(); // mount the stub, capture onChange
  });
  await waitFor(() => expect(emitEdit).toBeTruthy());
  await act(async () => {
    emitEdit?.(MINE); // typed, NOT saved
  });
  expect(document.body.textContent).toContain("unsaved");
}

describe("an agent edit landing on an unsaved buffer", () => {
  it("takes the agent's question, and leaves the human's sentence alone", async () => {
    await mountAndType();

    await act(async () => {
      agent.externalChange(ASKED);
    });

    expect(document.body.textContent).toContain("The agent left a comment"); // said, not silent
    await act(async () => {
      screen.getByRole("button", { name: /^Comments$/ }).click(); // the rail renders on its own tab
    });
    expect(document.body.textContent).toContain("Which datastore should this use?"); // it is really there
    expect(document.body.textContent).toContain("The human's own sentence"); // untouched
    expect(document.body.textContent).toContain("unsaved"); // still theirs to save
  });

  it("keeps the human's body when the agent rewrote it too, and says so", async () => {
    await mountAndType();

    await act(async () => {
      agent.externalChange(ASKED_AND_REWROTE);
    });

    expect(document.body.textContent).toContain("changed the body"); // and says the body is not shown
    expect(document.body.textContent).toContain("The human's own sentence");
    await act(async () => {
      screen.getByRole("button", { name: /^Comments$/ }).click();
    });
    expect(document.body.textContent).toContain("Which datastore should this use?"); // the question still arrives
    expect(document.body.textContent).not.toContain("The agent's rewritten body."); // not shown: see #131
  });

  it("takes the agent's edit outright when the buffer is clean — the normal case is unchanged", async () => {
    const { App } = await import("../src/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("The original body."));

    await act(async () => {
      agent.externalChange(ASKED_AND_REWROTE);
    });

    await waitFor(() => expect(document.body.textContent).toContain("The agent's rewritten body."));
  });
});
