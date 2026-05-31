// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// App-level test for answering a question comment (FR4): mount the real <App/>
// with a memory-backed window.api over a doc whose data block carries a comment
// with a structured `question` (choices). The rail renders QuestionChips; pick a
// choice and click Answer; an answer reply carrying the selected label(s) appears
// in the thread. Covers both multiple-choice (radio) and multi-select (checkbox).
//
// SourceEditor (CodeMirror) is stubbed — it needs layout APIs happy-dom only stubs.

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { forwardRef, useImperativeHandle } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryApi, type MemoryAgent } from "../src/renderer/memoryApi";

vi.mock("../src/renderer/SourceEditor", () => ({
  SourceEditor: forwardRef(function SourceEditorStub(_props: unknown, ref: React.Ref<unknown>) {
    useImperativeHandle(ref, () => ({ scrollToLine() {}, selectRange() {} }));
    return null;
  }),
}));

// A doc-level comment carrying a multiple-choice question.
const SINGLE_DOC =
  "# Plan\n\nPick a database.\n\n<!--inplan v1\n" +
  JSON.stringify([
    {
      id: "cmt-q1",
      anchor: "doc",
      author: "Agent <agent@inplan>",
      date: "2026-05-30T10:00:00Z",
      resolved: false,
      text: "Which database for v1?",
      question: {
        multiSelect: false,
        choices: [
          { label: "Postgres", description: "battle-tested" },
          { label: "SQLite", description: "zero-config" },
        ],
      },
    },
  ]) +
  "\n-->\n";

// A doc-level comment carrying a multi-select question.
const MULTI_DOC =
  "# Plan\n\nPick features.\n\n<!--inplan v1\n" +
  JSON.stringify([
    {
      id: "cmt-q2",
      anchor: "doc",
      author: "Agent <agent@inplan>",
      date: "2026-05-30T10:00:00Z",
      resolved: false,
      text: "Which integrations do we need?",
      question: {
        multiSelect: true,
        choices: [{ label: "Slack" }, { label: "GitHub" }, { label: "Linear" }],
      },
    },
  ]) +
  "\n-->\n";

let agent: MemoryAgent;

function mount(content: string) {
  document.body.innerHTML = '<div id="root"></div>';
  const session = createMemoryApi({ content });
  (window as unknown as { api: unknown }).api = session.api;
  agent = session.agent;
}
afterEach(cleanup);

describe("App choice answer flow (memory-backed)", () => {
  it("renders the question's choice chips in the rail", async () => {
    mount(SINGLE_DOC);
    const { App } = await import("../src/renderer/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("Which database for v1?"));

    // Both choice labels (and their descriptions) render as chips.
    expect(document.body.textContent).toContain("Postgres");
    expect(document.body.textContent).toContain("battle-tested");
    expect(document.body.textContent).toContain("SQLite");
    expect(document.body.textContent).toContain("zero-config");
    // Two radio inputs (multiple choice) plus the Answer button.
    expect(document.querySelectorAll('.ap-question input[type="radio"]').length).toBe(2);
    expect(screen.getByRole("button", { name: /^answer$/i })).toBeTruthy();
  });

  it("multiple-choice: pick a radio and Answer posts a reply carrying the label", async () => {
    mount(SINGLE_DOC);
    const { App } = await import("../src/renderer/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("Which database for v1?"));

    const answer = screen.getByRole("button", { name: /^answer$/i }) as HTMLButtonElement;
    // Answer is disabled until something is selected.
    expect(answer.disabled).toBe(true);

    const radios = document.querySelectorAll('.ap-question input[type="radio"]');
    await act(async () => {
      fireEvent.click(radios[1]); // SQLite
    });
    expect(answer.disabled).toBe(false);

    await act(async () => {
      answer.click();
    });

    // An answer reply carrying the selected label appears in the thread.
    await waitFor(() => expect(document.body.textContent).toContain("▶ SQLite"));
    // The picked label is not the other choice.
    expect(document.body.textContent).not.toContain("▶ Postgres");
  });

  it("multi-select: pick two checkboxes and Answer posts both labels", async () => {
    mount(MULTI_DOC);
    const { App } = await import("../src/renderer/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("Which integrations do we need?"));

    const checks = document.querySelectorAll('.ap-question input[type="checkbox"]');
    expect(checks.length).toBe(3);

    await act(async () => {
      fireEvent.click(checks[0]); // Slack
      fireEvent.click(checks[2]); // Linear
    });

    const answer = screen.getByRole("button", { name: /^answer$/i }) as HTMLButtonElement;
    expect(answer.disabled).toBe(false);
    await act(async () => {
      answer.click();
    });

    // The answer reply joins the selected labels in order.
    await waitFor(() => expect(document.body.textContent).toContain("▶ Slack, Linear"));
  });
});
