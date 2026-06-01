// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The behavioral contract every inplan backend must satisfy. Mirrors the
// Fs<->Memory cross-backend suite in the open core. Run against the in-process
// reference backend today (memory.contract.test.ts) and against a live Supabase
// when env is present (supabase.contract.test.ts) — proving the adapter is a
// drop-in for the same interfaces the desktop CLI + editor consume.
//
// Factories are async so a backend can provision a fresh document (Supabase) or
// just `new` an instance (Memory) per test.

import { describe, expect, it } from "vitest";
import type { ControlChannel, DocumentStore } from "@inplan/core";

type Make<T> = () => T | Promise<T>;

const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

export function runControlChannelContract(name: string, makeChannel: Make<ControlChannel>): void {
  describe(`ControlChannel contract: ${name}`, () => {
    it("append assigns a monotonic seq and echoes the event", async () => {
      const ch = await makeChannel();
      const a = await ch.append({ actor: "agent", type: "agent_revised" });
      const b = await ch.append({ actor: "user", type: "turn_ended", payload: { bytes: 10 } });
      expect(a.seq).toBeGreaterThan(0);
      expect(b.seq).toBeGreaterThan(a.seq);
      expect(b.type).toBe("turn_ended");
      expect(b.payload).toEqual({ bytes: 10 });
      expect(typeof b.ts).toBe("string");
    });

    it("readSince returns only entries strictly after the cursor", async () => {
      const ch = await makeChannel();
      const first = await ch.append({ actor: "user", type: "turn_ended" });
      const second = await ch.append({ actor: "agent", type: "agent_revised" });

      const after1 = await ch.readSince(first.seq);
      expect(after1.entries.map((e) => e.seq)).toEqual([second.seq]);
      expect(after1.cursor).toBe(second.seq);

      const afterAll = await ch.readSince(second.seq);
      expect(afterAll.entries).toEqual([]);
      expect(afterAll.cursor).toBe(second.seq);
    });

    it("persists a read cursor (0 until set)", async () => {
      const ch = await makeChannel();
      expect(await ch.getCursor()).toBe(0);
      await ch.setCursor(5);
      expect(await ch.getCursor()).toBe(5);
    });

    it("single-waiter lock: the most recent claimant supersedes the prior", async () => {
      const ch = await makeChannel();
      await ch.claimLock("token-A");
      expect(await ch.isSuperseded("token-A")).toBe(false);
      await ch.claimLock("token-B");
      expect(await ch.isSuperseded("token-A")).toBe(true);
      expect(await ch.isSuperseded("token-B")).toBe(false);
    });

    it("subscribe returns an unsubscribe that halts further notifications", async () => {
      const ch = await makeChannel();
      let hits = 0;
      const off = ch.subscribe(() => {
        hits += 1;
      });
      expect(typeof off).toBe("function");
      await ch.append({ actor: "user", type: "turn_ended" });
      await flush();
      const beforeOff = hits;
      off();
      await ch.append({ actor: "agent", type: "agent_revised" });
      await flush();
      expect(hits).toBe(beforeOff); // no notifications fire after unsubscribe
    });
  });
}

export function runDocumentStoreContract(name: string, makeStore: Make<DocumentStore>): void {
  describe(`DocumentStore contract: ${name}`, () => {
    it("round-trips the working document", async () => {
      const s = await makeStore();
      await s.saveDoc("# Plan\n");
      expect(await s.loadDoc()).toBe("# Plan\n");
    });

    it("canonical base is null until set, then sticks", async () => {
      const s = await makeStore();
      expect(await s.getCanonical()).toBeNull();
      await s.setCanonical("base");
      expect(await s.getCanonical()).toBe("base");
    });

    it("a proposed revision can be parked, read, and cleared", async () => {
      const s = await makeStore();
      expect(await s.getProposed()).toBeNull();
      await s.setProposed("proposal");
      expect(await s.getProposed()).toBe("proposal");
      await s.clearProposed();
      expect(await s.getProposed()).toBeNull();
    });

    it("backup does not disturb the working document", async () => {
      const s = await makeStore();
      await s.saveDoc("live");
      await s.backup("snapshot-1");
      expect(await s.loadDoc()).toBe("live");
    });
  });
}
