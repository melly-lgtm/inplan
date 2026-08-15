// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";
import { MemoryControlChannel, MemoryDocumentStore, LogEventType } from "@inplan/core";
import { applyGatedEdit } from "../src/applyEdit";
import type { AgentEditEvaluation } from "../src/gate";
import type { PluginGate } from "../src/pluginGate";

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
    expect(await store.getProposed()).toBe("agent body");
    expect(await store.loadDoc()).toBe("canon"); // working file reverted to canonical
    expect(await types(channel)).toEqual([LogEventType.AgentRevisionProposed]);
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
    store.setProposed = async () => {
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
    expect(applied).toEqual({ proposed: true });
    expect(await store.getProposed()).toBe("agent body");
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
    expect(applied).toEqual({ proposed: true }); // no crash, no false failure
    expect(await store.getProposed()).toBe("agent body");
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
    expect(await store.getProposed()).toBe("agent body");
    expect(await store.loadDoc()).toBe("agent body"); // NOT reverted to canon
    expect(gate.applyRevision).not.toHaveBeenCalled();
    expect(await types(channel)).toEqual([LogEventType.AgentRevisionProposed]);
  });
});
