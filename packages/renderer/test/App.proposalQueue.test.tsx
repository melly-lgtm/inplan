// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// App-level coverage for the proposals-v1 QUEUE (phase D): the review surfaces the doc's oldest
// pending proposal with a count, a decision settles that exact row AND logs an id-carrying
// decision event, the next proposal in the queue surfaces automatically, and a STALE proposal
// (written against an older canonical) is reviewed as a 3-way merge that preserves the current
// document's own unrelated changes.
//
// The host Api is a hand-built stub around the memory session: the queue semantics under test
// live in the HOST (the web bridge serves the oldest pending row), so the stub plays that role
// while App is exercised for real.

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { forwardRef, useImperativeHandle } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryApi } from "../src/memoryApi";
import type { Api } from "../src/api";

vi.mock("../src/SourceEditor", () => ({
  SourceEditor: forwardRef(function SourceEditorStub(_props: unknown, ref: React.Ref<unknown>) {
    useImperativeHandle(ref, () => ({ scrollToLine() {}, selectRange() {} }));
    return null;
  }),
}));

const BLOCK = "<!--inplan v1\n[]\n-->\n";
const DOC = `# Plan\n\nAlpha line.\n\nBeta line.\n\n${BLOCK}`;

interface QueueRow {
  id: string;
  content: string;
  baseContent?: string;
  pending?: number;
}

let queue: QueueRow[];
let decisions: Array<{ outcome?: string; id?: string }>;
let logged: Array<{ type: string; payload?: unknown }>;

function install(content: string, rows: QueueRow[]): void {
  document.body.innerHTML = '<div id="root"></div>';
  queue = rows;
  decisions = [];
  logged = [];
  const session = createMemoryApi({ content });
  const api: Api = {
    ...session.api,
    // The host serves the queue HEAD (oldest pending), with the live count.
    async getProposal() {
      const head = queue[0];
      return head ? { ...head, pending: queue.length } : null;
    },
    async clearProposal(outcome, id) {
      decisions.push({ ...(outcome ? { outcome } : {}), ...(id ? { id } : {}) });
      queue = queue.filter((r) => r.id !== id);
    },
    async logAction(type, payload) {
      logged.push({ type, ...(payload !== undefined ? { payload } : {}) });
    },
  };
  (window as unknown as { api: unknown }).api = api;
}

afterEach(cleanup);

async function mount() {
  const { App } = await import("../src/App");
  render(<App />);
  await waitFor(() => expect(document.body.textContent).toContain("Agent proposed changes"));
}

const applyAll = async () => {
  const apply = screen.getByRole("button", { name: /^apply$/i });
  await act(async () => {
    apply.click();
  });
};

describe("proposal queue (phase D)", () => {
  it("reviews the queue oldest-first with a count, settles the exact row, and advances", async () => {
    install(DOC, [
      { id: "row-a", content: DOC.replace("Alpha line.", "Alpha FROM-A.") },
      { id: "row-b", content: DOC.replace("Beta line.", "Beta FROM-B.") },
    ]);
    await mount();

    // The head of the queue is under review, with its position in the queue visible.
    expect(document.body.textContent).toContain("1 of 2");
    expect(document.body.textContent).toContain("Alpha FROM-A.");

    await applyAll();

    // The decision settled row-a EXACTLY, and the decision event names it.
    expect(decisions).toEqual([{ outcome: "accepted", id: "row-a" }]);
    expect(logged).toContainEqual({ type: "revision_accepted_all", payload: expect.objectContaining({ proposal_id: "row-a" }) });

    // The queue advanced: row-b's review surfaced without any new park signal.
    await waitFor(() => expect(document.body.textContent).toContain("Beta FROM-B."));
    expect(document.body.textContent).not.toContain("1 of 2"); // last one — no queue chip

    await applyAll();
    expect(decisions[1]).toEqual({ outcome: "accepted", id: "row-b" });
    await waitFor(() => expect(document.body.textContent).not.toContain("Agent proposed changes"));
  });

  it("a stale proposal is reviewed as a 3-way merge that keeps the current document's own changes", async () => {
    // The proposal was written against ORIGINAL (Beta edit), but the canonical has since changed
    // Alpha. The review must replay ONLY the proposal's Beta edit onto the current text.
    const current = DOC.replace("Alpha line.", "Alpha EDITED-SINCE.");
    install(current, [
      {
        id: "row-stale",
        content: DOC.replace("Beta line.", "Beta FROM-PROPOSAL."),
        baseContent: DOC,
      },
    ]);
    await mount();

    // Staleness is surfaced to the reviewer…
    expect(document.body.textContent).toContain("written against an older version");
    // …and the merged review keeps the canonical's own Alpha edit while proposing the Beta one.
    await applyAll();
    await waitFor(() => expect(document.body.textContent).toContain("Alpha EDITED-SINCE."));
    expect(document.body.textContent).toContain("Beta FROM-PROPOSAL.");
    expect(decisions).toEqual([{ outcome: "accepted", id: "row-stale" }]);
  });

  it("a proposal whose base matches the current canonical shows no stale notice", async () => {
    install(DOC, [{ id: "row-fresh", content: DOC.replace("Beta line.", "Beta FRESH."), baseContent: DOC }]);
    await mount();
    expect(document.body.textContent).not.toContain("written against an older version");
    expect(document.body.textContent).not.toContain("1 of 1");
  });
});
