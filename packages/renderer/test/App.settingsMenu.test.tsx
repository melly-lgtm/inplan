// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// App-level integration tests for the ⚙ Settings menu (SettingsMenu) against the
// real <App/> with a memory-backed window.api. Covers opening the menu, toggling
// Agent-change acceptance between Auto-accept and Review (a global setting persisted
// via a settings_changed event), and toggling the auto-resolve setting (likewise).
//
// SourceEditor (CodeMirror) is stubbed: it needs layout APIs happy-dom only
// stubs, and the settings flow under test lives in App, not the editor.

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

const DOC = "# Plan\n\nHello world.\n\n<!--inplan v1\n[]\n-->\n";
let agent: MemoryAgent;

function mount(content: string, settings?: Settings) {
  document.body.innerHTML = '<div id="root"></div>';
  const session = createMemoryApi({ content, settings });
  (window as unknown as { api: unknown }).api = session.api;
  agent = session.agent;
}
afterEach(() => {
  cleanup();
  localStorage.clear(); // layout is seeded from ap-layout; don't leak across tests
});

async function openMenu() {
  // Settings now live in the avatar menu (tagged data-onboard="settings").
  const avatar = document.querySelector('[data-onboard="settings"]') as HTMLElement;
  await act(async () => {
    avatar.click();
  });
  await waitFor(() => expect(document.body.textContent).toContain("Auto-resolve comments"));
}

describe("App settings menu (memory-backed)", () => {
  it("opens the menu and reveals the acceptance + auto-resolve toggles", async () => {
    mount(DOC);
    const { App } = await import("../src/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("Hello world."));

    // Menu is closed initially.
    expect(document.body.textContent).not.toContain("Auto-resolve comments");

    await openMenu();
    // Both settings are now on/off switches.
    expect(screen.getByRole("switch", { name: /auto-accept agent's changes/i })).toBeTruthy();
    expect(screen.getByRole("switch", { name: /auto-resolve comments/i })).toBeTruthy();
  });

  it("turning the Auto-accept switch on logs a settings_changed event with acceptance=auto", async () => {
    // Acceptance is a global setting: the toggle persists via setSettings (a
    // settings_changed event), not the per-doc mode_changed.
    mount(DOC);
    const { App } = await import("../src/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("Hello world."));

    await openMenu();
    // Default acceptance is Review → the Auto-accept switch starts off.
    const sw = screen.getByRole("switch", { name: /auto-accept agent's changes/i }) as HTMLInputElement;
    expect(sw.checked).toBe(false);
    await act(async () => {
      fireEvent.click(sw); // → auto
    });

    await waitFor(async () => {
      const log = await agent.log();
      const changed = log.filter(
        (e) => e.type === "settings_changed" && (e.payload as { acceptance?: string }).acceptance != null,
      );
      expect(changed.length).toBeGreaterThan(0);
      const last = changed[changed.length - 1];
      expect((last.payload as { acceptance: string }).acceptance).toBe("auto");
    });
  });

  it("turning the Auto-accept switch off logs acceptance=review", async () => {
    // Seed acceptance=auto via the global settings so the switch starts on — one
    // click off → review (avoids relying on a controlled-checkbox double toggle).
    mount(DOC, { autoResolve: true, acceptance: "auto" });
    const { App } = await import("../src/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("Hello world."));

    await openMenu();
    const sw = screen.getByRole("switch", { name: /auto-accept agent's changes/i }) as HTMLInputElement;
    await waitFor(() => expect(sw.checked).toBe(true));
    await act(async () => {
      fireEvent.click(sw); // → review
    });

    await waitFor(async () => {
      const log = await agent.log();
      const changed = log.filter(
        (e) => e.type === "settings_changed" && (e.payload as { acceptance?: string }).acceptance != null,
      );
      const last = changed[changed.length - 1];
      expect((last.payload as { acceptance: string }).acceptance).toBe("review");
    });
  });

  it("toggling auto-resolve off logs a settings_changed event with autoResolve=false", async () => {
    mount(DOC);
    const { App } = await import("../src/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("Hello world."));

    await openMenu();
    // The auto-resolve toggle (a switch). Memory backend defaults autoResolve=true.
    const sw = screen.getByRole("switch", { name: /auto-resolve comments/i }) as HTMLInputElement;
    expect(sw.checked).toBe(true);

    await act(async () => {
      fireEvent.click(sw);
    });

    await waitFor(async () => {
      const log = await agent.log();
      const settings = log.filter((e) => e.type === "settings_changed");
      expect(settings.length).toBeGreaterThan(0);
      const last = settings[settings.length - 1];
      expect((last.payload as { autoResolve: boolean }).autoResolve).toBe(false);
    });
    // UI reflects the new state.
    expect(sw.checked).toBe(false);
  });
});
