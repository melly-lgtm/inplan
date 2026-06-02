// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// App-level autosave / dirty-indicator / Save tests against the real <App/> with
// a memory-backed window.api. Covers the debounced autosave effect (Turn ⇒ a
// backup save after ~1500ms; Instant ⇒ a canonical save after ~5000ms that
// clears the dirty flag), the "· unsaved" status-bar indicator, and the manual
// Save button (saveNow: backup checkpoint in Turn, canonical "saved" in Instant).
//
// The doc is marked dirty through the SourceEditor's onChange — which CodeMirror
// drives in the real app. SourceEditor is stubbed (it needs layout APIs happy-dom
// only stubs), so the stub forwards the latest onChange to a module-level holder
// the test calls directly to simulate an in-editor body edit.

import { LogEventType } from "@inplan/core";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { forwardRef, useImperativeHandle } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryApi, type MemoryAgent } from "../src/memoryApi";

// The latest onChange handed to the stubbed SourceEditor. Calling it simulates a
// CodeMirror body edit, which App turns into a dirty doc (App.tsx onChange).
let emitEdit: ((body: string) => void) | null = null;

vi.mock("../src/SourceEditor", () => ({
  SourceEditor: forwardRef(function SourceEditorStub(
    props: { onChange?: (body: string) => void },
    ref: React.Ref<unknown>,
  ) {
    emitEdit = props.onChange ?? null;
    useImperativeHandle(ref, () => ({ scrollToLine() {}, selectRange() {} }));
    return null;
  }),
}));

const DOC = "# Plan\n\nOriginal body.\n\n<!--inplan v1\n[]\n-->\n";
let agent: MemoryAgent;

function mount(content: string) {
  // App persists cadence/panes to localStorage; clear it so each test boots into
  // the default Turn mode rather than inheriting a prior test's Instant mode.
  localStorage.clear();
  document.body.innerHTML = '<div id="root"></div>';
  const session = createMemoryApi({ content });
  (window as unknown as { api: unknown }).api = session.api;
  agent = session.agent;
}

afterEach(() => {
  cleanup();
  emitEdit = null;
  vi.useRealTimers();
});

async function mountApp(content: string) {
  mount(content);
  const { App } = await import("../src/App");
  render(<App />);
  await waitFor(() => expect(document.body.textContent).toContain("Original body."));
  // Reveal the Source pane so the (stubbed) SourceEditor mounts and hands us its
  // onChange — panes default to 2 with the Comments tab active.
  await act(async () => {
    screen.getByRole("button", { name: /^Source$/ }).click();
  });
  await waitFor(() => expect(emitEdit).toBeTruthy());
}

/** Drive an in-editor body edit through the stubbed SourceEditor's onChange. */
async function editBody(body: string) {
  await act(async () => {
    emitEdit?.(body);
  });
}

describe("App autosave / dirty / Save (memory-backed)", () => {
  it("Turn mode: a dirty edit autosaves a BACKUP after ~1500ms and keeps the unsaved indicator", async () => {
    await mountApp(DOC);
    vi.useFakeTimers();

    // Editing in Turn mode marks the doc dirty → the "· unsaved" indicator shows.
    await editBody("# Plan\n\nEdited body.\n\n<!--inplan v1\n[]\n-->\n");
    expect(document.body.textContent).toContain("unsaved");

    const saveSpy = vi.spyOn(window.api, "save");

    // Before the debounce elapses nothing has saved.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(saveSpy).not.toHaveBeenCalled();

    // Past the 1500ms Turn debounce: a backup checkpoint save fires.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(700);
    });
    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy.mock.calls[0][1]).toEqual({ kind: "backup", cadence: "turn" });
    expect(document.body.textContent).toContain("autosaved (backup)");

    // A backup leaves the doc dirty (only canonical saves clear it), so the
    // unsaved indicator persists and the agent log got no turn-ending event.
    expect(document.body.textContent).toContain("unsaved");
    const log = await agent.log();
    expect(log.some((e) => e.type === LogEventType.TurnEnded || e.type === LogEventType.DocumentEdited)).toBe(false);
  });

  it("Turn mode: rapid edits debounce to a single backup autosave", async () => {
    await mountApp(DOC);
    vi.useFakeTimers();

    const saveSpy = vi.spyOn(window.api, "save");

    await editBody("# Plan\n\nEdit one.\n\n<!--inplan v1\n[]\n-->\n");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000); // not yet past the debounce
    });
    await editBody("# Plan\n\nEdit two.\n\n<!--inplan v1\n[]\n-->\n"); // resets the timer
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(saveSpy).not.toHaveBeenCalled(); // first timer was cleared

    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy.mock.calls[0][0]).toContain("Edit two.");
  });

  it("Instant mode: a dirty edit autosaves CANONICAL after ~5000ms, clears dirty and logs the edit", async () => {
    await mountApp(DOC);
    vi.useFakeTimers();

    // Switch to Instant mode via the toolbar.
    await act(async () => {
      screen.getByRole("button", { name: /^Instant$/ }).click();
    });

    const saveSpy = vi.spyOn(window.api, "save");
    await editBody("# Plan\n\nInstant edit.\n\n<!--inplan v1\n[]\n-->\n");
    expect(document.body.textContent).toContain("unsaved");

    // The Turn debounce (1500ms) is NOT enough in Instant mode.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500);
    });
    expect(saveSpy).not.toHaveBeenCalled();

    // Past the 5000ms Instant debounce: a canonical save fires and clears dirty.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3600);
    });
    expect(saveSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy.mock.calls[0][1]).toEqual({ kind: "canonical", cadence: "instant" });
    expect(document.body.textContent).toContain("auto-saving…");

    // Canonical autosave clears the dirty flag → no "· unsaved" indicator.
    expect(document.body.textContent).not.toContain("unsaved");

    // The canonical Instant save woke the agent: a user document_edited landed.
    const log = await agent.log();
    expect(log.some((e) => e.actor === "user" && e.type === LogEventType.DocumentEdited)).toBe(true);
  });

  it("manual Save: Turn writes a backup checkpoint (dirty stays); Instant writes canonical (dirty clears)", async () => {
    await mountApp(DOC);
    vi.useFakeTimers();

    // Make the doc dirty; the Save button shows its dirty bullet.
    await editBody("# Plan\n\nManual save body.\n\n<!--inplan v1\n[]\n-->\n");
    expect(document.body.textContent).toContain("unsaved");
    const saveBtn = () => screen.getByRole("button", { name: /^Save/ });
    expect(saveBtn().querySelector(".ap-dirty")).toBeTruthy(); // dirty dot on the Save icon

    const saveSpy = vi.spyOn(window.api, "save");

    // Turn mode manual Save → backup checkpoint; dirty (and the bullet) persists.
    await act(async () => {
      saveBtn().click();
    });
    expect(saveSpy).toHaveBeenLastCalledWith(expect.any(String), { kind: "backup", cadence: "turn" });
    expect(document.body.textContent).toContain("checkpoint saved");
    expect(document.body.textContent).toContain("unsaved");
    expect(saveBtn().querySelector(".ap-dirty")).toBeTruthy(); // still dirty after a backup

    // Switch to Instant and Save again → canonical save clears dirty.
    await act(async () => {
      screen.getByRole("button", { name: /^Instant$/ }).click();
    });
    await act(async () => {
      saveBtn().click();
    });
    expect(saveSpy).toHaveBeenLastCalledWith(expect.any(String), { kind: "canonical", cadence: "instant" });
    expect(document.body.textContent).toContain("saved");
    expect(document.body.textContent).not.toContain("unsaved");
    expect(saveBtn().querySelector(".ap-dirty")).toBeNull(); // canonical save cleared the dirty dot
  });
});
