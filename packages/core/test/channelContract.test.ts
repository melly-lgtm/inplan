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

    it("round-trips doc, canonical, and proposed (null when absent)", async () => {
      expect(await b.store.getCanonical()).toBeNull();
      expect(await b.store.getProposed()).toBeNull();
      await b.store.saveDoc("# body");
      await b.store.setCanonical("# canon");
      await b.store.setProposed("# proposed");
      expect(await b.store.loadDoc()).toBe("# body");
      expect(await b.store.getCanonical()).toBe("# canon");
      expect(await b.store.getProposed()).toBe("# proposed");
      await b.store.clearProposed();
      expect(await b.store.getProposed()).toBeNull();
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
