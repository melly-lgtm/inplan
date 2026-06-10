// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The desktop cloud sign-in overlay: when the host opens it, the /cli-auth page shows in an
// in-app modal (iframe) over the editor; clicking the dimmed backdrop dismisses it and cancels
// the handoff; the host can close it programmatically when the handoff settles.

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

/** Wire a controllable cloudSignIn channel onto a memory api. */
function withCloudSignIn() {
  const session = createMemoryApi({ content: DOC });
  const cancel = vi.fn();
  let open!: (url: string) => void;
  let close!: () => void;
  const api = session.api as unknown as Record<string, unknown>;
  api.cloudSignIn = {
    onOpen: (cb: (url: string) => void) => {
      open = cb;
      return () => {};
    },
    onClose: (cb: () => void) => {
      close = cb;
      return () => {};
    },
    cancel,
  };
  (window as unknown as { api: unknown }).api = api;
  return { cancel, open: () => open, close: () => close };
}

describe("desktop cloud sign-in overlay", () => {
  it("frames the host URL on open and dismisses + cancels on backdrop click", async () => {
    const h = withCloudSignIn();
    const { App } = await import("../src/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("Hello world."));

    expect(document.querySelector("iframe.ap-signin-frame")).toBeNull();
    act(() => h.open()("https://inplan.ai/cli-auth?port=5000&state=abc"));

    const frame = await waitFor(() => screen.getByTitle("Sign in to inplan.ai") as HTMLIFrameElement);
    expect(frame.src).toContain("/cli-auth?port=5000&state=abc");

    fireEvent.mouseDown(document.querySelector(".ap-signin-backdrop")!);
    expect(h.cancel).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(document.querySelector("iframe.ap-signin-frame")).toBeNull());
  });

  it("a click inside the panel does NOT dismiss the overlay", async () => {
    const h = withCloudSignIn();
    const { App } = await import("../src/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("Hello world."));
    act(() => h.open()("https://inplan.ai/cli-auth?port=5000&state=abc"));
    await waitFor(() => screen.getByTitle("Sign in to inplan.ai"));

    fireEvent.mouseDown(document.querySelector(".ap-signin-panel")!);
    expect(h.cancel).not.toHaveBeenCalled();
    expect(document.querySelector("iframe.ap-signin-frame")).not.toBeNull();
  });

  it("the host can close the overlay when the handoff settles", async () => {
    const h = withCloudSignIn();
    const { App } = await import("../src/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("Hello world."));
    act(() => h.open()("https://inplan.ai/cli-auth?port=5000&state=abc"));
    await waitFor(() => screen.getByTitle("Sign in to inplan.ai"));

    act(() => h.close()());
    await waitFor(() => expect(document.querySelector("iframe.ap-signin-frame")).toBeNull());
    expect(h.cancel).not.toHaveBeenCalled(); // host-driven close is not a user cancel
  });
});
