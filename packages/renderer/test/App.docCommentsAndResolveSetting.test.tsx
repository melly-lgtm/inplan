// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// App-level integration tests against the real <App/> with a memory-backed
// window.api, covering two slices the other suites skip:
//   1. The comment rail groups a document-level comment ("Document" section)
//      ahead of an anchored span comment ("Anchored" section).
//   2. The auto-resolve setting is loaded from window.api.getSettings() on mount
//      and round-trips through the Settings menu: toggling it persists via
//      setSettings and logs a settings_changed control event.
//
// SourceEditor (CodeMirror) is stubbed — it needs layout APIs happy-dom only
// stubs, and none of the behavior under test lives in the editor.

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { forwardRef, useImperativeHandle } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryApi, type MemoryAgent } from "../src/memoryApi";
import type { Settings } from "../src/api";

vi.mock("../src/SourceEditor", () => ({
  SourceEditor: forwardRef(function SourceEditorStub(_props: unknown, ref: React.Ref<unknown>) {
    useImperativeHandle(ref, () => ({ scrollToLine() {}, selectRange() {} }));
    return null;
  }),
}));

// A document carrying BOTH a document-level comment (anchor: "doc", no body
// link) and a span comment (one in-body anchor link). The rail must group the
// doc comment first.
const DOC_WITH_BOTH =
  "# Plan\n\nUse [Postgres](#cmt-span01) for storage.\n\n<!--inplan v1\n" +
  JSON.stringify([
    { id: "cmt-doc001", author: "x", date: "d", resolved: false, text: "Overall this needs scope.", anchor: "doc" },
    { id: "cmt-span01", author: "x", date: "d", resolved: false, text: "Why not SQLite for v1?" },
  ]) +
  "\n-->\n";

let agent: MemoryAgent;
let getSettings: () => Promise<Settings>;

function mount(content: string, settings?: Settings) {
  document.body.innerHTML = '<div id="root"></div>';
  const session = createMemoryApi(settings ? { content, settings } : { content });
  (window as unknown as { api: typeof session.api }).api = session.api;
  agent = session.agent;
  getSettings = () => session.api.getSettings();
}
afterEach(cleanup);

describe("App doc-comment ordering + auto-resolve setting (memory-backed)", () => {
  it("groups a document-level comment before an anchored span comment in the rail", async () => {
    mount(DOC_WITH_BOTH);
    const { App } = await import("../src/App");
    render(<App />);

    await waitFor(() => expect(document.body.textContent).toContain("Overall this needs scope."));
    expect(document.body.textContent).toContain("Why not SQLite for v1?");

    // Both section titles render.
    const titles = Array.from(document.querySelectorAll(".ap-section-title")).map((el) => el.textContent);
    expect(titles).toEqual(["Document", "Anchored"]);

    // The Document section comes before the Anchored section, and the doc-level
    // comment text precedes the span comment text in DOM order.
    const body = document.body.textContent ?? "";
    expect(body.indexOf("Document")).toBeLessThan(body.indexOf("Anchored"));
    expect(body.indexOf("Overall this needs scope.")).toBeLessThan(body.indexOf("Why not SQLite for v1?"));
  });

  it("loads autoResolve=false from settings on mount (checkbox reflects it)", async () => {
    mount("# Plan\n\nbody text\n\n<!--inplan v1\n[]\n-->\n", { autoResolve: false });
    const { App } = await import("../src/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("body text"));

    // Open the Settings (gear) menu.
    fireEvent.click(screen.getByTitle("Settings"));
    await waitFor(() => expect(screen.getByText(/Agent auto-resolves a thread/i)).toBeTruthy());

    // The auto-resolve checkbox is the one inside the auto-resolve row.
    const row = screen.getByText(/Agent auto-resolves a thread/i).closest("label")!;
    const checkbox = row.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
  });

  it("toggling auto-resolve persists via setSettings and logs settings_changed", async () => {
    mount("# Plan\n\nbody text\n\n<!--inplan v1\n[]\n-->\n", { autoResolve: true });
    const { App } = await import("../src/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("body text"));

    fireEvent.click(screen.getByTitle("Settings"));
    const row = screen.getByText(/Agent auto-resolves a thread/i).closest("label")!;
    const checkbox = row.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);

    // Turn auto-resolve OFF.
    await act(async () => {
      fireEvent.click(checkbox);
    });
    await waitFor(() => expect((row.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(false));

    // Persisted to the settings store.
    expect((await getSettings()).autoResolve).toBe(false);

    // A settings_changed control event was logged with the new value.
    const entries = await agent.log();
    const settingsEvents = entries.filter((e) => e.type === "settings_changed");
    expect(settingsEvents.length).toBe(1);
    expect((settingsEvents[0]!.payload as Settings).autoResolve).toBe(false);

    // Turn it back ON — a second event is logged with autoResolve=true.
    await act(async () => {
      fireEvent.click(row.querySelector('input[type="checkbox"]') as HTMLInputElement);
    });
    await waitFor(async () => expect((await getSettings()).autoResolve).toBe(true));
    const after = (await agent.log()).filter((e) => e.type === "settings_changed");
    expect(after.length).toBe(2);
    expect((after[1]!.payload as Settings).autoResolve).toBe(true);
  });
});
