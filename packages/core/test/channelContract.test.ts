// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Contract tests: the same scenarios run against every ControlChannel /
// DocumentStore implementation, proving the backends are interchangeable (so the
// cli/app can swap fs ⇄ memory ⇄ supabase without behaviour change).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FsControlChannel,
  FsDocumentStore,
  LogEventType,
  MemoryControlChannel,
  MemoryDocumentStore,
  type ControlChannel,
  type DocumentStore,
} from "../src/node";

interface Backend {
  channel: ControlChannel;
  store: DocumentStore;
  cleanup: () => void;
}

const BACKENDS: Record<string, () => Backend> = {
  memory: () => ({ channel: new MemoryControlChannel(), store: new MemoryDocumentStore(), cleanup: () => {} }),
  fs: () => {
    const dir = mkdtempSync(join(tmpdir(), "inplan-contract-"));
    const paths = {
      file: join(dir, "doc.plan.md"),
      logPath: join(dir, "log.jsonl"),
      canonicalPath: join(dir, "canonical.md"),
      proposedPath: join(dir, "proposed.md"),
      backupsDir: join(dir, "backups"),
      cursorPath: join(dir, "cursor"),
      waitLockPath: join(dir, "waitlock"),
    };
    return { channel: new FsControlChannel(paths), store: new FsDocumentStore(paths), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  },
};

for (const [name, make] of Object.entries(BACKENDS)) {
  describe(`ControlChannel contract — ${name}`, () => {
    let b: Backend;
    beforeEach(() => (b = make()));
    afterEach(() => b.cleanup());

    it("assigns increasing seq and reads incrementally from a cursor", async () => {
      const a = await b.channel.append({ actor: "user", type: LogEventType.TurnEnded });
      const c = await b.channel.append({ actor: "agent", type: LogEventType.AgentRevised });
      expect([a.seq, c.seq]).toEqual([1, 2]);
      const since = await b.channel.readSince(1);
      expect(since.entries.map((e) => e.seq)).toEqual([2]);
      expect(since.cursor).toBe(2);
      const all = await b.channel.readSince(0);
      expect(all.entries).toHaveLength(2);
    });

    it("persists a cursor (0 when unset)", async () => {
      expect(await b.channel.getCursor()).toBe(0);
      await b.channel.setCursor(5);
      expect(await b.channel.getCursor()).toBe(5);
    });

    it("supersedes an older lock holder when a newer token claims", async () => {
      await b.channel.claimLock("waiter-A");
      expect(await b.channel.isSuperseded("waiter-A")).toBe(false);
      await b.channel.claimLock("waiter-B");
      expect(await b.channel.isSuperseded("waiter-A")).toBe(true);
      expect(await b.channel.isSuperseded("waiter-B")).toBe(false);
    });
  });

  describe(`DocumentStore contract — ${name}`, () => {
    let b: Backend;
    beforeEach(() => (b = make()));
    afterEach(() => b.cleanup());

    it("round-trips doc and canonical (null when absent)", async () => {
      expect(await b.store.getCanonical()).toBeNull();
      await b.store.saveDoc("# body");
      await b.store.setCanonical("# canon");
      expect(await b.store.loadDoc()).toBe("# body");
      expect(await b.store.getCanonical()).toBe("# canon");
    });

    it("parks a proposal and reads it back as the pending row, by id and as mine", async () => {
      expect(await b.store.myPendingProposal()).toBeNull();
      const { id } = await b.store.createProposal({ content: "# proposed", baseHash: "h1", baseContent: "# canon" });
      const mine = await b.store.myPendingProposal();
      expect(mine).toMatchObject({ id, content: "# proposed", baseHash: "h1", baseContent: "# canon", state: "pending" });
      expect(await b.store.getProposal(id)).toMatchObject({ id, state: "pending" });
    });

    it("re-parking IDENTICAL content with no id keeps the same proposal identity (a retry, not a successor)", async () => {
      const a = await b.store.createProposal({ content: "same text", baseHash: "h", baseContent: "c" });
      const again = await b.store.createProposal({ content: "same text", baseHash: "h", baseContent: "c" });
      expect(again.id).toBe(a.id);
      expect(await b.store.getProposal(a.id)).toMatchObject({ state: "pending" }); // never superseded by its own retry
    });

    it("re-parking with the SAME id converges (idempotent retry), updating content and base", async () => {
      const { id } = await b.store.createProposal({ id: "p-fixed", content: "v1", baseHash: "h1", baseContent: "c1" });
      expect(id).toBe("p-fixed");
      await b.store.createProposal({ id: "p-fixed", content: "v2", baseHash: "h2", baseContent: "c2" });
      expect(await b.store.myPendingProposal()).toMatchObject({ id: "p-fixed", content: "v2", baseHash: "h2" });
    });

    it("a NEW id supersedes the caller's own previous pending proposal — history is kept", async () => {
      const a = await b.store.createProposal({ content: "first", baseHash: "h", baseContent: "c" });
      const c = await b.store.createProposal({ content: "second", baseHash: "h", baseContent: "c" });
      expect(await b.store.myPendingProposal()).toMatchObject({ id: c.id, content: "second" });
      expect(await b.store.getProposal(a.id)).toMatchObject({ state: "superseded", content: "first" });
    });

    it("deciding a pending proposal is terminal — later decisions, withdraws, and re-parks are no-ops on it", async () => {
      const { id } = await b.store.createProposal({ content: "v1", baseHash: "h", baseContent: "c" });
      // `transitioned` is the ATOMIC "this call settled it" answer: true exactly once — a repeat
      // (even with the SAME outcome) reports false, which is how a caller about to announce a
      // decision tells its own settlement from one that raced ahead of it.
      expect(await b.store.decideProposal(id, "accepted")).toEqual({ transitioned: true });
      expect(await b.store.getProposal(id)).toMatchObject({ state: "accepted" });
      expect((await b.store.getProposal(id))?.decidedAt).toBeTruthy();
      expect(await b.store.decideProposal(id, "accepted")).toEqual({ transitioned: false }); // same outcome — no transition
      expect(await b.store.decideProposal("no-such-id", "accepted")).toEqual({ transitioned: false }); // absent row
      expect(await b.store.decideProposal(id, "rejected")).toEqual({ transitioned: false }); // immutable
      await b.store.withdrawProposal(id); // immutable
      await b.store.createProposal({ id, content: "sneaky rewrite", baseHash: "h2", baseContent: "c2" });
      expect(await b.store.getProposal(id)).toMatchObject({ state: "accepted", content: "v1" });
      expect(await b.store.myPendingProposal()).toBeNull(); // the decided row never reappears as pending
    });

    it("withdraw retracts the caller's own pending proposal", async () => {
      const { id } = await b.store.createProposal({ content: "v1", baseHash: "h", baseContent: "c" });
      await b.store.withdrawProposal(id);
      expect(await b.store.getProposal(id)).toMatchObject({ state: "withdrawn" });
      expect(await b.store.myPendingProposal()).toBeNull();
    });
  });
}

describe("MemoryControlChannel specifics", () => {
  it("notifies subscribers synchronously on append and supports presence/unsubscribe", async () => {
    const ch = new MemoryControlChannel();
    let hits = 0;
    const unsub = ch.subscribe(() => hits++);
    await ch.append({ actor: "user", type: LogEventType.TurnEnded });
    expect(hits).toBe(1);
    unsub();
    await ch.append({ actor: "user", type: LogEventType.TurnEnded });
    expect(hits).toBe(1); // no longer notified

    expect(await ch.presence()).toBe(false);
    ch.setPresent(true);
    expect(await ch.presence()).toBe(true);
  });
});
