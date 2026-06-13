// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// App-level integration test for the review-time SPAN-comment DEMOTION on Apply
// (App.tsx applyProposal, ~1124-1130). While an agent Review proposal is open,
// the human selects body text and creates a SPAN comment — anchoring it in the
// live (base) body. Accepting the proposal rebuilds the body from the agent's
// diff, so that review-time anchor link is GONE from the accepted body. A naive
// merge would leave a root span comment with no in-body link (span_missing_link)
// or, worse, a dangling anchor. The demotion safety net rewrites such a root
// span comment to anchor:"doc" — keeping it (not dropped, not dangling) and its
// replies parentId-linked — so the saved canonical doc still passes
// checkIntegrity.
//
// SourceEditor (CodeMirror) is stubbed — it needs layout APIs happy-dom only
// stubs, and the merge/demotion logic under test lives entirely in App.
// window.getSelection is mocked because happy-dom can't make a real selection
// (mirrors App.spanComment.test.tsx).

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { forwardRef, useImperativeHandle } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkIntegrity, parse } from "@inplan/core";
import { createMemoryApi, type MemoryAgent } from "../src/memoryApi";

vi.mock("../src/SourceEditor", () => ({
  SourceEditor: forwardRef(function SourceEditorStub(_props: unknown, ref: React.Ref<unknown>) {
    useImperativeHandle(ref, () => ({ scrollToLine() {}, selectRange() {} }));
    return null;
  }),
}));

// Base body has a distinctive phrase the human will anchor a span comment to.
const DOC = "# Plan\n\nThe greeting line here.\n\n<!--inplan v1\n[]\n-->\n";
// The agent's proposal rewrites that same line, so the human's review-time span
// anchor (added to the base body) cannot survive into the accepted body.
const REVISED = "# Plan\n\nThe farewell line here.\n\n<!--inplan v1\n[]\n-->\n";

let agent: MemoryAgent;
let origGetSelection: typeof window.getSelection;

type Win = {
  api: { getProposal(): Promise<string | null>; load(): Promise<{ content: string }> };
};

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

function mockSelection(text: string) {
  const range = { cloneRange: () => range, getBoundingClientRect: () => ({ left: 0, bottom: 0, top: 0, right: 0, width: 0, height: 0 }) } as unknown as Range;
  window.getSelection = (() => ({ toString: () => text, rangeCount: 1, getRangeAt: () => range, removeAllRanges() {}, addRange() {} })) as unknown as typeof window.getSelection;
}

describe("App applyProposal span demotion (memory-backed)", () => {
  it("demotes a review-time span comment to doc-level when its anchor doesn't survive Accept, keeping replies linked and the doc valid", async () => {
    const { App } = await import("../src/App");
    render(<App />);
    await waitFor(() => expect(document.body.textContent).toContain("The greeting line here."));

    // The agent parks a Review-mode proposal that rewrites the greeting line.
    await act(async () => {
      agent.proposeRevision(REVISED);
    });
    await waitFor(() => expect(document.body.textContent).toContain("Agent proposed changes"));

    // WHILE the proposal is open, the human selects body text and creates a SPAN
    // comment. addSpanComment wraps the selection in the LIVE (base) body with an
    // anchor link `[..](#cmt-id)` — so the span is anchored, valid, and shows in the rail.
    mockSelection("The greeting line here.");
    await act(async () => void document.dispatchEvent(new Event("selectionchange")));
    await act(async () => void screen.getByRole("button", { name: /^comment on text$/i }).click());
    const ta = await screen.findByPlaceholderText(/Add a comment/i);
    const SPAN_NOTE = "Reconsider this whole line.";
    await act(async () => void fireEvent.change(ta, { target: { value: SPAN_NOTE } }));
    await act(async () => void screen.getByRole("button", { name: /^comment$/i }).click());
    await waitFor(() => expect(document.body.textContent).toContain(SPAN_NOTE));

    // It anchored as a real SPAN (not doc-level): the rail card surfaces the new
    // thread root. Recover its id from the card so we can drive its reply + assert
    // on it after Apply. (During review the preview renders the diff, so the live
    // base-body anchor element isn't painted in the preview — the data lives in the doc.)
    const cardEl = await waitFor(() => {
      const el = document.querySelector('[data-cmt-card^="cmt-"]');
      if (!el) throw new Error("no thread card yet");
      return el as HTMLElement;
    });
    const spanId = cardEl.getAttribute("data-cmt-card")!;
    expect(spanId).toMatch(/^cmt-/);
    expect(cardEl.textContent).toContain(SPAN_NOTE);

    // The human adds a REPLY to that span thread — a child whose parentId points at the span.
    const cardSel = `[data-cmt-card="${spanId}"]`;
    const cardScope = () => within(document.querySelector(cardSel) as HTMLElement);
    await act(async () => void fireEvent.click(cardScope().getByRole("button", { name: /^reply$/i })));
    const replyBox = await waitFor(() => cardScope().getByPlaceholderText(/Reply/));
    const REPLY_NOTE = "Agreed, rephrase it.";
    await act(async () => void fireEvent.change(replyBox, { target: { value: REPLY_NOTE } }));
    await act(async () => void fireEvent.click(cardScope().getByRole("button", { name: /^comment$/i })));
    await waitFor(() => expect((document.querySelector(cardSel) as HTMLElement).textContent).toContain(REPLY_NOTE));

    // Accept the whole proposal (default tri-state = accept-all) and apply.
    await act(async () => void screen.getByRole("button", { name: /^apply$/i }).click());

    // Review bar cleared; the agent's accepted body landed (the greeting line is gone).
    await waitFor(() => expect(document.body.textContent).not.toContain("Agent proposed changes"));
    expect(document.body.textContent).toContain("The farewell line here.");
    expect(document.body.textContent).not.toContain("The greeting line here.");

    // The span comment + its reply SURVIVED the merge (not dropped).
    expect(document.body.textContent).toContain(SPAN_NOTE);
    expect(document.body.textContent).toContain(REPLY_NOTE);

    const { api } = window as unknown as Win;
    expect(await api.getProposal()).toBeNull();

    // The saved canonical document is valid: the orphaned span was DEMOTED to a
    // doc-level comment (anchor:"doc"), not left as a dangling/linkless span.
    const persisted = await api.load();
    const saved = parse(persisted.content);

    const root = saved.comments.find((c) => c.id === spanId);
    expect(root).toBeTruthy();
    expect(root!.parentId).toBeUndefined(); // still a thread root
    expect(root!.anchor).toBe("doc"); // demoted (no longer a span)
    expect(persisted.content).not.toContain(`](#${spanId})`); // no in-body anchor link survives

    // The reply stayed linked to the (now-doc) root.
    const reply = saved.comments.find((c) => c.parentId === spanId);
    expect(reply).toBeTruthy();
    expect(reply!.text).toBe(REPLY_NOTE);

    // The agent's proposed (empty) comment snapshot didn't clobber our comments.
    expect(saved.comments.some((c) => c.text === SPAN_NOTE)).toBe(true);

    // Integrity: no span_missing_link / dangling_link / missing_parent on the saved doc.
    // (If the reply were NOT repaired and integrity failed here, that's a REAL bug —
    // see suspectedBug; this assertion would be left as it.fails.)
    const integrity = checkIntegrity(saved);
    const codes = integrity.errors.map((e) => e.code);
    expect(codes).not.toContain("span_missing_link");
    expect(codes).not.toContain("dangling_link");
    expect(codes).not.toContain("missing_parent");
    expect(integrity.ok).toBe(true);

    // The merge logged a full-accept revision decision.
    const events = await agent.log();
    expect(events.some((e) => e.type === "revision_accepted_all")).toBe(true);
  });
});
