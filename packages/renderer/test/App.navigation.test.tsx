// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Desktop in-window navigation (M4.11 link-following): the back/forward buttons
// appear only when the host provides `api.navigate`, reflect the pushed nav state,
// route clicks, and `onNavigated` swaps the document in place.

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { forwardRef, useImperativeHandle } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryApi } from "../src/memoryApi";

vi.mock("../src/SourceEditor", () => ({
  SourceEditor: forwardRef(function SourceEditorStub(_props: unknown, ref: React.Ref<unknown>) {
    useImperativeHandle(ref, () => ({ scrollToLine() {}, selectRange() {} }));
    return null;
  }),
}));

afterEach(cleanup);

function mountWithNav(content: string) {
  document.body.innerHTML = '<div id="root"></div>';
  const api = createMemoryApi({ content }).api as typeof window.api & {
    navigate: ReturnType<typeof vi.fn>;
    onNavState: (cb: (s: { canBack: boolean; canForward: boolean }) => void) => void;
    onNavigated: (cb: (p: { path: string; content: string }) => void) => void;
  };
  let navStateCb: ((s: { canBack: boolean; canForward: boolean }) => void) | undefined;
  let navigatedCb: ((p: { path: string; content: string }) => void) | undefined;
  api.navigate = vi.fn(async () => {});
  api.onNavState = (cb) => void (navStateCb = cb);
  api.onNavigated = (cb) => void (navigatedCb = cb);
  (window as unknown as { api: unknown }).api = api;
  return {
    api,
    fireNavState: (s: { canBack: boolean; canForward: boolean }) => act(() => navStateCb?.(s)),
    fireNavigated: (p: { path: string; content: string }) => act(() => navigatedCb?.(p)),
  };
}

describe("editor navigation (desktop)", () => {
  it("shows back/forward, reflects nav state, and routes a click", async () => {
    const { api, fireNavState } = mountWithNav("# A\n\nDoc A.\n\n<!--inplan v1\n[]\n-->\n");
    const { App } = await import("../src/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("Doc A."));

    const back = screen.getByRole("button", { name: "Back" }) as HTMLButtonElement;
    const fwd = screen.getByRole("button", { name: "Forward" }) as HTMLButtonElement;
    expect(back.disabled).toBe(true); // no history yet
    expect(fwd.disabled).toBe(true);

    fireNavState({ canBack: true, canForward: false });
    await waitFor(() => expect(back.disabled).toBe(false));
    fireEvent.click(back);
    expect(api.navigate).toHaveBeenCalledWith("back");
  });

  it("onNavigated swaps the document in place", async () => {
    const { fireNavigated } = mountWithNav("# A\n\nDoc A body.\n\n<!--inplan v1\n[]\n-->\n");
    const { App } = await import("../src/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("Doc A body."));

    fireNavigated({ path: "docs/B.md", content: "# B\n\nDoc B body.\n\n<!--inplan v1\n[]\n-->\n" });
    await waitFor(() => expect(document.body.textContent).toContain("Doc B body."));
    expect(document.body.textContent).not.toContain("Doc A body.");
  });

  it("hides the nav buttons when the host has no navigate (web/tests)", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    (window as unknown as { api: unknown }).api = createMemoryApi({ content: "# X\n\nbody\n\n<!--inplan v1\n[]\n-->\n" }).api;
    const { App } = await import("../src/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("body"));
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  });
});
