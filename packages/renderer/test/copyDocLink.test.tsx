// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom
//
// "Copy link to document" in a comment's ⋯ menu. The link is host-supplied (DocPayload.shareLink)
// because only the host knows what a shareable address is — https for a cloud host, a file path
// for the desktop — and open-core must not guess. Absent ⇒ fall back to DocPayload.path, which on
// desktop is already the file, so a local document gets a useful link with no host change.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { App } from "../src/App";
import { setHostApi } from "../src/api";
import { createMemoryApi } from "../src/memoryApi";

const DOC = "# Plan\n\nBody text.\n\n<!--inplan v1\n[{\"id\":\"cmt-a\",\"anchor\":\"doc\",\"text\":\"hello\",\"author\":\"m\",\"date\":\"2026-01-01T00:00:00Z\",\"resolved\":false}]\n-->\n";

let written: string[];
beforeEach(() => {
  written = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: (s: string) => { written.push(s); return Promise.resolve(); } },
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

async function openMenu(payload: { path: string; shareLink?: string }): Promise<void> {
  setHostApi(createMemoryApi({ ...payload, content: DOC }).api);
  render(<App />);
  await waitFor(() => expect(screen.getByText("hello")).toBeTruthy());
  fireEvent.click(screen.getByTitle("More"));
}

describe("copy link to document", () => {
  it("copies the host-supplied share link for a cloud document", async () => {
    await openMenu({ path: "/docs/cis/web/plan.md", shareLink: "https://inplan.ai/docs/cis/web/plan.md" });
    fireEvent.click(screen.getByText("Copy link to document"));
    expect(written).toEqual(["https://inplan.ai/docs/cis/web/plan.md"]);
  });

  it("falls back to the path for a local document, so desktop needs no host change", async () => {
    await openMenu({ path: "/Users/me/plans/plan.plan.md" });
    fireEvent.click(screen.getByText("Copy link to document"));
    expect(written).toEqual(["/Users/me/plans/plan.plan.md"]);
  });

  it("offers nothing to copy when the host supplies neither", async () => {
    await openMenu({ path: "" });
    expect(screen.queryByText("Copy link to document")).toBeNull();
  });
});
