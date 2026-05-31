// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { MemoryDocumentStore } from "../src/index";

describe("MemoryDocumentStore", () => {
  it("accumulates backups and reports the count", async () => {
    const store = new MemoryDocumentStore("init");
    expect(store.backupCount()).toBe(0);
    await store.backup("a");
    await store.backup("b");
    expect(store.backupCount()).toBe(2);
  });
});
