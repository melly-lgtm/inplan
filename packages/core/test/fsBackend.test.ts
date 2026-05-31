// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FsControlChannel, FsDocumentStore, LogEventType, type FsBackendPaths } from "../src/node";

let dir: string;
let paths: FsBackendPaths;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "inplan-fsbackend-"));
  paths = {
    file: join(dir, "design.plan.md"),
    logPath: join(dir, "log.jsonl"),
    canonicalPath: join(dir, "canonical.md"),
    proposedPath: join(dir, "proposed.md"),
    backupsDir: join(dir, "backups"),
    cursorPath: join(dir, "cursor"),
    waitLockPath: join(dir, "waitlock"),
  };
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("FsControlChannel", () => {
  it("appends and reads incrementally from a cursor", async () => {
    const ch = new FsControlChannel(paths);
    const a = await ch.append({ actor: "user", type: "turn_ended" });
    const b = await ch.append({ actor: "agent", type: "agent_revised" });
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    const since = await ch.readSince(1);
    expect(since.entries.map((e) => e.seq)).toEqual([2]);
    expect(since.cursor).toBe(2);
  });

  it("persists a cursor (0 when unset)", async () => {
    const ch = new FsControlChannel(paths);
    expect(await ch.getCursor()).toBe(0);
    await ch.setCursor(7);
    expect(await ch.getCursor()).toBe(7);
  });

  it("supersedes an older lock holder when a newer token claims", async () => {
    const ch = new FsControlChannel(paths);
    await ch.claimLock("token-a");
    expect(await ch.isSuperseded("token-a")).toBe(false);
    await ch.claimLock("token-b");
    expect(await ch.isSuperseded("token-a")).toBe(true);
    expect(await ch.isSuperseded("token-b")).toBe(false);
  });

  it("reports presence from the latest live editor_pid", async () => {
    const ch = new FsControlChannel(paths);
    await ch.append({ actor: "agent", type: LogEventType.EditorPid, payload: { pid: 2147483646 } });
    expect(await ch.presence()).toBe(false); // implausible pid → not alive
    await ch.append({ actor: "agent", type: LogEventType.EditorPid, payload: { pid: process.pid } });
    expect(await ch.presence()).toBe(true); // this test process is alive
  });

  it("notifies subscribers on append", async () => {
    const ch = new FsControlChannel(paths);
    await ch.append({ actor: "user", type: "turn_ended" }); // ensure the file exists to watch
    const fired = await new Promise<boolean>((resolve) => {
      const unsub = ch.subscribe(() => {
        unsub();
        resolve(true);
      });
      const t = setTimeout(() => {
        unsub();
        resolve(false);
      }, 3000);
      t.unref?.();
      // Append only after watchFile has captured its baseline stat; appending in
      // the same tick would race that capture and look like "no change".
      setTimeout(() => void ch.append({ actor: "agent", type: "agent_revised" }), 300);
    });
    expect(fired).toBe(true);
  });
});

describe("FsDocumentStore", () => {
  it("round-trips doc, canonical, and proposed (null when absent)", async () => {
    const store = new FsDocumentStore(paths);
    expect(await store.getCanonical()).toBeNull();
    expect(await store.getProposed()).toBeNull();
    await store.saveDoc("# body");
    await store.setCanonical("# canon");
    await store.setProposed("# proposed");
    expect(await store.loadDoc()).toBe("# body");
    expect(await store.getCanonical()).toBe("# canon");
    expect(await store.getProposed()).toBe("# proposed");
    await store.clearProposed();
    expect(await store.getProposed()).toBeNull();
  });

  it("caps autosave backups at the retention limit", async () => {
    const store = new FsDocumentStore(paths);
    for (let i = 0; i < 30; i++) await store.backup(`v${i}`);
    const files = readdirSync(paths.backupsDir).filter((f) => /^autosave-\d+\.md$/.test(f));
    expect(files.length).toBe(25);
  });
});
