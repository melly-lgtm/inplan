// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// AppRoot first-run flow: on first launch it runs the guided tour against a throwaway
// in-memory SAMPLE (never the host doc), and on finish/skip it restores the host api
// and mounts the editor on the REAL document. The SourceEditor is stubbed (it needs
// layout APIs happy-dom doesn't provide).

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { forwardRef, useImperativeHandle } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryApi } from "../src/memoryApi";

vi.mock("../src/SourceEditor", () => ({
  SourceEditor: forwardRef(function SourceEditorStub(_props: unknown, ref: React.Ref<unknown>) {
    useImperativeHandle(ref, () => ({ scrollToLine() {}, selectRange() {} }));
    return null;
  }),
}));

const REAL_DOC = "# Real Plan\n\nThe agent's actual document.\n\n<!--inplan v1\n[]\n-->\n";

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '<div id="root"></div>';
  (window as unknown as { api: unknown }).api = createMemoryApi({ content: REAL_DOC }).api;
});
afterEach(cleanup);

describe("AppRoot onboarding gate", () => {
  it("first run shows the tour on the sample, then opens the real doc when skipped", async () => {
    const { AppRoot } = await import("../src/App");
    render(<AppRoot />);

    // The tour runs against the bundled sample — NOT the agent's real document.
    await waitFor(() => expect(document.body.textContent).toContain("Sample Plan"));
    expect(document.body.textContent).not.toContain("The agent's actual document.");
    expect(screen.getByText(/welcome to inplan/i)).toBeTruthy();

    await act(async () => {
      screen.getByRole("button", { name: /skip tutorial/i }).click();
    });

    // Finishing restores the host api and loads the real document.
    await waitFor(() => expect(document.body.textContent).toContain("The agent's actual document."));
    expect(screen.queryByText(/skip tutorial/i)).toBeNull();
    expect(localStorage.getItem("ap-onboarded")).toBe("1");
  });

  it("when already onboarded, opens the real doc directly (no tour)", async () => {
    localStorage.setItem("ap-onboarded", "1");
    const { AppRoot } = await import("../src/App");
    render(<AppRoot />);

    await waitFor(() => expect(document.body.textContent).toContain("The agent's actual document."));
    expect(screen.queryByText(/welcome to inplan/i)).toBeNull();
    expect(screen.queryByText(/skip tutorial/i)).toBeNull();
  });

  it("surfaces the host's extra modes (e.g. the cloud's instant mode) during the tour", async () => {
    // A host that advertises a second mode (the cloud injects instant mode this way). The cadence
    // toggle only renders when more than the built-in TURN mode is available — and it must appear
    // in the tutorial too, not only in the real editor.
    const api = createMemoryApi({ content: REAL_DOC }).api;
    api.extraModes = [
      { id: "instant", labelKey: "topbar.instant", locksEditor: false, wake: "any-action", autosaveKind: "canonical", autosaveDelayMs: 400, applyKind: "canonical", showFinishTurn: false },
    ];
    (window as unknown as { api: unknown }).api = api;

    const { AppRoot } = await import("../src/App");
    render(<AppRoot />);

    await waitFor(() => expect(document.body.textContent).toContain("Sample Plan")); // the tour, on the sample
    expect(screen.getByRole("group", { name: /cadence/i })).toBeTruthy(); // the mode switch is present
  });
});
