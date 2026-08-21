// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// End-to-end guard for a span comment whose anchored text spans SEVERAL source lines — the case
// from the multi-line-preview bug: an author cannot escape a hand-aligned block into a code fence
// without losing the comment, because an anchor's link text is inline, so the block has to stay a
// paragraph. Mounts the real <App/> over a doc whose only comment anchors a three-line directory
// tree, and checks the anchor is still ONE element covering all three lines, still tagged
// data-cmt/.ap-anchor, and still click-to-focus. (Whether those three lines are drawn as three
// lines is the stylesheet's job — asserted in previewMultiline.test.ts, since happy-dom does no
// layout and cannot report the rendered line count.)

import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { forwardRef, useImperativeHandle } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryApi } from "../src/memoryApi";

vi.mock("../src/SourceEditor", () => ({
  SourceEditor: forwardRef(function SourceEditorStub(_props: unknown, ref: React.Ref<unknown>) {
    useImperativeHandle(ref, () => ({ scrollToLine() {}, selectRange() {} }));
    return null;
  }),
}));

const TREE_LINES = [
  "├── /dashboard       — 분석 대시보드 (로그인 필요)",
  "├── /collections     — 컬렉션 관리 (웹 버전)",
  "└── /login           — 인증",
];

const DOC_WITH_MULTILINE_COMMENT =
  `# Plan\n\nRoutes:\n\n[${TREE_LINES.join("\n")}](#cmt-cwnj04)\n\n<!--inplan v1\n` +
  '[ { "id": "cmt-cwnj04", "author": "alice", "date": "2026-05-30T10:00:00", "resolved": false, "text": "Is /login still needed?" } ]\n' +
  "-->\n";

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>';
  const session = createMemoryApi({ content: DOC_WITH_MULTILINE_COMMENT });
  (window as unknown as { api: unknown }).api = session.api;
});
afterEach(cleanup);

async function mountApp() {
  const { App } = await import("../src/App");
  render(<App />);
  await waitFor(() => expect(document.body.textContent).toContain("Is /login still needed?"));
}

describe("a span comment anchoring a multi-line block", () => {
  it("renders as a single tagged anchor covering every line of the block", async () => {
    await mountApp();
    const anchors = document.querySelectorAll<HTMLElement>(".ap-rendered [data-cmt]");
    expect(anchors).toHaveLength(1);
    const anchor = anchors[0]!;
    expect(anchor.tagName).toBe("A");
    expect(anchor.getAttribute("data-cmt")).toBe("cmt-cwnj04");
    expect(anchor.classList.contains("ap-anchor")).toBe(true);
    // One anchor, all three lines — not just the first line linked and the rest left loose.
    for (const line of TREE_LINES) expect(anchor.textContent).toContain(line);
  });

  it("is still click-to-focus: clicking it focuses and flashes the whole anchored block", async () => {
    await mountApp();
    const anchor = document.querySelector('[data-cmt="cmt-cwnj04"]') as HTMLElement;
    expect(anchor.classList.contains("ap-flash-anchor")).toBe(false);
    await act(async () => {
      fireEvent.click(anchor);
    });
    // App's preview onClick resolves the event target with closest("a") and focuses data-cmt —
    // structure-based, so it works from any line of the multi-line anchor.
    expect(anchor.classList.contains("ap-flash-anchor")).toBe(true);
  });

  it("keeps the block's lines intact in the preview markup, so the anchor and the text agree", async () => {
    await mountApp();
    const anchor = document.querySelector('[data-cmt="cmt-cwnj04"]') as HTMLElement;
    // The newlines must survive into the DOM text — the stylesheet can only preserve what's there.
    expect(anchor.textContent!.split("\n")).toHaveLength(3);
    // …and so must the runs of alignment spaces the author typed to line the columns up.
    const dashColumns = anchor.textContent!.split("\n").map((l) => l.indexOf("—"));
    expect(new Set(dashColumns).size).toBe(1);
  });
});
