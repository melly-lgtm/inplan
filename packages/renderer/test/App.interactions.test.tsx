// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Interaction coverage for App.tsx surfaces not exercised by the workflow suites:
// the preview click handler (comment / internal-doc / external links + line sync),
// the find-&-replace bar (replace one/all + scope toggles), and the comment-reply
// composer.

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

function mount(content: string) {
  document.body.innerHTML = '<div id="root"></div>';
  const session = createMemoryApi({ content });
  (window as unknown as { api: unknown }).api = session.api;
  return session;
}
afterEach(cleanup);

const LINKS_DOC =
  "# Plan\n\nUse [Postgres](#cmt-abc123) here. See [sibling](./design.md) and [site](https://example.com).\n\nA plain paragraph.\n\n" +
  '<!--inplan v1\n[ { "id": "cmt-abc123", "author": "x", "date": "d", "resolved": false, "text": "Why Postgres?" } ]\n-->\n';

describe("preview click handler", () => {
  it("routes comment-anchor, internal-doc, external links and line sync", async () => {
    const session = mount(LINKS_DOC);
    const openDoc = vi.spyOn(session.api, "openDoc").mockResolvedValue(undefined as never);
    const openSpy = vi.fn();
    vi.stubGlobal("open", openSpy);
    const { App } = await import("../src/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("Why Postgres?"));

    const preview = document.querySelector(".ap-rendered") as HTMLElement;
    // 1) comment anchor — focuses the rail card (no throw, exercises focusComment).
    fireEvent.click(preview.querySelector('a[data-cmt="cmt-abc123"]') as HTMLElement);
    // 2) internal .md link — resolves against the doc path and opens it.
    fireEvent.click([...preview.querySelectorAll("a")].find((a) => a.textContent === "sibling") as HTMLElement);
    expect(openDoc).toHaveBeenCalled();
    // 3) external link — opens a new window.
    fireEvent.click([...preview.querySelectorAll("a")].find((a) => a.textContent === "site") as HTMLElement);
    expect(openSpy).toHaveBeenCalledWith("https://example.com", "_blank");
    // 4) plain block click — syncs the editor to that source line (no throw).
    const block = preview.querySelector("[data-line]") as HTMLElement;
    fireEvent.click(block);
    expect(block).toBeTruthy();
  });
});

describe("find & replace bar", () => {
  const REPEAT = "# Plan\n\nalpha alpha alpha here.\n\n<!--inplan v1\n[]\n-->\n";
  it("replaces all matches and toggles preview⊕editor scopes", async () => {
    mount(REPEAT);
    const { App } = await import("../src/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("alpha alpha alpha"));

    fireEvent.keyDown(document.body, { key: "f", metaKey: true });
    const find = await screen.findByPlaceholderText("Find…");
    fireEvent.change(find, { target: { value: "alpha" } });

    // Enter replace mode, supply a replacement, replace all.
    fireEvent.click(screen.getByRole("checkbox", { name: /replace/i }));
    const replace = await screen.findByPlaceholderText("Replace…");
    fireEvent.change(replace, { target: { value: "beta" } });
    await act(async () => {
      fireEvent.click(screen.getByText("Replace All"));
    });
    await waitFor(() => expect(document.querySelector(".ap-rendered")?.textContent).toContain("beta beta beta"));

    // Scope toggles: preview ⊕ editor (checking editor unchecks preview).
    const editor = screen.getByText("editor").closest("label")!.querySelector("input")!;
    fireEvent.click(editor);
    expect(editor.checked).toBe(true);
    fireEvent.click(screen.getByText("comments").closest("label")!.querySelector("input")!);
  });

  it("replace-next advances and rewrites a single match", async () => {
    mount(REPEAT);
    const { App } = await import("../src/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("alpha"));
    fireEvent.keyDown(document.body, { key: "f", metaKey: true });
    fireEvent.change(await screen.findByPlaceholderText("Find…"), { target: { value: "alpha" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /replace/i }));
    fireEvent.change(await screen.findByPlaceholderText("Replace…"), { target: { value: "X" } });
    await act(async () => {
      fireEvent.click(screen.getByText("Replace Next"));
    });
    await waitFor(() => expect(document.querySelector(".ap-rendered")?.textContent).toContain("X"));
  });
});

describe("comment reply composer", () => {
  it("submits a reply via the Comment button", async () => {
    mount(LINKS_DOC);
    const { App } = await import("../src/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("Why Postgres?"));

    fireEvent.click(screen.getByRole("button", { name: /^reply$/i }));
    const ta = await screen.findByPlaceholderText(/repl/i);
    fireEvent.change(ta, { target: { value: "Because scale." } });
    fireEvent.keyDown(ta, { key: "Enter", metaKey: true });
    await waitFor(() => expect(document.body.textContent).toContain("Because scale."));
  });
});
