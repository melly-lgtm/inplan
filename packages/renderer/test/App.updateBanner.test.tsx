// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The desktop update banner: when the host reports a newer npm version, the app
// offers an in-app "Update now" → on success it prompts a restart.

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

const DOC = "# Plan\n\nHello world.\n\n<!--inplan v1\n[]\n-->\n";

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '<div id="root"></div>';
});
afterEach(cleanup);

describe("desktop update banner", () => {
  it("offers Update now when a newer version is available, then prompts restart", async () => {
    const session = createMemoryApi({ content: DOC });
    const applyUpdate = vi.fn(async () => ({ ok: true }));
    const api = session.api as unknown as Record<string, unknown>;
    api.onUpdateAvailable = (cb: (i: { current: string; latest: string }) => void) => cb({ current: "0.1.0", latest: "0.2.0" });
    api.applyUpdate = applyUpdate;
    (window as unknown as { api: unknown }).api = api;

    const { App } = await import("../src/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("Hello world."));

    expect(document.body.textContent).toContain("v0.1.0 → v0.2.0");
    const btn = screen.getByRole("button", { name: /update now/i });
    await act(async () => {
      btn.click();
    });
    expect(applyUpdate).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole("button", { name: /restart/i })).toBeTruthy());
  });

  it("shows no banner when the host has no update channel (web / tests)", async () => {
    const session = createMemoryApi({ content: DOC });
    (window as unknown as { api: unknown }).api = session.api;
    const { App } = await import("../src/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("Hello world."));
    expect(screen.queryByRole("button", { name: /update now/i })).toBeNull();
  });
});
