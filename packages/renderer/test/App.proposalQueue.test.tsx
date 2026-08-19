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
let agentRef: ReturnType<typeof createMemoryApi>["agent"] | null = null;

function install(content: string, rows: QueueRow[]): void {
  document.body.innerHTML = '<div id="root"></div>';
  queue = rows;
  decisions = [];
  logged = [];
  const session = createMemoryApi({ content });
  agentRef = session.agent;
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
  it("reviews the queue oldest-first with a count, settles exact rows, and sequential accepts preserve each other", async () => {
    // Both proposals were written against the SAME base (two proposers parked concurrently).
    // After row-a is accepted, row-b is stale relative to the new canonical — the merge path is
    // what keeps row-a's accepted edit alive through row-b's acceptance. Asserting the FINAL
    // document is the point: the queue mechanics can all pass while a whole-doc overwrite
    // silently reverts the earlier acceptance.
    install(DOC, [
      { id: "row-a", content: DOC.replace("Alpha line.", "Alpha FROM-A."), baseContent: DOC },
      { id: "row-b", content: DOC.replace("Beta line.", "Beta FROM-B."), baseContent: DOC },
    ]);
    await mount();

    // The head of the queue is under review, with its position in the queue visible.
    expect(document.body.textContent).toContain("1 of 2");
    expect(document.body.textContent).toContain("Alpha FROM-A.");

    await applyAll();

    // The decision settled row-a EXACTLY, and the decision event names it.
    await waitFor(() => expect(decisions).toEqual([{ outcome: "accepted", id: "row-a" }]));
    expect(logged).toContainEqual({ type: "revision_accepted_all", payload: expect.objectContaining({ proposal_id: "row-a" }) });

    // The queue advanced: row-b's review surfaced without any new park signal, stale against
    // the just-accepted canonical.
    await waitFor(() => expect(document.body.textContent).toContain("Beta FROM-B."));
    expect(document.body.textContent).not.toContain("1 of 2"); // last one — no queue chip
    expect(document.body.textContent).toContain("written against an older version");

    await applyAll();
    await waitFor(() => expect(decisions[1]).toEqual({ outcome: "accepted", id: "row-b" }));
    await waitFor(() => expect(document.body.textContent).not.toContain("Agent proposed changes"));
    // BOTH accepted edits are in the final document — the second acceptance replayed onto the
    // first instead of reverting it.
    expect(document.body.textContent).toContain("Alpha FROM-A.");
    expect(document.body.textContent).toContain("Beta FROM-B.");
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

  it("a decision raced by another reviewer logs NO event and restores the pre-apply document", async () => {
    install(DOC, [{ id: "row-raced", content: DOC.replace("Alpha line.", "Alpha RACED."), baseContent: DOC }]);
    // The host's settle rejects: someone else decided the row while Apply was in flight — and
    // their decision consumed the queue.
    const api = (window as unknown as { api: Api }).api;
    api.clearProposal = async () => {
      queue = [];
      throw new Error("proposal row-raced was decided elsewhere");
    };
    await mount();
    await applyAll();
    await waitFor(() => expect(document.body.textContent).toContain("decided elsewhere"));
    // No phantom decision event for a settlement this call never made — and canonical is
    // untouched: the applied body was rolled back to the pre-apply document.
    expect(logged.filter((l) => l.type.startsWith("revision_"))).toEqual([]);
    await waitFor(() => expect(document.body.textContent).toContain("Alpha line."));
    expect(document.body.textContent).not.toContain("Alpha RACED.");
  });

  it("a TRANSIENT settle failure keeps the still-pending review open and invites a retry", async () => {
    install(DOC, [{ id: "row-flaky", content: DOC.replace("Alpha line.", "Alpha FLAKY."), baseContent: DOC }]);
    // The settle rejects but the row is STILL the queue head — a transport blip, not a decision.
    const api = (window as unknown as { api: Api }).api;
    api.clearProposal = async () => {
      throw new Error("network hiccup");
    };
    await mount();
    await applyAll();
    await waitFor(() => expect(document.body.textContent).toContain("try Apply again"));
    // The review is still there (same proposal, still pending) and no decision event was logged.
    expect(document.body.textContent).toContain("Agent proposed changes");
    expect(logged.filter((l) => l.type.startsWith("revision_"))).toEqual([]);
  });

  it("memory host: clearProposal rejects when the row was decided elsewhere", async () => {
    const session = createMemoryApi({ content: DOC });
    await session.agent.proposeRevision(DOC.replace("Alpha line.", "X."));
    const head = await session.api.getProposal();
    await session.api.clearProposal("rejected", head!.id); // the other reviewer's decision lands first
    await expect(session.api.clearProposal("accepted", head!.id)).rejects.toThrow(/decided elsewhere/);
  });

  it("an external change landing mid-review REBASES the open review — Apply cannot overwrite it", async () => {
    install(DOC, [{ id: "row-open", content: DOC.replace("Beta line.", "Beta FROM-PROPOSAL."), baseContent: DOC }]);
    await mount();
    expect(document.body.textContent).not.toContain("written against an older version");

    // The canonical changes underneath the open review (an auto-accepted agent edit elsewhere).
    const changed = DOC.replace("Alpha line.", "Alpha CHANGED-UNDERNEATH.");
    await act(async () => {
      agentRef!.externalChange(changed);
    });

    // The review rebased: now marked stale, and applying keeps BOTH the external change and the
    // proposal's own edit — the frozen pre-change diff base would have overwritten the former.
    await waitFor(() => expect(document.body.textContent).toContain("written against an older version"));
    await applyAll();
    await waitFor(() => expect(document.body.textContent).toContain("Alpha CHANGED-UNDERNEATH."));
    expect(document.body.textContent).toContain("Beta FROM-PROPOSAL.");
  });

  it("an external rewrite landing MID-SETTLE is not overwritten — the publish rebases onto it", async () => {
    install(DOC, [{ id: "row-slow", content: DOC.replace("Beta line.", "Beta ACCEPTED."), baseContent: DOC }]);
    const api = (window as unknown as { api: Api }).api;
    const origClear = api.clearProposal.bind(api);
    let release!: () => void;
    api.clearProposal = (outcome, id) =>
      new Promise((res) => {
        release = () => res(origClear(outcome, id));
      });
    await mount();
    await applyAll(); // the settle is now in flight — nothing published yet

    // An auto-accepted agent edit rewrites the document while the settle is pending.
    await act(async () => {
      agentRef!.externalChange(DOC.replace("Alpha line.", "Alpha MID-SETTLE."));
    });
    await act(async () => {
      release(); // the settle wins now — the publish must rebase, not overwrite
    });

    await waitFor(() => expect(document.body.textContent).toContain("Alpha MID-SETTLE."));
    expect(document.body.textContent).toContain("Beta ACCEPTED.");
  });

  it("a proposal whose base matches the current canonical shows no stale notice", async () => {
    install(DOC, [{ id: "row-fresh", content: DOC.replace("Beta line.", "Beta FRESH."), baseContent: DOC }]);
    await mount();
    expect(document.body.textContent).not.toContain("written against an older version");
    expect(document.body.textContent).not.toContain("1 of 1");
  });
});
