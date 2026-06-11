// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The generic host-injected side-panel seam (Api.sidePanels) — the open-core hook a cloud
// feature like the table of contents plugs into. The renderer owns the menu-bar toggle, the
// slide-in slot, and cross-pane scrolling; the host owns the panel's content. We inject a
// fake panel and assert: no toggle when none are provided; toggling shows/hides the panel;
// the panel receives live context (body + activeLine) and its scrollToLine drives the editor.

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { forwardRef, useImperativeHandle } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryApi } from "../src/memoryApi";
import type { Api, SidePanelSpec } from "../src/api";

// Capture the source editor's scrollToLine so we can assert a panel pick scrolls the source.
const { scrollToLine } = vi.hoisted(() => ({ scrollToLine: vi.fn() }));
vi.mock("../src/SourceEditor", () => ({
  SourceEditor: forwardRef(function Stub(_props: unknown, ref: React.Ref<unknown>) {
    useImperativeHandle(ref, () => ({ scrollToLine, selectRange() {} }));
    return null;
  }),
}));

const DOC = "# Title\n\nintro\n\n## Section\n\nbody\n\n<!--inplan v1\n[]\n-->\n";

// A minimal host panel exercising the full context: shows body length + active line, a button
// that scrolls to line 3, and a button that closes itself.
const demoPanel: SidePanelSpec = {
  id: "demo",
  title: "Demo Panel",
  icon: <span data-testid="demo-icon">D</span>,
  render: (ctx) => (
    <div data-testid="demo-body">
      <span>active:{String(ctx.activeLine)}</span>
      <button onClick={() => ctx.scrollToLine(3)}>go to 3</button>
      <button onClick={ctx.close}>close panel</button>
    </div>
  ),
};

function mount(panels: SidePanelSpec[] | null) {
  document.body.innerHTML = '<div id="root"></div>';
  localStorage.setItem("ap-layout", JSON.stringify({ panes: 3 })); // show the source pane (editorRef → scrollToLine)
  const session = createMemoryApi({ content: DOC });
  const api = session.api as Api;
  if (panels) api.sidePanels = panels;
  (window as unknown as { api: unknown }).api = api;
}

beforeEach(() => scrollToLine.mockClear());
afterEach(cleanup);

async function mountApp() {
  const { App } = await import("../src/App");
  render(<App />);
  await waitFor(() => expect(document.body.textContent).toContain("intro"));
}

describe("Api.sidePanels (host-injected side-panel seam)", () => {
  it("shows no bump when the host injects no panels", async () => {
    mount(null);
    await mountApp();
    expect(screen.queryByRole("button", { name: "Demo Panel" })).toBeNull();
  });

  it("is folded by default, opens from the preview bump, then auto-hides ~0.5s after the cursor leaves", async () => {
    mount([demoPanel]);
    await mountApp();
    const bump = screen.getByRole("button", { name: "Demo Panel" }); // the preview-edge handle
    expect(screen.queryByTestId("demo-body")).toBeNull(); // folded by default

    await act(async () => fireEvent.click(bump));
    const panel = screen.getByTestId("demo-body").closest("aside")!;
    expect(panel).toBeTruthy(); // slid in

    // Leaving the panel starts a ~0.5s hide timer; then the panel folds out over ~0.54s (kept
    // mounted for the exit animation) before it's dropped.
    vi.useFakeTimers();
    fireEvent.mouseLeave(panel);
    act(() => vi.advanceTimersByTime(500)); // hide delay elapses → begins folding out
    act(() => vi.advanceTimersByTime(560)); // fold-out animation finishes → unmounted
    vi.useRealTimers();
    expect(screen.queryByTestId("demo-body")).toBeNull();
  });

  it("re-entering the panel cancels the pending auto-hide", async () => {
    mount([demoPanel]);
    await mountApp();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Demo Panel" })));
    const panel = screen.getByTestId("demo-body").closest("aside")!;

    vi.useFakeTimers();
    fireEvent.mouseLeave(panel); // arm the timer
    act(() => vi.advanceTimersByTime(250));
    fireEvent.mouseEnter(panel); // cancel it
    act(() => vi.advanceTimersByTime(1000));
    vi.useRealTimers();
    expect(screen.getByTestId("demo-body")).toBeTruthy(); // still open
  });

  it("hands the panel live context: scrollToLine drives the source + updates the active line", async () => {
    mount([demoPanel]);
    await mountApp();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Demo Panel" })));

    expect(screen.getByText("active:null")).toBeTruthy(); // no active line yet
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "go to 3" })));

    expect(scrollToLine).toHaveBeenCalledWith(3); // scrolled the source editor
    await waitFor(() => expect(screen.getByText("active:3")).toBeTruthy()); // and the preview's active line
  });

  it("the panel can close itself via ctx.close (then folds out)", async () => {
    mount([demoPanel]);
    await mountApp();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Demo Panel" })));
    vi.useFakeTimers();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "close panel" })));
    act(() => vi.advanceTimersByTime(560)); // fold-out animation finishes → unmounted
    vi.useRealTimers();
    expect(screen.queryByTestId("demo-body")).toBeNull();
  });
});
