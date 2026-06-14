// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A host can open a doc read-only (DocPayload.readOnly) — e.g. the cloud archives a doc over the
// plan's active-doc cap. The editor then blocks editing + turn handoff and shows an archived
// banner, but stays viewable (and the host's Download action still works). SourceEditor is stubbed
// (CodeMirror needs layout APIs happy-dom lacks); we assert the gating App owns via the top bar.

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

const DOC = "# Plan\n\nArchived body.\n\n<!--inplan v1\n[]\n-->\n";

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>';
});
afterEach(cleanup);

describe("App read-only doc (DocPayload.readOnly)", () => {
  it("blocks editing and shows the archived banner when the host opens a doc read-only", async () => {
    (window as unknown as { api: unknown }).api = createMemoryApi({ content: DOC, readOnly: true }).api;
    const { App } = await import("../src/App");
    await act(async () => void render(<App />));
    await waitFor(() => expect(document.body.textContent).toContain("Archived body."));

    // The archived banner is shown (view + download only)…
    expect(document.querySelector(".ap-banner--readonly")).toBeTruthy();
    expect(document.body.textContent).toContain("archived");
    // …and mutation is blocked: "Comment on Doc/Text" is disabled (the shared editingLocked gate).
    const addComment = screen.getByRole("button", { name: /comment on (text|doc)/i }) as HTMLButtonElement;
    expect(addComment.disabled).toBe(true);
    // The Save button is disabled too — an archived doc is view/download-only, so no UI path
    // (button or ⌘/Ctrl+S, both routed through the readOnly-guarded saveNow) can write it.
    const save = screen.getByRole("button", { name: /^save$/i }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });

  it("an editable doc (no readOnly) shows no archived banner and allows commenting", async () => {
    (window as unknown as { api: unknown }).api = createMemoryApi({ content: DOC }).api;
    const { App } = await import("../src/App");
    await act(async () => void render(<App />));
    await waitFor(() => expect(document.body.textContent).toContain("Archived body."));

    expect(document.querySelector(".ap-banner--readonly")).toBeNull();
    const addComment = screen.getByRole("button", { name: /comment on (text|doc)/i }) as HTMLButtonElement;
    expect(addComment.disabled).toBe(false);
    const save = screen.getByRole("button", { name: /^save$/i }) as HTMLButtonElement;
    expect(save.disabled).toBe(false); // symmetric to the read-only case: editable ⇒ Save enabled
  });
});
