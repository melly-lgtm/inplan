// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// App-level integration tests for the ⚙ Settings menu (SettingsMenu) against the
// real <App/> with a memory-backed window.api. Covers opening the menu, toggling
// Agent-change acceptance between Auto-accept and Review (a mode_changed control
// event), and toggling the auto-resolve setting (a settings_changed event).
//
// SourceEditor (CodeMirror) is stubbed: it needs layout APIs happy-dom only
// stubs, and the settings flow under test lives in App, not the editor.

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { forwardRef, useImperativeHandle } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryApi, type MemoryAgent } from "../src/memoryApi";

vi.mock("../src/SourceEditor", () => ({
  SourceEditor: forwardRef(function SourceEditorStub(_props: unknown, ref: React.Ref<unknown>) {
    useImperativeHandle(ref, () => ({ scrollToLine() {}, selectRange() {} }));
    return null;
  }),
}));

const DOC = "# Plan\n\nHello world.\n\n<!--inplan v1\n[]\n-->\n";
let agent: MemoryAgent;

function mount(content: string) {
  document.body.innerHTML = '<div id="root"></div>';
  const session = createMemoryApi({ content });
  (window as unknown as { api: unknown }).api = session.api;
  agent = session.agent;
}
afterEach(cleanup);

async function openMenu() {
  const gear = screen.getByTitle("Settings");
  await act(async () => {
    gear.click();
  });
  await waitFor(() => expect(document.body.textContent).toContain("Agent changes"));
}

describe("App settings menu (memory-backed)", () => {
  it("opens the ⚙ menu and reveals the acceptance + auto-resolve controls", async () => {
    mount(DOC);
    const { App } = await import("../src/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("Hello world."));

    // Menu is closed initially.
    expect(document.body.textContent).not.toContain("Agent changes");

    await openMenu();
    expect(screen.getByRole("button", { name: /auto-accept/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /^review$/i })).toBeTruthy();
    expect(document.body.textContent).toContain("Agent auto-resolves a thread after incorporating it");
  });

  it("switching acceptance to Review logs a mode_changed control event", async () => {
    mount(DOC);
    const { App } = await import("../src/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("Hello world."));

    await openMenu();
    const review = screen.getByRole("button", { name: /^review$/i });
    await act(async () => {
      review.click();
    });

    await waitFor(async () => {
      const log = await agent.log();
      const mode = log.filter((e) => e.type === "mode_changed");
      expect(mode.length).toBeGreaterThan(0);
      const last = mode[mode.length - 1];
      expect((last.payload as { acceptance: string }).acceptance).toBe("review");
    });
  });

  it("switching back to Auto-accept logs a mode_changed event with acceptance=auto", async () => {
    mount(DOC);
    const { App } = await import("../src/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("Hello world."));

    await openMenu();
    await act(async () => {
      screen.getByRole("button", { name: /^review$/i }).click();
    });
    await act(async () => {
      screen.getByRole("button", { name: /auto-accept/i }).click();
    });

    await waitFor(async () => {
      const log = await agent.log();
      const mode = log.filter((e) => e.type === "mode_changed");
      const last = mode[mode.length - 1];
      expect((last.payload as { acceptance: string }).acceptance).toBe("auto");
    });
  });

  it("toggling auto-resolve off logs a settings_changed event with autoResolve=false", async () => {
    mount(DOC);
    const { App } = await import("../src/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("Hello world."));

    await openMenu();
    // The auto-resolve checkbox lives inside the settings row labelled
    // "Agent auto-resolves…"; scope to that row so we don't grab the
    // unrelated "resolved & orphaned" / find-bar checkboxes.
    const row = screen.getByText("Agent auto-resolves a thread after incorporating it").closest("label");
    const checkbox = row!.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);

    await act(async () => {
      fireEvent.click(checkbox);
    });

    await waitFor(async () => {
      const log = await agent.log();
      const settings = log.filter((e) => e.type === "settings_changed");
      expect(settings.length).toBeGreaterThan(0);
      const last = settings[settings.length - 1];
      expect((last.payload as { autoResolve: boolean }).autoResolve).toBe(false);
    });
    // UI reflects the new state.
    expect(checkbox.checked).toBe(false);
  });
});
