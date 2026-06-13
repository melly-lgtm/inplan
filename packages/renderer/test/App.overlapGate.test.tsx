// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// App-level invariant: addComment's span guard is the last line of defense for span comments.
// addSpanComment itself does NOT enforce overlap — App.addComment(text, target, span) calls
// spanCommentBlocker(docRef.current.body, target, span) first and, on "overlap", sets the
// cant-overlap status and returns WITHOUT creating a comment (so no nested Markdown link ever
// corrupts the doc); on a non-anchorable selection it sets cant-anchor; only a clean selection
// actually creates the comment.
//
// The UI's toolbar / ⌘+/ / context-menu entry points all pre-block overlapping selections, so to
// exercise the in-addComment guard we open the composer on a clean selection and then let the
// agent rewrite the document underneath it (the composer stays open with its captured target) —
// the body the submit reads is the rewritten one. SourceEditor (CodeMirror) is stubbed.

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { forwardRef, useImperativeHandle } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryApi, type MemoryAgent } from "../src/memoryApi";

vi.mock("../src/SourceEditor", () => ({
  SourceEditor: forwardRef(function SourceEditorStub(_props: unknown, ref: React.Ref<unknown>) {
    useImperativeHandle(ref, () => ({ scrollToLine() {}, selectRange() {} }));
    return null;
  }),
}));

// A clean starting doc with no comment anchors. "Postgres" appears once, as plain text.
const DOC = "# Plan\n\nUse Postgres here.\n\n<!--inplan v1\n[]\n-->\n";

// After the agent rewrites the doc, the SOLE occurrence of "Postgres" sits inside an existing
// comment anchor, so a span comment on "Postgres" would have to nest a Markdown link → overlap.
const DOC_WITH_ANCHOR =
  "# Plan\n\nUse [Postgres](#cmt-abc123) here.\n\n<!--inplan v1\n" +
  '[ { "id": "cmt-abc123", "author": "alice", "date": "2026-05-30T10:00:00", "resolved": false, "text": "Why not SQLite?" } ]\n' +
  "-->\n";

// After this rewrite the selected text no longer exists anywhere in the body → not-found → cant-anchor.
const DOC_TEXT_GONE = "# Plan\n\nUse MySQL here.\n\n<!--inplan v1\n[]\n-->\n";

let agent: MemoryAgent;
let origGetSelection: typeof window.getSelection;

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>';
  const session = createMemoryApi({ content: DOC });
  (window as unknown as { api: unknown }).api = session.api;
  agent = session.agent;
  origGetSelection = window.getSelection;
});
afterEach(() => {
  window.getSelection = origGetSelection;
  cleanup();
});

// A mocked selection: rangeCount 1 with a range that has no [data-line] container, so
// selectionSourceSpan() returns null (span undefined) — matching App.spanComment.test.tsx. The
// toolbar's no-span pre-guard then maps to the (currently clean) global occurrence, so the button
// stays enabled at open time.
function mockSelection(text: string) {
  const range = {
    cloneRange: () => range,
    getBoundingClientRect: () => ({ left: 0, bottom: 0, top: 0, right: 0, width: 0, height: 0 }),
  } as unknown as Range;
  window.getSelection = (() => ({
    toString: () => text,
    rangeCount: 1,
    getRangeAt: () => range,
    removeAllRanges() {},
    addRange() {},
  })) as unknown as typeof window.getSelection;
}

async function mountApp() {
  const { App } = await import("../src/App");
  render(<App />);
  await waitFor(() => expect(document.body.textContent).toContain("Postgres"));
}

// Open the composer on the current (clean) selection via the toolbar, then type and submit.
async function composeAndSubmit(target: string, text: string) {
  mockSelection(target);
  await act(async () => void document.dispatchEvent(new Event("selectionchange")));
  const btn = screen.getByRole("button", { name: /^comment on text$/i }) as HTMLButtonElement;
  expect(btn.disabled).toBe(false); // clean selection ⇒ the entry point is open
  await act(async () => void btn.click());
  const ta = await screen.findByPlaceholderText(/Add a comment/i);
  await act(async () => void fireEvent.change(ta, { target: { value: text } }));
  await act(async () => void screen.getByRole("button", { name: /^comment$/i }).click());
}

function statusText(): string {
  return document.querySelector(".ap-status-msg")?.textContent ?? "";
}

async function commentCreatedCount(): Promise<number> {
  return (await agent.log()).filter((e) => e.type === "comment_created").length;
}

describe("App-level addComment overlap/anchor gate (protects addSpanComment)", () => {
  it("blocks an OVERLAPPING span: sets cant-overlap status and creates no comment", async () => {
    await mountApp();
    // Open the composer while the doc is clean, then the agent rewrites it so "Postgres" is now
    // wrapped in an anchor — the body the submit reads overlaps an existing comment link.
    mockSelection("Postgres");
    await act(async () => void document.dispatchEvent(new Event("selectionchange")));
    const btn = screen.getByRole("button", { name: /^comment on text$/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    await act(async () => void btn.click());
    const ta = await screen.findByPlaceholderText(/Add a comment/i);
    await act(async () => void fireEvent.change(ta, { target: { value: "Anchor it to Postgres." } }));

    // The composer stays open across an external (agent) rewrite — submit will read the new body.
    // Sync on the rewrite-SPECIFIC anchor (cmt-abc123 exists only post-rewrite); "here." is in both
    // the original and rewritten body, so waiting on it could pass on stale DOM.
    await act(async () => void agent.externalChange(DOC_WITH_ANCHOR));
    await waitFor(() => expect(document.querySelector('[data-cmt="cmt-abc123"]')).toBeTruthy());

    await act(async () => void screen.getByRole("button", { name: /^comment$/i }).click());

    // Cant-overlap status surfaced; the typed comment never landed.
    await waitFor(() => expect(statusText()).toBe("Comments can't overlap"));
    expect(document.body.textContent).not.toContain("Anchor it to Postgres.");
    // Only the pre-existing alice anchor exists — no new comment anchor was wrapped in.
    expect(document.querySelectorAll("[data-cmt]")).toHaveLength(1);
    expect(document.querySelector('[data-cmt="cmt-abc123"]')).toBeTruthy();
    // No comment_created control event was logged (the agent's edit must not have woken a create).
    expect(await commentCreatedCount()).toBe(0);
  });

  it("blocks a NON-ANCHORABLE selection: sets cant-anchor status and creates no comment", async () => {
    await mountApp();
    mockSelection("Postgres");
    await act(async () => void document.dispatchEvent(new Event("selectionchange")));
    const btn = screen.getByRole("button", { name: /^comment on text$/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    await act(async () => void btn.click());
    const ta = await screen.findByPlaceholderText(/Add a comment/i);
    await act(async () => void fireEvent.change(ta, { target: { value: "Anchor it to Postgres." } }));

    // The agent replaces "Postgres" with "MySQL" — the captured target no longer maps to any source
    // range → spanCommentBlocker returns "not-found".
    await act(async () => void agent.externalChange(DOC_TEXT_GONE));
    await waitFor(() => expect(document.body.textContent).toContain("MySQL"));

    await act(async () => void screen.getByRole("button", { name: /^comment$/i }).click());

    await waitFor(() => expect(statusText()).toBe("Comments can't be anchored to this selection"));
    expect(document.body.textContent).not.toContain("Anchor it to Postgres.");
    expect(document.querySelector("[data-cmt]")).toBeNull();
    expect(await commentCreatedCount()).toBe(0);
  });

  it("creates the span comment for a clean, non-overlapping selection", async () => {
    await mountApp();
    await composeAndSubmit("Postgres", "Anchor it to Postgres.");

    // The composer closed and the comment text now shows in the rail.
    await waitFor(() => expect(screen.queryByPlaceholderText(/Add a comment/i)).toBeNull());
    await waitFor(() => expect(document.body.textContent).toContain("Anchor it to Postgres."));
    // "Postgres" became a span anchor (a comment link) and one comment_created event was logged.
    await waitFor(() => expect(document.querySelector("[data-cmt]")).toBeTruthy());
    expect(statusText()).not.toBe("Comments can't overlap");
    expect(await commentCreatedCount()).toBe(1);
  });
});
