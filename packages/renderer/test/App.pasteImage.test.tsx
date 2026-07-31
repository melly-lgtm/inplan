// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// App.tsx's onPasteImage wiring: derives a file extension from the pasted image's MIME type,
// calls the host's optional saveAsset(bytes, ext), and hands the SourceEditor the resulting
// relative link (or null when the host can't save one — e.g. no saveAsset at all).

import { cleanup, render, waitFor } from "@testing-library/react";
import { forwardRef, useImperativeHandle } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryApi } from "../src/memoryApi";

type OnPasteImage = (bytes: ArrayBuffer, mime: string) => Promise<string | null>;
let onPasteImage: OnPasteImage | undefined;

vi.mock("../src/SourceEditor", () => ({
  SourceEditor: forwardRef(function SourceEditorStub(props: { onPasteImage?: OnPasteImage }, ref: React.Ref<unknown>) {
    onPasteImage = props.onPasteImage;
    useImperativeHandle(ref, () => ({ scrollToLine() {}, selectRange() {} }));
    return null;
  }),
}));

const DOC = "# Plan\n\nHello world.\n\n<!--inplan v1\n[]\n-->\n";

beforeEach(() => {
  // 3-pane layout so the source pane (and its SourceEditor) actually mounts — the default
  // 2-pane layout starts on the Comments tab, which never renders SourceEditor at all.
  localStorage.setItem("ap-layout", JSON.stringify({ panes: 3, zoom: 1, showResolvedOrphaned: false, cadence: "turn", srcW: 380, cmtW: 380 }));
  document.body.innerHTML = '<div id="root"></div>';
  const session = createMemoryApi({ content: DOC });
  (window as unknown as { api: unknown }).api = session.api;
  onPasteImage = undefined;
});
afterEach(cleanup);

async function mountApp() {
  const { App } = await import("../src/App");
  render(<App />);
  await waitFor(() => expect(document.body.textContent).toContain("Hello world."));
}

describe("App onPasteImage wiring", () => {
  it("derives the extension from MIME type and returns the host's relPath", async () => {
    const saveAsset = vi.fn(async (_bytes: ArrayBuffer, ext: string) => ({ relPath: `plan.assets/x.${ext}` }));
    (window as unknown as { api: { saveAsset: unknown } }).api.saveAsset = saveAsset;
    await mountApp();

    const result = await onPasteImage!(new ArrayBuffer(3), "image/png");

    expect(saveAsset).toHaveBeenCalledWith(expect.any(ArrayBuffer), "png");
    expect(result).toBe("plan.assets/x.png");
  });

  it("maps image/jpeg to the .jpg extension", async () => {
    const saveAsset = vi.fn(async (_bytes: ArrayBuffer, ext: string) => ({ relPath: `plan.assets/x.${ext}` }));
    (window as unknown as { api: { saveAsset: unknown } }).api.saveAsset = saveAsset;
    await mountApp();

    await onPasteImage!(new ArrayBuffer(3), "image/jpeg");

    expect(saveAsset).toHaveBeenCalledWith(expect.any(ArrayBuffer), "jpg");
  });

  it("resolves null without crashing when the host has no saveAsset (e.g. a cloud doc)", async () => {
    await mountApp(); // memoryApi never sets api.saveAsset

    const result = await onPasteImage!(new ArrayBuffer(3), "image/png");

    expect(result).toBeNull();
  });
});
