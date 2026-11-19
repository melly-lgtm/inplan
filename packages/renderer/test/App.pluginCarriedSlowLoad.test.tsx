// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The wait for a plugin-carried edit has a budget, and the budget is for the plugin's delivery.
// A wait that began when the event arrived would spend it on a slow load instead — and then run
// out, and adopt whatever the binding holds, with the revision still on its way.
//
// Its own file: the budget is shortened here so "slower than the budget" does not take seconds.

import { act, cleanup, render, waitFor } from "@testing-library/react";
import { forwardRef, useImperativeHandle } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "@inplan/core";
import { createMemoryApi } from "../src/memoryApi";

vi.mock("../src/SourceEditor", () => ({
  SourceEditor: forwardRef(function SourceEditorStub(_p: unknown, ref: React.Ref<unknown>) {
    useImperativeHandle(ref, () => ({ scrollToLine() {}, selectRange() {} }));
    return null;
  }),
}));
const BUDGET_MS = 200;
vi.mock("../src/bindingRead", async (original) => {
  const real = await original<typeof import("../src/bindingRead")>();
  return {
    ...real,
    whenCaughtUp: (read: () => string | null, hash: string, abandoned: () => boolean) => real.whenCaughtUp(read, hash, abandoned, { intervalMs: 20, retries: 10 }),
  };
});

const DOC = "# Plan\n\nThe original body.\n\n<!--inplan v1\n[]\n-->\n";
const REVISED = "# Plan\n\nThe revision, as the shared document holds it.\n\n<!--inplan v1\n[]\n-->\n";
type Payload = { path: string; content: string; viaPlugin?: boolean; bodyHash?: string };
let emit: ((p: Payload) => void) | null = null;
let release: () => void = () => {};

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '<div id="root"></div>';
  const session = createMemoryApi({ content: DOC });
  const api = session.api as unknown as { onExternalChange: (cb: (p: Payload) => void) => () => void; load: () => Promise<unknown> };
  api.onExternalChange = (cb) => {
    emit = cb;
    return () => (emit = null);
  };
  const realLoad = api.load.bind(api);
  const held = new Promise<void>((r) => (release = r));
  api.load = async () => (await held, realLoad());
  (window as unknown as { api: unknown }).api = api;
});
afterEach(() => {
  cleanup();
  emit = null;
});

describe("a load slower than the wait", () => {
  it("does not spend the wait: the edit is still waited for once the document is there", async () => {
    let text = DOC; // the binding is behind for the whole load, and a little longer
    (window as unknown as { api: { binding: unknown } }).api.binding = { extensions: [], getText: () => text, setText: vi.fn() };
    const { sha256Hex } = await import("../src/bindingRead");
    const { App } = await import("../src/App");
    render(<App />);
    await waitFor(() => expect(emit).toBeTruthy());
    const landed = (await sha256Hex(parse(REVISED).body))!;

    act(() => emit!({ path: "memory://doc", content: DOC, viaPlugin: true, bodyHash: landed }));
    await new Promise((r) => setTimeout(r, BUDGET_MS * 2)); // the whole budget goes by, twice, inside load
    release();
    await waitFor(() => expect(document.body.textContent).toContain("The original body."));
    await new Promise((r) => setTimeout(r, 60));
    expect(document.body.textContent).not.toContain("agent updated the document"); // not given up on: pre-revision text was not adopted

    text = REVISED; // the plugin delivers, inside a budget that only began after load
    await waitFor(() => expect(document.body.textContent).toContain("as the shared document holds it"));
  });
});
