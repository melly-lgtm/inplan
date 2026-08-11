// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { MemoryControlChannel, MemoryDocumentStore } from "../src/index";

describe("MemoryDocumentStore", () => {
  it("accumulates backups and reports the count", async () => {
    const store = new MemoryDocumentStore("init");
    expect(store.backupCount()).toBe(0);
    await store.backup("a");
    await store.backup("b");
    expect(store.backupCount()).toBe(2);
  });
});

describe("MemoryControlChannel presence freshness", () => {
  it("uses a strict `>` bound — a heartbeat exactly at sinceMs is NOT counted as fresh", async () => {
    const ch = new MemoryControlChannel();
    ch.setPresent(true, 1000); // heartbeat stamped at t=1000
    expect(await ch.presence()).toBe(true); // no bound → present
    expect(await ch.presence(999)).toBe(true); // written AFTER 999 → fresh
    expect(await ch.presence(1000)).toBe(false); // equal to the grace-start → NOT "after"
    expect(await ch.presence(1001)).toBe(false); // older than the bound → stale
  });
});
