// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";
import { MemoryControlChannel, MemoryDocumentStore, LogEventType } from "@inplan/core";
import { applyGatedEdit, shouldQuarantine } from "../src/applyEdit";
import type { AgentEditEvaluation } from "../src/gate";
import type { PluginGate } from "../src/pluginGate";
import { proposedContent } from "./helpers";

const ev = (over: Partial<AgentEditEvaluation> = {}): AgentEditEvaluation => ({
  integrityOk: true,
  integrityErrors: [],
  lost: [],
  unconfirmed: [],
  removedIds: [],
  acceptedText: "",
  changed: false,
  ...over,
});

const fakeGate = (): PluginGate & { readCanonical: ReturnType<typeof vi.fn>; applyRevision: ReturnType<typeof vi.fn> } => ({
  readCanonical: vi.fn(async () => "live"),
  applyRevision: vi.fn(async () => {}),
});

const types = async (ch: MemoryControlChannel): Promise<string[]> => (await ch.readSince(0)).entries.map((e) => e.type);

describe("applyGatedEdit — file path (no plugin)", () => {
  it("auto-accepts a body change: advances canonical, clears proposed, logs DocumentEdited", async () => {
    const store = new MemoryDocumentStore("new body");
    const channel = new MemoryControlChannel();
    const applied = await applyGatedEdit(store, channel, ev({ changed: true }), { current: "new body", canonicalText: "old", quarantine: false, gate: null });
    expect(applied.proposed).toBe(false);
    expect(await store.getCanonical()).toBe("new body");
    expect(await types(channel)).toEqual([LogEventType.DocumentEdited]);
  });

  it("quarantines a Review-mode body change: parks proposed, reverts the file to canonical, logs AgentRevisionProposed", async () => {
    const store = new MemoryDocumentStore("agent body");
    const channel = new MemoryControlChannel();
    const applied = await applyGatedEdit(store, channel, ev({ changed: true }), { current: "agent body", canonicalText: "canon", quarantine: true, gate: null });
    expect(applied.proposed).toBe(true); // the caller surfaces the park (#88)
    expect(await proposedContent(store)).toBe("agent body");
    expect(await store.loadDoc()).toBe("canon"); // working file reverted to canonical
    expect(await types(channel)).toEqual([LogEventType.AgentRevisionProposed]);
  });

  it("quarantine with a BLANK canonical parks the proposal but never wipes the working file (#95)", async () => {
    // `open` on a fresh path seeds an empty canonical; the agent's first fill is the only copy of
    // the text. The revert used to materialize the empty canonical over it — a total wipe.
    const store = new MemoryDocumentStore("the whole plan body");
    const channel = new MemoryControlChannel();
    const applied = await applyGatedEdit(store, channel, ev({ changed: true }), { current: "the whole plan body", canonicalText: "", quarantine: true, gate: null });
    expect(applied.proposed).toBe(true); // review semantics intact: the park still happens
    expect(await proposedContent(store)).toBe("the whole plan body");
    expect(await store.loadDoc()).toBe("the whole plan body"); // NOT reverted — this is the only copy
    expect(await types(channel)).toEqual([LogEventType.AgentRevisionProposed]);
  });

  it("the wipe guard judges the BODY, not the raw text: a comments-only canonical is still blank", async () => {
    // A canonical holding only the comment data block (no body) is the same total-wipe shape.
    const store = new MemoryDocumentStore("the whole plan body");
    const channel = new MemoryControlChannel();
    const canonicalText = "<!--inplan\n[]\n-->\n";
    const applied = await applyGatedEdit(store, channel, ev({ changed: true }), { current: "the whole plan body", canonicalText, quarantine: true, gate: null });
    expect(applied.proposed).toBe(true);
    expect(await store.loadDoc()).toBe("the whole plan body"); // NOT reverted
  });

  it("confirmed deletions: writes acceptedText to file + canonical, clears proposed, logs DocumentEdited", async () => {
    const store = new MemoryDocumentStore("with comment");
    const channel = new MemoryControlChannel();
    await applyGatedEdit(store, channel, ev({ changed: true, removedIds: ["cmt-1"], acceptedText: "clean" }), { current: "with comment", canonicalText: "canon", quarantine: false, gate: null });
    expect(await store.loadDoc()).toBe("clean");
    expect(await store.getCanonical()).toBe("clean");
    expect(await types(channel)).toEqual([LogEventType.DocumentEdited]);
  });

  it("park failure degrades: the file is NOT reverted, no event is appended, parkFailed is reported", async () => {
    // A crashed park used to reject all the way out of waitCycle — no status, no marker — and a
    // continued turn would have re-synced the working copy over the ONLY copy of the edit.
    const store = new MemoryDocumentStore("agent body");
    store.createProposal = async () => {
      throw new Error("hub down");
    };
    const channel = new MemoryControlChannel();
    const applied = await applyGatedEdit(store, channel, ev({ changed: true }), { current: "agent body", canonicalText: "canon", quarantine: true, gate: null });
    expect(applied).toEqual({ proposed: false, parkFailed: true });
    expect(await store.loadDoc()).toBe("agent body"); // NOT reverted — this is the only copy
    expect(await types(channel)).toEqual([]); // nothing was proposed, so no event claims it was
  });

  it("a failed canonical restore AFTER a successful push is a COMPLETED park, not a failed one", async () => {
    // The store holds the proposal (the human can see it in their editor), so the log and return
    // must say so — claiming FAILED here is the same false signal #88 exists to kill. The failed
    // revert just leaves the edit in the working copy, where the hydration guard protects it.
    const store = new MemoryDocumentStore("agent body");
    store.saveDoc = async () => {
      throw new Error("disk full");
    };
    const channel = new MemoryControlChannel();
    const applied = await applyGatedEdit(store, channel, ev({ changed: true }), { current: "agent body", canonicalText: "canon", quarantine: true, gate: null });
    expect(applied).toEqual({ proposed: true, proposalId: (await store.myPendingProposal())?.id }); // the id names the parked row
    expect(await proposedContent(store)).toBe("agent body");
    expect(await store.loadDoc()).toBe("agent body"); // revert failed — edit stays put
    expect(await types(channel)).toEqual([LogEventType.AgentRevisionProposed]); // the park is logged
  });

  it("a failed event append after a successful park still reports proposed — the park is real", async () => {
    const store = new MemoryDocumentStore("agent body");
    const channel = new MemoryControlChannel();
    channel.append = async () => {
      throw new Error("log unavailable");
    };
    const applied = await applyGatedEdit(store, channel, ev({ changed: true }), { current: "agent body", canonicalText: "canon", quarantine: true, gate: null });
    expect(applied).toEqual({ proposed: true, proposalId: (await store.myPendingProposal())?.id, eventLogged: false }); // no crash, no false failure — and the missing event is reported
    expect(await proposedContent(store)).toBe("agent body");
    expect(await store.loadDoc()).toBe("canon"); // the revert did run
  });

  it("no change: writes nothing, logs nothing", async () => {
    const store = new MemoryDocumentStore("same");
    const channel = new MemoryControlChannel();
    const applied = await applyGatedEdit(store, channel, ev({ changed: false }), { current: "same", canonicalText: "same", quarantine: false, gate: null });
    expect(applied.proposed).toBe(false);
    expect(await store.getCanonical()).toBeNull();
    expect(await types(channel)).toEqual([]);
  });
});

describe("applyGatedEdit — plugin path (a plugin gate is connected)", () => {
  it("auto-accept pushes the current text into the plugin and never touches the .md", async () => {
    const store = new MemoryDocumentStore("agent body");
    const channel = new MemoryControlChannel();
    const gate = fakeGate();
    await applyGatedEdit(store, channel, ev({ changed: true }), { current: "agent body", canonicalText: "live", quarantine: false, gate });
    expect(gate.applyRevision).toHaveBeenCalledWith("agent body");
    expect(await store.getCanonical()).toBeNull(); // file canonical untouched — the plugin owns it
    expect(await types(channel)).toEqual([LogEventType.DocumentEdited]);
  });

  it("confirmed deletions push acceptedText through the plugin, not the file", async () => {
    const store = new MemoryDocumentStore("with comment");
    const channel = new MemoryControlChannel();
    const gate = fakeGate();
    await applyGatedEdit(store, channel, ev({ changed: true, removedIds: ["cmt-1"], acceptedText: "clean" }), { current: "with comment", canonicalText: "live", quarantine: false, gate });
    expect(gate.applyRevision).toHaveBeenCalledWith("clean");
    expect(await store.loadDoc()).toBe("with comment"); // .md untouched
    expect(await types(channel)).toEqual([LogEventType.DocumentEdited]);
  });

  it("quarantine still parks a proposal but does NOT revert the .md (the plugin owns the working doc)", async () => {
    const store = new MemoryDocumentStore("agent body");
    const channel = new MemoryControlChannel();
    const gate = fakeGate();
    const applied = await applyGatedEdit(store, channel, ev({ changed: true }), { current: "agent body", canonicalText: "canon", quarantine: true, gate });
    expect(applied.proposed).toBe(true);
    expect(await proposedContent(store)).toBe("agent body");
    expect(await store.loadDoc()).toBe("agent body"); // NOT reverted to canon
    expect(gate.applyRevision).not.toHaveBeenCalled();
    expect(await types(channel)).toEqual([LogEventType.AgentRevisionProposed]);
  });
});

describe("which carrier an edit went out on", () => {
  const payloadOf = async (ch: MemoryControlChannel) => (await ch.readSince(0)).entries[0]!.payload as { via?: string };

  it("stamps BOTH carriers — unstamped has to stay distinguishable as 'a CLI that predates this'", async () => {
    // The one fact about an edit only this process knows, and knows exactly. The editor uses it to
    // decide where to READ the edit from — the shared document, or the canonical the gate
    // advanced — because the working file is not a safe answer once a plugin is alive.
    const viaGate = new MemoryControlChannel();
    const gate = fakeGate();
    await applyGatedEdit(new MemoryDocumentStore("body"), viaGate, ev({ changed: true }), { current: "body", canonicalText: "canon", quarantine: false, gate });
    const viaFile = new MemoryControlChannel();
    const store = new MemoryDocumentStore("body");
    await applyGatedEdit(store, viaFile, ev({ changed: true }), { current: "body", canonicalText: "canon", quarantine: false, gate: null });

    expect((await payloadOf(viaGate)).via).toBe("plugin");
    expect(gate.applyRevision).toHaveBeenCalledWith("body"); // the stamp is true: it did go through the plugin
    expect((await payloadOf(viaFile)).via).toBe("file");
    expect(await store.getCanonical()).toBe("body"); // …and a file-stamped edit IS in the canonical, where the editor will look
  });

  it("stamps a confirmed deletion the same way", async () => {
    const channel = new MemoryControlChannel();
    await applyGatedEdit(new MemoryDocumentStore("body"), channel, ev({ changed: true, removedIds: ["cmt-aaa111"], acceptedText: "accepted" }), { current: "body", canonicalText: "canon", quarantine: false, gate: fakeGate() });
    expect((await payloadOf(channel)).via).toBe("plugin");
  });
});

describe("onlyIfUnmoved — writing against a document that may have moved", () => {
  it("skips the write when the document moved after the caller read it", async () => {
    // The live watcher decides against a snapshot while the human may be saving. Its file re-read
    // happens before the apply, so a save landing after it would still have had the canonical
    // overwritten with the older snapshot — and in review mode the next wait then reads the
    // human's own saved text as an agent revision and parks it back at them.
    const store = new MemoryDocumentStore("the agent's text");
    await store.setCanonical("canon");
    const channel = new MemoryControlChannel();
    await store.saveDoc("the human saved this instead"); // …the document moves under the decision

    const applied = await applyGatedEdit(store, channel, ev({ changed: true }), {
      current: "the agent's text",
      canonicalText: "canon",
      quarantine: false,
      gate: null,
      onlyIfUnmoved: true,
    });

    expect(applied.stale).toBe(true);
    expect(await store.getCanonical()).toBe("canon"); // nothing written
    expect(await types(channel)).toEqual([]); // and nothing logged
  });

  it("skips it when the CANONICAL moved, which is how the editor's own save shows up", async () => {
    const store = new MemoryDocumentStore("the agent's text");
    await store.setCanonical("a newer canonical the human just saved");
    const channel = new MemoryControlChannel();

    const applied = await applyGatedEdit(store, channel, ev({ changed: true }), {
      current: "the agent's text",
      canonicalText: "canon", // what the decision was made against
      quarantine: false,
      gate: null,
      onlyIfUnmoved: true,
    });

    expect(applied.stale).toBe(true);
    expect(await store.getCanonical()).toBe("a newer canonical the human just saved");
  });

  it("writes when nothing moved, and the turn path never asks for the check", async () => {
    const store = new MemoryDocumentStore("the agent's text");
    await store.setCanonical("canon");
    const channel = new MemoryControlChannel();

    const applied = await applyGatedEdit(store, channel, ev({ changed: true }), { current: "the agent's text", canonicalText: "canon", quarantine: false, gate: null, onlyIfUnmoved: true });

    expect(applied.stale).toBeUndefined();
    expect(await store.getCanonical()).toBe("the agent's text");
  });
});

describe("a landing edit and someone else's parked revision", () => {
  const WITH_COMMENT = 'canon\n\n<!--inplan\n[{"id":"cmt-aaa111","author":"a","date":"2026-01-01T00:00:00Z","resolved":false,"anchor":"doc","text":"q"}]\n-->\n';

  it("a comment-only landing leaves a parked body revision standing", async () => {
    // The park reverted the working copy, so the agent's next write — a comment added mid-turn —
    // is composed WITHOUT the parked revision's body. Retracting the proposal on that write
    // deleted the revision outright: reverted off disk, withdrawn from the pending set, never
    // decided by the human.
    const store = new MemoryDocumentStore(WITH_COMMENT);
    await store.setCanonical("canon");
    const { id } = await store.createProposal({ content: "the agent's rewritten body", baseHash: "h", baseContent: "canon" });
    const channel = new MemoryControlChannel();

    const applied = await applyGatedEdit(store, channel, ev({ changed: true }), { current: WITH_COMMENT, canonicalText: "canon", quarantine: false, gate: null });

    expect(applied.withdrew).toBeUndefined();
    expect((await store.myPendingProposal())?.id).toBe(id); // still the human's to decide
    expect(await store.getCanonical()).toBe(WITH_COMMENT); // …and the comment still landed
  });

  it("retracts it only when what landed IS that proposal's body", async () => {
    // Retracting is destructive — the proposal is the only copy of a revision the park reverted off
    // disk — so it takes the proposal's OWN body landing, which makes accepting it a no-op.
    const store = new MemoryDocumentStore("the proposed body");
    await store.setCanonical("canon");
    await store.createProposal({ content: "the proposed body", baseHash: "h", baseContent: "canon" });
    const channel = new MemoryControlChannel();

    const applied = await applyGatedEdit(store, channel, ev({ changed: true }), { current: "the proposed body", canonicalText: "canon", quarantine: false, gate: null });

    expect(applied.withdrew).toBe(true);
    expect(await store.myPendingProposal()).toBeNull();
  });

  it("leaves a proposal alone when a DIFFERENT body lands", async () => {
    // "The body changed at all" was the old test, and it fails quietly in the case that matters:
    // `inplan comment --span` writes its anchor link INTO the body, so under auto acceptance a span
    // comment counts as a body edit — and would retract a revision it has nothing to do with,
    // which the park had already reverted off disk. The proposal stands; the reviewer rebases a
    // stale one against the current canonical, so leaving it is safe where retracting is not.
    const store = new MemoryDocumentStore("canon with [an anchor](#cmt-aaa111)");
    await store.setCanonical("canon");
    const { id } = await store.createProposal({ content: "an entirely different revision", baseHash: "h", baseContent: "canon" });
    const channel = new MemoryControlChannel();

    const applied = await applyGatedEdit(store, channel, ev({ changed: true }), { current: "canon with [an anchor](#cmt-aaa111)", canonicalText: "canon", quarantine: false, gate: null });

    expect(applied.withdrew).toBeUndefined();
    expect((await store.myPendingProposal())?.id).toBe(id); // still the human's to decide
  });

});

describe("shouldQuarantine — park for the human, or land", () => {
  const withComments = (body: string): string => `${body}\n\n<!--inplan\n[{"id":"cmt-aaa111","author":"a","date":"2026-01-01T00:00:00Z","resolved":false,"text":"q"}]\n-->\n`;

  it("lands the first content of a brand-new doc: an empty base has no human text to protect", () => {
    // `open` seeds an EMPTY canonical and the agent fills the doc in. Parking that fill leaves the
    // human looking at the empty document the editor was launched on.
    expect(shouldQuarantine("review", "", "# The plan\n\nBody.\n")).toBe(false);
  });

  it("a blank body that carries a document-level comment is NOT an empty document: it parks", () => {
    // The human opens the empty doc and writes what they want covered. detectLostComments only
    // reports orphaned SPAN comments, so a fill that drops a doc-level comment passes the confirm
    // gate untouched — landing it would delete the human's words with no review and no prompt.
    expect(shouldQuarantine("review", withComments(""), "# The plan\n\nBody.\n")).toBe(true);
  });

  it("an unparseable base is not provably empty, so it parks", () => {
    expect(shouldQuarantine("review", "<!--inplan\nnot json\n-->\n", "# The plan\n\nBody.\n")).toBe(true);
  });

  it("parks a body change once the document has content", () => {
    expect(shouldQuarantine("review", "# The plan\n\nBody one.\n", "# The plan\n\nBody two.\n")).toBe(true);
  });

  it("never parks a comment-only change", () => {
    expect(shouldQuarantine("review", "# The plan\n", withComments("# The plan"))).toBe(false);
  });

  it("never parks in auto mode, including the first fill", () => {
    expect(shouldQuarantine("auto", "# The plan\n\nBody one.\n", "# The plan\n\nBody two.\n")).toBe(false);
    expect(shouldQuarantine("auto", "", "# The plan\n")).toBe(false);
  });
});
