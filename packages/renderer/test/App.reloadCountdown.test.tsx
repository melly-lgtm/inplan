// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// App-level integration test for the reload countdown banner + auto-close
// behavior. When the agent signals a new build is ready (suggestReload → onReload),
// the App surfaces a banner with a 30s countdown that ticks down once per second
// and calls window.api.closeWindow() at zero. The "Reload now" button closes
// immediately; "Cancel" stops the countdown and dismisses the banner.
//
// SourceEditor (CodeMirror) is stubbed: it needs layout APIs happy-dom only stubs,
// and the countdown logic under test lives entirely in App.

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { forwardRef, useImperativeHandle } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryApi, type MemoryAgent, type MemorySession } from "../src/memoryApi";

vi.mock("../src/SourceEditor", () => ({
  SourceEditor: forwardRef(function SourceEditorStub(_props: unknown, ref: React.Ref<unknown>) {
    useImperativeHandle(ref, () => ({ scrollToLine() {}, selectRange() {} }));
    return null;
  }),
}));

const DOC = "# Plan\n\nHello world.\n\n<!--inplan v1\n[]\n-->\n";
let agent: MemoryAgent;
let session: MemorySession;

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>';
  session = createMemoryApi({ content: DOC });
  (window as unknown as { api: unknown }).api = session.api;
  agent = session.agent;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("App reload countdown (memory-backed)", () => {
  it("shows the countdown banner, ticks down, and auto-closes at zero", async () => {
    const { App } = await import("../src/App");
    render(<App />);

    // Let the document load under real timers (waitFor polls on real timers).
    await waitFor(() => expect(document.body.textContent).toContain("Hello world."));

    // No reload banner before the agent signals a new build.
    expect(document.body.textContent).not.toContain("A new build is ready");

    // Switch to fake timers now to drive the per-second countdown deterministically.
    vi.useFakeTimers();

    // Agent signals a new build → banner appears with a 30s countdown.
    await act(async () => {
      agent.suggestReload();
    });
    expect(document.body.textContent).toContain("A new build is ready");
    expect(document.body.textContent).toContain("reloading in 30s");

    // The countdown ticks down once per second. Each tick re-arms a fresh
    // setTimeout (the effect re-runs on every reloadIn change), so advance one
    // second at a time to let each scheduled timeout fire and re-schedule.
    const tick = async () => {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
    };

    await tick();
    expect(document.body.textContent).toContain("reloading in 29s");

    await tick();
    await tick();
    await tick();
    expect(document.body.textContent).toContain("reloading in 26s");

    // Not yet closed.
    expect(session.isClosed()).toBe(false);

    // Tick the remaining 26 seconds down to zero → the effect calls
    // window.api.closeWindow().
    for (let i = 0; i < 26; i++) await tick();
    expect(session.isClosed()).toBe(true);
  });

  it("'Reload now' closes the window immediately", async () => {
    const { App } = await import("../src/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("Hello world."));

    vi.useFakeTimers();
    await act(async () => {
      agent.suggestReload();
    });
    expect(screen.getByRole("button", { name: /reload now/i })).toBeTruthy();

    expect(session.isClosed()).toBe(false);
    await act(async () => {
      screen.getByRole("button", { name: /reload now/i }).click();
    });
    expect(session.isClosed()).toBe(true);
  });

  it("'Cancel' stops the countdown and dismisses the banner without closing", async () => {
    const { App } = await import("../src/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("Hello world."));

    vi.useFakeTimers();
    await act(async () => {
      agent.suggestReload();
    });
    expect(document.body.textContent).toContain("A new build is ready");

    // Let it tick once to prove the timer is live, then cancel.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(document.body.textContent).toContain("reloading in 29s");

    await act(async () => {
      screen.getByRole("button", { name: /cancel/i }).click();
    });
    expect(document.body.textContent).not.toContain("A new build is ready");

    // The countdown is fully stopped: advancing far past zero never closes.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60 * 1000);
    });
    expect(session.isClosed()).toBe(false);
    expect(document.body.textContent).not.toContain("A new build is ready");
  });
});
