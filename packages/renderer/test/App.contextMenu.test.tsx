// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// App-level test for the preview right-click context menu (item 3): right-click
// opens a menu with Add comment / Find text / Copy / Select line / Select all, and
// "Add comment" opens the composer (rather than right-click composing immediately).

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  document.body.innerHTML = '<div id="root"></div>';
  const session = createMemoryApi({ content: DOC });
  (window as unknown as { api: unknown }).api = session.api;
});
afterEach(cleanup);

async function mountApp() {
  const { App } = await import("../src/App");
  render(<App />);
  await waitFor(() => expect(document.body.textContent).toContain("Hello world."));
}

describe("App preview context menu (item 3)", () => {
  it("right-click opens a menu with the five items", async () => {
    await mountApp();
    expect(screen.queryByRole("menuitem", { name: /comment on doc/i })).toBeNull();
    fireEvent.contextMenu(document.querySelector(".ap-rendered")!);
    // No selection ⇒ the first item is the document-level "Add Doc Comment".
    for (const name of [/comment on doc/i, /find text/i, /copy/i, /select line/i, /select all/i]) {
      expect(screen.getByRole("menuitem", { name })).toBeTruthy();
    }
  });

  it("right-click on the empty preview area (white space) still opens the menu", async () => {
    await mountApp();
    // Fire on the preview pane itself, not the rendered text — the empty "white" region.
    fireEvent.contextMenu(document.querySelector(".ap-preview")!);
    expect(screen.getByRole("menuitem", { name: /comment on doc/i })).toBeTruthy();
  });

  it("'Comment on Doc' opens the composer and closes the menu", async () => {
    await mountApp();
    fireEvent.contextMenu(document.querySelector(".ap-rendered")!);
    fireEvent.click(screen.getByRole("menuitem", { name: /comment on doc/i }));
    await waitFor(() => expect(screen.getByPlaceholderText(/Add a comment/i)).toBeTruthy());
    expect(screen.queryByRole("menuitem", { name: /comment on doc/i })).toBeNull(); // menu closed
  });

  it("'Select all' runs and closes the menu without error", async () => {
    await mountApp();
    fireEvent.contextMenu(document.querySelector(".ap-rendered")!);
    fireEvent.click(screen.getByRole("menuitem", { name: /select all/i }));
    expect(screen.queryByRole("menuitem", { name: /select all/i })).toBeNull();
  });
});
