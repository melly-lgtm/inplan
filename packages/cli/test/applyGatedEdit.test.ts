// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";
import { MemoryControlChannel, MemoryDocumentStore, LogEventType } from "@inplan/core";
import { applyGatedEdit } from "../src/applyEdit";
import type { AgentEditEvaluation } from "../src/gate";
import type { HubGate } from "../src/peerGate";

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

const fakeHub = (): HubGate & { readCanonical: ReturnType<typeof vi.fn>; applyRevision: ReturnType<typeof vi.fn> } => ({
  readCanonical: vi.fn(async () => "live"),
  applyRevision: vi.fn(async () => {}),
});

const types = async (ch: MemoryControlChannel): Promise<string[]> => (await ch.readSince(0)).entries.map((e) => e.type);

describe("applyGatedEdit — file path (no hub)", () => {
  it("auto-accepts a body change: advances canonical, clears proposed, logs DocumentEdited", async () => {
    const store = new MemoryDocumentStore("new body");
    const channel = new MemoryControlChannel();
    await applyGatedEdit(store, channel, ev({ changed: true }), { current: "new body", canonicalText: "old", quarantine: false, hub: null });
    expect(await store.getCanonical()).toBe("new body");
    expect(await types(channel)).toEqual([LogEventType.DocumentEdited]);
  });

  it("quarantines a Review-mode body change: parks proposed, reverts the file to canonical, logs AgentRevisionProposed", async () => {
    const store = new MemoryDocumentStore("agent body");
    const channel = new MemoryControlChannel();
    await applyGatedEdit(store, channel, ev({ changed: true }), { current: "agent body", canonicalText: "canon", quarantine: true, hub: null });
    expect(await store.getProposed()).toBe("agent body");
    expect(await store.loadDoc()).toBe("canon"); // working file reverted to canonical
    expect(await types(channel)).toEqual([LogEventType.AgentRevisionProposed]);
  });

  it("confirmed deletions: writes acceptedText to file + canonical, clears proposed, logs DocumentEdited", async () => {
    const store = new MemoryDocumentStore("with comment");
    const channel = new MemoryControlChannel();
    await applyGatedEdit(store, channel, ev({ changed: true, removedIds: ["cmt-1"], acceptedText: "clean" }), { current: "with comment", canonicalText: "canon", quarantine: false, hub: null });
    expect(await store.loadDoc()).toBe("clean");
    expect(await store.getCanonical()).toBe("clean");
    expect(await types(channel)).toEqual([LogEventType.DocumentEdited]);
  });

  it("no change: writes nothing, logs nothing", async () => {
    const store = new MemoryDocumentStore("same");
    const channel = new MemoryControlChannel();
    await applyGatedEdit(store, channel, ev({ changed: false }), { current: "same", canonicalText: "same", quarantine: false, hub: null });
    expect(await store.getCanonical()).toBeNull();
    expect(await types(channel)).toEqual([]);
  });
});

describe("applyGatedEdit — hub path (live-collab peer connected)", () => {
  it("auto-accept pushes the current text into the live doc and never touches the .md", async () => {
    const store = new MemoryDocumentStore("agent body");
    const channel = new MemoryControlChannel();
    const hub = fakeHub();
    await applyGatedEdit(store, channel, ev({ changed: true }), { current: "agent body", canonicalText: "live", quarantine: false, hub });
    expect(hub.applyRevision).toHaveBeenCalledWith("agent body");
    expect(await store.getCanonical()).toBeNull(); // file canonical untouched — the hub owns it
    expect(await types(channel)).toEqual([LogEventType.DocumentEdited]);
  });

  it("confirmed deletions push acceptedText through the hub, not the file", async () => {
    const store = new MemoryDocumentStore("with comment");
    const channel = new MemoryControlChannel();
    const hub = fakeHub();
    await applyGatedEdit(store, channel, ev({ changed: true, removedIds: ["cmt-1"], acceptedText: "clean" }), { current: "with comment", canonicalText: "live", quarantine: false, hub });
    expect(hub.applyRevision).toHaveBeenCalledWith("clean");
    expect(await store.loadDoc()).toBe("with comment"); // .md untouched
    expect(await types(channel)).toEqual([LogEventType.DocumentEdited]);
  });

  it("quarantine still parks a proposal but does NOT revert the .md (the hub owns the working doc)", async () => {
    const store = new MemoryDocumentStore("agent body");
    const channel = new MemoryControlChannel();
    const hub = fakeHub();
    await applyGatedEdit(store, channel, ev({ changed: true }), { current: "agent body", canonicalText: "canon", quarantine: true, hub });
    expect(await store.getProposed()).toBe("agent body");
    expect(await store.loadDoc()).toBe("agent body"); // NOT reverted to canon
    expect(hub.applyRevision).not.toHaveBeenCalled();
    expect(await types(channel)).toEqual([LogEventType.AgentRevisionProposed]);
  });
});
