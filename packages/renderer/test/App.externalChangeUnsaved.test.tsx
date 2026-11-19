// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// An agent edit that LANDS arrives here as an external change. Until live fill (CLI) that only
// happened at a turn boundary, with the human either locked or idle; now the agent's first fill of
// a new document lands while the human may be typing into it. Replacing the buffer wholesale
// deleted those keystrokes — they exist in no other copy, while the incoming text is already on
// disk. This pins the rebase that keeps both.

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

const BODY = "# Plan\n\nIntro paragraph.\n\n## Section A\n\nAlpha.\n\n## Section B\n\nBeta.\n";
const DOC = `${BODY}\n<!--inplan v1\n[]\n-->\n`;
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

describe("an agent edit landing on an unsaved buffer", () => {
  async function mountWithUnsavedEdit(humanBody: string) {
    const { App } = await import("../src/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("Intro paragraph."));
    await act(async () => {
      screen.getByRole("button", { name: /^Source$/ }).click(); // mount the stub, capture onChange
    });
    await waitFor(() => expect(emitEdit).toBeTruthy());
    await act(async () => {
      emitEdit?.(humanBody); // the human types, and does NOT save
    });
    expect(document.body.textContent).toContain("unsaved");
  }

  it("never deletes the human's unsaved text, even where the two edits collide", async () => {
    // Both appended at the same point — a genuine conflict. merge3 hands contested regions to its
    // third argument, and the human's buffer goes there because it is the only copy that is not
    // already on disk: the agent's paragraph is in the canonical either way, a keystroke is not.
    await mountWithUnsavedEdit(`${BODY}\n## Section C\n\nThe human's own sentence, not yet saved.\n`);

    await act(async () => {
      // The agent appends at the very point the human is typing into.
      agent.externalChange(`${BODY}\n## Section C\n\nThe agent's landed paragraph.\n\n<!--inplan v1\n[]\n-->\n`);
    });

    expect(document.body.textContent).toContain("The human's own sentence");
    expect(document.body.textContent).toContain("unsaved"); // still theirs to save
  });

  it("takes the agent's edit when it does not collide with what the human is writing", async () => {
    // The useful half: an agent editing elsewhere in the document shows up live, and the human's
    // in-progress paragraph rides along untouched. ("Elsewhere" is merge3's granularity — it
    // resolves by change block, so edits in the same block are the collision case above.)
    await mountWithUnsavedEdit(`${BODY}\n## Section C\n\nThe human's own sentence, not yet saved.\n`);

    await act(async () => {
      // The agent rewrites the intro, well away from the section the human is appending.
      agent.externalChange(`${BODY.replace("Intro paragraph.", "Intro paragraph, rewritten by the agent.")}\n<!--inplan v1\n[]\n-->\n`);
    });

    await waitFor(() => expect(document.body.textContent).toContain("rewritten by the agent"));
    expect(document.body.textContent).toContain("The human's own sentence");
  });
});
