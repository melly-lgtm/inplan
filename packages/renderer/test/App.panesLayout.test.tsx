// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// App-level layout tests against the real <App/> with a memory-backed window.api:
// the pane selector (1 = preview only, 2 = default tabbed, 3 = three panes), the
// right-pane Comments/Source tab switch, and zoom in/out/reset. SourceEditor
// (CodeMirror) is stubbed — it needs layout APIs happy-dom only stubs — and is
// the only thing the Source pane renders, so we assert on the Comments rail
// (which carries visible text) appearing/disappearing as the layout changes.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { forwardRef, useImperativeHandle } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryApi, type MemoryAgent } from "../src/memoryApi";

vi.mock("../src/SourceEditor", () => ({
  SourceEditor: forwardRef(function SourceEditorStub(_props: unknown, ref: React.Ref<unknown>) {
    useImperativeHandle(ref, () => ({ scrollToLine() {}, selectRange() {} }));
    return null;
  }),
}));

const DOC = "# Plan\n\nBody text here.\n\n<!--inplan v1\n[]\n-->\n";
let agent: MemoryAgent;

function mount(content: string) {
  // Layout is persisted to localStorage; clear it so each test starts from the
  // default 2-pane / comments-tab / 100% zoom state.
  localStorage.clear();
  document.body.innerHTML = '<div id="root"></div>';
  const session = createMemoryApi({ content });
  (window as unknown as { api: unknown }).api = session.api;
  agent = session.agent;
}

beforeEach(() => mount(DOC));
afterEach(cleanup);

// The pane-selector buttons carry title="N pane(s)"; grab them by accessible name.
const paneBtn = (n: 1 | 2 | 3) => screen.getByRole("button", { name: `${n} pane${n > 1 ? "s" : ""}` });

describe("App panes / tabs / zoom (memory-backed)", () => {
  it("defaults to 2 panes: preview + the Comments rail", async () => {
    const { App } = await import("../src/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("Body text here."));

    // Comments rail present by default (its empty-state hint is unique to the rail).
    expect(screen.getByText(/No comments\./)).toBeTruthy();
    // 2-pane tabs are shown (Comments + Source tab buttons exist).
    expect(screen.getByRole("button", { name: "Comments" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Source" })).toBeTruthy();
  });

  it("1-pane shows preview only — no Comments rail, no tabs", async () => {
    const { App } = await import("../src/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("Body text here."));

    fireEvent.click(paneBtn(1));

    await waitFor(() => expect(screen.queryByText(/No comments\./)).toBeNull());
    // No Comments/Source tab buttons in 1-pane mode (only PaneTabs renders them).
    expect(screen.queryByRole("button", { name: "Source" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Comments" })).toBeNull();
    // Preview content still rendered.
    expect(document.body.textContent).toContain("Body text here.");
  });

  it("3-pane shows both source and comments at once (tabs disappear)", async () => {
    const { App } = await import("../src/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("Body text here."));

    fireEvent.click(paneBtn(3));

    // Comments rail is present (its empty hint shows)...
    await waitFor(() => expect(screen.getByText(/No comments\./)).toBeTruthy());
    // ...and the tab switcher is gone in 3-pane mode (PaneTabs only renders for panes===2).
    expect(screen.queryByRole("button", { name: "Source" })).toBeNull();
    // Both source (.ap-pane) and comments (.ap-rail) sections exist.
    expect(document.querySelector(".ap-rail")).toBeTruthy();
    expect(document.querySelectorAll("section.ap-pane").length).toBe(2);
  });

  it("right-pane tab switches Comments -> Source in 2-pane mode", async () => {
    const { App } = await import("../src/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("Body text here."));

    // Starts on Comments: the rail's empty hint is visible.
    expect(screen.getByText(/No comments\./)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Source" }));

    // Now the comments rail is gone (Source tab is active); tabs still present.
    await waitFor(() => expect(screen.queryByText(/No comments\./)).toBeNull());
    expect(screen.queryByText(/No comments\./)).toBeNull();
    expect(document.querySelector(".ap-rail")).toBeNull();

    // Switch back to Comments.
    fireEvent.click(screen.getByRole("button", { name: "Comments" }));
    await waitFor(() => expect(screen.getByText(/No comments\./)).toBeTruthy());
  });

  it("hydrates the initial layout from localStorage on first render (no clobber race)", async () => {
    // Pre-seed the persisted layout BEFORE mount (beforeEach already cleared it). The lazy useState
    // initializers must read this synchronously so the FIRST render is 3-pane @ 120% — proving the
    // hydrate-then-write effect race (which reverted prefs under StrictMode on web) is gone.
    localStorage.setItem("ap-layout", JSON.stringify({ panes: 3, zoom: 1.2, rightTab: "comments", showResolvedOrphaned: false, cadence: "turn", srcW: 380, cmtW: 380 }));
    const { App } = await import("../src/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("Body text here."));

    // 3-pane straight away: both source + comments sections, no tab switcher — and never reverted to 2.
    expect(document.querySelectorAll("section.ap-pane").length).toBe(2);
    expect(document.querySelector(".ap-rail")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Source" })).toBeNull(); // tabs only render for panes===2
    expect(screen.getByTitle("Reset zoom").textContent).toBe("120%");
  });

  it("zoom in / out / reset update the indicator and never crash", async () => {
    const { App } = await import("../src/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("Body text here."));

    // The zoom buttons carry title attrs; their visible text is the glyph / %.
    const zoomIn = () => screen.getByTitle("Zoom in");
    const zoomOut = () => screen.getByTitle("Zoom out");
    const reset = () => screen.getByTitle("Reset zoom");

    // Reset button label doubles as the zoom indicator.
    expect(reset().textContent).toBe("100%");

    fireEvent.click(zoomIn());
    await waitFor(() => expect(reset().textContent).toBe("110%"));

    fireEvent.click(zoomIn());
    await waitFor(() => expect(reset().textContent).toBe("120%"));

    fireEvent.click(zoomOut());
    await waitFor(() => expect(reset().textContent).toBe("110%"));

    // Reset zoom returns to 100%.
    fireEvent.click(reset());
    await waitFor(() => expect(reset().textContent).toBe("100%"));

    // Document still rendered after all the zoom churn.
    expect(document.body.textContent).toContain("Body text here.");
  });
});
