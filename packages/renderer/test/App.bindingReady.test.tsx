// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A plugin binding is created before its source has synced, so until `binding.ready` settles it
// answers for an EMPTY document. The editor used to mount on it straight away and showed a blank
// page for the seconds the sync took; it now keeps the loading screen up until the binding is
// ready — and never longer than the timeout, nor when the sync fails.

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { forwardRef, useImperativeHandle } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryApi } from "../src/memoryApi";

vi.mock("../src/SourceEditor", () => ({
  SourceEditor: forwardRef(function SourceEditorStub(_props: unknown, ref: React.Ref<unknown>) {
    useImperativeHandle(ref, () => ({ scrollToLine() {}, selectRange() {} }));
    return null;
  }),
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const DOC = "# Plan\n\nThe real content.\n\n<!--inplan v1\n[]\n-->\n";

function mountWithBinding(ready: Promise<void>) {
  document.body.innerHTML = '<div id="root"></div>';
  const api = createMemoryApi({ content: DOC }).api;
  (api as { binding?: unknown }).binding = { extensions: [], getText: () => "", ready };
  (window as unknown as { api: unknown }).api = api;
}

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: unknown) => void } {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("loading screen vs a plugin binding's first sync", () => {
  it("stays up — spinner, no editor — until the binding is ready, then shows the document", async () => {
    const sync = deferred();
    mountWithBinding(sync.promise);
    const { App } = await import("../src/App");
    render(<App />);

    // The document itself has loaded; only the binding is still syncing.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(screen.getByRole("status").textContent).toContain("Loading");
    expect(document.querySelector(".ap-spinner")).not.toBeNull();
    expect(document.body.textContent).not.toContain("The real content.");

    await act(async () => sync.resolve());
    await waitFor(() => expect(document.body.textContent).toContain("The real content."));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("shows the editor anyway when the binding's sync fails", async () => {
    const sync = deferred();
    mountWithBinding(sync.promise);
    const { App } = await import("../src/App");
    render(<App />);
    await act(async () => sync.reject(new Error("hub unreachable")));
    await waitFor(() => expect(document.body.textContent).toContain("The real content."));
  });

  it("never waits forever: after 10 s without a sync the editor shows", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mountWithBinding(new Promise<void>(() => {})); // a sync that never comes
    const { App } = await import("../src/App");
    render(<App />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_000);
    });
    expect(screen.getByRole("status")).toBeTruthy(); // still waiting just before the bound
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    await waitFor(() => expect(document.body.textContent).toContain("The real content."));
  });
});
