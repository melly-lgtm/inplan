// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// End-to-end guard for a span comment whose anchored text spans SEVERAL source lines — the case
// from the multi-line-preview bug. Mounts the real <App/> over a doc whose only comment anchors a
// three-line directory tree, and checks the anchor is still ONE element covering all three lines,
// still tagged data-cmt/.ap-anchor, and still click-to-focus.
//
// Covered in both of the places the reported document put that block: as a PARAGRAPH, and inside
// a ``` FENCE. The fence is the harder half, because fence content is literal text to CommonMark:
// the anchor is not a markdown link there, so the renderer marks the spanned characters with a
// `<span data-cmt>` of its own instead of an `<a>`. Everything downstream — the preview's click
// handler, the rail's scroll/flash — resolves its target by `[data-cmt]`, so both shapes work; a
// handler that had gone looking for an `<a>` specifically would break on the fenced one.
//
// (Whether those three lines are DRAWN as three lines is the stylesheet's job — asserted in
// previewMultiline.test.ts, since happy-dom does no layout and cannot report a rendered line
// count.)

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

const ANCHORED_TREE = `[${TREE_LINES.join("\n")}](#cmt-cwnj04)`;
const COMMENT_BLOCK =
  "<!--inplan v1\n" +
  '[ { "id": "cmt-cwnj04", "author": "alice", "date": "2026-05-30T10:00:00", "resolved": false, "text": "Is /login still needed?" } ]\n' +
  "-->\n";

const DOC_WITH_MULTILINE_COMMENT = `# Plan\n\nRoutes:\n\n${ANCHORED_TREE}\n\n${COMMENT_BLOCK}`;
/** The same document with the tree fenced — the second half of the reported case. */
const DOC_WITH_FENCED_COMMENT = `# Plan\n\nRoutes:\n\n\`\`\`\n${ANCHORED_TREE}\n\`\`\`\n\n${COMMENT_BLOCK}`;

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>';
});
afterEach(cleanup);

/** Mount the real editor over `content`, settled once the comment's text is on screen. */
async function mountApp(content: string) {
  const session = createMemoryApi({ content });
  (window as unknown as { api: unknown }).api = session.api;
  const { App } = await import("../src/App");
  render(<App />);
  await waitFor(() => expect(document.body.textContent).toContain("Is /login still needed?"));
}

// Both halves must satisfy the same reader-facing contract, so they run the same checks. Only
// the element the renderer can legitimately use differs: a paragraph anchor IS a markdown link
// (<a>), a fenced one cannot be (<span>).
for (const [label, content, tag] of [
  ["as a paragraph", DOC_WITH_MULTILINE_COMMENT, "A"],
  ["inside a code fence", DOC_WITH_FENCED_COMMENT, "SPAN"],
] as const) {
  describe(`a span comment anchoring a multi-line block ${label}`, () => {
    it("renders as a single tagged anchor covering every line of the block", async () => {
      await mountApp(content);
      const anchors = document.querySelectorAll<HTMLElement>(".ap-rendered [data-cmt]");
      expect(anchors).toHaveLength(1);
      const anchor = anchors[0]!;
      expect(anchor.tagName).toBe(tag);
      expect(anchor.getAttribute("data-cmt")).toBe("cmt-cwnj04");
      expect(anchor.classList.contains("ap-anchor")).toBe(true);
      // One anchor, all three lines — not just the first line linked and the rest left loose.
      for (const line of TREE_LINES) expect(anchor.textContent).toContain(line);
    });

    it("is still click-to-focus: clicking it focuses and flashes the whole anchored block", async () => {
      await mountApp(content);
      const anchor = document.querySelector('[data-cmt="cmt-cwnj04"]') as HTMLElement;
      expect(anchor.classList.contains("ap-flash-anchor")).toBe(false);
      await act(async () => {
        fireEvent.click(anchor);
      });
      // App's preview onClick resolves the event target by [data-cmt] — element-agnostic, so it
      // works from any line of the multi-line anchor and for either shape of marker.
      expect(anchor.classList.contains("ap-flash-anchor")).toBe(true);
    });

    it("keeps the block's lines intact in the preview markup, so the anchor and the text agree", async () => {
      await mountApp(content);
      const anchor = document.querySelector('[data-cmt="cmt-cwnj04"]') as HTMLElement;
      // The newlines must survive into the DOM text — the stylesheet can only preserve what's there.
      expect(anchor.textContent!.split("\n")).toHaveLength(3);
      // …and so must the runs of alignment spaces the author typed to line the columns up.
      const dashColumns = anchor.textContent!.split("\n").map((l) => l.indexOf("—"));
      expect(new Set(dashColumns).size).toBe(1);
    });

    it("shows the reader the block, never the anchor's markdown syntax", async () => {
      await mountApp(content);
      const rendered = document.querySelector(".ap-rendered") as HTMLElement;
      expect(rendered.textContent).not.toContain("](#cmt-cwnj04)");
      expect(rendered.textContent).not.toContain("#cmt-cwnj04");
    });
  });
}

describe("a fenced comment anchor", () => {
  it("keeps the fence a code block, with its source line for cross-pane sync", async () => {
    await mountApp(DOC_WITH_FENCED_COMMENT);
    const marker = document.querySelector('[data-cmt="cmt-cwnj04"]') as HTMLElement;
    const pre = marker.closest("pre");
    expect(pre).not.toBeNull();
    expect(marker.closest("code")).not.toBeNull();
    // The fence's <pre> still carries the data-line the click handler syncs the source pane to.
    expect(pre!.getAttribute("data-line")).toBe("4");
  });

  it("is reachable from the comments rail, which flashes the marker in the preview", async () => {
    await mountApp(DOC_WITH_FENCED_COMMENT);
    const card = document.querySelector('[data-cmt-card="cmt-cwnj04"]') as HTMLElement;
    const marker = document.querySelector('[data-cmt="cmt-cwnj04"]') as HTMLElement;
    await act(async () => {
      fireEvent.click(card);
    });
    // focusComment() looks the preview target up by [data-cmt] and flashes it — the whole point
    // of marking the fenced span, since before this there was no element to find.
    expect(marker.classList.contains("ap-flash-anchor")).toBe(true);
  });
});
